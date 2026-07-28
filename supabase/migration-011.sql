-- ============================================================================
-- 差分適用スクリプト 011
--
-- 既に schema.sql（＋002〜010）を実行済みのプロジェクトに、あとから入った
-- 変更だけを当てる。Supabaseダッシュボードの SQL Editor に貼り付けて「Run」。
-- 何度実行しても同じ結果になる。
--
-- 新しくプロジェクトを作る場合はこれは不要（schema.sql に取り込み済み）。
--
-- 内容:
--   回戦ごとの開始と配信台。
--
--   010 で選手がゲームカウントを入力できるようにしたが、運営の合図より先に
--   勝手に進められてしまう。回戦ごとに運営が「開始」を出すまで、選手は
--   ゲームカウントを報告できないようにする。
--
--   開始の前に、運営はその回戦の配信台（＝配信に乗せる試合）を決めなければ
--   ならない。基本は1回戦につき1試合だが、全試合を配信する大会もあるので
--   複数選べるようにしてある。「決めないと開始できない」は制約で保証する。
-- ============================================================================

create table if not exists tournament_rounds (
  tournament_id      uuid not null references tournaments(id) on delete cascade,
  -- ブラケットの rounds 配列の位置（0始まり）。ラウンド名（R1/QF/SF/F）は
  -- 表の大きさで変わるので、位置で持つほうが崩れない
  round_index        int not null,
  -- 配信台に乗せる試合。基本は1つだが、全試合を配信する大会もある
  streamed_match_ids uuid[] not null default '{}',
  -- 開始通知を出した時刻。null なら未開始（選手は報告できない）
  started_at         timestamptz,
  started_by         uuid references players(id) on delete set null,
  primary key (tournament_id, round_index),
  -- 配信台を決めずに開始通知は出せない
  constraint rounds_stream_before_start check (
    started_at is null or coalesce(array_length(streamed_match_ids, 1), 0) >= 1
  )
);

-- ---------------------------------------------------------------------------
-- 権限とRLS
--
-- 配信台と開始状態は誰が見てもよい（選手も観戦者も、どこで何が始まったか知りたい）。
-- 決められるのは運営だけ。
-- ---------------------------------------------------------------------------

grant select on tournament_rounds to anon, authenticated;
grant insert, update, delete on tournament_rounds to authenticated;

alter table tournament_rounds enable row level security;

drop policy if exists rounds_select on tournament_rounds;
create policy rounds_select on tournament_rounds
  for select to anon, authenticated
  using (true);

drop policy if exists rounds_write on tournament_rounds;
create policy rounds_write on tournament_rounds
  for all to authenticated
  using (is_admin())
  with check (is_admin());

-- ---------------------------------------------------------------------------
-- 試合がどの回戦にあるか
-- ---------------------------------------------------------------------------

create or replace function bracket_round_index(p_tournament_id uuid, p_match_id uuid)
  returns int
  language sql
  security definer
  stable
  set search_path = public
as $$
  select (r.ord - 1)::int
  from brackets b,
       jsonb_array_elements(b.data->'rounds') with ordinality as r(j, ord),
       jsonb_array_elements(r.j->'matches') as m
  where b.tournament_id = p_tournament_id
    and m->>'id' = p_match_id::text
  limit 1;
$$;

-- その試合の回戦が開始されているか。運営の合図が出るまで選手は報告できない。
create or replace function round_is_started(p_tournament_id uuid, p_match_id uuid)
  returns boolean
  language sql
  security definer
  stable
  set search_path = public
as $$
  select exists (
    select 1 from tournament_rounds
    where tournament_id = p_tournament_id
      and round_index = bracket_round_index(p_tournament_id, p_match_id)
      and started_at is not null
  );
$$;

revoke all on function bracket_round_index(uuid, uuid) from anon, public;
revoke all on function round_is_started(uuid, uuid)    from anon, public;
grant execute on function bracket_round_index(uuid, uuid) to authenticated;
grant execute on function round_is_started(uuid, uuid)    to authenticated;

-- ---------------------------------------------------------------------------
-- 報告と承認に開始の条件を足す
--
-- 010 の関数を丸ごと置き換える（差分だけの追記ができないため）。
-- 増えているのは round_is_started の判定だけ。
-- ---------------------------------------------------------------------------

create or replace function report_match_result(
  p_tournament_id     uuid,
  p_match_id          uuid,
  p_score             text,
  p_winner_entrant_id uuid
) returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_me         uuid;
  v_my_entrant uuid;
  v_m          jsonb;
  v_p1         uuid;
  v_p2         uuid;
  v_s1         int;
  v_s2         int;
begin
  v_me := current_player_id();
  if v_me is null then
    raise exception '選手登録がまだのため報告できません。' using errcode = 'insufficient_privilege';
  end if;

  v_m := bracket_match(p_tournament_id, p_match_id);
  if v_m is null then
    raise exception '対象の試合が見つかりません。' using errcode = 'no_data_found';
  end if;
  if coalesce((v_m->>'confirmed')::boolean, false) then
    raise exception 'この試合は既に確定済みです。' using errcode = 'check_violation';
  end if;

  if not round_is_started(p_tournament_id, p_match_id) then
    raise exception 'この回戦はまだ開始されていません。運営の開始をお待ちください。'
      using errcode = 'check_violation';
  end if;

  v_p1 := (v_m->>'player1Id')::uuid;
  v_p2 := (v_m->>'player2Id')::uuid;
  if v_p1 is null or v_p2 is null then
    raise exception '対戦カードが確定していないため報告できません。' using errcode = 'check_violation';
  end if;

  v_my_entrant := my_entrant_id(p_tournament_id);
  if v_my_entrant is null or v_my_entrant not in (v_p1, v_p2) then
    raise exception 'この対戦の当事者ではありません。' using errcode = 'insufficient_privilege';
  end if;
  if p_winner_entrant_id not in (v_p1, v_p2) then
    raise exception '勝者は対戦カードから選んでください。' using errcode = 'check_violation';
  end if;

  if p_score !~ '^[0-9]{1,3}-[0-9]{1,3}$' then
    raise exception 'ゲームカウントの形式が正しくありません。' using errcode = 'check_violation';
  end if;
  v_s1 := split_part(p_score, '-', 1)::int;
  v_s2 := split_part(p_score, '-', 2)::int;
  if v_s1 = v_s2 then
    raise exception 'ゲームカウントが同点のため勝者を判定できません。' using errcode = 'check_violation';
  end if;
  -- スコアの左が player1 側。勝者の指定と向きが食い違っていたら受け付けない
  if (v_s1 > v_s2) <> (p_winner_entrant_id = v_p1) then
    raise exception 'ゲームカウントと勝者が食い違っています。' using errcode = 'check_violation';
  end if;

  insert into match_result_reports (
    tournament_id, match_id, reported_by, reporter_player_id, score, winner_entrant_id
  ) values (
    p_tournament_id, p_match_id, v_my_entrant, v_me, p_score, p_winner_entrant_id
  )
  on conflict (tournament_id, match_id) do update set
    reported_by        = excluded.reported_by,
    reporter_player_id = excluded.reporter_player_id,
    score              = excluded.score,
    winner_entrant_id  = excluded.winner_entrant_id,
    created_at         = now();
end;
$$;

create or replace function approve_match_result(p_tournament_id uuid, p_match_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_me         uuid;
  v_my_entrant uuid;
  v_rep        match_result_reports%rowtype;
  v_m          jsonb;
  v_p1         uuid;
  v_p2         uuid;
  v_loser      uuid;
  v_round      text;
  v_is_team    boolean;
begin
  v_me := current_player_id();
  if v_me is null then
    raise exception '選手登録がまだのため承認できません。' using errcode = 'insufficient_privilege';
  end if;

  -- 同じ試合を2人が同時に承認しても、二重に確定させない
  select * into v_rep from match_result_reports
    where tournament_id = p_tournament_id and match_id = p_match_id
    for update;
  if not found then
    raise exception 'この対戦にはまだ報告がありません。' using errcode = 'no_data_found';
  end if;

  v_m := bracket_match(p_tournament_id, p_match_id);
  if v_m is null then
    raise exception '対象の試合が見つかりません。' using errcode = 'no_data_found';
  end if;
  if coalesce((v_m->>'confirmed')::boolean, false) then
    raise exception 'この試合は既に確定済みです。' using errcode = 'check_violation';
  end if;

  if not round_is_started(p_tournament_id, p_match_id) then
    raise exception 'この回戦はまだ開始されていません。運営の開始をお待ちください。'
      using errcode = 'check_violation';
  end if;

  v_p1 := (v_m->>'player1Id')::uuid;
  v_p2 := (v_m->>'player2Id')::uuid;

  v_my_entrant := my_entrant_id(p_tournament_id);
  if v_my_entrant is null or v_my_entrant not in (v_p1, v_p2) then
    raise exception 'この対戦の当事者ではありません。' using errcode = 'insufficient_privilege';
  end if;
  if v_my_entrant = v_rep.reported_by then
    raise exception '自分が出した報告は自分では承認できません。相手の承認を待ってください。'
      using errcode = 'check_violation';
  end if;

  v_loser := case when v_rep.winner_entrant_id = v_p1 then v_p2 else v_p1 end;
  v_round := v_m->>'round';

  update brackets
     set data = apply_match_result_json(
           data, p_match_id, v_rep.winner_entrant_id, v_loser, v_rep.score)
   where tournament_id = p_tournament_id;

  -- 試合の記録。チーム戦はチーム列に入れる（個人の通算成績に混ぜないため）
  select match_type = '2v2' into v_is_team from tournaments where id = p_tournament_id;

  if v_is_team then
    insert into matches (id, tournament_id, winner_team_id, loser_team_id, score, round)
      values (p_match_id, p_tournament_id, v_rep.winner_entrant_id, v_loser, v_rep.score, v_round);
  else
    insert into matches (id, tournament_id, winner_id, loser_id, score, round)
      values (p_match_id, p_tournament_id, v_rep.winner_entrant_id, v_loser, v_rep.score, v_round);
  end if;

  delete from match_result_reports
    where tournament_id = p_tournament_id and match_id = p_match_id;
end;
$$;

-- 開始の状態は選手も観戦者も待っているので、変わった瞬間に届けたい。
do $$
begin
  execute 'alter publication supabase_realtime add table tournament_rounds';
exception when duplicate_object then null;
end $$;

-- ============================================================================
-- 差分適用スクリプト 010
--
-- 既に schema.sql（＋002〜009）を実行済みのプロジェクトに、あとから入った
-- 変更だけを当てる。Supabaseダッシュボードの SQL Editor に貼り付けて「Run」。
-- 何度実行しても同じ結果になる。
--
-- 新しくプロジェクトを作る場合はこれは不要（schema.sql に取り込み済み）。
--
-- 内容:
--   選手が自分の対戦のゲームカウントを入力できるようにする。
--
--   片方が報告し、相手が承認して初めて確定する。一方的な入力で勝ち上がれない
--   ようにするため。相手が反応しないときは、チャットと運営への報告で運営が入る。
--
--   選手は brackets に直接書けない（brackets_write は運営限定）。ここを緩めると
--   対戦表を丸ごと書き換えられてしまうので、確定の処理は security definer の
--   関数の中に閉じ込め、「この1試合の結果を入れて、勝者を次の枠へ送る」以外の
--   ことができないようにする。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 当事者の判定
--
-- 008 で入れた can_use_match_chat と同じ判定を、チャット以外からも使う。
-- 中身を is_match_participant に移し、can_use_match_chat はその別名にする
-- （008 で作ったポリシーはそのまま動く）。
-- ---------------------------------------------------------------------------

create or replace function is_match_participant(p_tournament_id uuid, p_match_id uuid)
  returns boolean
  language sql
  security definer
  stable
  set search_path = public
as $$
  with m as (select bracket_match(p_tournament_id, p_match_id) as j)
  select
    (select j->>'player1Id' is not null and j->>'player2Id' is not null from m)
    and (
      is_admin()
      or exists (
        select 1
        from tournament_entries e, m
        where e.tournament_id = p_tournament_id
          and e.player_id = current_player_id()
          and coalesce(e.team_id, e.player_id) in (
            (m.j->>'player1Id')::uuid,
            (m.j->>'player2Id')::uuid
          )
      )
    );
$$;

create or replace function can_use_match_chat(p_tournament_id uuid, p_match_id uuid)
  returns boolean
  language sql
  security definer
  stable
  set search_path = public
as $$
  select is_match_participant(p_tournament_id, p_match_id);
$$;

-- 呼び出し元がこの大会で入る「出場枠」（個人戦は選手ID、チーム戦はチームID）。
create or replace function my_entrant_id(p_tournament_id uuid)
  returns uuid
  language sql
  security definer
  stable
  set search_path = public
as $$
  select coalesce(e.team_id, e.player_id)
  from tournament_entries e
  where e.tournament_id = p_tournament_id
    and e.player_id = current_player_id();
$$;

-- ---------------------------------------------------------------------------
-- 承認待ちの報告
-- ---------------------------------------------------------------------------

create table if not exists match_result_reports (
  tournament_id      uuid not null references tournaments(id) on delete cascade,
  match_id           uuid not null,
  -- 報告した側の出場枠（個人戦は選手ID、チーム戦はチームID）
  reported_by        uuid not null,
  -- 実際に操作した選手。チーム戦で誰が出したのかを残す
  reporter_player_id uuid not null references players(id) on delete cascade,
  -- "3-1" 形式。左が player1Id 側で、brackets / matches の score と同じ向き
  score              text not null,
  winner_entrant_id  uuid not null,
  created_at         timestamptz not null default now(),
  -- 1試合につき承認待ちは1件。出し直すと上書きされる（相手からの対案もこれで入る）
  primary key (tournament_id, match_id)
);

grant select on match_result_reports to anon, authenticated;
-- 登録と更新は下のRPC経由だけ（テーブルへの直接の権限は与えない）。
-- 取り消しだけはポリシーで足りるので、そのまま delete させる。
grant delete on match_result_reports to authenticated;

alter table match_result_reports enable row level security;

drop policy if exists result_reports_select on match_result_reports;
create policy result_reports_select on match_result_reports
  for select to anon, authenticated
  using (is_match_participant(tournament_id, match_id));

-- 取り消せるのは出した本人と運営。相手が違うと思ったときは、
-- 取り消してもらうのではなく自分のスコアを出し直す（上書きされる）。
drop policy if exists result_reports_delete on match_result_reports;
create policy result_reports_delete on match_result_reports
  for delete to authenticated
  using (is_admin() or reporter_player_id = current_player_id());

-- ---------------------------------------------------------------------------
-- 対戦表への結果の反映
--
-- ブラケットのJSONを組み直す。触るのは「その試合の結果欄」と「勝者を送る先の枠」
-- だけで、それ以外はそのまま写す。js/bracket.js の applyWinner と同じ内容。
-- ---------------------------------------------------------------------------

create or replace function apply_match_result_json(
  p_data     jsonb,
  p_match_id uuid,
  p_winner   uuid,
  p_loser    uuid,
  p_score    text
) returns jsonb
  language plpgsql
  immutable
as $$
declare
  v_rounds    jsonb := '[]'::jsonb;
  v_round     jsonb;
  v_matches   jsonb;
  v_match     jsonb;
  v_next_id   text;
  v_next_slot int;
begin
  -- 勝者をどの枠へ送るかを先に調べる（決勝なら送り先は無い）
  select m->>'nextMatchId', (m->>'nextSlot')::int
    into v_next_id, v_next_slot
  from jsonb_array_elements(p_data->'rounds') r,
       jsonb_array_elements(r->'matches') m
  where m->>'id' = p_match_id::text;

  for v_round in select * from jsonb_array_elements(p_data->'rounds') loop
    v_matches := '[]'::jsonb;

    for v_match in select * from jsonb_array_elements(v_round->'matches') loop
      if v_match->>'id' = p_match_id::text then
        v_match := v_match || jsonb_build_object(
          'winnerId',   p_winner,
          'loserId',    p_loser,
          'score',      p_score,
          'confirmed',  true,
          'isBye',      false,
          'isWalkover', false
        );
      elsif v_next_id is not null and v_match->>'id' = v_next_id then
        v_match := v_match || jsonb_build_object(
          case when v_next_slot = 1 then 'player1Id' else 'player2Id' end, p_winner
        );
      end if;

      v_matches := v_matches || jsonb_build_array(v_match);
    end loop;

    v_rounds := v_rounds || jsonb_build_array(jsonb_set(v_round, '{matches}', v_matches));
  end loop;

  return jsonb_set(p_data, '{rounds}', v_rounds);
end;
$$;

-- ---------------------------------------------------------------------------
-- 報告と承認（RPC）
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

-- 相手の報告を承認して確定させる。自分が出した報告は自分では承認できない。
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

revoke all on function is_match_participant(uuid, uuid)          from anon, public;
revoke all on function my_entrant_id(uuid)                       from anon, public;
revoke all on function report_match_result(uuid, uuid, text, uuid) from anon, public;
revoke all on function approve_match_result(uuid, uuid)          from anon, public;
grant execute on function is_match_participant(uuid, uuid)          to authenticated;
grant execute on function my_entrant_id(uuid)                       to authenticated;
grant execute on function report_match_result(uuid, uuid, text, uuid) to authenticated;
grant execute on function approve_match_result(uuid, uuid)          to authenticated;

-- 承認待ちは相手が対戦表を見ながら待つものなので、届いた瞬間に出したい。
-- 中身はゲームカウントと出場枠のIDだけで、確定すればどのみち全員に見えるもの
-- （チャットや報告の本文とは性質が違う）ので、Realtimeに載せる。
do $$
begin
  execute 'alter publication supabase_realtime add table match_result_reports';
exception when duplicate_object then null;
end $$;

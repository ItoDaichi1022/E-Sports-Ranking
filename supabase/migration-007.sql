-- ============================================================================
-- 差分適用スクリプト 007
--
-- 既に schema.sql（＋002〜006）を実行済みのプロジェクトに、あとから入った
-- 変更だけを当てる。Supabaseダッシュボードの SQL Editor に貼り付けて「Run」。
-- 何度実行しても同じ結果になる。
--
-- 新しくプロジェクトを作る場合はこれは不要（schema.sql に取り込み済み）。
--
-- 内容:
--   2v2（チーム戦）の大会に対応する。
--
--   これまでは「1エントリー＝1人」で、ブラケットの枠・シード・成績のすべてが
--   players.id に直結していた。2v2ではブラケットの枠に入るのはチームなので、
--   「出場枠（entrant）」と「出場した人」を分ける。
--
--     出場枠  : 1v1／リレーでは選手、2v2ではチーム
--     出場した人: どちらもメンバー全員（tournament_entries の行）
--
--   チームIDもuuidなので、brackets に保存済みのJSON（player1Id / player2Id）は
--   構造を変えなくてよい。入っているIDの意味だけが大会の対戦方法で変わる。
--
--   既存の1v1／リレーの大会は team_id が null のままなので、挙動は一切変わらない。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- チーム
-- ---------------------------------------------------------------------------

create table if not exists tournament_teams (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id) on delete cascade,
  name          text not null,
  -- 募集締切後に確定するシード順（1 = 第1シード）。tournament_entries.seed の
  -- チーム版で、チーム大会ではこちらだけを使う
  seed          int,
  -- 確定した成績（勝ち上がりの深さ。優勝=1）。メンバーの entries 行にも同じ値を
  -- 書き写すので、選手ページはチームの存在を知らなくても成績を出せる
  placement     int,
  created_at    timestamptz not null default now(),
  constraint teams_name_not_blank check (btrim(name) <> ''),
  -- 対戦表でどちらのチームか分からなくなるため、同じ大会に同名は作らせない
  constraint teams_name_unique unique (tournament_id, name)
);

create index if not exists teams_tournament_idx on tournament_teams (tournament_id);

-- メンバーは1人1行のまま。同じチームの2人が同じ team_id を共有する。
-- 既存の主キー (tournament_id, player_id) が「1人が同じ大会で2チームに入る」を防ぐ。
alter table tournament_entries
  add column if not exists team_id uuid references tournament_teams(id) on delete cascade;

create index if not exists entries_team_idx on tournament_entries (team_id);

-- ---------------------------------------------------------------------------
-- 試合をチーム対応にする
--
-- 別テーブルに分けると「1大会の試合は matches を見れば分かる」性質が崩れ、
-- js/db.js の syncTournamentProgress の照合が二重になる。同じテーブルに
-- チーム列を足し、どちらか一方だけが入ることを制約で保証する。
--
-- チーム戦の行は winner_id が null になるため、js/playerStats.js の
-- 「自分が勝者か敗者か」の絞り込みに引っかからない。これで2v2の勝敗は
-- 個人の通算成績（W-L）に混ざらない（個人ランキングが2v2を除外しているのと揃える）。
-- ---------------------------------------------------------------------------

alter table matches alter column winner_id drop not null;
alter table matches alter column loser_id  drop not null;

alter table matches add column if not exists winner_team_id uuid
  references tournament_teams(id) on delete cascade;
alter table matches add column if not exists loser_team_id  uuid
  references tournament_teams(id) on delete cascade;

alter table matches drop constraint if exists matches_entrant_check;
alter table matches add constraint matches_entrant_check check (
  (winner_id is not null and loser_id is not null
   and winner_team_id is null and loser_team_id is null)
  or
  (winner_team_id is not null and loser_team_id is not null
   and winner_id is null and loser_id is null)
);

-- 個人戦の matches_distinct_players と同じ書き方にする。列がnullのとき check は
-- NULL（＝通過）になるので、チーム列が空の個人戦の行はこの制約に引っかからない。
-- `is distinct from` にすると null 同士が「区別されない」＝false と評価され、
-- 既存の個人戦の行がすべて弾かれてしまう。
alter table matches drop constraint if exists matches_distinct_teams;
alter table matches add constraint matches_distinct_teams
  check (winner_team_id <> loser_team_id);

create index if not exists matches_winner_team_idx on matches (winner_team_id);
create index if not exists matches_loser_team_idx  on matches (loser_team_id);

-- ---------------------------------------------------------------------------
-- 定員の数え方
--
-- チーム大会の定員は「チーム数」。行をそのまま数えると16チーム32人が
-- 定員16に対して32と判定され、正しいエントリーが弾かれる。
-- coalesce(team_id, player_id) で数えれば、個人戦は人数・チーム戦はチーム数になる。
-- ---------------------------------------------------------------------------

create or replace function enforce_entry_capacity() returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  rec record;
  cap int;
  cnt int;
begin
  for rec in select distinct tournament_id from new_entries loop
    -- 同じ大会への同時エントリーを直列化する（ロックしてから数える）
    select capacity into cap from tournaments where id = rec.tournament_id for update;
    if cap is not null then
      select count(distinct coalesce(team_id, player_id)) into cnt
        from tournament_entries where tournament_id = rec.tournament_id;
      if cnt > cap then
        raise exception 'この大会は定員（%）に達しています。', cap using errcode = 'check_violation';
      end if;
    end if;
  end loop;

  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 権限とRLS
-- ---------------------------------------------------------------------------

grant select on tournament_teams to anon, authenticated;
grant insert, update, delete on tournament_teams to authenticated;

alter table tournament_teams enable row level security;

drop policy if exists teams_select on tournament_teams;
create policy teams_select on tournament_teams
  for select to anon, authenticated
  using (true);

-- 一般ユーザーの経路は下のRPCに限定する（RPCは security definer なのでRLSを通らない）。
-- 直接の書き込みは運営だけ。
drop policy if exists teams_write on tournament_teams;
create policy teams_write on tournament_teams
  for all to authenticated
  using (is_admin())
  with check (is_admin());

-- ---------------------------------------------------------------------------
-- チームでのエントリー（RPC）
--
-- entries_insert ポリシーは「自分の選手行だけ」しか挿入させない。チーム戦では
-- 申し込んだ人が相方の行も入れる必要があるので、security definer の関数を通す。
-- 大会行を FOR UPDATE でロックしてから定員を数えるので、同時に申し込まれても
-- 定員を超えない（個人エントリーのトリガーと同じ考え方）。
-- ---------------------------------------------------------------------------

create or replace function enter_tournament_as_team(
  p_tournament_id uuid,
  p_team_name     text,
  p_member_ids    uuid[]
) returns uuid
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_me      uuid;
  v_name    text;
  v_members uuid[];
  v_status  text;
  v_type    text;
  v_cap     int;
  v_count   int;
  v_team_id uuid;
begin
  v_me := current_player_id();
  if v_me is null then
    raise exception '選手登録がまだのためエントリーできません。' using errcode = 'insufficient_privilege';
  end if;

  v_name := btrim(coalesce(p_team_name, ''));
  if v_name = '' then
    raise exception 'チーム名を入力してください。' using errcode = 'check_violation';
  end if;
  if char_length(v_name) > 24 then
    raise exception 'チーム名は24文字までにしてください。' using errcode = 'check_violation';
  end if;

  select array_agg(distinct m) into v_members
    from unnest(coalesce(p_member_ids, '{}'::uuid[])) as m;
  if v_members is null or array_length(v_members, 1) <> 2 then
    raise exception 'チームはちょうど2人で登録してください。' using errcode = 'check_violation';
  end if;
  if not (v_me = any(v_members)) then
    raise exception '自分が入っていないチームは登録できません。' using errcode = 'insufficient_privilege';
  end if;
  if (select count(*) from players where id = any(v_members)) <> 2 then
    raise exception '選択された選手が見つかりません。' using errcode = 'no_data_found';
  end if;

  -- 同じ大会への同時エントリーを直列化する
  select status, match_type, capacity into v_status, v_type, v_cap
    from tournaments where id = p_tournament_id for update;
  if not found then
    raise exception '大会が見つかりません。' using errcode = 'no_data_found';
  end if;
  if v_status <> 'recruiting' then
    raise exception 'この大会は募集中ではありません。' using errcode = 'check_violation';
  end if;
  if v_type is distinct from '2v2' then
    raise exception 'この大会はチーム戦ではありません。' using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from tournament_entries
    where tournament_id = p_tournament_id and player_id = any(v_members)
  ) then
    raise exception 'すでにこの大会にエントリーしている選手が含まれています。' using errcode = 'unique_violation';
  end if;

  if exists (
    select 1 from tournament_teams
    where tournament_id = p_tournament_id and name = v_name
  ) then
    raise exception 'このチーム名はすでに使われています。' using errcode = 'unique_violation';
  end if;

  -- 定員はチーム数で数える。挿入前に数えるので +1 して比べる
  if v_cap is not null then
    select count(distinct coalesce(team_id, player_id)) into v_count
      from tournament_entries where tournament_id = p_tournament_id;
    if v_count + 1 > v_cap then
      raise exception 'この大会は定員（%チーム）に達しています。', v_cap using errcode = 'check_violation';
    end if;
  end if;

  insert into tournament_teams (tournament_id, name)
    values (p_tournament_id, v_name)
    returning id into v_team_id;

  insert into tournament_entries (tournament_id, player_id, team_id)
    select p_tournament_id, m, v_team_id from unnest(v_members) as m;

  return v_team_id;
end;
$$;

-- チームのエントリー取り消し。メンバーなら誰でも取り消せる。
-- 2人組は片方が抜けた時点で成立しないので、「申し込んだ人だけ」に絞ると
-- その人が離脱したときに相方がチームを畳めなくなる。
create or replace function cancel_team_entry(p_team_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_me      uuid;
  v_tid     uuid;
  v_status  text;
begin
  select tournament_id into v_tid from tournament_teams where id = p_team_id;
  if not found then
    raise exception 'チームが見つかりません。' using errcode = 'no_data_found';
  end if;

  select status into v_status from tournaments where id = v_tid for update;

  if not is_admin() then
    v_me := current_player_id();
    if v_status <> 'recruiting' then
      raise exception '募集が締め切られているため取り消せません。' using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from tournament_entries where team_id = p_team_id and player_id = v_me
    ) then
      raise exception '自分が入っているチームではありません。' using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- メンバーの entries 行は team_id の ON DELETE CASCADE で一緒に消える
  delete from tournament_teams where id = p_team_id;
end;
$$;

revoke all on function enter_tournament_as_team(uuid, text, uuid[]) from anon, public;
revoke all on function cancel_team_entry(uuid)                      from anon, public;
grant execute on function enter_tournament_as_team(uuid, text, uuid[]) to authenticated;
grant execute on function cancel_team_entry(uuid)                      to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------

do $$
begin
  execute 'alter publication supabase_realtime add table tournament_teams';
exception when duplicate_object then null;
end $$;

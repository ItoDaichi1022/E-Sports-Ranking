-- ============================================================================
-- 差分適用スクリプト 023
--
-- 既に schema.sql（＋002〜022）を実行済みのプロジェクトに、あとから入った
-- 変更だけを当てる。Supabaseダッシュボードの SQL Editor に貼り付けて「Run」。
-- 何度実行しても同じ結果になる。
--
-- 新しくプロジェクトを作る場合はこれは不要（schema.sql に取り込み済み）。
--
-- 内容:
--   選手ページからの通報と、アカウントの利用停止（BAN）。
--
--   大会を誰でも開けるようにした結果、運営者の目が届かないところで人が増える。
--   もめごとの入口が対戦チャットの「運営に報告」だけでは足りない ── あれは
--   「その対戦の当事者」しか使えず、大会の外や、対戦していない相手には効かない。
--   そこで、選手ページから直接その人を通報できる経路を作る。
--
--   【自動でBANはしない】通報が閾値（3人）に達すると、サイトの持ち主の画面に
--   「BAN対象」として並ぶ。停止するかどうかを決めるのは人で、DBは数えるだけ。
--   自動で消す作りにすると、結託した3アカウントで無実の選手を消せてしまう。
--
--   【停止しても記録は消さない】止まるのは新しく関わること（エントリー・大会作成・
--   対戦チャットへの書き込み・プロフィールの編集・通報）だけで、players の行は
--   残る。確定済みの大会の対戦表と戦績は他の参加者の記録でもあるので、
--   消すと関係のない選手の戦績まで壊れる。
--
--   【進行中の対戦は止めない】ゲームカウントの入力（report_match_result）と
--   エントリーの取り消しは、停止中でも通す。ここを止めると、停止された人と
--   当たっている相手が対戦表の中で立ち往生する（巻き添えを作らない）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. players に停止の印を足す
-- ---------------------------------------------------------------------------

-- 利用停止にした時刻と、停止した運営。null なら停止されていない。
--
-- 【この2列を update のGRANTに足してはいけない】players の UPDATE は列単位で
-- 絞ってあり（schema.sql の「権限（列単位）」節）、そこに無い列は本人にも運営にも
-- 直接は書けない。足してしまうと、停止された本人が自分で解除できるようになる。
-- 書き換えは下の admin_set_player_ban（security definer）からだけ行う。
--
-- 停止の理由は列に持たない。players の SELECT は誰にでも開いている（一覧と
-- 対戦表が読めなくなるので閉じられない）ため、ここに書いた運営のメモは
-- そのまま全員に読まれる。理由にあたるものは下の player_reports に残る。
alter table players add column if not exists banned_at timestamptz;
alter table players add column if not exists banned_by uuid references players(id) on delete set null;

create index if not exists players_banned_idx on players (id) where banned_at is not null;

-- ---------------------------------------------------------------------------
-- 2. 選手ページからの通報
-- ---------------------------------------------------------------------------

-- 誰が誰を、どんな理由で通報したか。
--
-- resolved_at が null のものが「まだ運営が見ていない通報」で、画面が数えるのも
-- 印を出すのもこれだけ。対応すると resolution に結末（'banned' か 'dismissed'）が入る。
--
-- 【消せない】GRANT に delete を与えていない。通報された側はもちろん、通報した
-- 本人にも取り消させない ── 「通報したことにして取り下げる」を繰り返せると、
-- 嫌がらせの道具になる。判断は運営が行い、却下（dismissed）として記録に残す。
create table if not exists player_reports (
  id          uuid primary key default gen_random_uuid(),
  -- 通報された選手
  target_id   uuid not null references players(id) on delete cascade,
  -- 通報した選手
  reporter_id uuid not null references players(id) on delete cascade,
  -- 分類。画面の選択肢と1対1で対応する（js/app.js の REPORT_REASONS）
  reason      text not null,
  -- 具体的な状況。任意だが、これが無い通報は運営が判断できないので画面では促す
  body        text,
  created_at  timestamptz not null default now(),
  -- 運営が見終えた時刻・見た運営・結末。null なら未対応（＝件数に数える）
  resolved_at timestamptz,
  resolved_by uuid references players(id) on delete set null,
  resolution  text,
  constraint player_reports_not_self check (target_id <> reporter_id),
  constraint player_reports_reason_check check (
    reason in ('harassment', 'cheating', 'impersonation', 'inappropriate', 'spam', 'other')
  ),
  constraint player_reports_body_length check (body is null or char_length(body) <= 500),
  constraint player_reports_resolution_check check (
    resolution is null or resolution in ('banned', 'dismissed')
  )
);

-- 【同じ人からの連投を1件に潰す】BANの判定は「何件届いたか」ではなく
-- 「何人から届いたか」で行う。1人が10回押しても1件にしかならないようにしておかないと、
-- 閾値の意味が無くなる。
--
-- 未対応のものだけを対象にしているのは、一度運営が見終えたあとの別件を
-- 通報できなくならないようにするため（却下されたら、また通報できる）。
create unique index if not exists player_reports_open_uniq
  on player_reports (target_id, reporter_id) where resolved_at is null;

-- 画面が見るのはほぼ「未対応の通報」だけなので、そこに絞る
create index if not exists player_reports_open_idx
  on player_reports (target_id) where resolved_at is null;

-- ---------------------------------------------------------------------------
-- 3. 判定用の関数
-- ---------------------------------------------------------------------------

-- BAN対象として運営の画面に並べる人数のしきい値。
--
-- 関数にしてあるのは、変えたくなったときに直す場所を1か所にするため
-- （画面側は js/state.js の BAN_THRESHOLD が同じ数を持つ。変えるときは両方）。
create or replace function player_ban_threshold()
  returns int
  language sql
  immutable
as $$
  select 3;
$$;

revoke all on function player_ban_threshold() from anon, public;
grant execute on function player_ban_threshold() to anon, authenticated;

-- いま操作している人が利用停止中か。
--
-- security definer なのは players の閲覧ポリシーを気にせず読むため。
-- 【anon への実行許可は必須】下で書き換えるポリシーのいくつかは anon にも
-- 適用され、その評価の中でこの関数を呼ぶ。実行権限が無いと0件ではなく42501で
-- 落ち、サイトが開けなくなる（migration-013・022 と同じ落とし穴）。
create or replace function is_banned()
  returns boolean
  language sql
  security definer
  stable
  set search_path = public
as $$
  select exists (
    select 1 from players p
    where p.user_id = auth.uid() and p.banned_at is not null
  );
$$;

revoke all on function is_banned() from anon, public;
grant execute on function is_banned() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. 権限とRLS
-- ---------------------------------------------------------------------------

-- Supabaseは新規テーブルに広い権限を自動で与えるので、まず剥がす。
revoke all on player_reports from anon, authenticated;

-- 通報はポリシー側で運営と本人に絞る。anon にも select を与えるのは、
-- ゲストの読み込み（js/db.js の loadAll）が権限エラーで止まらないようにするため
-- （ポリシーのどちらの条件も満たさないので、返るのは常に0件）。
grant select on player_reports to anon, authenticated;
grant insert on player_reports to authenticated;
-- update / delete は与えない。対応済みにするのは下のRPCからだけ。

alter table player_reports enable row level security;

-- 読めるのは運営と、自分が出した通報だけ。
-- 通報された本人には見せない ── 誰が通報したかが分かると報復の材料になる。
drop policy if exists player_reports_select on player_reports;
create policy player_reports_select on player_reports
  for select to anon, authenticated
  using (is_admin() or reporter_id = current_player_id());

-- 自分の名前でしか通報できない。自分自身は通報できない（制約でも止めている）。
-- 停止中の人は通報できない ── 止められた腹いせに通報を撒く経路を残さない。
drop policy if exists player_reports_insert on player_reports;
create policy player_reports_insert on player_reports
  for insert to authenticated
  with check (
    reporter_id = current_player_id()
    and target_id <> reporter_id
    and not is_banned()
  );

-- ---------------------------------------------------------------------------
-- 5. 停止中にできなくなること
--
-- 既存のポリシーに not is_banned() を足す。画面側でもボタンを隠すが、
-- あれは押せないものを見せないための便宜で、防御はここが持つ。
-- ---------------------------------------------------------------------------

-- 大会を作る
drop policy if exists tournaments_insert on tournaments;
create policy tournaments_insert on tournaments
  for insert to authenticated
  with check (current_player_id() is not null and not is_banned());

-- エントリーする（取り消しは止めない。停止された人が募集中の大会から自分で
-- 抜けられなくなると、運営が1件ずつ外して回ることになる）
drop policy if exists entries_insert on tournament_entries;
create policy entries_insert on tournament_entries
  for insert to authenticated
  with check (
    is_tournament_admin(tournament_id)
    or (
      player_id = current_player_id()
      and not is_banned()
      and exists (
        select 1 from tournaments t
        where t.id = tournament_id and t.status = 'recruiting'
      )
    )
  );

-- 対戦チャットに書き込む（読むのは止めない。運営とのやり取りの経緯は本人にも残す）
drop policy if exists chat_insert on match_chat_messages;
create policy chat_insert on match_chat_messages
  for insert to authenticated
  with check (
    player_id = current_player_id()
    and not is_banned()
    and can_use_match_chat(tournament_id, match_id)
    and (is_tournament_admin(tournament_id) or match_chat_is_open(tournament_id, match_id))
  );

-- プロフィールを編集する（名前・自己紹介・アイコンを差し替えて回れなくする）。
-- 運営は停止中の人のプロフィールも直せる ── 不適切な自己紹介やアイコンを
-- 消すのは、停止したあとにこそ必要になる。
drop policy if exists players_update on players;
create policy players_update on players
  for update to authenticated
  using ((user_id = auth.uid() and not is_banned()) or is_admin())
  with check ((user_id = auth.uid() and not is_banned()) or is_admin());

-- チーム戦のエントリーは security definer のRPC経由なのでRLSを通らない。
-- 関数の中で明示的に確かめる（申し込む本人も相方も、停止中なら組めない）。
--
-- 【本体は migration-011 のものと同じ】足したのは下に印を付けた2か所の判定だけ。
-- 定員の直列化（for update）・チーム名の重複・二重エントリーの確認は、
-- 落とすとその場では動いてしまうぶん事故に気づきにくいので、そのまま残す。
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

  -- ここから ↓ が 023 で足した判定
  if is_banned() then
    raise exception 'このアカウントは利用を停止されているため、エントリーできません。'
      using errcode = 'insufficient_privilege';
  end if;
  -- ここまで

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

  -- ここから ↓ が 023 で足した判定
  if exists (select 1 from players where id = any(v_members) and banned_at is not null) then
    raise exception '利用を停止されている選手とはチームを組めません。'
      using errcode = 'insufficient_privilege';
  end if;
  -- ここまで

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

revoke all on function enter_tournament_as_team(uuid, text, uuid[]) from anon, public;
grant execute on function enter_tournament_as_team(uuid, text, uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. 運営専用の操作（RPC）
-- ---------------------------------------------------------------------------

-- 利用停止のオン・オフ。
--
-- banned_at は列単位のGRANTから外してあるので、変更はここを通すしかない。
-- 停止しても解除しても、その人に届いていた未対応の通報はまとめて片付ける
-- （画面の「BAN対象」から消える。結末は resolution に残る）。
create or replace function admin_set_player_ban(target_player_id uuid, p_banned boolean)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_role text;
  v_me   uuid;
begin
  if not is_admin() then
    raise exception '運営権限が必要です。' using errcode = 'insufficient_privilege';
  end if;

  select role into v_role from players where id = target_player_id;
  if not found then
    raise exception '対象の選手が見つかりません。' using errcode = 'no_data_found';
  end if;

  -- 持ち主は誰にも止められない（止められると、解除できる人がいなくなる）
  if v_role = 'owner' then
    raise exception 'サイトの持ち主は利用停止にできません。' using errcode = 'insufficient_privilege';
  end if;
  -- 運営どうしで止め合えないようにする
  if v_role = 'admin' and not is_owner() then
    raise exception '運営を利用停止にできるのは、サイトの持ち主だけです。'
      using errcode = 'insufficient_privilege';
  end if;

  v_me := current_player_id();

  if p_banned then
    update players set banned_at = now(), banned_by = v_me where id = target_player_id;
  else
    update players set banned_at = null, banned_by = null where id = target_player_id;
  end if;

  update player_reports
     set resolved_at = now(),
         resolved_by = v_me,
         resolution = case when p_banned then 'banned' else 'dismissed' end
   where target_id = target_player_id and resolved_at is null;
end;
$$;

revoke all on function admin_set_player_ban(uuid, boolean) from anon, public;
grant execute on function admin_set_player_ban(uuid, boolean) to authenticated;

-- 通報を却下する（停止はしない）。見終えた印だけを付けて一覧から下ろす。
create or replace function admin_dismiss_player_reports(target_player_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  if not is_admin() then
    raise exception '運営権限が必要です。' using errcode = 'insufficient_privilege';
  end if;

  update player_reports
     set resolved_at = now(),
         resolved_by = current_player_id(),
         resolution = 'dismissed'
   where target_id = target_player_id and resolved_at is null;
end;
$$;

revoke all on function admin_dismiss_player_reports(uuid) from anon, public;
grant execute on function admin_dismiss_player_reports(uuid) to authenticated;

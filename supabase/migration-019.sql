-- ============================================================================
-- 差分適用スクリプト 019
--
-- 既に schema.sql（＋002〜018）を実行済みのプロジェクトに、あとから入った
-- 変更だけを当てる。Supabaseダッシュボードの SQL Editor に貼り付けて「Run」。
-- 何度実行しても同じ結果になる。
--
-- 新しくプロジェクトを作る場合はこれは不要（schema.sql に取り込み済み）。
--
-- 内容:
--   大会を「誰でも作れる」ようにし、権限を大会ごとに持たせる。
--
--   これまでは players.role が 'admin' の人だけが大会を作れて、作れる人は
--   同時にすべての大会を触れた。コミュニティの中で誰かが大会を開きたいたびに
--   サイト全体の運営権限を渡すことになり、権限の粒度が現実と合っていなかった。
--
--   そこで3段階にする。
--
--     owner  サイトの持ち主。1人だけ。ランキングの公開を握る
--     admin  サイト全体の運営。これまでどおり全大会を触れる
--     player 一般の選手。大会を作れる。作った大会（と運営に指名された大会）だけ触れる
--
--   大会ごとの運営は tournament_organizers で持つ。大会を作った人は
--   トリガで自動的にその大会の運営になるので、作ったあとすぐ編集できる。
--   ランキング（published_rankings）への書き込みは owner だけに絞る。
--
--   【owner を誰にするか】下の OWNER_EMAIL を、持ち主のログインに使っている
--   メールアドレスに書き換えてから実行すること。合致する選手が居なければ
--   何も起こらない（あとで手で
--     update players set role = 'owner' where id = '...';
--   としてもよい）。
--
--   【既存の大会】運営には owner だけを入れる。これまで admin だった人は
--   admin のまま全大会を触れるので、この時点で誰かが操作できなくなることはない。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. owner ロール
-- ---------------------------------------------------------------------------

alter table players drop constraint if exists players_role_check;
alter table players add constraint players_role_check
  check (role in ('player', 'admin', 'owner'));

-- サイトの持ち主か。ランキングの公開と、順位発表の画面だけがこれを見る。
create or replace function is_owner() returns boolean
  language sql
  security definer
  stable
  set search_path = public
as $$
  select exists (
    select 1 from players
    where user_id = auth.uid() and role = 'owner'
  );
$$;

-- サイト全体の運営か。owner も含む（持ち主が運営でないと、あらゆる画面から
-- 締め出されてしまう）。既存のポリシーはこの関数を呼んでいるので、
-- 意味が広がるだけで書き換えは要らない。
create or replace function is_admin() returns boolean
  language sql
  security definer
  stable
  set search_path = public
as $$
  select exists (
    select 1 from players
    where user_id = auth.uid() and role in ('admin', 'owner')
  );
$$;

-- 持ち主を決める。★ここを自分のメールアドレスに書き換えてから実行すること★
do $$
declare
  owner_email constant text := 'tomokkugyu@gmail.com';
begin
  update players p
     set role = 'owner'
    from auth.users u
   where u.id = p.user_id
     and lower(u.email) = lower(owner_email);
end $$;

-- ---------------------------------------------------------------------------
-- 2. 大会ごとの運営
-- ---------------------------------------------------------------------------

-- この大会を管理できる選手。大会を作った人はトリガで自動的に入る。
-- 誰が運営かは隠すものではないので、閲覧は全員に開ける（大会ページに出す）。
create table if not exists tournament_organizers (
  tournament_id uuid not null references tournaments(id) on delete cascade,
  player_id     uuid not null references players(id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (tournament_id, player_id)
);

alter table tournament_organizers enable row level security;
grant select on tournament_organizers to anon, authenticated;
grant insert, delete on tournament_organizers to authenticated;

-- この大会を管理できるか。サイト全体の運営（admin / owner）か、
-- この大会の運営に名前が入っているか。
--
-- security definer にしてあるのは、これを呼ぶポリシー自身が
-- tournament_organizers の読み取りポリシーに引っかからないようにするため。
create or replace function is_tournament_admin(p_tournament_id uuid)
  returns boolean
  language sql
  security definer
  stable
  set search_path = public
as $$
  select is_admin() or exists (
    select 1 from tournament_organizers o
    where o.tournament_id = p_tournament_id
      and o.player_id = current_player_id()
  );
$$;

drop policy if exists organizers_select on tournament_organizers;
create policy organizers_select on tournament_organizers
  for select to anon, authenticated
  using (true);

-- 運営の付け外しができるのは、その大会の運営自身とサイト全体の運営。
drop policy if exists organizers_write on tournament_organizers;
create policy organizers_write on tournament_organizers
  for all to authenticated
  using (is_tournament_admin(tournament_id))
  with check (is_tournament_admin(tournament_id));

-- 作った人を必ずその大会の運営にする。
--
-- クライアントから2回に分けて書くと、大会だけ出来て運営が入らない状態が
-- 起こりうる（通信が途中で切れた、など）。そうなると作った本人が自分の大会を
-- 編集できなくなるので、DB側で必ず同じトランザクションに入れる。
create or replace function tournaments_add_creator_organizer()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_me uuid;
begin
  v_me := current_player_id();
  if v_me is not null then
    insert into tournament_organizers (tournament_id, player_id)
      values (new.id, v_me)
      on conflict do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists tournaments_creator_organizer on tournaments;
create trigger tournaments_creator_organizer
  after insert on tournaments
  for each row execute function tournaments_add_creator_organizer();

-- 既存の大会の運営は owner だけにする（admin はロールのまま全大会を触れる）。
insert into tournament_organizers (tournament_id, player_id)
select t.id, p.id
  from tournaments t
 cross join players p
 where p.role = 'owner'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 3. 大会の作成を全員に開き、更新・削除はその大会の運営に絞る
-- ---------------------------------------------------------------------------

drop policy if exists tournaments_write on tournaments;

-- 選手登録さえ済んでいれば誰でも大会を作れる。
drop policy if exists tournaments_insert on tournaments;
create policy tournaments_insert on tournaments
  for insert to authenticated
  with check (current_player_id() is not null);

drop policy if exists tournaments_update on tournaments;
create policy tournaments_update on tournaments
  for update to authenticated
  using (is_tournament_admin(id))
  with check (is_tournament_admin(id));

drop policy if exists tournaments_delete on tournaments;
create policy tournaments_delete on tournaments
  for delete to authenticated
  using (is_tournament_admin(id));

-- ---------------------------------------------------------------------------
-- 4. 大会にぶら下がるものを、大会ごとの運営で判定し直す
--
-- 「サイト全体の運営か」から「この大会の運営か」へ差し替えるだけで、
-- 条件の形は変えていない（admin は is_tournament_admin の中に含まれる）。
-- ---------------------------------------------------------------------------

drop policy if exists teams_write on tournament_teams;
create policy teams_write on tournament_teams
  for all to authenticated
  using (is_tournament_admin(tournament_id))
  with check (is_tournament_admin(tournament_id));

drop policy if exists entries_insert on tournament_entries;
create policy entries_insert on tournament_entries
  for insert to authenticated
  with check (
    is_tournament_admin(tournament_id)
    or (
      player_id = current_player_id()
      and exists (
        select 1 from tournaments t
        where t.id = tournament_id and t.status = 'recruiting'
      )
    )
  );

drop policy if exists entries_delete on tournament_entries;
create policy entries_delete on tournament_entries
  for delete to authenticated
  using (
    is_tournament_admin(tournament_id)
    or (
      player_id = current_player_id()
      and exists (
        select 1 from tournaments t
        where t.id = tournament_id and t.status = 'recruiting'
      )
    )
  );

drop policy if exists entries_update on tournament_entries;
create policy entries_update on tournament_entries
  for update to authenticated
  using (is_tournament_admin(tournament_id))
  with check (is_tournament_admin(tournament_id));

drop policy if exists brackets_write on brackets;
create policy brackets_write on brackets
  for all to authenticated
  using (is_tournament_admin(tournament_id))
  with check (is_tournament_admin(tournament_id));

drop policy if exists matches_write on matches;
create policy matches_write on matches
  for all to authenticated
  using (is_tournament_admin(tournament_id))
  with check (is_tournament_admin(tournament_id));

drop policy if exists rounds_write on tournament_rounds;
create policy rounds_write on tournament_rounds
  for all to authenticated
  using (is_tournament_admin(tournament_id))
  with check (is_tournament_admin(tournament_id));

drop policy if exists chat_insert on match_chat_messages;
create policy chat_insert on match_chat_messages
  for insert to authenticated
  with check (
    player_id = current_player_id()
    and can_use_match_chat(tournament_id, match_id)
    and (is_tournament_admin(tournament_id) or match_chat_is_open(tournament_id, match_id))
  );

drop policy if exists chat_delete on match_chat_messages;
create policy chat_delete on match_chat_messages
  for delete to authenticated
  using (is_tournament_admin(tournament_id));

drop policy if exists reports_select on match_chat_reports;
create policy reports_select on match_chat_reports
  for select to anon, authenticated
  using (is_tournament_admin(tournament_id) or reporter_id = current_player_id());

drop policy if exists reports_update on match_chat_reports;
create policy reports_update on match_chat_reports
  for update to authenticated
  using (is_tournament_admin(tournament_id))
  with check (is_tournament_admin(tournament_id));

-- 対戦の当事者判定。運営が他人の対戦を覗けるのも、その大会の運営に限る。
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
      is_tournament_admin(p_tournament_id)
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

revoke all on function is_owner()                from anon, public;
revoke all on function is_tournament_admin(uuid) from anon, public;
grant execute on function is_owner() to authenticated;
-- is_match_participant と同じ理由で anon にも渡す。tournament_organizers と
-- match_room_codes の select ポリシーは anon にも適用され、その中でこの関数を
-- 呼ぶため、実行権限が無いとゲストの読み込み自体が42501で失敗する。
grant execute on function is_tournament_admin(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. ランキングの公開は持ち主だけ
-- ---------------------------------------------------------------------------

drop policy if exists rankings_write on published_rankings;
create policy rankings_write on published_rankings
  for all to authenticated
  using (is_owner())
  with check (is_owner());

-- ---------------------------------------------------------------------------
-- 6. 権限の付け外し
--
-- owner を作れるのは owner だけ。admin が admin を増やせるのはこれまでどおりだが、
-- owner の行には触れない（持ち主の権限を運営に降ろされないようにする）。
-- ---------------------------------------------------------------------------

create or replace function admin_set_player_role(target_player_id uuid, new_role text)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_current text;
begin
  if not is_admin() then
    raise exception '運営権限が必要です。' using errcode = 'insufficient_privilege';
  end if;
  if new_role not in ('player', 'admin', 'owner') then
    raise exception '不正な権限です: %', new_role using errcode = 'check_violation';
  end if;

  select role into v_current from players where id = target_player_id;
  if not found then
    raise exception '対象の選手が見つかりません。' using errcode = 'no_data_found';
  end if;

  if (new_role = 'owner' or v_current = 'owner') and not is_owner() then
    raise exception 'サイトの持ち主の権限は、持ち主にしか変更できません。'
      using errcode = 'insufficient_privilege';
  end if;

  update players set role = new_role where id = target_player_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. チームのエントリー取り消し（RPC）を大会ごとの運営で判定し直す
-- ---------------------------------------------------------------------------

create or replace function cancel_team_entry(p_team_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_me     uuid;
  v_tid    uuid;
  v_status text;
begin
  select tournament_id into v_tid from tournament_teams where id = p_team_id;
  if not found then
    raise exception 'チームが見つかりません。' using errcode = 'no_data_found';
  end if;

  select status into v_status from tournaments where id = v_tid for update;

  if not is_tournament_admin(v_tid) then
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

-- ---------------------------------------------------------------------------
-- 8. 大会の画像
--
-- 大会を誰でも作れるようになった以上、大会画像も誰でも上げられないと作れない。
-- ただし差し替え・削除は運営のままにする ── 開けてしまうと、他人が上げた画像を
-- 消せることになる（使われなくなった画像が消せずに残ることはあるが、
-- 実害は容量だけで、間違って消える事故のほうが取り返しがつかない）。
-- ---------------------------------------------------------------------------

drop policy if exists images_admin_insert on storage.objects;
create policy images_admin_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'images' and current_player_id() is not null);

-- ---------------------------------------------------------------------------
-- 9. Realtime
-- ---------------------------------------------------------------------------

do $$
begin
  execute 'alter publication supabase_realtime add table tournament_organizers';
exception when duplicate_object then null;
end $$;

-- ============================================================================
-- トーナメント運営＆ランキングサイト データベーススキーマ
--
-- Supabaseダッシュボードの SQL Editor に貼り付けて実行する。
-- 何度実行しても同じ結果になるよう、可能な範囲で冪等に書いている。
--
-- 設計の要点:
--   * 選手 = ユーザーアカウント。players.user_id が auth.users を指す。
--     user_id が null の行は運営が代理登録した選手（移行してきた既存26人）。
--   * 閲覧は認証不要（anonロールにSELECTを与える）。書き込みだけRLSで絞る。
--   * ブラケットは既存のJS実装が扱うオブジェクト構造をそのままJSONBで保持し、
--     js/bracket.js / js/bracketView.js を書き換えずに済ませる。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- テーブル
-- ---------------------------------------------------------------------------

create table if not exists players (
  id              uuid primary key default gen_random_uuid(),
  -- 本人のアカウント。null = 運営が代理登録した選手（本人がまだ紐付いていない）
  user_id         uuid unique references auth.users(id) on delete set null,
  display_name    text not null,
  -- 名前を変更したときの旧名。戦績はidに紐づくので名前が変わっても分断されない
  past_names      text[] not null default '{}',
  -- プロフィール表示用。本人が自由に記入・変更できる（主キーではない）
  game_account_id text,
  bio             text,
  -- アイコン画像。Storageの avatars バケットに置いた公開URLを入れる
  avatar_url      text,
  main_characters text[] not null default '{}',
  sns_x           text,
  sns_twitch      text,
  sns_youtube     text,
  role            text not null default 'player',
  created_at      timestamptz not null default now(),
  constraint players_role_check check (role in ('player', 'admin')),
  constraint players_display_name_not_blank check (btrim(display_name) <> '')
);

create table if not exists tournaments (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  date       date,
  format     text not null default 'single_elim',
  rules      text,
  -- 大会のバナー画像。Storageの images バケットに置いた公開URL
  image_url  text,
  -- draft(準備中) → recruiting(募集中) → running(進行中) → finished(終了)
  status     text not null default 'draft',
  capacity   int,
  -- 大会規模の重み。null なら参加人数から自動算出（js/ranking.js）
  weight     numeric,
  created_by uuid references players(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint tournaments_status_check check (status in ('draft', 'recruiting', 'running', 'finished')),
  constraint tournaments_format_check check (format in ('single_elim', 'double_elim', 'round_robin')),
  constraint tournaments_capacity_check check (capacity is null or capacity >= 2),
  constraint tournaments_name_not_blank check (btrim(name) <> '')
);

-- 大会へのエントリー（募集ページの「エントリー」ボタン）
create table if not exists tournament_entries (
  tournament_id uuid not null references tournaments(id) on delete cascade,
  player_id     uuid not null references players(id) on delete cascade,
  -- 募集締切後に確定するシード順（1 = 第1シード）。締切前は null
  seed          int,
  -- 確定した成績を「勝ち上がりの深さ」で持つ。優勝=1、準優勝=2、ベスト4=4 …
  -- 小さいほど上位。null は未確定（進行中、または結果を確定していない大会）。
  --
  -- ブラケットのJSONから毎回計算することもできるが、それだと選手ページを開くだけで
  -- 全大会の対戦表を読む必要があり、通信量の大半をブラケットが占めてしまう。
  placement     int,
  entered_at    timestamptz not null default now(),
  primary key (tournament_id, player_id)
);

create table if not exists brackets (
  tournament_id uuid primary key references tournaments(id) on delete cascade,
  data          jsonb not null,
  updated_at    timestamptz not null default now()
);

create table if not exists matches (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id) on delete cascade,
  winner_id     uuid not null references players(id) on delete restrict,
  loser_id      uuid not null references players(id) on delete restrict,
  score         text,
  round         text not null,
  constraint matches_distinct_players check (winner_id <> loser_id)
);

-- 運営が「公開する」を押した瞬間のランキングのスナップショット。
-- 常時計算するスコアは保存しないという設計原則（doc/design.md 6章）を維持する。
create table if not exists published_rankings (
  id            uuid primary key default gen_random_uuid(),
  published_at  timestamptz not null default now(),
  period_months int,
  data          jsonb not null
);

-- ホーム画面に出す運営からのお知らせ。運営だけが投稿・編集・削除できる。
-- pinned を先頭に、あとは新しい順で並べる。
create table if not exists announcements (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text not null default '',
  -- お知らせに添える画像。Storageの images バケットに置いた公開URL
  image_url   text,
  pinned      boolean not null default false,
  created_by  uuid references players(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint announcements_title_not_blank check (btrim(title) <> '')
);

create index if not exists matches_tournament_idx on matches (tournament_id);
create index if not exists matches_winner_idx     on matches (winner_id);
create index if not exists matches_loser_idx      on matches (loser_id);
create index if not exists entries_player_idx     on tournament_entries (player_id);
create index if not exists tournaments_status_idx on tournaments (status);
create index if not exists rankings_published_idx on published_rankings (published_at desc);
create index if not exists announcements_order_idx on announcements (pinned desc, created_at desc);

-- ---------------------------------------------------------------------------
-- 管理者判定
--
-- playersに対するポリシーの中でplayersを普通にSELECTすると、そのSELECT自体が
-- 再びポリシー評価を呼んで無限再帰になる。security definer関数は所有者権限で
-- 実行されRLSを迂回するため、この再帰を断ち切れる。
-- search_pathを固定するのは、呼び出し側の検索パスを差し替えて別のplayersテーブルを
-- 参照させる攻撃を防ぐため。
-- ---------------------------------------------------------------------------

create or replace function is_admin() returns boolean
  language sql
  security definer
  stable
  set search_path = public
as $$
  select exists (
    select 1 from players
    where user_id = auth.uid() and role = 'admin'
  );
$$;

-- 呼び出し元の選手行のid（未登録ならnull）。ポリシーとクライアントの両方から使う。
create or replace function current_player_id() returns uuid
  language sql
  security definer
  stable
  set search_path = public
as $$
  select id from players where user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- 定員の強制
--
-- クライアント側で「残り枠があるか」を確認してからINSERTする方式は、2人が同時に
-- 押したときに両方とも通ってしまう。大会行をFOR UPDATEでロックしてから数えることで、
-- 同じ大会へのエントリーを直列化して超過を防ぐ。
--
-- 行単位のBEFORE INSERTではなく「文単位のAFTER INSERT」で、挿入後の最終人数を見る。
-- 行単位だと次の2つの問題があった:
--   1. 締切時にシード順を upsert（INSERT ... ON CONFLICT）で書き戻すと、
--      既存行の更新であってもINSERTトリガーが発火し、定員ちょうどまで埋まった大会が
--      「定員に達しています」で締め切れなくなる。
--   2. 行単位トリガーから見た count(*) には、同じINSERT文で挿入中の行が含まれない。
--      そのため一括挿入では全行が「まだ0人」と判定され、定員が素通りしていた。
-- AFTER INSERT の遷移テーブルなら、何行まとめて入っても最終状態だけを1回検査できる。
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
      select count(*) into cnt from tournament_entries where tournament_id = rec.tournament_id;
      if cnt > cap then
        raise exception 'この大会は定員（%人）に達しています。', cap using errcode = 'check_violation';
      end if;
    end if;
  end loop;

  return null;
end;
$$;

drop trigger if exists entries_capacity_trigger on tournament_entries;
create trigger entries_capacity_trigger
  after insert on tournament_entries
  referencing new table as new_entries
  for each statement execute function enforce_entry_capacity();

create or replace function touch_bracket_updated_at() returns trigger
  language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists brackets_touch_trigger on brackets;
create trigger brackets_touch_trigger
  before update on brackets
  for each row execute function touch_bracket_updated_at();

drop trigger if exists announcements_touch_trigger on announcements;
create trigger announcements_touch_trigger
  before update on announcements
  for each row execute function touch_bracket_updated_at();

-- ---------------------------------------------------------------------------
-- 権限（列単位）
--
-- Supabaseは新規テーブルにanon/authenticatedへの広い権限を自動で与えるので、
-- まず全部剥がしてから必要なものだけ戻す。
--
-- playersのUPDATEを列単位で絞るのが要点。roleとuser_idを更新可能列から外すことで、
-- 一般ユーザーが自分をadminに昇格させたり、他人のアカウントを自分の行に
-- 付け替えたりできなくなる。RLSポリシーは「どの行か」しか制御できず、
-- 「どの列か」は制御できないため、この2段構えが必要になる。
-- 特権的な変更は下部のRPC関数からのみ行う。
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;

-- 閲覧は全員（ログアウト状態のゲストを含む）
grant select on players, tournaments, tournament_entries, brackets, matches, published_rankings, announcements
  to anon, authenticated;

-- 選手行の作成。idとroleは指定させない（roleは既定値'player'が入る）
grant insert (user_id, display_name, past_names, game_account_id, bio, avatar_url,
              main_characters, sns_x, sns_twitch, sns_youtube)
  on players to authenticated;

-- プロフィールの編集。roleとuser_idは意図的に含めない
grant update (display_name, past_names, game_account_id, bio, avatar_url,
              main_characters, sns_x, sns_twitch, sns_youtube)
  on players to authenticated;

grant delete on players to authenticated;

grant insert, update, delete on tournaments, tournament_entries, brackets, matches, published_rankings, announcements
  to authenticated;

-- ---------------------------------------------------------------------------
-- 行レベルセキュリティ
-- ---------------------------------------------------------------------------

alter table players             enable row level security;
alter table tournaments         enable row level security;
alter table tournament_entries  enable row level security;
alter table brackets            enable row level security;
alter table matches             enable row level security;
alter table published_rankings  enable row level security;
alter table announcements       enable row level security;

-- ---- players ----

drop policy if exists players_select on players;
create policy players_select on players
  for select to anon, authenticated
  using (true);

-- 自分のアカウントに紐づく行だけ作れる。運営は代理登録もできる（user_id = null）
drop policy if exists players_insert on players;
create policy players_insert on players
  for insert to authenticated
  with check (user_id = auth.uid() or is_admin());

-- 自分の行、または運営なら全行。更新できる「列」は上のGRANTで絞ってある
drop policy if exists players_update on players;
create policy players_update on players
  for update to authenticated
  using (user_id = auth.uid() or is_admin())
  with check (user_id = auth.uid() or is_admin());

drop policy if exists players_delete on players;
create policy players_delete on players
  for delete to authenticated
  using (is_admin());

-- ---- tournaments ----

drop policy if exists tournaments_select on tournaments;
create policy tournaments_select on tournaments
  for select to anon, authenticated
  using (true);

drop policy if exists tournaments_write on tournaments;
create policy tournaments_write on tournaments
  for all to authenticated
  using (is_admin())
  with check (is_admin());

-- ---- tournament_entries ----

drop policy if exists entries_select on tournament_entries;
create policy entries_select on tournament_entries
  for select to anon, authenticated
  using (true);

-- 自分の選手行で、募集中の大会にだけエントリーできる
drop policy if exists entries_insert on tournament_entries;
create policy entries_insert on tournament_entries
  for insert to authenticated
  with check (
    is_admin()
    or (
      player_id = current_player_id()
      and exists (
        select 1 from tournaments t
        where t.id = tournament_id and t.status = 'recruiting'
      )
    )
  );

-- 取り消せるのは募集中の間だけ（組み合わせが決まった後に抜けられると困る）
drop policy if exists entries_delete on tournament_entries;
create policy entries_delete on tournament_entries
  for delete to authenticated
  using (
    is_admin()
    or (
      player_id = current_player_id()
      and exists (
        select 1 from tournaments t
        where t.id = tournament_id and t.status = 'recruiting'
      )
    )
  );

-- シードの設定は運営のみ
drop policy if exists entries_update on tournament_entries;
create policy entries_update on tournament_entries
  for update to authenticated
  using (is_admin())
  with check (is_admin());

-- ---- brackets / matches / published_rankings ----

drop policy if exists brackets_select on brackets;
create policy brackets_select on brackets
  for select to anon, authenticated using (true);

drop policy if exists brackets_write on brackets;
create policy brackets_write on brackets
  for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists matches_select on matches;
create policy matches_select on matches
  for select to anon, authenticated using (true);

drop policy if exists matches_write on matches;
create policy matches_write on matches
  for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists rankings_select on published_rankings;
create policy rankings_select on published_rankings
  for select to anon, authenticated using (true);

drop policy if exists rankings_write on published_rankings;
create policy rankings_write on published_rankings
  for all to authenticated using (is_admin()) with check (is_admin());

-- ---- announcements ----

drop policy if exists announcements_select on announcements;
create policy announcements_select on announcements
  for select to anon, authenticated using (true);

drop policy if exists announcements_write on announcements;
create policy announcements_write on announcements
  for all to authenticated using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------------
-- 運営専用の操作（RPC）
--
-- roleとuser_idはGRANTで更新不可にしてあるため、変更はここを通す。
-- 関数内で is_admin() を確認するので、一般ユーザーが呼んでも失敗する。
-- ---------------------------------------------------------------------------

-- 運営権限の付与・剥奪
create or replace function admin_set_player_role(target_player_id uuid, new_role text)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  if not is_admin() then
    raise exception '運営権限が必要です。' using errcode = 'insufficient_privilege';
  end if;
  if new_role not in ('player', 'admin') then
    raise exception '不正な権限です: %', new_role using errcode = 'check_violation';
  end if;

  update players set role = new_role where id = target_player_id;
end;
$$;

-- 既存選手（代理登録された行）に本人のアカウントを対応付ける。
-- 移行してきた26人の初回だけ必要になる操作。
create or replace function admin_link_player_account(target_player_id uuid, target_user_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  if not is_admin() then
    raise exception '運営権限が必要です。' using errcode = 'insufficient_privilege';
  end if;

  -- user_idはUNIQUEなので、同じアカウントが他の行を掴んでいたら先に外す
  update players set user_id = null
    where user_id = target_user_id and id <> target_player_id;

  update players set user_id = target_user_id where id = target_player_id;
end;
$$;

-- 本人が先に新規登録してしまい、過去の戦績を持つ古い行と二重になった場合の統合。
-- 新しい行(source)のアカウントとプロフィールを古い行(target)へ移し、新しい行を消す。
-- 戦績を失わないよう、sourceに試合記録がある場合は中断する。
create or replace function admin_merge_players(source_player_id uuid, target_player_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  src players%rowtype;
begin
  if not is_admin() then
    raise exception '運営権限が必要です。' using errcode = 'insufficient_privilege';
  end if;
  if source_player_id = target_player_id then
    raise exception '統合元と統合先が同じです。' using errcode = 'check_violation';
  end if;

  select * into src from players where id = source_player_id;
  if not found then
    raise exception '統合元の選手が見つかりません。' using errcode = 'no_data_found';
  end if;

  if exists (select 1 from matches where winner_id = source_player_id or loser_id = source_player_id) then
    raise exception '統合元に試合記録があるため統合できません。戦績が失われます。' using errcode = 'check_violation';
  end if;

  delete from tournament_entries where player_id = source_player_id;
  delete from players where id = source_player_id;

  update players set
    user_id         = src.user_id,
    game_account_id = coalesce(src.game_account_id, game_account_id),
    bio             = coalesce(src.bio, bio),
    main_characters = case when array_length(src.main_characters, 1) is null
                           then main_characters else src.main_characters end,
    sns_x           = coalesce(src.sns_x, sns_x),
    sns_twitch      = coalesce(src.sns_twitch, sns_twitch),
    sns_youtube     = coalesce(src.sns_youtube, sns_youtube)
  where id = target_player_id;
end;
$$;

-- 認証済みユーザーだけがRPCを呼べるようにする
revoke all on function admin_set_player_role(uuid, text)   from anon, public;
revoke all on function admin_link_player_account(uuid, uuid) from anon, public;
revoke all on function admin_merge_players(uuid, uuid)     from anon, public;
grant execute on function admin_set_player_role(uuid, text)   to authenticated;
grant execute on function admin_link_player_account(uuid, uuid) to authenticated;
grant execute on function admin_merge_players(uuid, uuid)     to authenticated;

-- ---------------------------------------------------------------------------
-- アイコン画像の保管場所（Storage）
--
-- 誰でも見られる（公開バケット）が、書き込めるのは自分のフォルダだけ。
-- ファイルは avatars/{自分のuser_id}/{ファイル名} に置く決まりにして、
-- 先頭フォルダ名が自分のIDと一致するかどうかで他人の画像の差し替えを防ぐ。
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars', 'avatars', true, 2097152,
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public = true,
  file_size_limit = 2097152,
  allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

drop policy if exists avatars_public_read on storage.objects;
create policy avatars_public_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'avatars');

drop policy if exists avatars_own_insert on storage.objects;
create policy avatars_own_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists avatars_own_update on storage.objects;
create policy avatars_own_update on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists avatars_own_delete on storage.objects;
create policy avatars_own_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------------------
-- 大会・お知らせの画像の保管場所（Storage）
--
-- 誰でも見られる（公開バケット）が、書き込めるのは運営だけ。
-- アイコンと違って本人フォルダの制約は不要なので、is_admin() で判定する。
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'images', 'images', true, 5242880,
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public = true,
  file_size_limit = 5242880,
  allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

drop policy if exists images_public_read on storage.objects;
create policy images_public_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'images');

drop policy if exists images_admin_insert on storage.objects;
create policy images_admin_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'images' and is_admin());

drop policy if exists images_admin_update on storage.objects;
create policy images_admin_update on storage.objects
  for update to authenticated
  using (bucket_id = 'images' and is_admin())
  with check (bucket_id = 'images' and is_admin());

drop policy if exists images_admin_delete on storage.objects;
create policy images_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'images' and is_admin());

-- ---------------------------------------------------------------------------
-- Realtime
--
-- 進行中の大会を見ている観戦者の画面へ変更をプッシュする（10秒ポーリングの置換）。
-- ---------------------------------------------------------------------------

-- Supabaseは supabase_realtime パブリケーションを既定で用意しているが、
-- 消えている環境でも下の add table が失敗しないよう先に確認しておく。
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

do $$
begin
  execute 'alter publication supabase_realtime add table matches';
exception when duplicate_object then null;
end $$;

do $$
begin
  execute 'alter publication supabase_realtime add table brackets';
exception when duplicate_object then null;
end $$;

do $$
begin
  execute 'alter publication supabase_realtime add table tournaments';
exception when duplicate_object then null;
end $$;

do $$
begin
  execute 'alter publication supabase_realtime add table tournament_entries';
exception when duplicate_object then null;
end $$;

do $$
begin
  execute 'alter publication supabase_realtime add table players';
exception when duplicate_object then null;
end $$;

do $$
begin
  execute 'alter publication supabase_realtime add table published_rankings';
exception when duplicate_object then null;
end $$;

do $$
begin
  execute 'alter publication supabase_realtime add table announcements';
exception when duplicate_object then null;
end $$;

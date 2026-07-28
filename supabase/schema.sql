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
  -- 対戦方法。'1v1' / 'relay' はランキング反映の対象、'2v2' / 'other' は対象外
  -- （条件は js/rankingEligibility.js）。null はこの列より前に作られた大会で、対象外扱い。
  match_type      text,
  -- match_type = 'other' のときだけ意味を持つ、運営が書いた対戦方法の説明
  match_type_note text,
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
  constraint tournaments_match_type_check check (match_type is null or match_type in ('1v1', 'relay', '2v2', 'other')),
  constraint tournaments_capacity_check check (capacity is null or capacity >= 2),
  constraint tournaments_name_not_blank check (btrim(name) <> '')
);

-- 2v2（チーム戦）の大会でブラケットの枠に入る単位。
--
-- 個人戦では「出場枠＝選手」だが、チーム戦では「出場枠＝チーム」になる。
-- チームIDもuuidなので、brackets のJSON構造（player1Id / player2Id）は変えなくてよい。
-- 入っているIDが選手かチームかは、大会の match_type で決まる。
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

-- 大会へのエントリー（募集ページの「エントリー」ボタン）
create table if not exists tournament_entries (
  tournament_id uuid not null references tournaments(id) on delete cascade,
  player_id     uuid not null references players(id) on delete cascade,
  -- チーム戦のとき、この選手が属するチーム。個人戦では null。
  -- 同じチームの2人が同じ team_id を共有する。主キー (tournament_id, player_id) が
  -- 「1人が同じ大会で2チームに入る」を自動的に防ぐ。
  team_id       uuid references tournament_teams(id) on delete cascade,
  -- 募集締切後に確定するシード順（1 = 第1シード）。締切前は null。
  -- チーム大会では tournament_teams.seed を使うのでこちらは null のまま
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

-- 確定した試合。個人戦は winner_id / loser_id、チーム戦は winner_team_id /
-- loser_team_id が入り、制約でどちらか一方だけを許す。
--
-- 別テーブルに分けると「1大会の試合は matches を見れば分かる」性質が崩れ、
-- js/db.js の syncTournamentProgress の照合が二重になるので、同じテーブルに置く。
--
-- チーム戦の行は winner_id が null になるため、js/playerStats.js の
-- 「自分が勝者か敗者か」の絞り込みに引っかからない。これで2v2の勝敗は個人の
-- 通算成績（W-L）に混ざらない（個人ランキングが2v2を除外しているのと揃える）。
create table if not exists matches (
  id             uuid primary key default gen_random_uuid(),
  tournament_id  uuid not null references tournaments(id) on delete cascade,
  winner_id      uuid references players(id) on delete restrict,
  loser_id       uuid references players(id) on delete restrict,
  winner_team_id uuid references tournament_teams(id) on delete cascade,
  loser_team_id  uuid references tournament_teams(id) on delete cascade,
  score          text,
  round          text not null,
  -- 列がnullのとき check は NULL（＝通過）になるので、使っていない側の組は素通りする。
  -- ここを `is distinct from` にすると null 同士がfalseと評価され、全行が弾かれる。
  constraint matches_distinct_players check (winner_id <> loser_id),
  constraint matches_distinct_teams check (winner_team_id <> loser_team_id),
  constraint matches_entrant_check check (
    (winner_id is not null and loser_id is not null
     and winner_team_id is null and loser_team_id is null)
    or
    (winner_team_id is not null and loser_team_id is not null
     and winner_id is null and loser_id is null)
  )
);

-- 対戦カードごとのチャット。部屋はブラケットの試合1つにつき1つで、読み書きできるのは
-- その試合の当事者と運営だけ（閲覧が全員に開いている他のテーブルとはここが違う）。
-- 同じ相手でもラウンドが違えば別の部屋になる。
--
-- 誰がどの部屋に入れるかは、参加者をここへコピーせず、そのつどブラケットのJSONを
-- 読んで判定する（下の can_use_match_chat）。コピーを持つと、参加者の入れ替えや
-- 連鎖的な結果の取り消しでブラケットだけが変わり、2つの情報がずれるため。
create table if not exists match_chat_messages (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id) on delete cascade,
  -- ブラケットのJSON内の試合ID。matches テーブルには確定した試合しか無いので
  -- 外部キーは張れない（チャットは試合前から使うため、こちらが先に存在する）
  match_id      uuid not null,
  player_id     uuid not null references players(id) on delete cascade,
  body          text not null,
  created_at    timestamptz not null default now(),
  constraint chat_body_not_blank check (btrim(body) <> ''),
  constraint chat_body_length check (char_length(body) <= 500)
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
create index if not exists matches_winner_team_idx on matches (winner_team_id);
create index if not exists matches_loser_team_idx  on matches (loser_team_id);
create index if not exists entries_player_idx     on tournament_entries (player_id);
create index if not exists entries_team_idx       on tournament_entries (team_id);
create index if not exists teams_tournament_idx   on tournament_teams (tournament_id);
create index if not exists chat_room_idx          on match_chat_messages (tournament_id, match_id, created_at);
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
-- 対戦カードごとのチャットの参加資格
--
-- ブラケットはJSONBなので、ポリシーから「この試合に出ているのは誰か」を引くには
-- JSONを辿る必要がある。取り出しをここに切り出して、ポリシー側を短く保つ。
-- ---------------------------------------------------------------------------

create or replace function bracket_match(p_tournament_id uuid, p_match_id uuid)
  returns jsonb
  language sql
  security definer
  stable
  set search_path = public
as $$
  select m
  from brackets b,
       jsonb_array_elements(b.data->'rounds') as r,
       jsonb_array_elements(r->'matches') as m
  where b.tournament_id = p_tournament_id
    and m->>'id' = p_match_id::text
  limit 1;
$$;

-- その試合のチャットに入れるか。当事者か運営なら true。
--
-- 当事者の判定は「出場枠」で行う。tournament_entries の coalesce(team_id, player_id) が
-- ブラケットのスロットに入っているIDなので、個人戦でもチーム戦でも同じ式で済む
-- （チーム戦ではメンバー全員が同じ部屋に入る）。
--
-- 両方の枠が埋まっていることを運営にも求めるのは、相手のいない部屋を作らせないため。
-- BYE・対戦カード未確定の試合、そして存在しない match_id はこの条件で落ちる。
create or replace function can_use_match_chat(p_tournament_id uuid, p_match_id uuid)
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

-- 書き込みを受け付ける状態か。勝敗が確定した試合は読むだけにする
-- （直前のやりとりを見返してスコアの行き違いを確かめられるよう、閲覧は残す）。
create or replace function match_chat_is_open(p_tournament_id uuid, p_match_id uuid)
  returns boolean
  language sql
  security definer
  stable
  set search_path = public
as $$
  select coalesce((bracket_match(p_tournament_id, p_match_id)->>'confirmed')::boolean, false) = false;
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
--
-- チーム大会の定員は「チーム数」で数える。行をそのまま数えると16チーム32人が
-- 定員16に対して32と判定され、正しいエントリーが弾かれてしまう。
-- coalesce(team_id, player_id) なら、個人戦は人数・チーム戦はチーム数になる。
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
grant select on players, tournaments, tournament_teams, tournament_entries, brackets, matches, published_rankings, announcements
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

grant insert, update, delete on tournaments, tournament_teams, tournament_entries, brackets, matches, published_rankings, announcements
  to authenticated;

-- 対戦カードのチャットだけは anon に何も与えない（当事者と運営に閉じる）
grant select, insert, delete on match_chat_messages to authenticated;

-- ---------------------------------------------------------------------------
-- 行レベルセキュリティ
-- ---------------------------------------------------------------------------

alter table players             enable row level security;
alter table tournaments         enable row level security;
alter table tournament_teams    enable row level security;
alter table tournament_entries  enable row level security;
alter table brackets            enable row level security;
alter table matches             enable row level security;
alter table published_rankings  enable row level security;
alter table announcements       enable row level security;
alter table match_chat_messages enable row level security;

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

-- ---- tournament_teams ----

drop policy if exists teams_select on tournament_teams;
create policy teams_select on tournament_teams
  for select to anon, authenticated
  using (true);

-- 一般ユーザーの経路は下のRPC（enter_tournament_as_team / cancel_team_entry）に
-- 限定する。RPCは security definer なのでRLSを通らない。直接の書き込みは運営だけ。
drop policy if exists teams_write on tournament_teams;
create policy teams_write on tournament_teams
  for all to authenticated
  using (is_admin())
  with check (is_admin());

-- ---- tournament_entries ----

drop policy if exists entries_select on tournament_entries;
create policy entries_select on tournament_entries
  for select to anon, authenticated
  using (true);

-- 自分の選手行で、募集中の大会にだけエントリーできる。
-- チーム戦は申し込んだ人が相方の行も入れる必要があるので、このポリシーでは通らない。
-- 代わりに enter_tournament_as_team（security definer）を通す。
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

-- ---- match_chat_messages ----
--
-- 他のテーブルと違い、ゲスト（anon）には一切見せない。

drop policy if exists chat_select on match_chat_messages;
create policy chat_select on match_chat_messages
  for select to authenticated
  using (can_use_match_chat(tournament_id, match_id));

-- 自分の名前でしか書けない。確定した試合は運営だけが書ける（介入のため）。
drop policy if exists chat_insert on match_chat_messages;
create policy chat_insert on match_chat_messages
  for insert to authenticated
  with check (
    player_id = current_player_id()
    and can_use_match_chat(tournament_id, match_id)
    and (is_admin() or match_chat_is_open(tournament_id, match_id))
  );

-- 削除は運営だけ（不適切な発言の取り消し）。本人にも消させない。
-- 消えた発言を巡って「言った/言わない」になるより、運営が判断する形にする。
drop policy if exists chat_delete on match_chat_messages;
create policy chat_delete on match_chat_messages
  for delete to authenticated
  using (is_admin());

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
  v_me     uuid;
  v_tid    uuid;
  v_status text;
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

revoke all on function bracket_match(uuid, uuid)      from anon, public;
revoke all on function can_use_match_chat(uuid, uuid) from anon, public;
revoke all on function match_chat_is_open(uuid, uuid) from anon, public;
grant execute on function bracket_match(uuid, uuid)      to authenticated;
grant execute on function can_use_match_chat(uuid, uuid) to authenticated;
grant execute on function match_chat_is_open(uuid, uuid) to authenticated;

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
  execute 'alter publication supabase_realtime add table tournament_teams';
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

-- match_chat_messages は意図的に入れていない。
--
-- 既存の購読は「どれかのテーブルが変わったら全データを取り直す」作りなので、
-- チャット1通ごとに全員が全件取得することになる。加えて、当事者にしか見せない
-- データをブロードキャストに載せると、購読側のRLS適用の設定ミスがそのまま漏洩になる。
-- チャットは画面を開いている間だけ、RLSを通る普通のSELECTで取りに行く
-- （js/matchChat.js）。

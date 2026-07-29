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

-- 回戦ごとの開始と配信台。
--
-- 選手がゲームカウントを入力できるのは、運営がその回戦を開始してから。
-- 開始の前に配信台（＝配信に乗せる試合）を決めなければならず、そこは制約で保証する。
-- 基本は1回戦につき1試合だが、全試合を配信する大会もあるので複数選べる。
create table if not exists tournament_rounds (
  tournament_id      uuid not null references tournaments(id) on delete cascade,
  -- ブラケットの rounds 配列の位置（0始まり）。ラウンド名（R1/QF/SF/F）は
  -- 表の大きさで変わるので、位置で持つほうが崩れない
  round_index        int not null,
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

-- 選手が入力したゲームカウントのうち、相手の承認を待っているもの。
--
-- 片方が報告し、相手が承認して初めて確定する（一方的な入力で勝ち上がれないため）。
-- 確定すると行は消え、結果は brackets と matches に入る。
-- 1試合につき1件で、出し直すと上書きされる（相手からの対案もこれで入る）。
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
  primary key (tournament_id, match_id)
);

-- 対戦カードごとのルームコード。
--
-- チャットの発言として伝えると会話に埋もれてしまうので、専用の欄を1つ持たせて
-- 対戦チャットの上部と対戦表のカードに常に見えるようにする。
-- 記入できるのはその試合の当事者と運営。運営が回戦の開始前に配信台のコードを
-- 入れておけば、選手は開始と同時にコードを確認できる。
create table if not exists match_room_codes (
  tournament_id uuid not null references tournaments(id) on delete cascade,
  match_id      uuid not null,
  code          text not null,
  -- 誰が記入したか（表示用。消えた選手は null になるだけで、コードは残る）
  set_by        uuid references players(id) on delete set null,
  updated_at    timestamptz not null default now(),
  -- 1試合につき1つ。書き直すと上書きされる
  primary key (tournament_id, match_id),
  constraint room_code_not_blank check (btrim(code) <> ''),
  constraint room_code_length check (char_length(code) <= 50)
);

-- チャットでもめたときに、当事者が運営へ知らせるための報告。
-- 未対応（resolved_at is null）のものがある大会は、運営の画面で大会カードと
-- 対戦表の該当試合に印が出る。
create table if not exists match_chat_reports (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id) on delete cascade,
  match_id      uuid not null,
  reporter_id   uuid not null references players(id) on delete cascade,
  body          text not null,
  created_at    timestamptz not null default now(),
  -- 対応済みにした時刻と運営。null なら未対応（＝印を出す）
  resolved_at   timestamptz,
  resolved_by   uuid references players(id) on delete set null,
  constraint report_body_not_blank check (btrim(body) <> ''),
  constraint report_body_length check (char_length(body) <= 500)
);

-- 運営が「公開する」を押した瞬間のランキングのスナップショット。
-- 常時計算するスコアは保存しないという設計原則（doc/design.md 6章）を維持する。
--
-- 集計期間は運営がカレンダーで選んだ開始日・終了日そのもの（片方だけ・両方とも
-- 省略も可、省略側は無制限）。period_months は移行前の「直近Nか月」形式の名残で、
-- 古い公開データの表示にだけ使う（新規の公開では書き込まない）。
create table if not exists published_rankings (
  id            uuid primary key default gen_random_uuid(),
  published_at  timestamptz not null default now(),
  period_months int,
  period_start  date,
  period_end    date,
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
-- 画面が見るのはほぼ「未対応の報告」だけなので、そこに絞る
create index if not exists reports_open_idx       on match_chat_reports (tournament_id) where resolved_at is null;
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

-- その試合の当事者（どちらかの枠のメンバー）か運営なら true。
-- チャットに入れるか、ゲームカウントを報告できるか、の両方の判定に使う。
--
-- 当事者の判定は「出場枠」で行う。tournament_entries の coalesce(team_id, player_id) が
-- ブラケットのスロットに入っているIDなので、個人戦でもチーム戦でも同じ式で済む
-- （チーム戦ではメンバー全員が同じ扱いになる）。
--
-- 両方の枠が埋まっていることを運営にも求めるのは、相手のいない部屋を作らせないため。
-- BYE・対戦カード未確定の試合、そして存在しない match_id はこの条件で落ちる。
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

-- チャットのポリシーから使う別名（意味を読みやすくするためだけのもの）。
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

-- その試合がブラケットの何番目の回戦にあるか（0始まり）。
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
grant select on players, tournaments, tournament_teams, tournament_entries, brackets, matches, tournament_rounds, published_rankings, announcements
  to anon, authenticated;

-- 報告はポリシー側で運営と本人に絞る。anon にも select を与えるのは、
-- ゲストの読み込み（js/db.js の loadAll）が権限エラーで止まらないようにするため
-- （ポリシーのどちらの条件も満たさないので、返るのは常に0件）。
grant select on match_chat_reports to anon, authenticated;

-- 承認待ちのゲームカウント。登録と更新は下のRPC経由だけなので、
-- テーブルに与えるのは select と（出した本人の取り消し用の）delete だけ。
grant select on match_result_reports to anon, authenticated;
grant delete on match_result_reports to authenticated;

-- ルームコード。anon への select はゲストの読み込みを止めないため
-- （ポリシーが偽なので返るのは常に0件）。書き込みは当事者と運営（ポリシーで絞る）。
grant select on match_room_codes to anon, authenticated;
grant insert, update, delete on match_room_codes to authenticated;

-- 選手行の作成。idとroleは指定させない（roleは既定値'player'が入る）
grant insert (user_id, display_name, past_names, game_account_id, bio, avatar_url,
              main_characters, sns_x, sns_twitch, sns_youtube)
  on players to authenticated;

-- プロフィールの編集。roleとuser_idは意図的に含めない
grant update (display_name, past_names, game_account_id, bio, avatar_url,
              main_characters, sns_x, sns_twitch, sns_youtube)
  on players to authenticated;

grant delete on players to authenticated;

grant insert, update, delete on tournaments, tournament_teams, tournament_entries, brackets, matches, tournament_rounds, published_rankings, announcements
  to authenticated;

-- 対戦カードのチャットだけは anon に何も与えない（当事者と運営に閉じる）
grant select, insert, delete on match_chat_messages to authenticated;

-- 報告は消せない（deleteを与えない）。もめごとの経緯そのものが失われるため。
-- 更新できる列も「対応済みにする」の2列だけに絞る（RLSは行しか制御できない）。
grant insert on match_chat_reports to authenticated;
grant update (resolved_at, resolved_by) on match_chat_reports to authenticated;

-- ---------------------------------------------------------------------------
-- 行レベルセキュリティ
-- ---------------------------------------------------------------------------

alter table players             enable row level security;
alter table tournaments         enable row level security;
alter table tournament_teams    enable row level security;
alter table tournament_entries  enable row level security;
alter table brackets            enable row level security;
alter table tournament_rounds   enable row level security;
alter table matches             enable row level security;
alter table published_rankings  enable row level security;
alter table announcements       enable row level security;
alter table match_chat_messages enable row level security;
alter table match_chat_reports  enable row level security;
alter table match_result_reports enable row level security;
alter table match_room_codes    enable row level security;

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

-- ---- tournament_rounds ----
--
-- 配信台と開始状態は誰が見てもよい（選手も観戦者も、どこで何が始まったか知りたい）。
-- 決められるのは運営だけ。

drop policy if exists rounds_select on tournament_rounds;
create policy rounds_select on tournament_rounds
  for select to anon, authenticated
  using (true);

drop policy if exists rounds_write on tournament_rounds;
create policy rounds_write on tournament_rounds
  for all to authenticated
  using (is_admin())
  with check (is_admin());

-- ---- match_result_reports ----

drop policy if exists result_reports_select on match_result_reports;
create policy result_reports_select on match_result_reports
  for select to anon, authenticated
  using (is_match_participant(tournament_id, match_id));

-- 取り消せるのは出した本人と運営。相手が違うと思ったときは、取り消してもらうのではなく
-- 自分のゲームカウントを出し直す（上書きされる）。
drop policy if exists result_reports_delete on match_result_reports;
create policy result_reports_delete on match_result_reports
  for delete to authenticated
  using (is_admin() or reporter_player_id = current_player_id());

-- ---- match_room_codes ----
--
-- 部屋のコードは当事者と運営だけが見る。観戦者に見せると、無関係の人が
-- 部屋に入って来られてしまう。

drop policy if exists room_codes_select on match_room_codes;
create policy room_codes_select on match_room_codes
  for select to anon, authenticated
  using (is_match_participant(tournament_id, match_id));

drop policy if exists room_codes_insert on match_room_codes;
create policy room_codes_insert on match_room_codes
  for insert to authenticated
  with check (is_match_participant(tournament_id, match_id));

drop policy if exists room_codes_update on match_room_codes;
create policy room_codes_update on match_room_codes
  for update to authenticated
  using (is_match_participant(tournament_id, match_id))
  with check (is_match_participant(tournament_id, match_id));

drop policy if exists room_codes_delete on match_room_codes;
create policy room_codes_delete on match_room_codes
  for delete to authenticated
  using (is_match_participant(tournament_id, match_id));

-- ---- match_chat_reports ----
--
-- 読めるのは運営と、自分が出した報告の本人だけ。本人にも見せるのは
-- 「報告が届いているか」を画面で確かめられるようにするため。

drop policy if exists reports_select on match_chat_reports;
create policy reports_select on match_chat_reports
  for select to anon, authenticated
  using (is_admin() or reporter_id = current_player_id());

-- 報告できるのは その試合のチャットを使える人（＝当事者）だけ。自分の名前でのみ。
drop policy if exists reports_insert on match_chat_reports;
create policy reports_insert on match_chat_reports
  for insert to authenticated
  with check (
    reporter_id = current_player_id()
    and can_use_match_chat(tournament_id, match_id)
  );

-- 対応済みにできるのは運営だけ。書き換えられる列は上のGRANTで絞ってある
drop policy if exists reports_update on match_chat_reports;
create policy reports_update on match_chat_reports
  for update to authenticated
  using (is_admin())
  with check (is_admin());

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


revoke all on function bracket_match(uuid, uuid)       from anon, public;
revoke all on function is_match_participant(uuid, uuid) from anon, public;
revoke all on function can_use_match_chat(uuid, uuid)  from anon, public;
revoke all on function match_chat_is_open(uuid, uuid)  from anon, public;
revoke all on function my_entrant_id(uuid)             from anon, public;
revoke all on function bracket_round_index(uuid, uuid) from anon, public;
revoke all on function round_is_started(uuid, uuid)    from anon, public;
revoke all on function report_match_result(uuid, uuid, text, uuid) from anon, public;
revoke all on function approve_match_result(uuid, uuid)            from anon, public;
grant execute on function bracket_match(uuid, uuid)       to authenticated;
-- is_match_participant だけは anon にも許可する。match_result_reports と
-- match_room_codes の select ポリシーは anon にも適用され、その中でこの関数を
-- 呼ぶため、実行権限が無いとゲストの読み込み自体が42501で失敗する
-- （行が0件になるのではなく、エラーになる）。ログインしていなければ
-- 常に偽を返すだけなので、ゲストに見えるデータは増えない。
grant execute on function is_match_participant(uuid, uuid) to anon, authenticated;
grant execute on function can_use_match_chat(uuid, uuid)  to authenticated;
grant execute on function match_chat_is_open(uuid, uuid)  to authenticated;
grant execute on function my_entrant_id(uuid)             to authenticated;
grant execute on function bracket_round_index(uuid, uuid) to authenticated;
grant execute on function round_is_started(uuid, uuid)    to authenticated;
grant execute on function report_match_result(uuid, uuid, text, uuid) to authenticated;
grant execute on function approve_match_result(uuid, uuid)            to authenticated;

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

-- 回戦の開始は選手も観戦者も待っているので、変わった瞬間に届けたい
do $$
begin
  execute 'alter publication supabase_realtime add table tournament_rounds';
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

-- 承認待ちのゲームカウントは、相手が対戦表を見ながら待つものなので届いた瞬間に出したい。
-- 中身はゲームカウントと出場枠のIDだけで、確定すればどのみち全員に見えるもの
-- （チャットや報告の本文とは性質が違う）。
do $$
begin
  execute 'alter publication supabase_realtime add table match_result_reports';
exception when duplicate_object then null;
end $$;

-- 相手が入れたコードを待っている場面で使うものなので、届いた瞬間に出したい。
-- Realtimeの配信にもRLSが効くため、当事者と運営以外には流れない。
do $$
begin
  execute 'alter publication supabase_realtime add table match_room_codes';
exception when duplicate_object then null;
end $$;

-- match_chat_messages と match_chat_reports は意図的に入れていない。
--
-- 既存の購読は「どれかのテーブルが変わったら全データを取り直す」作りなので、
-- チャット1通ごとに全員が全件取得することになる。加えて、当事者にしか見せない
-- データをブロードキャストに載せると、購読側のRLS適用の設定ミスがそのまま漏洩になる。
-- チャットは画面を開いている間だけ、RLSを通る普通のSELECTで取りに行く
-- （js/matchChat.js）。

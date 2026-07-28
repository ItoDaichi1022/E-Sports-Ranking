-- ============================================================================
-- 差分適用スクリプト 008
--
-- 既に schema.sql（＋002〜007）を実行済みのプロジェクトに、あとから入った
-- 変更だけを当てる。Supabaseダッシュボードの SQL Editor に貼り付けて「Run」。
-- 何度実行しても同じ結果になる。
--
-- 新しくプロジェクトを作る場合はこれは不要（schema.sql に取り込み済み）。
--
-- 内容:
--   対戦カードごとのチャット。
--
--   進行中の大会で、対戦相手と待ち合わせや進行の相談ができるようにする。部屋は
--   ブラケットの試合1つにつき1つで、読み書きできるのは その試合の当事者と運営だけ。
--   同じ相手でもラウンドが違えば別の部屋になる。
--
--   誰がどの部屋に入れるかは、ブラケットのJSONを読んで判定する（下の関数）。
--   参加者をチャット側にコピーして持つと、参加者の入れ替えや連鎖的な結果の
--   取り消しでブラケットだけが変わり、2つの情報がずれる。判定の根拠は
--   常にブラケット1つに寄せる。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- ブラケットJSONの読み取り
--
-- RLSポリシーの中から brackets を普通にSELECTすると、閲覧は全員に許可されている
-- とはいえポリシー評価が増えて重い。security definer でJSONの取り出しだけを
-- 切り出しておく（is_admin() と同じ考え方）。
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

-- 書き込みを受け付ける状態か。勝敗が確定した試合は読むだけにする。
-- （直前のやりとりを見返してスコアの行き違いを確かめられるよう、閲覧は残す）
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
-- メッセージ
-- ---------------------------------------------------------------------------

create table if not exists match_chat_messages (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id) on delete cascade,
  -- ブラケットのJSON内の試合ID。matches テーブルには確定した試合しか無いので、
  -- 外部キーは張れない（チャットは試合前から使うためこちらが先に存在する）
  match_id      uuid not null,
  player_id     uuid not null references players(id) on delete cascade,
  body          text not null,
  created_at    timestamptz not null default now(),
  constraint chat_body_not_blank check (btrim(body) <> ''),
  constraint chat_body_length check (char_length(body) <= 500)
);

create index if not exists chat_room_idx
  on match_chat_messages (tournament_id, match_id, created_at);

-- ---------------------------------------------------------------------------
-- 権限とRLS
--
-- ゲスト（anon）には一切与えない。閲覧が全員に開いている他のテーブルと違い、
-- ここだけは当事者と運営に閉じる。
-- ---------------------------------------------------------------------------

grant select, insert, delete on match_chat_messages to authenticated;

alter table match_chat_messages enable row level security;

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

revoke all on function bracket_match(uuid, uuid)       from anon, public;
revoke all on function can_use_match_chat(uuid, uuid)  from anon, public;
revoke all on function match_chat_is_open(uuid, uuid)  from anon, public;
grant execute on function bracket_match(uuid, uuid)       to authenticated;
grant execute on function can_use_match_chat(uuid, uuid)  to authenticated;
grant execute on function match_chat_is_open(uuid, uuid)  to authenticated;

-- Realtime のパブリケーションには入れない。
--
-- 既存の購読は「どれかのテーブルが変わったら全データを取り直す」作りなので、
-- チャット1通ごとに全員が全件取得することになる。加えて、非公開のデータを
-- ブロードキャストに載せると、購読側のRLS適用の設定ミスがそのまま漏洩になる。
-- チャットは画面を開いている間だけ、RLSを通る普通のSELECTで取りに行く
-- （js/matchChat.js）。

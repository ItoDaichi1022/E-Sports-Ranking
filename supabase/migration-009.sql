-- ============================================================================
-- 差分適用スクリプト 009
--
-- 既に schema.sql（＋002〜008）を実行済みのプロジェクトに、あとから入った
-- 変更だけを当てる。Supabaseダッシュボードの SQL Editor に貼り付けて「Run」。
-- 何度実行しても同じ結果になる。
--
-- 新しくプロジェクトを作る場合はこれは不要（schema.sql に取り込み済み）。
--
-- 内容:
--   対戦カードのチャットから運営へ報告する仕組み。
--
--   チャットでもめたとき、当事者が一言添えて運営に知らせる。未対応の報告がある
--   大会は、運営の画面で大会カードと対戦表の該当試合に印が出る。
--   運営が「対応済みにする」を押すと印が消え、誰がいつ閉じたかが残る。
-- ============================================================================

create table if not exists match_chat_reports (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id) on delete cascade,
  -- ブラケットのJSON内の試合ID（match_chat_messages と同じ理由で外部キーは張れない）
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

-- 画面が見るのはほぼ「未対応のもの」だけなので、そこに絞った索引にする
create index if not exists reports_open_idx
  on match_chat_reports (tournament_id) where resolved_at is null;

-- ---------------------------------------------------------------------------
-- 権限とRLS
--
-- 読めるのは運営と、自分が出した報告の本人だけ。本人にも見せるのは
-- 「報告が届いているか」を画面で確かめられるようにするため。
--
-- anon にも select を与えるが、ポリシーが is_admin() と current_player_id() の
-- どちらも満たさないため0件になる。ゲストの読み込み（js/db.js の loadAll）が
-- 権限エラーで止まらないよう、他のテーブルと同じ形に揃えている。
-- ---------------------------------------------------------------------------

grant select on match_chat_reports to anon, authenticated;
grant insert on match_chat_reports to authenticated;
-- 更新できる列を「対応済みにする」の2列に限る。報告の中身は誰にも書き換えさせない
-- （RLSは行しか制御できないので、列はGRANTで絞る。playersのroleと同じ考え方）。
grant update (resolved_at, resolved_by) on match_chat_reports to authenticated;

alter table match_chat_reports enable row level security;

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

-- 対応済みにできるのは運営だけ
drop policy if exists reports_update on match_chat_reports;
create policy reports_update on match_chat_reports
  for update to authenticated
  using (is_admin())
  with check (is_admin());

-- 削除は誰にもさせない（delete のGRANTを与えていない）。報告を消せてしまうと、
-- もめごとの経緯そのものが失われる。大会を消せば cascade で一緒に消える。

-- Realtime には入れない（match_chat_messages と同じ理由）。
-- 運営の画面には js/app.js が短い間隔で取りに行く。

-- ============================================================================
-- 差分適用スクリプト 003
--
-- 既に schema.sql（＋002）を実行済みのプロジェクトに、あとから入った変更だけを当てる。
-- Supabaseダッシュボードの SQL Editor に貼り付けて「Run」。
-- 何度実行しても同じ結果になる。
--
-- 新しくプロジェクトを作る場合はこれは不要（schema.sql に取り込み済み）。
--
-- 内容:
--   ホーム画面に出す「運営からのお知らせ」テーブル一式。
--   閲覧は全員、投稿・編集・削除は運営のみ。
-- ============================================================================

create table if not exists announcements (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text not null default '',
  pinned      boolean not null default false,
  created_by  uuid references players(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint announcements_title_not_blank check (btrim(title) <> '')
);

create index if not exists announcements_order_idx on announcements (pinned desc, created_at desc);

-- updated_at を自動更新する。touch_bracket_updated_at は new.updated_at を now() にするだけの
-- 汎用トリガー関数なので、そのまま使い回す（schema.sql で定義済み）。
drop trigger if exists announcements_touch_trigger on announcements;
create trigger announcements_touch_trigger
  before update on announcements
  for each row execute function touch_bracket_updated_at();

-- 権限。Supabaseは新規テーブルに広い権限を自動付与するので、まず剥がしてから絞る。
revoke all on announcements from anon, authenticated;
grant select on announcements to anon, authenticated;
grant insert, update, delete on announcements to authenticated;

alter table announcements enable row level security;

drop policy if exists announcements_select on announcements;
create policy announcements_select on announcements
  for select to anon, authenticated using (true);

drop policy if exists announcements_write on announcements;
create policy announcements_write on announcements
  for all to authenticated using (is_admin()) with check (is_admin());

-- 観戦者の画面へお知らせの追加・変更を即時に反映する
do $$
begin
  execute 'alter publication supabase_realtime add table announcements';
exception when duplicate_object then null;
end $$;

-- ============================================================================
-- 差分適用スクリプト 004
--
-- 既に schema.sql（＋002・003）を実行済みのプロジェクトに、あとから入った変更だけを当てる。
-- Supabaseダッシュボードの SQL Editor に貼り付けて「Run」。
-- 何度実行しても同じ結果になる。
--
-- 新しくプロジェクトを作る場合はこれは不要（schema.sql に取り込み済み）。
--
-- 内容:
--   大会とお知らせに画像を持たせる（image_url 列 ＋ images バケット）。
--   閲覧は全員、アップロード・変更・削除は運営のみ。
-- ============================================================================

-- 大会のバナー画像・お知らせの画像。tournaments と announcements は
-- テーブル単位で authenticated に書き込みを与えており（RLSで運営に限定）、
-- 列単位のGRANTは使っていないので、列を足すだけで書き込めるようになる。
alter table tournaments  add column if not exists image_url text;
alter table announcements add column if not exists image_url text;

-- 画像の保管場所。誰でも見られる公開バケットだが、書けるのは運営だけ。
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

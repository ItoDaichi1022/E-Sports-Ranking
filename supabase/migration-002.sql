-- ============================================================================
-- 差分適用スクリプト 002
--
-- 既に schema.sql を実行済みのプロジェクトに、あとから入った変更だけを当てる。
-- Supabaseダッシュボードの SQL Editor に貼り付けて「Run」。
-- 何度実行しても同じ結果になる。
--
-- 新しくプロジェクトを作る場合はこれは不要（schema.sql に取り込み済み）。
--
-- 内容:
--   1. 定員チェックの作り直し（締め切れない・一括挿入で素通りする不具合の修正）
--   2. アイコン画像用の列とStorageバケット
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 定員チェックの作り直し
--
-- これまでは行単位のBEFORE INSERTトリガーだったが、次の2つの問題があった。
--   * 締切時にシード順を upsert（INSERT ... ON CONFLICT）で書き戻すと、既存行の
--     更新であってもINSERTトリガーが発火し、定員ちょうどまで埋まった大会を
--     締め切れなくなる。
--   * 行単位トリガーから見た count(*) には、同じINSERT文で挿入中の行が含まれない。
--     そのため一括挿入では全行が「まだ0人」と判定され、定員が素通りしていた。
-- 文単位のAFTER INSERTで、挿入後の最終人数を1回だけ検査する形に変える。
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

-- ---------------------------------------------------------------------------
-- 2. アイコン画像
-- ---------------------------------------------------------------------------

alter table players add column if not exists avatar_url text;

-- 列を増やしたので、本人が編集できる列の一覧を与え直す
grant insert (user_id, display_name, past_names, game_account_id, bio, avatar_url,
              main_characters, sns_x, sns_twitch, sns_youtube)
  on players to authenticated;

grant update (display_name, past_names, game_account_id, bio, avatar_url,
              main_characters, sns_x, sns_twitch, sns_youtube)
  on players to authenticated;

-- 誰でも見られるが、書き込めるのは自分のフォルダだけ。
-- ファイルは avatars/{自分のuser_id}/{ファイル名} に置く決まりにして、
-- 先頭フォルダ名が自分のIDと一致するかどうかで他人の画像の差し替えを防ぐ。
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

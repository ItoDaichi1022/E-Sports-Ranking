-- ============================================================================
-- 差分適用スクリプト 026
--
-- 既に schema.sql（＋002〜025）を実行済みのプロジェクトに、あとから入った
-- 変更だけを当てる。Supabaseダッシュボードの SQL Editor に貼り付けて「Run」。
-- 何度実行しても同じ結果になる。
--
-- 新しくプロジェクトを作る場合はこれは不要（schema.sql に取り込み済み）。
--
-- 内容:
--   大会の開催日（tournaments.date）を、日付だけの date から
--   開始時刻まで持てる timestamptz に変える。
--
--   「何日にやるか」だけでは、選手が当日に何時へ集まればよいか分からなかった。
--   ルール欄に文章で書く運用になっていて、一覧にも共有カードにも出てこない。
--
-- 【時差の扱い】
--   date から timestamptz への変換は、そのままだと接続の時間帯（Supabaseは
--   既定でUTC）で読まれる ── 8月15日の大会が「8月15日 0:00 UTC」＝日本時間の
--   9:00 になってしまう。ここでは日本時間の 0:00 として読み替える。
--
--   これまでに登録された大会は、時刻を持っていない。移行後は「0:00」と
--   表示される（本当に0時開催という意味になる）。実際の開始時刻は、運営が
--   大会情報の編集から入れ直すこと。こちらで推測して埋めない ── 推測した
--   時刻は、当時の記録として残ってしまう。
--
-- 【列の名前は変えない】date のままにしてある。中身は日時になるが、
--   名前を変えると js/db.js・worker/index.js・schema.sql の参照を
--   同時に直す必要があり、取りこぼすと「大会の日付が消えた」ように見える。
--   画面に出す言葉のほうを「開催日時」にそろえてある。
-- ============================================================================

do $$
begin
  -- 既に timestamptz なら何もしない（何度実行してもよいようにするため）
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'tournaments'
      and column_name  = 'date'
      and data_type    = 'date'
  ) then
    alter table tournaments
      alter column date type timestamptz
      using (date::timestamp at time zone 'Asia/Tokyo');
  end if;
end $$;

comment on column tournaments.date is
  '開催日時。時刻を持たなかった頃の大会は日本時間の0:00に移行済み（migration-026）。';

-- ============================================================================
-- 差分適用スクリプト 006
--
-- 既に schema.sql（＋002〜005）を実行済みのプロジェクトに、あとから入った
-- 変更だけを当てる。Supabaseダッシュボードの SQL Editor に貼り付けて「Run」。
-- 何度実行しても同じ結果になる。
--
-- 新しくプロジェクトを作る場合はこれは不要（schema.sql に取り込み済み）。
--
-- 内容:
--   大会に「対戦方法」を持たせ、ランキング反映の条件に使う。
--
--   これまで大会の試合は無条件でランキングのスコアに入っていた。少人数の大会や
--   チーム戦まで同じ土俵で集計すると、個人の実力を表す指標として成り立たないため、
--     ① 参加人数が24人以上
--     ② 対戦方法が 1v1 またはリレー
--   の両方を満たす大会だけをスコア計算の対象にする（判定は js/rankingEligibility.js）。
--
--   match_type は null を許す。既存の大会は対戦方法が分からないため、運営が
--   大会情報の編集から選び直すまでランキング反映の対象外として扱われる。
--   match_type_note は match_type = 'other' のときだけ意味を持つ説明文。
-- ============================================================================

alter table tournaments add column if not exists match_type      text;
alter table tournaments add column if not exists match_type_note text;

alter table tournaments drop constraint if exists tournaments_match_type_check;
alter table tournaments add constraint tournaments_match_type_check
  check (match_type is null or match_type in ('1v1', 'relay', '2v2', 'other'));

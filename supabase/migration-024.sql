-- ============================================================================
-- 差分適用スクリプト 024
--
-- 既に schema.sql（＋002〜023）を実行済みのプロジェクトに、あとから入った
-- 変更だけを当てる。Supabaseダッシュボードの SQL Editor に貼り付けて「Run」。
-- 何度実行しても同じ結果になる。
--
-- 新しくプロジェクトを作る場合はこれは不要（schema.sql に取り込み済み）。
--
-- 内容:
--   選手の検索をブラウザ側からDB側へ移すための、検索用の列と索引。
--
--   これまでサイトを開くと players の全行がブラウザへ降りてきていた。名前を
--   引く（対戦表・チャット・戦績）ためと、4か所ある検索欄が手元で絞るためで、
--   登録者が増えるほど、誰がどのページを見ても重くなり続ける作りだった。
--
--   検索をここへ移すと、ブラウザは「打った文字に当たった人」だけを受け取れる。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 検索用の列
-- ---------------------------------------------------------------------------
--
-- 名前・ゲームID・過去名（直近2件）を1本の小文字の文字列にまとめる。
-- 生成列なので書き込みは要らず、元の列を変えれば必ず追随する
-- （検索用の値を別に持って更新し忘れる、という壊れ方が起きない）。
--
-- 【過去名を array_to_string でまとめないこと】あれは IMMUTABLE ではないので、
-- 生成列の式に書くと Postgres に弾かれる（要素の出力関数に依存するため）。
-- 添字で取り出すほう（array_length と subscript）は IMMUTABLE なので通る。
--
-- 【直近2件だけなのは画面に合わせるため】選手ページに出している過去名も直近2件。
-- 全履歴を検索対象にすると、画面のどこにも出ていない古い名前で見つかることになり、
-- 探した人から見て理由の分からない結果になる（js/players.js の注記と同じ判断）。
-- 過去名が0件・1件のときは array_length が null になり、添字も null、
-- coalesce で空文字になる。
alter table players
  add column if not exists search_text text
  generated always as (
    lower(display_name)
    || ' ' || lower(coalesce(game_account_id, ''))
    || ' ' || lower(coalesce(past_names[array_length(past_names, 1)], ''))
    || ' ' || lower(coalesce(past_names[array_length(past_names, 1) - 1], ''))
  ) stored;

-- ---------------------------------------------------------------------------
-- 部分一致のための索引
-- ---------------------------------------------------------------------------
--
-- 検索は前方一致ではなく部分一致（「たろう」で「きんたろう」も出す）。普通の
-- btree索引は %foo% には効かないので、三文字組（trigram）の索引を張る。
--
-- 【ここで失敗したら、この節だけ飛ばしてよい】拡張機能の置き場所は環境によって
-- 違い（Supabaseは extensions スキーマに置く運用）、gin_trgm_ops が見つからない
-- ことがある。その場合は下の2文を
--     create extension if not exists pg_trgm with schema extensions;
--     create index if not exists players_search_trgm
--       on players using gin (search_text extensions.gin_trgm_ops);
-- に読み替える。どちらも通らなければ索引無しで構わない ── 検索は全表走査になるが
-- 結果は同じで、数千人までは体感の差も出ない。上の列さえあれば機能は動く。
create extension if not exists pg_trgm;

create index if not exists players_search_trgm
  on players using gin (search_text gin_trgm_ops);

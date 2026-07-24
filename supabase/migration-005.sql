-- ============================================================================
-- 差分適用スクリプト 005
--
-- 既に schema.sql（＋002・003・004）を実行済みのプロジェクトに、あとから入った
-- 変更だけを当てる。Supabaseダッシュボードの SQL Editor に貼り付けて「Run」。
-- 何度実行しても同じ結果になる。
--
-- 新しくプロジェクトを作る場合はこれは不要（schema.sql に取り込み済み）。
--
-- 内容:
--   確定した大会成績を tournament_entries.placement に保存する。
--
--   これまで「優勝／準優勝／ベストN」は、そのつどブラケットのJSONから計算していた。
--   そのため選手ページやランキングを開くだけで全大会のブラケットを読む必要があり、
--   通信量の大半をブラケットが占めていた。結果を1列に持たせれば、対戦表そのものは
--   見るときだけ取ればよくなる。
--
--   値は「勝ち上がりの深さ」。優勝=1、準優勝=2、ベスト4=4、ベスト8=8 …。
--   小さいほど上位で、そのまま数値として比較できる（ランキングの好成績評価で使う）。
--   null は未確定（進行中、または結果を確定していない大会）。
-- ============================================================================

alter table tournament_entries add column if not exists placement int;

-- ---------------------------------------------------------------------------
-- 既存の確定済み大会からの埋め戻し
--
-- ブラケットのJSONは既にDBにあるので、そこから同じ計算をして1回だけ書き込む。
-- 対象は status = 'finished' の大会のみ（確定していない結果は公開しない方針）。
-- ---------------------------------------------------------------------------

-- 優勝者。決勝（最終ラウンドの唯一の試合）が確定していればその勝者。
update tournament_entries e
set placement = 1
from brackets b
join tournaments t on t.id = b.tournament_id
where e.tournament_id = b.tournament_id
  and t.status = 'finished'
  and coalesce((b.data->'rounds'->-1->'matches'->0->>'confirmed')::boolean, false)
  and e.player_id = (b.data->'rounds'->-1->'matches'->0->>'winnerId')::uuid;

-- 敗退者。第Rラウンド（0始まり）で負けた人の深さは bracketSize / 2^R。
-- 例: 16人枠なら1回戦敗退=16（ベスト16）、決勝敗退=2（準優勝）。
-- BYEは対戦が成立していないので loserId が無く、ここに含まれない。
with losers as (
  select
    b.tournament_id,
    (m->>'loserId')::uuid as player_id,
    (b.data->>'bracketSize')::int / (2 ^ (r.ord - 1))::int as depth
  from brackets b
  join tournaments t on t.id = b.tournament_id and t.status = 'finished'
  cross join lateral jsonb_array_elements(b.data->'rounds') with ordinality as r(round, ord)
  cross join lateral jsonb_array_elements(r.round->'matches') as m
  where coalesce((m->>'confirmed')::boolean, false)
    and m->>'loserId' is not null
)
update tournament_entries e
set placement = l.depth
from losers l
where e.tournament_id = l.tournament_id
  and e.player_id = l.player_id;

-- 確定していない大会に古い値が残らないようにする（確定を取り消した場合など）。
update tournament_entries e
set placement = null
from tournaments t
where t.id = e.tournament_id
  and t.status <> 'finished'
  and e.placement is not null;

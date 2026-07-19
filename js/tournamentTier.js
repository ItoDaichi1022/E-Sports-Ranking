// 大会規模のTier分類。
// コミュニティの慣習に合わせ、10人刻みでTier1〜Tier6、60人以上は「大規模」判定とする。
// design.md 6章の tournament.weight（ランキング計算用の重み）とは独立した、表示用のラベル。
const LARGE_SCALE_THRESHOLD = 60;

export function tournamentTier(participantCount) {
  if (participantCount >= LARGE_SCALE_THRESHOLD) return '大規模';
  const tierNumber = Math.floor(participantCount / 10) + 1;
  return `Tier ${tierNumber}`;
}

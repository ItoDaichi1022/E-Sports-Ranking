// 大会をランキングに反映するかどうかの条件判定。
//
// 大会の試合は自動でランキングに乗るが、少人数の大会やチーム戦まで同じ土俵で
// 集計すると、個人の実力を表す指標として成り立たなくなる。そこで
//   ① 参加人数が24人以上
//   ② 対戦方法が 1v1 またはリレー（＝個人の勝敗として数えられるもの）
// の両方を満たす大会だけをスコア計算の対象とする。
//
// 判定は保存せず、そのつど大会の内容から算出する（tournamentTier.js と同じ方針）。
// 参加人数は募集中に増えるので、値を持たせると実態とずれてしまうため。
export const RANKED_MIN_PARTICIPANTS = 24;

// 対戦方法。ranked が true のものだけがランキングのスコア計算に入る。
// キーはDBの tournaments.match_type にそのまま入る値。
export const MATCH_TYPES = {
  '1v1': { label: '1v1', ranked: true },
  relay: { label: 'リレー', ranked: true },
  '2v2': { label: '2v2', ranked: false },
  other: { label: 'その他', ranked: false },
};

export const MATCH_TYPE_KEYS = Object.keys(MATCH_TYPES);

// 表示用の対戦方法名。「その他」は運営が書いた説明をそのまま見せる。
// 未設定（この機能より前に作られた大会）は空欄ではなく理由が分かる文言にする。
export function matchTypeLabel(tournament) {
  const type = MATCH_TYPES[tournament.matchType];
  if (!type) return '未設定';
  if (tournament.matchType === 'other' && tournament.matchTypeNote) {
    return `その他（${tournament.matchTypeNote}）`;
  }
  return type.label;
}

// 大会がランキング反映の対象かどうかと、対象外ならその理由。
// 戻り値: { ranked: boolean, reasons: string[] }（ranked が true なら reasons は空）
export function rankingEligibility(tournament) {
  const reasons = [];

  const count = tournament.participantIds.length;
  if (count < RANKED_MIN_PARTICIPANTS) {
    reasons.push(`参加${RANKED_MIN_PARTICIPANTS}人以上（現在${count}人）`);
  }

  const type = MATCH_TYPES[tournament.matchType];
  if (!type) {
    reasons.push('対戦方法が未設定');
  } else if (!type.ranked) {
    reasons.push(`対戦方法が1v1・リレー以外（${type.label}）`);
  }

  return { ranked: reasons.length === 0, reasons };
}

export function isRankedTournament(tournament) {
  return rankingEligibility(tournament).ranked;
}

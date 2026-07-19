// LumiRank軽量版：相手の強さで重み付けした反復スコアリングのみを残した最小実装。
// doc/design.md の「7. ランキング方式」に準拠する。
export const RANKING_CONFIG = {
  initialScore: 1000,   // 全選手の初期スコア（相対値のみ意味を持つ）
  kFactor: 32,          // 1試合あたりの基本ポイント振れ幅
  maxIterations: 200,   // 収束しない場合の安全上限
  convergenceEpsilon: 0.01,
  scaleTarget: 100,     // #1のスコアをこの値にスケーリングする
  minTournaments: 1,    // 足切り大会数（design.md 10章で確定）
};

// 大会規模による重み。tournament.weight が未設定(null)の場合は参加人数から暫定算出する。
function getTournamentWeight(tournament) {
  if (tournament.weight != null) return tournament.weight;
  return tournament.participantIds.length;
}

// 大会の開催日をもとに、直近Nヶ月以内の試合だけを残す。日付未設定の大会の試合は対象外とする
// （いつの試合か判定できないため）。periodMonths が null/'all' の場合は全期間（フィルタなし）。
export function filterMatchesByPeriod(state, periodMonths) {
  if (periodMonths == null || periodMonths === 'all') return state.matches;

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - Number(periodMonths));
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const dateByTournament = new Map(state.tournaments.map((t) => [t.id, t.date]));
  return state.matches.filter((m) => {
    const date = dateByTournament.get(m.tournamentId);
    return date && date >= cutoffStr;
  });
}

// state（players/tournaments/matches）からランキングを計算する。
// 戻り値: [{ id, name, score, tournamentsPlayed, rank }] （スコア降順、足切り対象は除外）
export function computeRankings(state) {
  const { matches, tournaments, players } = state;

  const participantIds = new Set();
  matches.forEach((m) => {
    participantIds.add(m.winnerId);
    participantIds.add(m.loserId);
  });
  if (participantIds.size === 0) return [];

  const weightByTournament = new Map();
  tournaments.forEach((t) => weightByTournament.set(t.id, getTournamentWeight(t)));
  const weightValues = [...weightByTournament.values()];
  const avgWeight = weightValues.length
    ? weightValues.reduce((a, b) => a + b, 0) / weightValues.length
    : 1;

  let scores = new Map();
  participantIds.forEach((id) => scores.set(id, RANKING_CONFIG.initialScore));

  for (let iter = 0; iter < RANKING_CONFIG.maxIterations; iter += 1) {
    const sums = new Map();
    participantIds.forEach((id) => sums.set(id, { total: 0, count: 0 }));

    matches.forEach((m) => {
      const rawWeight = weightByTournament.get(m.tournamentId) ?? avgWeight;
      const relativeWeight = avgWeight > 0 ? rawWeight / avgWeight : 1;
      const bonus = RANKING_CONFIG.kFactor * relativeWeight;

      const winnerScore = scores.get(m.winnerId);
      const loserScore = scores.get(m.loserId);

      // 勝者は「敗者の強さ + ボーナス」を観測値として得る（強い相手ほど得点が高い）。
      const winnerSum = sums.get(m.winnerId);
      winnerSum.total += loserScore + bonus;
      winnerSum.count += 1;

      // 敗者は「勝者の強さ - ボーナス」を観測値として得る（弱い相手に負けるほど失点が大きい）。
      const loserSum = sums.get(m.loserId);
      loserSum.total += winnerScore - bonus;
      loserSum.count += 1;
    });

    let maxDelta = 0;
    const nextScores = new Map();
    participantIds.forEach((id) => {
      const { total, count } = sums.get(id);
      const newScore = count > 0 ? total / count : scores.get(id);
      maxDelta = Math.max(maxDelta, Math.abs(newScore - scores.get(id)));
      nextScores.set(id, newScore);
    });
    scores = nextScores;

    if (maxDelta < RANKING_CONFIG.convergenceEpsilon) break;
  }

  const tournamentsPlayedByPlayer = new Map();
  matches.forEach((m) => {
    [m.winnerId, m.loserId].forEach((id) => {
      if (!tournamentsPlayedByPlayer.has(id)) tournamentsPlayedByPlayer.set(id, new Set());
      tournamentsPlayedByPlayer.get(id).add(m.tournamentId);
    });
  });

  const maxScore = Math.max(...scores.values());
  const scale = maxScore > 0 ? RANKING_CONFIG.scaleTarget / maxScore : 1;

  return [...participantIds]
    .map((id) => {
      const player = players.find((p) => p.id === id);
      const tournamentsPlayed = tournamentsPlayedByPlayer.get(id)?.size ?? 0;
      return {
        id,
        name: player ? player.currentName : id,
        score: scores.get(id) * scale,
        tournamentsPlayed,
      };
    })
    .filter((r) => r.tournamentsPlayed >= RANKING_CONFIG.minTournaments)
    .sort((a, b) => b.score - a.score)
    .map((r, idx) => ({ ...r, rank: idx + 1 }));
}

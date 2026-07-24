import { state } from './state.js';
import { tournamentTier } from './tournamentTier.js';

// 「勝ち上がりの深さ」を表示用のラベルにする。優勝=1、準優勝=2、ベストN=N。
function depthLabel(depth) {
  if (depth <= 1) return '優勝';
  if (depth === 2) return '準優勝';
  return `ベスト${depth}`;
}

// 大会での成績を確定済みの記録（state.placements）から引く。
// 出場していない大会・対戦表が組まれる前の大会では null。
//
// 運営が結果を確定させていない大会では成績を出さない。表が埋まっただけの段階で
// 「優勝」と表示してしまうと、確定前に結果が広まり、入力ミスを直せなくなる。
// 記録はまさにその確定操作のときに書き込まれるので、有無がそのまま判定になる。
export function placementLabel(tournamentId, playerId) {
  if (!state.bracketIds.has(tournamentId)) return null;

  const tournament = state.tournaments.find((t) => t.id === tournamentId);
  if (!tournament || !tournament.participantIds.includes(playerId)) return null;
  if (tournament.status !== 'finished') return '進行中';

  const depth = state.placements[tournamentId]?.[playerId];
  return depth == null ? '進行中' : depthLabel(depth);
}

// 大会の優勝者。結果が確定していなければ null。
export function championOfTournament(tournamentId) {
  const byPlayer = state.placements[tournamentId];
  if (!byPlayer) return null;
  return Object.keys(byPlayer).find((playerId) => byPlayer[playerId] === 1) ?? null;
}

// 選手の「好成績」＝出場大会の中から、参加人数で重み付けして最も価値の高い成績を1つ選ぶ。
// 例: 32人大会の優勝（32/1=32）は、8人大会の優勝（8/1=8）より高く評価される。
// 同様に64人大会のベスト4（64/4=16）は8人大会の優勝（8）より高く評価される。
// tournamentIds を渡すと、その大会（IDのSet）だけを対象にする（ランキングの集計期間と揃えるため）。
// まだ大会が終わっていない（進行中）・出場していない大会は対象外。該当なしの場合は null を返す。
export function bestAchievement(playerId, tournamentIds = null) {
  const targets = state.tournaments.filter(
    (t) => (tournamentIds == null || tournamentIds.has(t.id)) && t.status === 'finished',
  );

  let best = null;
  targets.forEach((t) => {
    const depth = state.placements[t.id]?.[playerId];
    if (depth == null) return;
    const participantCount = t.participantIds.length;
    const value = participantCount / depth;
    if (!best || value > best.value) {
      best = {
        label: depthLabel(depth),
        tournamentName: t.name,
        participantCount,
        tier: tournamentTier(participantCount),
        value,
      };
    }
  });

  return best;
}

// 選手個人の戦績サマリー（通算・大会別・試合一覧）を state から集計する。
export function getPlayerStats(playerId) {
  const playerMatches = state.matches.filter(
    (m) => m.winnerId === playerId || m.loserId === playerId,
  );
  const wins = playerMatches.filter((m) => m.winnerId === playerId).length;
  const losses = playerMatches.length - wins;

  const tournamentIds = new Set(playerMatches.map((m) => m.tournamentId));
  state.tournaments.forEach((t) => {
    if (t.participantIds.includes(playerId)) tournamentIds.add(t.id);
  });

  const tournaments = state.tournaments
    .filter((t) => tournamentIds.has(t.id))
    .map((t) => {
      const tm = playerMatches.filter((m) => m.tournamentId === t.id);
      return {
        tournament: t,
        wins: tm.filter((m) => m.winnerId === playerId).length,
        losses: tm.filter((m) => m.loserId === playerId).length,
        placement: placementLabel(t.id, playerId),
      };
    });

  return { matches: playerMatches, wins, losses, tournaments };
}

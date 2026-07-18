import { state } from './state.js';
import { getChampionId } from './bracket.js';

// ブラケットから選手の最終成績（優勝/準優勝/ベストN/進行中）を求める。
// ブラケットが無い・出場していない場合は null。
export function placementLabel(tournamentId, playerId) {
  const bracket = state.brackets[tournamentId];
  if (!bracket) return null;

  const entered = bracket.rounds[0].matches.some(
    (m) => m.player1Id === playerId || m.player2Id === playerId,
  );
  if (!entered) return null;

  if (getChampionId(bracket) === playerId) return '優勝';

  for (let r = 0; r < bracket.rounds.length; r += 1) {
    for (const m of bracket.rounds[r].matches) {
      if (m.confirmed && m.loserId === playerId) {
        if (r === bracket.rounds.length - 1) return '準優勝';
        return `ベスト${bracket.bracketSize / 2 ** r}`;
      }
    }
  }
  return '進行中';
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

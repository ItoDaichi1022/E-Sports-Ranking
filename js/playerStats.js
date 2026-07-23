import { state } from './state.js';
import { getChampionId } from './bracket.js';
import { tournamentTier } from './tournamentTier.js';

// ブラケットから選手の最終成績（優勝/準優勝/ベストN/進行中）を求める。
// ブラケットが無い・出場していない場合は null。
//
// 運営が結果を確定させていない大会では成績を出さない。表が埋まっただけの段階で
// 「優勝」と表示してしまうと、確定前に結果が広まり、入力ミスを直せなくなる。
export function placementLabel(tournamentId, playerId) {
  const bracket = state.brackets[tournamentId];
  if (!bracket) return null;

  const entered = bracket.rounds[0].matches.some(
    (m) => m.player1Id === playerId || m.player2Id === playerId,
  );
  if (!entered) return null;

  const tournament = state.tournaments.find((t) => t.id === tournamentId);
  if (tournament && tournament.status !== 'finished') return '進行中';

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

// 順位ラベルを「勝ち上がりの深さ」を表す数値に変換する。優勝=1、準優勝=2、ベストN=N。
// 数値が小さいほど上位。進行中・null（未出場/大会がまだ終わっていない）は比較対象外として null を返す。
function placementDepth(label) {
  if (label === '優勝') return 1;
  if (label === '準優勝') return 2;
  const m = /^ベスト(\d+)$/.exec(label);
  return m ? Number(m[1]) : null;
}

// 選手の「好成績」＝出場大会の中から、参加人数で重み付けして最も価値の高い成績を1つ選ぶ。
// 例: 32人大会の優勝（32/1=32）は、8人大会の優勝（8/1=8）より高く評価される。
// 同様に64人大会のベスト4（64/4=16）は8人大会の優勝（8）より高く評価される。
// tournamentIds を渡すと、その大会（IDのSet）だけを対象にする（ランキングの集計期間と揃えるため）。
// まだ大会が終わっていない（進行中）・出場していない大会は対象外。該当なしの場合は null を返す。
export function bestAchievement(playerId, tournamentIds = null) {
  const targets = state.tournaments.filter(
    (t) => (tournamentIds == null || tournamentIds.has(t.id)) && state.brackets[t.id],
  );

  let best = null;
  targets.forEach((t) => {
    const label = placementLabel(t.id, playerId);
    const depth = label ? placementDepth(label) : null;
    if (depth == null) return;
    const participantCount = t.participantIds.length;
    const value = participantCount / depth;
    if (!best || value > best.value) {
      best = { label, tournamentName: t.name, participantCount, tier: tournamentTier(participantCount), value };
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

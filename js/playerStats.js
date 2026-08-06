import { state, findTournament, isTeamTournament, getPlayerName } from './state.js';
import { tournamentTier } from './tournamentTier.js';

// 「勝ち上がりの深さ」を表示用のラベルにする。優勝=1、準優勝=2、ベストN=N。
function depthLabel(depth) {
  if (depth <= 1) return '優勝';
  if (depth === 2) return '準優勝';
  // 3 が入るのは三位決定戦を行った大会だけ。行わない大会では準決勝で負けた2人とも
  // ベスト4（depth=4）になるので、「3位」と出ることはない。
  if (depth === 3) return '3位';
  return `ベスト${depth}`;
}

// 出場した大会での成績の表示。depth は確定済みの勝ち上がりの深さ（DBの placement）で、
// 未確定なら null を渡す。
//
// 運営が結果を確定させていない大会では成績を出さない。表が埋まっただけの段階で
// 「優勝」と表示してしまうと、確定前に結果が広まり、入力ミスを直せなくなる。
// 記録はまさにその確定操作のときに書き込まれるので、有無がそのまま判定になる。
export function placementLabelOf(tournamentId, depth) {
  if (!state.bracketIds.has(tournamentId)) return null;

  const tournament = findTournament(tournamentId);
  if (!tournament) return null;
  if (tournament.status !== 'finished') return '進行中';

  return depth == null ? '進行中' : depthLabel(depth);
}

// 大会の優勝者の表示名。結果が確定していなければ null。
//
// チーム戦ではチーム名を返す。メンバー全員のエントリー行に優勝の記録が入っているので、
// 選手名で返すと片方だけが優勝者として出てしまう。
//
// チーム名は、チームの行を読み込んでいない大会でも一覧に出せるよう
// state.teamChampions に控えてある（db.js の loadAll が集める）。
export function championLabel(tournamentId) {
  const tournament = findTournament(tournamentId);
  if (isTeamTournament(tournament)) {
    return tournament?.teams.find((tm) => tm.placement === 1)?.name
      ?? state.teamChampions[tournamentId]
      ?? null;
  }

  const byPlayer = state.placements[tournamentId];
  if (!byPlayer) return null;
  const championId = Object.keys(byPlayer).find((playerId) => byPlayer[playerId] === 1);
  return championId ? getPlayerName(championId) : null;
}

// 選手の「好成績」＝出場大会の中から、参加人数で重み付けして価値の高い順に並べる。
// 例: 32人大会の優勝（32/1=32）は、8人大会の優勝（8/1=8）より高く評価される。
// 同様に64人大会のベスト4（64/4=16）は8人大会の優勝（8）より高く評価される。
// tournamentIds を渡すと、その大会（IDのSet）だけを対象にする（ランキングの集計期間と揃えるため）。
// まだ大会が終わっていない（進行中）・出場していない大会は対象外。
//
// limit 件に満たなければ、あるぶんだけ返す（出場が1大会だけの選手もいる）。
// 順位発表の画面（js/reveal.js）が3件並べるために複数版を使い、
// ランキングの計算（js/ranking.js）は下の1件版を使う。
export function topAchievements(playerId, tournamentIds = null, limit = 3) {
  const targets = state.tournaments.filter(
    (t) => (tournamentIds == null || tournamentIds.has(t.id)) && t.status === 'finished',
  );

  const found = [];
  targets.forEach((t) => {
    const depth = state.placements[t.id]?.[playerId];
    if (depth == null) return;
    // 規模は出場枠の数で測る。チーム戦の「16チーム大会」を32人大会として扱うと、
    // 表の大きさ（＝勝ち上がりの重み）と釣り合わなくなる。
    const participantCount = t.entrantCount;
    found.push({
      label: depthLabel(depth),
      tournamentName: t.name,
      participantCount,
      tier: tournamentTier(participantCount),
      value: participantCount / depth,
    });
  });

  return found.sort((a, b) => b.value - a.value).slice(0, limit);
}

// 好成績を1つだけ選ぶ版。ランキングの計算と、公開済みスナップショットに焼き込む
// bestAchievement はこちら。該当なしの場合は null を返す。
export function bestAchievement(playerId, tournamentIds = null) {
  return topAchievements(playerId, tournamentIds, 1)[0] ?? null;
}

// 選手個人の戦績サマリー（通算・大会別・試合一覧）を、その選手ぶんだけ取ってきた
// 記録（db.loadPlayerRecord の戻り値）から組み立てる。
//
// 全選手の試合を state に持たなくても組めるよう、材料は引数で受け取る。
//   record.matches  その選手が勝者か敗者として記録されている試合
//   record.entries  その選手の出場記録 { tournamentId, placement, teamName }
//
// 通算に数えるのは選手として記録された試合だけ。チーム戦（2v2）の試合は
// チーム列に記録されていて winnerId が null なので、ここには入らない
// （個人の通算成績にチーム戦の勝敗を混ぜない、という方針）。
// 出場した大会そのものは出場記録から拾うので、2v2も一覧には並ぶ。
export function getPlayerStats(playerId, record) {
  const { matches: playerMatches, entries } = record;

  const wins = playerMatches.filter((m) => m.winnerId === playerId).length;
  const losses = playerMatches.filter((m) => m.loserId === playerId).length;

  const placementByTournament = new Map(entries.map((e) => [e.tournamentId, e.placement]));
  const teamNameByTournament = new Map(entries.map((e) => [e.tournamentId, e.teamName]));

  const tournamentIds = new Set(entries.map((e) => e.tournamentId));
  playerMatches.forEach((m) => tournamentIds.add(m.tournamentId));

  const tournaments = state.tournaments
    .filter((t) => tournamentIds.has(t.id))
    .map((t) => {
      const tm = playerMatches.filter((m) => m.tournamentId === t.id);
      return {
        tournament: t,
        wins: tm.filter((m) => m.winnerId === playerId).length,
        losses: tm.filter((m) => m.loserId === playerId).length,
        placement: placementLabelOf(t.id, placementByTournament.get(t.id) ?? null),
        // チーム戦のときだけ、どのチームで出たか
        teamName: teamNameByTournament.get(t.id) ?? null,
      };
    });

  return { matches: playerMatches, wins, losses, tournaments };
}

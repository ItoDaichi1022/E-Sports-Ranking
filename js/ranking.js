import { bestAchievement } from './playerStats.js';
import { isRankedTournament } from './rankingEligibility.js';
import { getEntrantMemberIds } from './state.js';

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

// 大会規模による重み。tournament.weight が未設定(null)の場合は出場枠の数から暫定算出する。
// （ここに来るのは1v1・リレーの大会だけなので、出場枠＝参加人数）
function getTournamentWeight(tournament) {
  if (tournament.weight != null) return tournament.weight;
  return tournament.entrantCount;
}

// 各ランキングエントリに、前回公開時点の順位（previousRank）を付与する。
// 前回ランキングに存在しなかった選手は previousRank が null になり、新規ランクイン扱いにできる。
export function withRankChange(rankings, previousRankings) {
  const prevRankById = new Map((previousRankings ?? []).map((r) => [r.id, r.rank]));
  return rankings.map((r) => ({
    ...r,
    previousRank: prevRankById.has(r.id) ? prevRankById.get(r.id) : null,
  }));
}

// previousRank と現在の rank から表示用のラベル・色分けクラスを決める。
// previousRank が undefined（古い形式の公開データ等）の場合は表示自体を呼び出し側で省く想定。
export function rankChangeInfo(previousRank, rank) {
  if (previousRank == null) return { label: 'NEW', className: 'new' };
  const diff = previousRank - rank; // 正の値 = 順位が上がった（数値が減った）
  if (diff > 0) return { label: `▲${diff}`, className: 'up' };
  if (diff < 0) return { label: `▼${-diff}`, className: 'down' };
  return { label: '―', className: 'same' };
}

// カレンダーで選んだ開始日・終了日（'YYYY-MM-DD' 文字列。どちらも省略可）から
// ランキングをまとめて計算する。renderRankingPage / 公開ボタン / 画像書き出しボタンの
// 3箇所で同じ計算が必要なため共通化する。
export function computeRankingsForRange(state, { start = null, end = null } = {}) {
  const filteredMatches = filterMatchesByRange(state, { start, end });
  return {
    periodStart: start,
    periodEnd: end,
    rankings: computeRankings({ ...state, matches: filteredMatches }),
  };
}

// 大会の開催日（'YYYY-MM-DD'）が start〜end の範囲に入っている試合だけを残す。
// 日付未設定の大会の試合は対象外とする（いつの試合か判定できないため）。
// start・end はどちらも省略可（null）で、省略した側は無制限になる。
// 両方省略なら全期間（フィルタなし）。
export function filterMatchesByRange(state, { start = null, end = null } = {}) {
  if (!start && !end) return state.matches;

  const dateByTournament = new Map(state.tournaments.map((t) => [t.id, t.date]));
  return state.matches.filter((m) => {
    const date = dateByTournament.get(m.tournamentId);
    if (!date) return false;
    if (start && date < start) return false;
    if (end && date > end) return false;
    return true;
  });
}

// 試合一覧から「選手ID -> 出場した大会IDのSet」を作る。
//
// チーム戦の試合は選手列が空なので、チームのメンバー全員に出場を数える。
// これは「その大会に出たか」を集めるだけで、勝敗のスコアには影響しない
// （スコアに使う rankedMatches にチーム戦の試合は含まれない）。数えておかないと
// 2v2で優勝しても、ランキングカードの「好成績」に選ばれなくなる。
function countTournamentsByPlayer(matches) {
  const byPlayer = new Map();
  matches.forEach((m) => {
    const ids = m.winnerTeamId
      ? [
        ...getEntrantMemberIds(m.tournamentId, m.winnerTeamId),
        ...getEntrantMemberIds(m.tournamentId, m.loserTeamId),
      ]
      : [m.winnerId, m.loserId];

    ids.forEach((id) => {
      if (!id) return;
      if (!byPlayer.has(id)) byPlayer.set(id, new Set());
      byPlayer.get(id).add(m.tournamentId);
    });
  });
  return byPlayer;
}

// 反復スコアリングの本体。収束したスコアと、計算に使った材料をそのまま返す。
//
// 順位を出す computeRankings と、大会ごとの寄与を出す scoreContributionsByPlayer が
// まったく同じ計算を二度書かないために切り出してある。片方だけ式をいじると
// 「発表画面に出る根拠」と「実際の順位」が食い違うので、必ずここを直すこと。
function runScoring(state) {
  const { matches, tournaments } = state;

  const rankedTournamentIds = new Set(
    tournaments.filter(isRankedTournament).map((t) => t.id),
  );
  const rankedMatches = matches.filter((m) => rankedTournamentIds.has(m.tournamentId));

  const participantIds = new Set();
  rankedMatches.forEach((m) => {
    participantIds.add(m.winnerId);
    participantIds.add(m.loserId);
  });
  if (participantIds.size === 0) {
    return {
      scores: new Map(), scale: 1, participantIds, rankedMatches, bonusOf: () => 0,
    };
  }

  // 重みの平均は「実際に集計する大会」だけで取る。対象外の大会を混ぜると、
  // 各試合の相対的な重み（rawWeight / avgWeight）が実態からずれる。
  const weightByTournament = new Map();
  tournaments.forEach((t) => {
    if (rankedTournamentIds.has(t.id)) weightByTournament.set(t.id, getTournamentWeight(t));
  });
  const weightValues = [...weightByTournament.values()];
  const avgWeight = weightValues.length
    ? weightValues.reduce((a, b) => a + b, 0) / weightValues.length
    : 1;

  const bonusOf = (tournamentId) => {
    const rawWeight = weightByTournament.get(tournamentId) ?? avgWeight;
    const relativeWeight = avgWeight > 0 ? rawWeight / avgWeight : 1;
    return RANKING_CONFIG.kFactor * relativeWeight;
  };

  let scores = new Map();
  participantIds.forEach((id) => scores.set(id, RANKING_CONFIG.initialScore));

  for (let iter = 0; iter < RANKING_CONFIG.maxIterations; iter += 1) {
    const sums = new Map();
    participantIds.forEach((id) => sums.set(id, { total: 0, count: 0 }));

    rankedMatches.forEach((m) => {
      const bonus = bonusOf(m.tournamentId);
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

  const maxScore = Math.max(...scores.values());
  const scale = maxScore > 0 ? RANKING_CONFIG.scaleTarget / maxScore : 1;

  return { scores, scale, participantIds, rankedMatches, bonusOf };
}

// 選手ごとに「どの大会がスコアを押し上げたか」を、効いた順に並べて返す。
// 戻り値: Map<選手ID, [{ tournamentId, score, matchCount, wins, losses }]>（score降順）
//
// 【なぜ順位ではなくこれで選ぶのか】
// スコアは1試合ごとの観測値（勝てば「相手の強さ+ボーナス」、負ければ
// 「相手の強さ-ボーナス」）の平均に収束する。つまり平均より高い観測値を出した大会が
// スコアを押し上げ、低い大会が押し下げている。大会ごとに観測値の平均を出して
// 高い順に並べれば、それがそのまま「スコアに良い影響を与えた大会」の順になる。
//
// これは順位（優勝・ベスト4）とは一致しないことがある。少人数の大会で優勝するより、
// 強豪ぞろいの大会で上位に食い込むほうがスコアには効く ── その差がこの方式の要点で、
// 発表画面はこちらの順で3件を選ぶ。
//
// 観測値は収束後のスコアでもう一度取り直す。反復の途中の値には、まだ動いている
// スコアが混ざっていて、大会どうしを比べる物差しにならないため。
export function scoreContributionsByPlayer(state) {
  const { scores, scale, rankedMatches, bonusOf } = runScoring(state);

  const byPlayer = new Map();
  const observe = (playerId, tournamentId, observed, won) => {
    if (!playerId) return;
    if (!byPlayer.has(playerId)) byPlayer.set(playerId, new Map());
    const byTournament = byPlayer.get(playerId);
    if (!byTournament.has(tournamentId)) {
      byTournament.set(tournamentId, {
        tournamentId, total: 0, matchCount: 0, wins: 0, losses: 0,
      });
    }
    const row = byTournament.get(tournamentId);
    row.total += observed;
    row.matchCount += 1;
    if (won) row.wins += 1;
    else row.losses += 1;
  };

  rankedMatches.forEach((m) => {
    const bonus = bonusOf(m.tournamentId);
    observe(m.winnerId, m.tournamentId, scores.get(m.loserId) + bonus, true);
    observe(m.loserId, m.tournamentId, scores.get(m.winnerId) - bonus, false);
  });

  const result = new Map();
  byPlayer.forEach((byTournament, playerId) => {
    result.set(playerId, [...byTournament.values()]
      .map((row) => ({
        tournamentId: row.tournamentId,
        matchCount: row.matchCount,
        wins: row.wins,
        losses: row.losses,
        // 画面に出ているスコアと同じ物差しにそろえる（順位表と桁が違うと比べられない）
        score: (row.total / row.matchCount) * scale,
      }))
      .sort((a, b) => b.score - a.score));
  });
  return result;
}

// state（players/tournaments/matches）からランキングを計算する。
// 戻り値: [{ id, name, score, tournamentsPlayed, rank }] （スコア降順、足切り対象は除外）
//
// スコアの計算に使うのは「ランキング反映の条件を満たす大会」の試合だけ
// （条件は js/rankingEligibility.js）。ただし好成績（bestAchievement）は
// 条件を満たさない大会からも選ぶ。優勝は優勝として讃えたいが、少人数の大会や
// チーム戦の勝敗までレートに混ぜると個人の実力指標として成り立たなくなるため。
export function computeRankings(state) {
  const { matches, players } = state;
  const { scores, scale, participantIds, rankedMatches } = runScoring(state);
  if (participantIds.size === 0) return [];

  // 足切り（minTournaments）と表示に使う出場大会数は、スコアの根拠と揃えて
  // 反映対象の大会だけを数える。
  const tournamentsPlayedByPlayer = countTournamentsByPlayer(rankedMatches);
  // 好成績はスコアと違い、対象外の大会も含めて集計期間内の全出場大会から選ぶ。
  const allTournamentsByPlayer = countTournamentsByPlayer(matches);

  return [...participantIds]
    .map((id) => {
      const player = players.find((p) => p.id === id);
      const tournamentsPlayed = tournamentsPlayedByPlayer.get(id)?.size ?? 0;
      return {
        id,
        name: player ? player.currentName : id,
        score: scores.get(id) * scale,
        tournamentsPlayed,
        bestAchievement: bestAchievement(id, allTournamentsByPlayer.get(id) ?? new Set()),
      };
    })
    .filter((r) => r.tournamentsPlayed >= RANKING_CONFIG.minTournaments)
    .sort((a, b) => b.score - a.score)
    .map((r, idx) => ({ ...r, rank: idx + 1 }));
}

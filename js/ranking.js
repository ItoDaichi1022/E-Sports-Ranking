import { bestAchievement } from './playerStats.js';
import { isRankedTournament } from './rankingEligibility.js';
import { getEntrantMemberIds } from './state.js';

// LumiRank軽量版：相手の強さで重み付けした反復スコアリングのみを残した最小実装。
// doc/design.md の「8. ランキング方式」に準拠する。
export const RANKING_CONFIG = {
  initialScore: 1000,   // 全選手の初期スコア（相対値のみ意味を持つ）
  scoreSpread: 400,     // このスコア差で期待勝率が約91%（10:1）になる物差し
  priorMatches: 2,      // 全員に足す「初期値の仮想相手との引き分け」の回数
  maxIterations: 200,   // 収束しない場合の安全上限（実データでは十数回で収束する）
  convergenceEpsilon: 0.01,
  maxStepPerIteration: 400, // 1回の更新で動かせる上限（発散止め）
  scaleTarget: 100,     // #1のスコアをこの値にスケーリングする
  minTournaments: 1,    // 足切り大会数（design.md 10章で確定）
};

// スコア差から期待勝率を出す。Eloと同じロジスティック曲線で、
// scoreSpread（400）点の差がついていると強い側の期待勝率が約91%になる。
//
// 【この関数がランキングの中心にある理由】
// 勝敗を「期待勝率とのズレ」で測るため。格上に勝てば大きく上がり、格下に勝っても
// ほとんど上がらない ── その差を作るのがこの曲線で、勝ち星をただ数える方式や、
// 1試合ごとの観測値を平均する方式では作れない（doc/design.md 8章の「averaging方式で
// 起きた不都合」）。
export function winProbability(scoreA, scoreB) {
  return 1 / (1 + 10 ** ((scoreB - scoreA) / RANKING_CONFIG.scoreSpread));
}

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
// ランキングをまとめて計算する。順位発表の画面（js/reveal.js）が、発表するランキングの
// プレビューと「前回の順位」の保存の両方で同じ計算を要るため共通化してある。
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
//
// 【何を解いているか】
// 各選手にスコアを1つ与え、「そのスコア差から出る期待勝率で、実際の勝敗がいちばん
// 起こりやすくなる」組み合わせを探す（Elo／Bradley-Terryの最尤推定）。1試合ごとに
//
//   勝ち星の余剰 = 実際の結果(勝ち1 / 負け0) − 期待勝率
//
// を集め、これが釣り合う位置までスコアを動かす。格上に勝てば余剰が大きく、格下に
// 勝ってもほぼ0 ── だから「勝ち上がった選手が、初戦で負けた選手と並ぶ」ことは起きない。
//
// 【試合数の少ない選手の扱い（priorMatches）】
// 全員に「初期値と同じ強さの仮想相手と priorMatches 回引き分けた」ぶんを足してある。
// これが無いと、1試合しかしていない無敗の選手が無限に上がってしまう（優勝者も同じ）。
// 引き戻す力があるので、試合数が少ない選手のスコアは初期値の近くに留まり、
// 試合を重ねた選手ほど自分の成績どおりの位置まで動ける。
//
// 【解き方】
// 選手ごとに1階微分（勝ち星の余剰）と2階微分（そのスコア帯で1点動かしたときの効き）を
// 出し、その比だけ動かす（対角ニュートン法）。全選手を同時に更新し、動きが
// convergenceEpsilon 未満になったら収束とみなす。実データでは十数回で収まる。
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
      scores: new Map(), scale: 1, participantIds, rankedMatches, weightOf: () => 1,
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

  // 各試合の重み。平均を1にした相対値で、大きい大会の1勝ほど大きくスコアを動かす。
  const weightOf = (tournamentId) => {
    const rawWeight = weightByTournament.get(tournamentId) ?? avgWeight;
    return avgWeight > 0 ? rawWeight / avgWeight : 1;
  };

  const {
    initialScore, scoreSpread, priorMatches,
    maxIterations, convergenceEpsilon, maxStepPerIteration,
  } = RANKING_CONFIG;

  const scores = new Map();
  participantIds.forEach((id) => scores.set(id, initialScore));

  for (let iter = 0; iter < maxIterations; iter += 1) {
    // surplus: 勝ち星の余剰（実際の結果 − 期待勝率）の合計。プラスなら上げる方向。
    // information: そのスコア帯で1点動かしたときの効きの大きさ。勝率が五分に近い試合ほど
    // 大きく、力量差がはっきりしている試合ほど小さい（＝動かしても情報が増えない）。
    const surplus = new Map();
    const information = new Map();
    participantIds.forEach((id) => {
      surplus.set(id, 0);
      information.set(id, 0);
    });

    rankedMatches.forEach((m) => {
      const weight = weightOf(m.tournamentId);
      const winnerProb = winProbability(scores.get(m.winnerId), scores.get(m.loserId));
      // 勝者から見た余剰。敗者にはそのまま符号を反転して入る（合計は必ず釣り合う）。
      const gain = weight * (1 - winnerProb);
      const info = weight * winnerProb * (1 - winnerProb);

      surplus.set(m.winnerId, surplus.get(m.winnerId) + gain);
      surplus.set(m.loserId, surplus.get(m.loserId) - gain);
      information.set(m.winnerId, information.get(m.winnerId) + info);
      information.set(m.loserId, information.get(m.loserId) + info);
    });

    let maxDelta = 0;
    const nextScores = new Map();
    participantIds.forEach((id) => {
      // 仮想相手（初期値）との引き分けを priorMatches 回ぶん足す。実際の試合とまったく
      // 同じ形で足すので、試合数が増えれば自然に効きが薄れていく。
      const priorProb = winProbability(scores.get(id), initialScore);
      const totalSurplus = surplus.get(id) + priorMatches * (0.5 - priorProb);
      const totalInfo = information.get(id) + priorMatches * priorProb * (1 - priorProb);

      // 余剰（勝ち星の単位）を、効きの大きさでスコアの単位（点）に直す。
      // Math.LN10 は、期待勝率が10のべき乗で書かれていることから出てくる係数。
      const rawStep = (scoreSpread * totalSurplus) / (Math.LN10 * Math.max(totalInfo, 1e-9));
      const step = Math.max(-maxStepPerIteration, Math.min(maxStepPerIteration, rawStep));

      maxDelta = Math.max(maxDelta, Math.abs(step));
      nextScores.set(id, scores.get(id) + step);
    });
    nextScores.forEach((value, id) => scores.set(id, value));

    if (maxDelta < convergenceEpsilon) break;
  }

  const maxScore = Math.max(...scores.values());
  const scale = maxScore > 0 ? RANKING_CONFIG.scaleTarget / maxScore : 1;

  return { scores, scale, participantIds, rankedMatches, weightOf };
}

// 選手ごとに「どの大会がスコアを押し上げたか」を、効いた順に並べて返す。
// 戻り値: Map<選手ID, [{ tournamentId, impact, matchCount, wins, losses }]>（impact降順）
//
// 【impact とは】
// その大会で挙げた「勝ち星の余剰」の合計 ── 実際の勝ち数から、スコアどおりなら
// そうなったはずの期待勝ち数を引いた値（大会規模の重み付き）。スコアはこの余剰が
// 釣り合う位置で決まるので（runScoring）、余剰がプラスの大会はスコアを押し上げ、
// マイナスの大会は押し下げている。単位は点ではなく勝ち星で、大会どうしを比べるための
// 物差しとしてだけ使う。
//
// 【なぜ順位ではなくこれで選ぶのか】
// 少人数の大会で優勝するより、強豪ぞろいの大会で上位に食い込むほうがスコアには効く
// ── その差がこの方式の要点で、発表画面はこちらの順で3件を選ぶ。負けた試合でも、
// 期待勝率より上の内容（＝格上との対戦）なら余剰はマイナスに振れにくい。
//
// 期待勝率は収束後のスコアで取り直す。反復の途中の値には、まだ動いているスコアが
// 混ざっていて、大会どうしを比べる物差しにならないため。
export function scoreContributionsByPlayer(state) {
  const { scores, rankedMatches, weightOf } = runScoring(state);

  const byPlayer = new Map();
  const observe = (playerId, tournamentId, gained, won) => {
    if (!playerId) return;
    if (!byPlayer.has(playerId)) byPlayer.set(playerId, new Map());
    const byTournament = byPlayer.get(playerId);
    if (!byTournament.has(tournamentId)) {
      byTournament.set(tournamentId, {
        tournamentId, impact: 0, matchCount: 0, wins: 0, losses: 0,
      });
    }
    const row = byTournament.get(tournamentId);
    row.impact += gained;
    row.matchCount += 1;
    if (won) row.wins += 1;
    else row.losses += 1;
  };

  rankedMatches.forEach((m) => {
    const weight = weightOf(m.tournamentId);
    const winnerProb = winProbability(scores.get(m.winnerId), scores.get(m.loserId));
    const gain = weight * (1 - winnerProb);
    observe(m.winnerId, m.tournamentId, gain, true);
    observe(m.loserId, m.tournamentId, -gain, false);
  });

  const result = new Map();
  byPlayer.forEach((byTournament, playerId) => {
    result.set(playerId, [...byTournament.values()]
      .sort((a, b) => b.impact - a.impact));
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

  // 同点のときの並び順を決めるための勝ち数（表示には出さない）。
  // 力量が本当に同じ形の成績（対称なブラケットの別ブロックなど）では小数点まで同じ
  // スコアになりうる。そのままだと並びが試合データの読み込み順で変わってしまうので、
  // 勝ち数 → 名前 で必ず同じ順になるようにする。
  const winsByPlayer = new Map();
  rankedMatches.forEach((m) => {
    if (!m.winnerId) return;
    winsByPlayer.set(m.winnerId, (winsByPlayer.get(m.winnerId) ?? 0) + 1);
  });

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
    .sort((a, b) => (
      b.score - a.score
      || (winsByPlayer.get(b.id) ?? 0) - (winsByPlayer.get(a.id) ?? 0)
      || a.name.localeCompare(b.name, 'ja')
    ))
    .map((r, idx) => ({ ...r, rank: idx + 1 }));
}

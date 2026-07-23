import { state, newId } from './state.js';

// 次の2のべき乗を返す（n=1の場合も2を返す：1人トーナメントは成立しないため呼び出し側で弾く）
export function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

// 標準的なブラケットのシード配置順を返す（例: size=8 -> [1,8,4,5,2,7,3,6]）
// 上位シードほど後の対戦相手が弱くなるよう、対戦表の対角に配置される。
export function seedOrder(size) {
  let positions = [1];
  while (positions.length < size) {
    const doubled = positions.length * 2;
    const next = [];
    positions.forEach((p) => {
      next.push(p);
      next.push(doubled + 1 - p);
    });
    positions = next;
  }
  return positions;
}

// ラウンド名を決定する。決勝=F、準決勝=SF、準々決勝=QFとし、それより前はR1,R2,...とする。
export function roundName(totalRounds, roundIndex) {
  const fromEnd = totalRounds - roundIndex;
  if (fromEnd === 1) return 'F';
  if (fromEnd === 2) return 'SF';
  if (fromEnd === 3) return 'QF';
  return `R${roundIndex + 1}`;
}

function findMatchById(bracket, matchId) {
  for (const round of bracket.rounds) {
    const m = round.matches.find((x) => x.id === matchId);
    if (m) return m;
  }
  return null;
}

function makeEmptyMatch(round) {
  return {
    id: newId(),
    round,
    player1Id: null,
    player2Id: null,
    winnerId: null,
    loserId: null,
    score: null,
    confirmed: false,
    isBye: false,
    nextMatchId: null,
    nextSlot: null,
  };
}

// 勝者を確定させ、次ラウンドの対応スロットへ進出させる（BYE解決にも使う共通処理）。
function applyWinner(bracket, match, winnerId, score, isBye, isWalkover) {
  match.winnerId = winnerId;
  match.loserId = isBye ? null : (match.player1Id === winnerId ? match.player2Id : match.player1Id);
  match.score = isBye ? null : score;
  match.confirmed = true;
  match.isBye = !!isBye;
  match.isWalkover = !!isWalkover;

  if (match.nextMatchId) {
    const nextMatch = findMatchById(bracket, match.nextMatchId);
    if (match.nextSlot === 1) nextMatch.player1Id = winnerId;
    else nextMatch.player2Id = winnerId;
  }
}

function resolveIfBye(bracket, match) {
  if (match.confirmed) return;
  const { player1Id, player2Id } = match;
  if (player1Id && !player2Id) applyWinner(bracket, match, player1Id, null, true);
  else if (player2Id && !player1Id) applyWinner(bracket, match, player2Id, null, true);
}

// シード順（seededParticipantIds[0] = 1位シード）でシングルエリミネーションのブラケットを生成する。
// 参加人数が2のべき乗でない場合は上位シードにBYE（不戦勝）を割り当てる。
export function createBracket(tournamentId, seededParticipantIds) {
  const k = seededParticipantIds.length;
  if (k < 2) throw new Error('参加者は2人以上必要です。');

  const bracketSize = nextPowerOfTwo(k);
  const order = seedOrder(bracketSize);
  const slots = order.map((seedNum) => (seedNum <= k ? seededParticipantIds[seedNum - 1] : null));
  const totalRounds = Math.log2(bracketSize);

  const rounds = [];
  const round0Matches = [];
  for (let i = 0; i < slots.length; i += 2) {
    const m = makeEmptyMatch(roundName(totalRounds, 0));
    m.player1Id = slots[i];
    m.player2Id = slots[i + 1];
    round0Matches.push(m);
  }
  rounds.push({ name: roundName(totalRounds, 0), matches: round0Matches });

  let prevRoundMatches = round0Matches;
  for (let r = 1; r < totalRounds; r += 1) {
    const roundMatches = [];
    for (let i = 0; i < prevRoundMatches.length; i += 2) {
      const m = makeEmptyMatch(roundName(totalRounds, r));
      roundMatches.push(m);
      prevRoundMatches[i].nextMatchId = m.id;
      prevRoundMatches[i].nextSlot = 1;
      prevRoundMatches[i + 1].nextMatchId = m.id;
      prevRoundMatches[i + 1].nextSlot = 2;
    }
    rounds.push({ name: roundName(totalRounds, r), matches: roundMatches });
    prevRoundMatches = roundMatches;
  }

  const bracket = { tournamentId, bracketSize, totalRounds, rounds };

  // BYEが絡む対戦は1回戦にのみ発生するため、生成直後にまとめて自動解決する。
  rounds[0].matches.forEach((m) => resolveIfBye(bracket, m));

  return bracket;
}

// 実際の対戦の勝敗を確定させる。matches スキーマに沿ったレコードを state.matches に積む。
// options.isWalkover: true の場合、スコアなしの不戦勝（対戦不成立による勝利）として記録する。
export function confirmMatch(tournamentId, matchId, winnerId, score, options = {}) {
  const bracket = state.brackets[tournamentId];
  if (!bracket) return { ok: false, error: '対象の大会が見つかりません。' };

  const match = findMatchById(bracket, matchId);
  if (!match) return { ok: false, error: '対象の試合が見つかりません。' };
  if (match.confirmed) return { ok: false, error: 'この試合は既に確定済みです。' };
  if (!match.player1Id || !match.player2Id) {
    return { ok: false, error: '両者が確定していないため結果を入力できません。' };
  }
  if (winnerId !== match.player1Id && winnerId !== match.player2Id) {
    return { ok: false, error: '勝者は対戦カードの選手から選んでください。' };
  }

  applyWinner(bracket, match, winnerId, options.isWalkover ? null : (score || null), false, options.isWalkover);

  state.matches.push({
    id: match.id,
    tournamentId,
    winnerId: match.winnerId,
    loserId: match.loserId,
    score: match.score,
    round: match.round,
  });

  return { ok: true };
}

function removeMatchRecord(tournamentId, matchId) {
  const idx = state.matches.findIndex((m) => m.tournamentId === tournamentId && m.id === matchId);
  if (idx !== -1) state.matches.splice(idx, 1);
}

function resetMatchResult(match) {
  match.winnerId = null;
  match.loserId = null;
  match.score = null;
  match.confirmed = false;
  match.isBye = false;
  match.isWalkover = false;
}

// 対象試合の勝者が次ラウンドへ渡した進出枠を取り消す。次の試合が既に確定済みだった場合は
// その結果も無効になるため、記録を削除したうえで再帰的に取り消していく。
function cascadeClearNext(bracket, tournamentId, match) {
  if (!match.nextMatchId) return;
  const nextMatch = findMatchById(bracket, match.nextMatchId);
  if (match.nextSlot === 1) nextMatch.player1Id = null;
  else nextMatch.player2Id = null;

  if (nextMatch.confirmed) {
    removeMatchRecord(tournamentId, nextMatch.id);
    resetMatchResult(nextMatch);
    cascadeClearNext(bracket, tournamentId, nextMatch);
  }
}

// 確定済みの試合を未確定に戻す。BYEは対戦相手がいないため編集対象外。
// 既に次ラウンド以降へ結果が伝播・確定している場合は、それらも連鎖的に未確定へ戻す。
export function editMatch(tournamentId, matchId) {
  const bracket = state.brackets[tournamentId];
  if (!bracket) return { ok: false, error: '対象の大会が見つかりません。' };

  const match = findMatchById(bracket, matchId);
  if (!match) return { ok: false, error: '対象の試合が見つかりません。' };
  if (!match.confirmed) return { ok: false, error: 'この試合はまだ確定していません。' };
  if (match.isBye) return { ok: false, error: 'BYE（不戦勝）の試合は編集できません。' };

  removeMatchRecord(tournamentId, match.id);
  cascadeClearNext(bracket, tournamentId, match);
  resetMatchResult(match);

  return { ok: true };
}

// 大会の基本情報（名前・日付・定員・ルール）を修正する。募集中でも変更できる。
export function updateTournament(tournamentId, { name, date, rules, capacity }) {
  const tournament = state.tournaments.find((t) => t.id === tournamentId);
  if (!tournament) return { ok: false, error: '対象の大会が見つかりません。' };

  const newName = name.trim();
  if (!newName) return { ok: false, error: '大会名を入力してください。' };

  if (capacity !== undefined) {
    if (capacity !== null && (!Number.isInteger(capacity) || capacity < 2)) {
      return { ok: false, error: '定員は2以上の整数で入力してください。' };
    }
    // 既にエントリーしている人を追い出すことになる定員は受け付けない
    if (capacity !== null && capacity < tournament.participantIds.length) {
      return {
        ok: false,
        error: `既に${tournament.participantIds.length}人がエントリーしているため、定員を${capacity}人にはできません。`,
      };
    }
    tournament.capacity = capacity;
  }

  tournament.name = newName;
  tournament.date = date || null;
  tournament.rules = (rules ?? '').trim() || null;
  return { ok: true };
}

// ブラケット全体の勝者（決勝が確定していればそのwinnerId）を返す。
export function getChampionId(bracket) {
  const finalRound = bracket.rounds[bracket.rounds.length - 1];
  const finalMatch = finalRound.matches[0];
  return finalMatch.confirmed ? finalMatch.winnerId : null;
}

// 表の全欄が埋まったか（BYEを含め、すべての試合が確定済みか）。
// これが真になって初めて「結果を確定する」操作ができる。
export function allMatchesDecided(bracket) {
  if (!bracket) return false;
  return bracket.rounds.every((round) => round.matches.every((m) => m.confirmed));
}

// シングルエリミネーションの最終順位を求める。
//
// 何回戦で負けたかで順位が決まる。決勝で負ければ2位、準決勝で負けた2人は同率3位、
// 準々決勝で負けた4人は同率5位…と、負けたラウンドが1つ前になるごとに枠が倍になる。
// 実際に何人参加したかではなく、BYEを含めた表の大きさ(bracketSize)を基準にする。
//
// 戻り値: [{ playerId, rank }] を順位の昇順で。limit位までに収まるものだけ返す。
export function finalStandings(bracket, limit = 16) {
  if (!bracket) return [];

  const standings = [];
  const champion = getChampionId(bracket);
  if (champion) standings.push({ playerId: champion, rank: 1 });

  bracket.rounds.forEach((round, roundIndex) => {
    // そのラウンドで敗退した人の順位。決勝(最終ラウンド)の敗者が2位になる。
    const rank = bracket.bracketSize / 2 ** (roundIndex + 1) + 1;
    if (rank > limit) return;

    round.matches.forEach((m) => {
      // BYEは対戦が成立していないので敗者がいない
      if (!m.confirmed || !m.loserId) return;
      standings.push({ playerId: m.loserId, rank });
    });
  });

  return standings.sort((a, b) => a.rank - b.rank);
}

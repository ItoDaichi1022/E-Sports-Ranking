// 移行によるID振り直しが、データの関係を壊していないことを確かめる。
//
//   node scripts/verify-migration.mjs
//
// 旧JSONから組んだ state と、移行後の行から組み直した state の両方に対して
// 本番と同じランキング計算・戦績集計（js/ranking.js, js/playerStats.js）を走らせ、
// 結果が一致するかを比較する。DBへの接続は不要（変換関数だけを検証する）。

import { transform, loadLegacyData } from './migrate.mjs';
import { state } from '../js/state.js';
import { computeRankings } from '../js/ranking.js';
import { getPlayerStats } from '../js/playerStats.js';
import { getChampionId } from '../js/bracket.js';

// 旧JSON群 → in-memory state（移行前のアプリが持っていた形）
function legacyState(data) {
  const matches = [
    ...Object.values(data.matchShards).flatMap((s) => s?.matches ?? []),
    ...(data.legacyMatches?.matches ?? []),
  ];
  const brackets = {};
  for (const [tid, b] of Object.entries(data.brackets)) {
    if (b) brackets[tid] = b;
  }
  return {
    players: data.players.map((p) => ({ ...p })),
    tournaments: data.tournaments.map((t) => ({ ...t })),
    matches,
    brackets,
  };
}

// DBに入る行 → in-memory state（js/db.js が読み込み後に組み立てる形と同じ）
function migratedState(rows) {
  const participantsByTournament = new Map();
  [...rows.entryRows]
    .sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0))
    .forEach((e) => {
      if (!participantsByTournament.has(e.tournament_id)) participantsByTournament.set(e.tournament_id, []);
      participantsByTournament.get(e.tournament_id).push(e.player_id);
    });

  const brackets = {};
  rows.bracketRows.forEach((b) => { brackets[b.tournament_id] = b.data; });

  return {
    players: rows.playerRows.map((p) => ({
      id: p.id,
      currentName: p.display_name,
      pastNames: p.past_names,
    })),
    tournaments: rows.tournamentRows.map((t) => ({
      id: t.id,
      name: t.name,
      date: t.date,
      format: t.format,
      weight: t.weight,
      rules: t.rules,
      participantIds: participantsByTournament.get(t.id) ?? [],
    })),
    matches: rows.matchRows.map((m) => ({
      id: m.id,
      tournamentId: m.tournament_id,
      winnerId: m.winner_id,
      loserId: m.loser_id,
      score: m.score,
      round: m.round,
    })),
    brackets,
  };
}

// js/playerStats.js も js/bracket.js もモジュールスコープの state を直接読むので、
// 計測したい側の内容を state に流し込んでから呼ぶ。
function withState(snapshot, fn) {
  state.players = snapshot.players;
  state.tournaments = snapshot.tournaments;
  state.matches = snapshot.matches;
  state.brackets = snapshot.brackets;
  return fn();
}

// ランキングは名前で突き合わせる（IDは移行で変わるが、表示名は変わらないため）
function rankingByName(snapshot) {
  return withState(snapshot, () =>
    computeRankings(state).map((r) => ({
      name: r.name,
      rank: r.rank,
      score: r.score.toFixed(6),
      tournamentsPlayed: r.tournamentsPlayed,
      best: r.bestAchievement ? `${r.bestAchievement.label}/${r.bestAchievement.tournamentName}` : null,
    })),
  );
}

function championsByTournamentName(snapshot) {
  return withState(snapshot, () =>
    snapshot.tournaments.map((t) => {
      const bracket = state.brackets[t.id];
      const championId = bracket ? getChampionId(bracket) : null;
      const champion = snapshot.players.find((p) => p.id === championId);
      return {
        tournament: t.name,
        participants: t.participantIds.length,
        champion: champion ? champion.currentName : null,
      };
    }),
  );
}

function statsByPlayerName(snapshot) {
  return withState(snapshot, () =>
    snapshot.players
      .map((p) => {
        const s = getPlayerStats(p.id);
        return {
          name: p.currentName,
          wins: s.wins,
          losses: s.losses,
          tournaments: s.tournaments.length,
          placements: s.tournaments.map((t) => t.placement).sort().join(','),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
}

// ---- 実行 ----

const data = await loadLegacyData();
const rows = transform(data);

const before = legacyState(data);
const after = migratedState(rows);

const checks = [
  ['ランキング（順位・スコア・好成績）', rankingByName],
  ['各大会の優勝者と参加人数', championsByTournamentName],
  ['選手ごとの通算成績と大会成績', statsByPlayerName],
];

let failed = 0;
for (const [label, fn] of checks) {
  const a = JSON.stringify(fn(before), null, 2);
  const b = JSON.stringify(fn(after), null, 2);
  if (a === b) {
    console.log(`OK   ${label}`);
  } else {
    failed += 1;
    console.error(`NG   ${label}`);
    console.error('--- 移行前 ---');
    console.error(a.slice(0, 2000));
    console.error('--- 移行後 ---');
    console.error(b.slice(0, 2000));
  }
}

// 参照の取りこぼし（変換で null になった外部キー）が無いことも確認する
const dangling = [
  ...rows.matchRows.filter((m) => !m.winner_id || !m.loser_id || !m.tournament_id)
    .map((m) => `matches ${m.id}`),
  ...rows.entryRows.filter((e) => !e.player_id || !e.tournament_id)
    .map((e) => `entry ${e.tournament_id}`),
];
if (dangling.length) {
  failed += 1;
  console.error(`NG   参照の欠落が ${dangling.length} 件: ${dangling.slice(0, 5).join(', ')}`);
} else {
  console.log('OK   外部キーの欠落なし');
}

// ブラケット内のIDがすべて新しいuuidに置き換わっていること（旧IDの残存が無いこと）
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const leftovers = [];
rows.bracketRows.forEach((b) => {
  b.data.rounds.forEach((round) => {
    round.matches.forEach((m) => {
      ['id', 'player1Id', 'player2Id', 'winnerId', 'loserId', 'nextMatchId'].forEach((key) => {
        const v = m[key];
        if (v != null && !UUID.test(v)) leftovers.push(`${key}=${v}`);
      });
    });
  });
});
if (leftovers.length) {
  failed += 1;
  console.error(`NG   ブラケットに旧IDが残存: ${leftovers.slice(0, 5).join(', ')}`);
} else {
  console.log('OK   ブラケット内のIDはすべてuuid');
}

console.log(failed === 0 ? '\nすべて一致しました。' : `\n${failed}件の不一致があります。`);
process.exit(failed === 0 ? 0 : 1);

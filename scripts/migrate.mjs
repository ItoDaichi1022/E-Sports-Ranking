// data/*.json（GitHubをDB代わりに使っていた頃のデータ）をSupabaseへ投入する。
//
// 使い方:
//   SUPABASE_URL=https://xxxx.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
//   node scripts/migrate.mjs [--reset] [--dry-run]
//
//   --reset    投入前に既存の行を全部消す（players/tournaments/matches/…）。
//              やり直すとき用。auth.users（アカウント）には触らない。
//   --dry-run  変換結果の要約だけ表示し、DBには書き込まない。
//
// service_roleキーはRLSを迂回する管理用の鍵。ブラウザには絶対に置かず、
// このスクリプトを実行する時だけ環境変数で渡すこと。
//
// IDの振り直し:
//   旧データの選手IDはゲームアカウントID文字列そのもの（例 "5190490651"）だった。
//   ゲームIDを本人が編集できるプロフィール欄にするため、主キーはuuidへ移行する。
//   旧IDは game_account_id 列に残すので情報は失われない。
//   大会ID・試合IDも同様にuuidへ振り直し、ブラケットJSON内の参照も併せて書き換える。

import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESET = process.argv.includes('--reset');
const DRY_RUN = process.argv.includes('--dry-run');

// ---- ファイル読み込み ---------------------------------------------------

async function readJson(relPath) {
  try {
    return JSON.parse(await readFile(path.join(DATA_DIR, relPath), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function readDirJson(dirName) {
  let names;
  try {
    names = await readdir(path.join(DATA_DIR, dirName));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  const out = {};
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    out[name.replace(/\.json$/, '')] = await readJson(path.join(dirName, name));
  }
  return out;
}

// ---- PostgREST -----------------------------------------------------------

async function rest(method, table, { body, query = '' } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${method} ${table} 失敗 (${res.status}): ${await res.text()}`);
  }
  return res;
}

async function insertRows(table, rows) {
  if (rows.length === 0) return;
  // 1回のリクエストが大きくなりすぎないよう分割する
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await rest('POST', table, { body: rows.slice(i, i + CHUNK) });
  }
  console.log(`  ${table}: ${rows.length}件`);
}

// 依存関係の逆順で消す（外部キーに引っかからないように）
async function resetTables() {
  const order = [
    'published_rankings', 'matches', 'brackets', 'tournament_entries', 'tournaments', 'players',
  ];
  for (const table of order) {
    // 「常に真」の条件を付けないとPostgRESTは一括DELETEを拒否する
    await rest('DELETE', table, { query: '?id=not.is.null' }).catch(async (err) => {
      // 複合主キーでid列を持たないテーブル用のフォールバック
      if (table === 'tournament_entries' || table === 'brackets') {
        return rest('DELETE', table, { query: '?tournament_id=not.is.null' });
      }
      throw err;
    });
    console.log(`  ${table} を空にしました`);
  }
}

// ---- 変換 ----------------------------------------------------------------

function buildIdMap(oldIds) {
  return new Map([...new Set(oldIds)].map((id) => [id, randomUUID()]));
}

// 旧JSONの構造を、DBの各テーブルに入る行へ変換する。
// scripts/verify-migration.mjs からも呼ばれるのでエクスポートしている。
export function transform(data) {
  const { players, tournaments, brackets, matchShards, legacyMatches, ranking } = data;

  const playerMap = buildIdMap(players.map((p) => p.id));
  const tournamentMap = buildIdMap(tournaments.map((t) => t.id));

  // 試合IDはブラケット内の試合スロットと共有されている（js/bracket.js の confirmMatch が
  // ブラケットの試合IDをそのまま試合レコードのIDに使う）。両方から集めて一括で対応付ける。
  const allMatchIds = [];
  for (const bracket of Object.values(brackets)) {
    bracket?.rounds?.forEach((r) => r.matches.forEach((m) => allMatchIds.push(m.id)));
  }
  const allMatches = [
    ...Object.values(matchShards).flatMap((s) => s?.matches ?? []),
    ...(legacyMatches?.matches ?? []),
  ];
  allMatches.forEach((m) => allMatchIds.push(m.id));
  const matchMap = buildIdMap(allMatchIds);

  const mapPlayer = (id) => (id == null ? null : (playerMap.get(id) ?? null));
  const mapMatch = (id) => (id == null ? null : (matchMap.get(id) ?? null));

  // -- players --
  const playerRows = players.map((p) => ({
    id: playerMap.get(p.id),
    user_id: null, // 本人のアカウントは後から運営が対応付ける
    display_name: p.currentName,
    past_names: p.pastNames ?? [],
    // 旧主キーはゲームアカウントIDそのものだったので、プロフィール欄へ引き継ぐ
    game_account_id: p.id,
    main_characters: p.mainCharacters ?? [],
    role: 'player',
  }));

  // -- brackets（IDの参照をすべて書き換える）--
  const bracketRows = [];
  const championByTournament = new Map();
  for (const [oldTid, bracket] of Object.entries(brackets)) {
    if (!bracket) continue;
    const newTid = tournamentMap.get(oldTid);
    if (!newTid) {
      console.warn(`  ! ブラケット ${oldTid} に対応する大会が無いので飛ばします`);
      continue;
    }
    const rewritten = {
      ...bracket,
      tournamentId: newTid,
      rounds: bracket.rounds.map((round) => ({
        ...round,
        matches: round.matches.map((m) => ({
          ...m,
          id: mapMatch(m.id),
          player1Id: mapPlayer(m.player1Id),
          player2Id: mapPlayer(m.player2Id),
          winnerId: mapPlayer(m.winnerId),
          loserId: mapPlayer(m.loserId),
          nextMatchId: mapMatch(m.nextMatchId),
        })),
      })),
    };
    bracketRows.push({ tournament_id: newTid, data: rewritten });

    const finalMatch = rewritten.rounds.at(-1)?.matches?.[0];
    championByTournament.set(oldTid, finalMatch?.confirmed ? finalMatch.winnerId : null);
  }

  // -- tournaments --
  // 決勝が確定していれば終了、ブラケットがあれば進行中、無ければ準備中とみなす。
  const tournamentRows = tournaments.map((t) => ({
    id: tournamentMap.get(t.id),
    name: t.name,
    date: t.date || null,
    format: t.format || 'single_elim',
    rules: t.rules || null,
    weight: t.weight,
    capacity: null,
    status: championByTournament.get(t.id)
      ? 'finished'
      : (brackets[t.id] ? 'running' : 'draft'),
  }));

  // -- tournament_entries（旧participantIdsはシード順そのもの）--
  const entryRows = [];
  tournaments.forEach((t) => {
    (t.participantIds ?? []).forEach((pid, index) => {
      const playerId = mapPlayer(pid);
      if (!playerId) {
        console.warn(`  ! 大会 ${t.name} の参加者 ${pid} が選手一覧に無いので飛ばします`);
        return;
      }
      entryRows.push({
        tournament_id: tournamentMap.get(t.id),
        player_id: playerId,
        seed: index + 1,
      });
    });
  });

  // -- matches --
  const matchRows = [];
  for (const m of allMatches) {
    const tid = tournamentMap.get(m.tournamentId);
    const winner = mapPlayer(m.winnerId);
    const loser = mapPlayer(m.loserId);
    if (!tid || !winner || !loser) {
      console.warn(`  ! 試合 ${m.id} は参照先が欠けているので飛ばします`);
      continue;
    }
    matchRows.push({
      id: mapMatch(m.id),
      tournament_id: tid,
      winner_id: winner,
      loser_id: loser,
      score: m.score ?? null,
      round: m.round,
    });
  }

  // -- published_rankings --
  const rankingRows = [];
  if (ranking?.rankings) {
    rankingRows.push({
      published_at: ranking.publishedAt ?? new Date().toISOString(),
      period_months: ranking.periodMonths ?? null,
      data: {
        ...ranking,
        rankings: ranking.rankings
          .map((r) => ({ ...r, id: mapPlayer(r.id) }))
          .filter((r) => r.id),
      },
    });
  }

  return { playerRows, tournamentRows, entryRows, bracketRows, matchRows, rankingRows };
}

// data/ 以下を丸ごと読み込む。verify-migration.mjs からも使う。
export async function loadLegacyData() {
  return {
    players: (await readJson('players.json'))?.players ?? [],
    tournaments: (await readJson('tournaments.json'))?.tournaments ?? [],
    brackets: await readDirJson('brackets'),
    matchShards: await readDirJson('matches'),
    legacyMatches: await readJson('matches.json'),
    ranking: await readJson('ranking.json'),
  };
}

// ---- 実行 ----------------------------------------------------------------
// 直接 node で起動されたときだけ動かす（import されたときは関数だけ提供する）。

async function runCli() {
  if (!DRY_RUN && (!SUPABASE_URL || !SERVICE_KEY)) {
    console.error('SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を環境変数で指定してください。');
    console.error('（変換結果だけ見たい場合は --dry-run を付けてください）');
    process.exit(1);
  }

  const data = await loadLegacyData();

  console.log('読み込み:');
  console.log(`  選手 ${data.players.length}人 / 大会 ${data.tournaments.length}件`);

  const rows = transform(data);

  console.log('変換結果:');
  console.log(`  players            ${rows.playerRows.length}`);
  console.log(`  tournaments        ${rows.tournamentRows.length}`);
  console.log(`  tournament_entries ${rows.entryRows.length}`);
  console.log(`  brackets           ${rows.bracketRows.length}`);
  console.log(`  matches            ${rows.matchRows.length}`);
  console.log(`  published_rankings ${rows.rankingRows.length}`);

  if (DRY_RUN) {
    console.log('\n--dry-run のため書き込みはしていません。');
    return;
  }

  if (RESET) {
    console.log('既存データを削除中...');
    await resetTables();
  }

  console.log('投入中...');
  // 外部キーの順序を守る（players → tournaments → entries/brackets/matches）
  await insertRows('players', rows.playerRows);
  await insertRows('tournaments', rows.tournamentRows);
  await insertRows('tournament_entries', rows.entryRows);
  await insertRows('brackets', rows.bracketRows);
  await insertRows('matches', rows.matchRows);
  await insertRows('published_rankings', rows.rankingRows);

  console.log('\n完了しました。');
  console.log('次にSupabaseのTable Editorでplayersを開き、自分の行のroleをadminにしてください。');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}

import { state } from './state.js';
import { githubConfig, getFile, putFile, deleteFile, listDirectory } from './github.js';

// 各ファイルの現在のsha（楽観ロック用）。読み込み時に記録し、書き込み成功時に更新する。
const shaCache = new Map();

// 最後に読み込み/保存したときのファイル内容（整形済みJSON文字列）。
// 「変更のないファイルはPUTしない」判定と、競合マージ時のベース（三方マージの共通祖先）に使う。
const contentCache = new Map();

function serialize(value) {
  // putFile と同じ整形（インデント2）で比較する
  return JSON.stringify(value, null, 2);
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ローカルで削除された大会。次回保存時にブラケット/試合ファイルをGitHub側からも削除する。
const deletedTournamentIds = new Set();

export function markTournamentDeleted(tournamentId) {
  deletedTournamentIds.add(tournamentId);
}

function dataPath(name) {
  return `${githubConfig.pathPrefix}/${name}`;
}

function bracketPath(tournamentId) {
  return `${githubConfig.pathPrefix}/brackets/${tournamentId}.json`;
}

// 試合結果は大会ごとの個別ファイルに保存する。別々の大会を同時に運営しても
// 同じファイルを取り合わず、書き込み競合自体が起きないようにするため。
function matchesPath(tournamentId) {
  return `${githubConfig.pathPrefix}/matches/${tournamentId}.json`;
}

// 旧形式（全大会共通の matches.json）の試合を、分割ファイルに無いものだけ合流させる。
function combineMatches(shardMatches, legacyMatches) {
  const merged = [...shardMatches];
  const ids = new Set(merged.map((m) => m.id));
  (legacyMatches ?? []).forEach((m) => {
    if (!ids.has(m.id)) merged.push(m);
  });
  return merged;
}

// サイトと同じ場所（GitHub Pages）から静的ファイルとしてJSONを取得する。
// GitHub APIと違って認証もレート制限も無いため、閲覧者はこちらを使う。
async function fetchStaticJson(path) {
  const res = await fetch(`${path}?_=${Date.now()}`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`データ読み込み失敗 (${path}): ${res.status}`);
  return res.json();
}

// 閲覧モード：データJSONはサイトと同一リポジトリに同居しているので、
// Pagesが配信する静的ファイルを直接読む（ブラケット/試合は大会IDからファイル名を引ける）。
// 途中で通信が失敗した場合に中途半端な状態にならないよう、
// すべて取得し終えてから state へ一括で反映する（自動更新でも使うため）。
async function loadAllViaStatic() {
  const [playersJson, tournamentsJson, legacyMatchesJson, rankingJson] = await Promise.all([
    fetchStaticJson(dataPath('players.json')),
    fetchStaticJson(dataPath('tournaments.json')),
    fetchStaticJson(dataPath('matches.json')),
    fetchStaticJson(dataPath('ranking.json')),
  ]);

  const tournaments = tournamentsJson?.tournaments ?? [];
  const brackets = {};
  let shardMatches = [];
  const [bracketResults, matchResults] = await Promise.all([
    Promise.all(tournaments.map(async (t) => ({ id: t.id, json: await fetchStaticJson(bracketPath(t.id)) }))),
    Promise.all(tournaments.map(async (t) => ({ id: t.id, json: await fetchStaticJson(matchesPath(t.id)) }))),
  ]);
  bracketResults.forEach(({ id, json }) => {
    if (json) brackets[id] = json;
  });
  matchResults.forEach(({ json }) => {
    if (json?.matches) shardMatches = shardMatches.concat(json.matches);
  });

  state.players = playersJson?.players ?? [];
  state.tournaments = tournaments;
  state.matches = combineMatches(shardMatches, legacyMatchesJson?.matches);
  state.brackets = brackets;
  state.publishedRanking = rankingJson ?? null;
}

// 運営モード：GitHub API経由で読み込み、更新時の楽観ロックに使うshaも記録する。
// 認証付きなのでレート制限は毎時5000回と実質問題にならない。
async function loadAllViaApi() {
  shaCache.clear();
  contentCache.clear();

  const [playersFile, tournamentsFile, legacyMatchesFile, rankingFile] = await Promise.all([
    getFile(dataPath('players.json')),
    getFile(dataPath('tournaments.json')),
    getFile(dataPath('matches.json')),
    getFile(dataPath('ranking.json')),
  ]);

  state.players = playersFile.json?.players ?? [];
  state.tournaments = tournamentsFile.json?.tournaments ?? [];
  state.publishedRanking = rankingFile.json ?? null;
  shaCache.set('players', playersFile.sha);
  shaCache.set('tournaments', tournamentsFile.sha);
  shaCache.set('matches', legacyMatchesFile.sha);
  shaCache.set('ranking', rankingFile.sha);
  if (playersFile.json) contentCache.set('players', serialize(playersFile.json));
  if (tournamentsFile.json) contentCache.set('tournaments', serialize(tournamentsFile.json));
  if (legacyMatchesFile.json) contentCache.set('matches', serialize(legacyMatchesFile.json));
  if (rankingFile.json) contentCache.set('ranking', serialize(rankingFile.json));

  async function loadDirectory(dirName, keyPrefix) {
    const entries = await listDirectory(`${githubConfig.pathPrefix}/${dirName}`);
    const files = await Promise.all(
      entries
        .filter((e) => e.type === 'file' && e.name.endsWith('.json'))
        .map(async (e) => ({ name: e.name, file: await getFile(`${githubConfig.pathPrefix}/${dirName}/${e.name}`) })),
    );
    const byId = {};
    files.forEach(({ name, file }) => {
      if (!file.json) return;
      const id = name.replace(/\.json$/, '');
      byId[id] = file.json;
      shaCache.set(`${keyPrefix}:${id}`, file.sha);
      contentCache.set(`${keyPrefix}:${id}`, serialize(file.json));
    });
    return byId;
  }

  const [brackets, matchShards] = await Promise.all([
    loadDirectory('brackets', 'bracket'),
    loadDirectory('matches', 'matches'),
  ]);

  state.brackets = brackets;
  let shardMatches = [];
  Object.values(matchShards).forEach((shard) => {
    if (shard?.matches) shardMatches = shardMatches.concat(shard.matches);
  });
  state.matches = combineMatches(shardMatches, legacyMatchesFile.json?.matches);
}

// players/tournaments/matches/brackets を読み込み、in-memory stateを丸ごと置き換える。
// トークンなし＝閲覧モード（静的取得）、トークンあり＝運営モード（API取得）。
export async function loadAllFromGitHub() {
  deletedTournamentIds.clear();

  if (githubConfig.token) {
    await loadAllViaApi();
  } else {
    await loadAllViaStatic();
  }
}

// 内容が前回の読み込み/保存から変わっているファイルだけをPUTする。
// 一度も読み込んでいないファイルがリモートに既に存在する場合は、他端末が先に
// 作成したものなので、上書きせず競合として扱い呼び出し側のマージに委ねる。
async function putIfChanged(key, path, payload, message) {
  const serialized = serialize(payload);
  if (contentCache.get(key) === serialized) return;

  let sha = shaCache.get(key);
  if (!sha) {
    const existing = await getFile(path);
    if (existing.sha && !contentCache.has(key)) {
      const err = new Error(`他の端末の変更と競合しました (${path})`);
      err.isConflict = true;
      throw err;
    }
    sha = existing.sha;
  }

  const newSha = await putFile(path, payload, sha, message);
  shaCache.set(key, newSha);
  contentCache.set(key, serialized);
}

async function deleteFileIfExists(key, path, message) {
  let sha = shaCache.get(key);
  if (!sha) sha = (await getFile(path)).sha;
  if (sha) await deleteFile(path, sha, message);
  shaCache.delete(key);
  contentCache.delete(key);
}

// 現在のin-memory stateをGitHubへ書き込む。変更のないファイルはスキップされる。
async function saveAllCore() {
  await putIfChanged('players', dataPath('players.json'), { players: state.players }, 'players.json を更新');
  await putIfChanged('tournaments', dataPath('tournaments.json'), { tournaments: state.tournaments }, 'tournaments.json を更新');
  if (state.publishedRanking) {
    await putIfChanged('ranking', dataPath('ranking.json'), state.publishedRanking, 'ranking.json を更新');
  }

  // 試合結果を大会ごとに分割して保存する。
  const byTournament = new Map();
  for (const m of state.matches) {
    if (!byTournament.has(m.tournamentId)) byTournament.set(m.tournamentId, []);
    byTournament.get(m.tournamentId).push(m);
  }
  // 以前はあったが全試合が取り消された大会も、空の内容で上書きして整合を保つ。
  for (const key of contentCache.keys()) {
    if (!key.startsWith('matches:')) continue;
    const tid = key.slice('matches:'.length);
    if (!byTournament.has(tid) && !deletedTournamentIds.has(tid)) byTournament.set(tid, []);
  }
  for (const [tid, matches] of byTournament) {
    await putIfChanged(`matches:${tid}`, matchesPath(tid), { matches }, `matches ${tid} を更新`);
  }

  for (const [tournamentId, bracket] of Object.entries(state.brackets)) {
    await putIfChanged(`bracket:${tournamentId}`, bracketPath(tournamentId), bracket, `bracket ${tournamentId} を更新`);
  }

  // ローカルで削除された大会のブラケット/試合ファイルをGitHub側からも消す。
  for (const tid of [...deletedTournamentIds]) {
    await deleteFileIfExists(`bracket:${tid}`, bracketPath(tid), `bracket ${tid} を削除`);
    await deleteFileIfExists(`matches:${tid}`, matchesPath(tid), `matches ${tid} を削除`);
    deletedTournamentIds.delete(tid);
  }

  // 旧形式の matches.json が残っていれば、分割ファイルへの保存が済んだ後に削除する（初回のみの移行）。
  if (shaCache.get('matches')) {
    await deleteFile(dataPath('matches.json'), shaCache.get('matches'), 'matches.json を大会別ファイルへ移行');
    shaCache.delete('matches');
    contentCache.delete('matches');
  }
}

// ---- 競合時の三方マージ ----
// ベース（最後に読み込んだ内容）・ローカル（自分の編集）・リモート（他端末の最新）を
// レコード単位で統合する。片方だけが変えたものは変えた側を、両方が変えたものは
// フィールド単位でローカル優先で採用する。

function parseCache(key, fallback) {
  const s = contentCache.get(key);
  return s ? JSON.parse(s) : fallback;
}

function baseSnapshot() {
  let matches = [];
  const brackets = {};
  for (const [key, val] of contentCache) {
    if (key.startsWith('matches:')) matches = matches.concat(JSON.parse(val).matches ?? []);
    else if (key.startsWith('bracket:')) brackets[key.slice('bracket:'.length)] = JSON.parse(val);
  }
  matches = combineMatches(matches, parseCache('matches', {}).matches);
  return {
    players: parseCache('players', {}).players ?? [],
    tournaments: parseCache('tournaments', {}).tournaments ?? [],
    matches,
    brackets,
    publishedRanking: parseCache('ranking', null),
  };
}

function snapshotLocal() {
  return JSON.parse(JSON.stringify({
    players: state.players,
    tournaments: state.tournaments,
    matches: state.matches,
    brackets: state.brackets,
    publishedRanking: state.publishedRanking,
  }));
}

// 両方が同じレコードを変更した場合の、フィールド単位のマージ（ローカル優先）。
function mergeFields(base, local, remote) {
  const merged = {};
  const keys = new Set([...Object.keys(local ?? {}), ...Object.keys(remote ?? {})]);
  for (const k of keys) {
    merged[k] = !same(local?.[k], base?.[k]) ? local?.[k] : remote?.[k];
  }
  return merged;
}

function mergeById(baseArr, localArr, remoteArr, idKey = 'id') {
  const bMap = new Map((baseArr ?? []).map((x) => [x[idKey], x]));
  const lMap = new Map((localArr ?? []).map((x) => [x[idKey], x]));
  const rMap = new Map((remoteArr ?? []).map((x) => [x[idKey], x]));

  const ids = [...lMap.keys()];
  for (const id of rMap.keys()) {
    if (!lMap.has(id)) ids.push(id);
  }

  const out = [];
  for (const id of ids) {
    const b = bMap.get(id);
    const l = lMap.get(id);
    const r = rMap.get(id);
    if (l && r) {
      if (same(l, b)) out.push(r);
      else if (same(r, b)) out.push(l);
      else out.push(mergeFields(b, l, r));
    } else if (l && !r) {
      // リモートに無い: ローカルの新規/変更なら残す。未変更ならリモートの削除に従う。
      if (!b || !same(l, b)) out.push(l);
    } else if (!l && r) {
      // ローカルに無い: ベースに有ればローカルが削除したので従う。無ければリモートの新規。
      if (!b) out.push(r);
    }
  }
  return out;
}

function flattenBracketMatches(bracket) {
  const map = new Map();
  bracket?.rounds?.forEach((round) => round.matches.forEach((m) => map.set(m.id, m)));
  return map;
}

// ブラケットの構造（ラウンド・試合ID）は生成時に決まり不変なので、
// 試合オブジェクトだけをフィールド単位で統合する（例: 別々の準決勝を同時に確定した場合、
// 決勝の player1Id はローカルから、player2Id はリモートから取り込まれる）。
function mergeBracket(base, local, remote) {
  const bMap = flattenBracketMatches(base);
  const rMap = flattenBracketMatches(remote);
  const merged = JSON.parse(JSON.stringify(local));
  merged.rounds.forEach((round) => {
    round.matches = round.matches.map((lm) => {
      const b = bMap.get(lm.id);
      const r = rMap.get(lm.id);
      if (!r) return lm;
      if (same(lm, b)) return r;
      if (same(r, b)) return lm;
      return mergeFields(b, lm, r);
    });
  });
  return merged;
}

function mergeBracketsMap(base, local, remote) {
  const out = {};
  const ids = new Set([...Object.keys(local), ...Object.keys(remote)]);
  for (const id of ids) {
    const b = base[id];
    const l = local[id];
    const r = remote[id];
    if (l && r) {
      if (same(l, b)) out[id] = r;
      else if (same(r, b)) out[id] = l;
      else out[id] = mergeBracket(b, l, r);
    } else if (l && !r) {
      if (!b || !same(l, b)) out[id] = l;
    } else if (!l && r) {
      if (!b) out[id] = r;
    }
  }
  return out;
}

// 保存の入口。競合（他端末が先に保存）を検出したら、最新を読み込み直して
// 自分の変更をレコード単位で載せ直し、新しいshaで再保存する。
// 戻り値 merged=true は他端末の変更を取り込んだことを示す（呼び出し側で再描画する）。
export async function saveAllToGitHub() {
  try {
    await saveAllCore();
    return { merged: false };
  } catch (err) {
    if (!err?.isConflict) throw err;

    const local = snapshotLocal();
    const base = baseSnapshot();
    await loadAllViaApi(); // state=リモート最新、sha/内容キャッシュも更新される

    state.players = mergeById(base.players, local.players, state.players);
    state.tournaments = mergeById(base.tournaments, local.tournaments, state.tournaments);
    state.matches = mergeById(base.matches, local.matches, state.matches);
    state.brackets = mergeBracketsMap(base.brackets, local.brackets, state.brackets);
    state.publishedRanking = same(local.publishedRanking, base.publishedRanking)
      ? state.publishedRanking
      : local.publishedRanking;

    // 再試行（この間にさらに他端末が保存して競合したら、次の自動保存周期で再びマージされる）
    await saveAllCore();
    return { merged: true };
  }
}

import { state } from './state.js';
import { githubConfig, getFile, putFile, deleteFile, listDirectory } from './github.js';

// 各ファイルの現在のsha（楽観ロック用）。読み込み時に記録し、書き込み成功時に更新する。
const shaCache = new Map();

// 最後に読み込み/保存したときのファイル内容（整形済みJSON文字列）。
// 自動保存で頻繁に保存されるようになったため、内容が変わっていないファイルは
// PUTせずスキップして無意味なコミットを作らない。
const contentCache = new Map();

function serialize(value) {
  // putFile と同じ整形（インデント2）で比較する
  return JSON.stringify(value, null, 2);
}

// ローカルで削除された大会のブラケットファイル。次回保存時にGitHub側からも削除する。
const deletedBracketIds = new Set();

export function markBracketDeleted(tournamentId) {
  deletedBracketIds.add(tournamentId);
}

function dataPath(name) {
  return `${githubConfig.pathPrefix}/${name}`;
}

function bracketPath(tournamentId) {
  return `${githubConfig.pathPrefix}/brackets/${tournamentId}.json`;
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
// Pagesが配信する静的ファイルを直接読む（ブラケットは大会IDからファイル名を引ける）。
// 途中で通信が失敗した場合に中途半端な状態にならないよう、
// すべて取得し終えてから state へ一括で反映する（自動更新でも使うため）。
async function loadAllViaStatic() {
  const [playersJson, tournamentsJson, matchesJson, rankingJson] = await Promise.all([
    fetchStaticJson(dataPath('players.json')),
    fetchStaticJson(dataPath('tournaments.json')),
    fetchStaticJson(dataPath('matches.json')),
    fetchStaticJson(dataPath('ranking.json')),
  ]);

  const tournaments = tournamentsJson?.tournaments ?? [];
  const brackets = {};
  const bracketResults = await Promise.all(
    tournaments.map(async (t) => ({ id: t.id, json: await fetchStaticJson(bracketPath(t.id)) })),
  );
  bracketResults.forEach(({ id, json }) => {
    if (json) brackets[id] = json;
  });

  state.players = playersJson?.players ?? [];
  state.tournaments = tournaments;
  state.matches = matchesJson?.matches ?? [];
  state.brackets = brackets;
  state.publishedRanking = rankingJson ?? null;
}

// 運営モード：GitHub API経由で読み込み、更新時の楽観ロックに使うshaも記録する。
// 認証付きなのでレート制限は毎時5000回と実質問題にならない。
async function loadAllViaApi() {
  const [playersFile, tournamentsFile, matchesFile, rankingFile] = await Promise.all([
    getFile(dataPath('players.json')),
    getFile(dataPath('tournaments.json')),
    getFile(dataPath('matches.json')),
    getFile(dataPath('ranking.json')),
  ]);

  state.players = playersFile.json?.players ?? [];
  state.tournaments = tournamentsFile.json?.tournaments ?? [];
  state.matches = matchesFile.json?.matches ?? [];
  state.publishedRanking = rankingFile.json ?? null;
  shaCache.set('players', playersFile.sha);
  shaCache.set('tournaments', tournamentsFile.sha);
  shaCache.set('matches', matchesFile.sha);
  shaCache.set('ranking', rankingFile.sha);
  if (playersFile.json) contentCache.set('players', serialize(playersFile.json));
  if (tournamentsFile.json) contentCache.set('tournaments', serialize(tournamentsFile.json));
  if (matchesFile.json) contentCache.set('matches', serialize(matchesFile.json));
  if (rankingFile.json) contentCache.set('ranking', serialize(rankingFile.json));

  state.brackets = {};
  const entries = await listDirectory(`${githubConfig.pathPrefix}/brackets`);
  const bracketFiles = await Promise.all(
    entries
      .filter((e) => e.type === 'file' && e.name.endsWith('.json'))
      .map(async (e) => ({ name: e.name, file: await getFile(`${githubConfig.pathPrefix}/brackets/${e.name}`) })),
  );
  bracketFiles.forEach(({ name, file }) => {
    if (!file.json) return;
    const tournamentId = name.replace(/\.json$/, '');
    state.brackets[tournamentId] = file.json;
    shaCache.set(`bracket:${tournamentId}`, file.sha);
    contentCache.set(`bracket:${tournamentId}`, serialize(file.json));
  });
}

// players/tournaments/matches/brackets を読み込み、in-memory stateを丸ごと置き換える。
// トークンなし＝閲覧モード（静的取得）、トークンあり＝運営モード（API取得）。
export async function loadAllFromGitHub() {
  deletedBracketIds.clear();
  shaCache.clear();
  contentCache.clear();

  if (githubConfig.token) {
    await loadAllViaApi();
  } else {
    await loadAllViaStatic();
  }
}

// shaが未取得のファイル（静的読み込み後にトークンを設定して保存した場合など）は
// 書き込み直前にAPIから現在のshaを取得して楽観ロックを成立させる。
async function ensureSha(key, path) {
  if (!shaCache.get(key)) {
    const { sha } = await getFile(path);
    shaCache.set(key, sha);
  }
  return shaCache.get(key);
}

// 内容が前回の読み込み/保存から変わっているファイルだけをPUTする。
async function putIfChanged(key, path, payload, message) {
  const serialized = serialize(payload);
  if (contentCache.get(key) === serialized) return;
  const sha = await putFile(path, payload, await ensureSha(key, path), message);
  shaCache.set(key, sha);
  contentCache.set(key, serialized);
}

// 現在のin-memory stateをGitHubへ書き込む（players/tournaments/matches + 各大会のbracket）。
// 変更のないファイルはスキップされる。書き込みトークンが必要。
export async function saveAllToGitHub() {
  await putIfChanged('players', dataPath('players.json'), { players: state.players }, 'players.json を更新');
  await putIfChanged('tournaments', dataPath('tournaments.json'), { tournaments: state.tournaments }, 'tournaments.json を更新');
  await putIfChanged('matches', dataPath('matches.json'), { matches: state.matches }, 'matches.json を更新');
  if (state.publishedRanking) {
    await putIfChanged('ranking', dataPath('ranking.json'), state.publishedRanking, 'ranking.json を更新');
  }

  for (const [tournamentId, bracket] of Object.entries(state.brackets)) {
    await putIfChanged(`bracket:${tournamentId}`, bracketPath(tournamentId), bracket, `bracket ${tournamentId} を更新`);
  }

  // ローカルで削除された大会のブラケットファイルをGitHub側からも消す。
  for (const tournamentId of [...deletedBracketIds]) {
    const path = bracketPath(tournamentId);
    let sha = shaCache.get(`bracket:${tournamentId}`);
    if (!sha) sha = (await getFile(path)).sha;
    if (sha) await deleteFile(path, sha, `bracket ${tournamentId} を削除`);
    shaCache.delete(`bracket:${tournamentId}`);
    contentCache.delete(`bracket:${tournamentId}`);
    deletedBracketIds.delete(tournamentId);
  }
}

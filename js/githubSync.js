import { state } from './state.js';
import { githubConfig, getFile, putFile, deleteFile, listDirectory } from './github.js';

// 各ファイルの現在のsha（楽観ロック用）。読み込み時に記録し、書き込み成功時に更新する。
const shaCache = new Map();

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
  const [playersJson, tournamentsJson, matchesJson] = await Promise.all([
    fetchStaticJson(dataPath('players.json')),
    fetchStaticJson(dataPath('tournaments.json')),
    fetchStaticJson(dataPath('matches.json')),
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
}

// 運営モード：GitHub API経由で読み込み、更新時の楽観ロックに使うshaも記録する。
// 認証付きなのでレート制限は毎時5000回と実質問題にならない。
async function loadAllViaApi() {
  const [playersFile, tournamentsFile, matchesFile] = await Promise.all([
    getFile(dataPath('players.json')),
    getFile(dataPath('tournaments.json')),
    getFile(dataPath('matches.json')),
  ]);

  state.players = playersFile.json?.players ?? [];
  state.tournaments = tournamentsFile.json?.tournaments ?? [];
  state.matches = matchesFile.json?.matches ?? [];
  shaCache.set('players', playersFile.sha);
  shaCache.set('tournaments', tournamentsFile.sha);
  shaCache.set('matches', matchesFile.sha);

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
  });
}

// players/tournaments/matches/brackets を読み込み、in-memory stateを丸ごと置き換える。
// トークンなし＝閲覧モード（静的取得）、トークンあり＝運営モード（API取得）。
export async function loadAllFromGitHub() {
  deletedBracketIds.clear();
  shaCache.clear();

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

// 現在のin-memory stateをGitHubへ書き込む（players/tournaments/matches + 各大会のbracket）。
// 書き込みトークンが必要。
export async function saveAllToGitHub() {
  const playersSha = await putFile(
    dataPath('players.json'),
    { players: state.players },
    await ensureSha('players', dataPath('players.json')),
    'players.json を更新',
  );
  shaCache.set('players', playersSha);

  const tournamentsSha = await putFile(
    dataPath('tournaments.json'),
    { tournaments: state.tournaments },
    await ensureSha('tournaments', dataPath('tournaments.json')),
    'tournaments.json を更新',
  );
  shaCache.set('tournaments', tournamentsSha);

  const matchesSha = await putFile(
    dataPath('matches.json'),
    { matches: state.matches },
    await ensureSha('matches', dataPath('matches.json')),
    'matches.json を更新',
  );
  shaCache.set('matches', matchesSha);

  for (const [tournamentId, bracket] of Object.entries(state.brackets)) {
    const sha = await putFile(
      bracketPath(tournamentId),
      bracket,
      await ensureSha(`bracket:${tournamentId}`, bracketPath(tournamentId)),
      `bracket ${tournamentId} を更新`,
    );
    shaCache.set(`bracket:${tournamentId}`, sha);
  }

  // ローカルで削除された大会のブラケットファイルをGitHub側からも消す。
  for (const tournamentId of [...deletedBracketIds]) {
    const path = bracketPath(tournamentId);
    let sha = shaCache.get(`bracket:${tournamentId}`);
    if (!sha) sha = (await getFile(path)).sha;
    if (sha) await deleteFile(path, sha, `bracket ${tournamentId} を削除`);
    shaCache.delete(`bracket:${tournamentId}`);
    deletedBracketIds.delete(tournamentId);
  }
}

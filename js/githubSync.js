import { state } from './state.js';
import { githubConfig, getFile, putFile, listDirectory } from './github.js';

// 各ファイルの現在のsha（楽観ロック用）。読み込み時に記録し、書き込み成功時に更新する。
const shaCache = new Map();

function dataPath(name) {
  return `${githubConfig.pathPrefix}/${name}`;
}

function bracketPath(tournamentId) {
  return `${githubConfig.pathPrefix}/brackets/${tournamentId}.json`;
}

// GitHub上のplayers/tournaments/matches/brackets を読み込み、in-memory stateを丸ごと置き換える。
// 閲覧のみなら書き込みトークンは不要。
export async function loadAllFromGitHub() {
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

// 現在のin-memory stateをGitHubへ書き込む（players/tournaments/matches + 各大会のbracket）。
// 書き込みトークンが必要。
export async function saveAllToGitHub() {
  const playersSha = await putFile(
    dataPath('players.json'),
    { players: state.players },
    shaCache.get('players'),
    'players.json を更新',
  );
  shaCache.set('players', playersSha);

  const tournamentsSha = await putFile(
    dataPath('tournaments.json'),
    { tournaments: state.tournaments },
    shaCache.get('tournaments'),
    'tournaments.json を更新',
  );
  shaCache.set('tournaments', tournamentsSha);

  const matchesSha = await putFile(
    dataPath('matches.json'),
    { matches: state.matches },
    shaCache.get('matches'),
    'matches.json を更新',
  );
  shaCache.set('matches', matchesSha);

  for (const [tournamentId, bracket] of Object.entries(state.brackets)) {
    const sha = await putFile(
      bracketPath(tournamentId),
      bracket,
      shaCache.get(`bracket:${tournamentId}`),
      `bracket ${tournamentId} を更新`,
    );
    shaCache.set(`bracket:${tournamentId}`, sha);
  }
}

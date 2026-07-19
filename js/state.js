// アプリ全体で共有する in-memory データストア。
// スキーマは doc/design.md の players.json / tournaments.json / matches.json に準拠する。
export const state = {
  players: [],       // { id, currentName, pastNames: [] }
  tournaments: [],    // { id, name, date, format, participantIds: [], weight, rules }
  matches: [],        // { id, tournamentId, winnerId, loserId, score, round }
  brackets: {},       // tournamentId -> bracket object (js/bracket.js が構造を定義)
};

let idCounter = 0;

export function generateId(prefix) {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

// プレイヤーIDから表示用の現在名を取得する。BYE(null)は呼び出し側で扱う。
export function getPlayerName(id) {
  if (!id) return null;
  const player = state.players.find((p) => p.id === id);
  return player ? player.currentName : id;
}

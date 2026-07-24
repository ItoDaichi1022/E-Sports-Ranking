// アプリ全体で共有する in-memory データストア。
// スキーマは doc/design.md のデータベース設計に準拠する。DBのsnake_caseとの変換は
// js/db.js が境界で行うため、ここから下の計算・描画ロジックはストレージを意識しない。
export const state = {
  // { id, currentName, pastNames: [], gameAccountId, bio, mainCharacters: [],
  //   snsX, snsTwitch, snsYoutube, role, userId }
  players: [],
  // { id, name, date, format, participantIds: [], weight, rules, imageUrl, status, capacity }
  tournaments: [],
  matches: [],        // { id, tournamentId, winnerId, loserId, score, round }
  brackets: {},       // tournamentId -> bracket object (js/bracket.js が構造を定義)
  publishedRanking: null, // { publishedAt, periodMonths, rankings: [...] } | null（未公開）
  // ホーム画面の運営からのお知らせ。pinned優先＋新しい順で並べて持つ。
  announcements: [],  // { id, title, body, imageUrl, pinned, createdAt, updatedAt }
};

// 新しいレコードのID。DB側の主キーがuuidなので、クライアントで作るIDもuuidに揃える。
// crypto.randomUUID はセキュアコンテキスト（HTTPS / localhost）でのみ使えるが、
// GitHub Pagesは常にHTTPSなので問題ない。
export function newId() {
  return crypto.randomUUID();
}

// プレイヤーIDから表示用の現在名を取得する。BYE(null)は呼び出し側で扱う。
export function getPlayerName(id) {
  if (!id) return null;
  const player = state.players.find((p) => p.id === id);
  return player ? player.currentName : id;
}

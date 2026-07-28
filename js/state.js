// アプリ全体で共有する in-memory データストア。
// スキーマは doc/design.md のデータベース設計に準拠する。DBのsnake_caseとの変換は
// js/db.js が境界で行うため、ここから下の計算・描画ロジックはストレージを意識しない。
export const state = {
  // { id, currentName, pastNames: [], gameAccountId, bio, mainCharacters: [],
  //   snsX, snsTwitch, snsYoutube, role, userId }
  players: [],
  // { id, name, date, format, matchType, matchTypeNote, entrantIds: [], participantIds: [],
  //   teams: [], weight, rules, imageUrl, status, capacity }
  //
  // 出場の単位が2つあることに注意（2v2でこの2つがズレる）。
  //   entrantIds     ブラケットの枠に入る単位。個人戦は選手ID、チーム戦はチームID。
  //                  シード・枠数・定員・大会規模Tierはすべてこちらで数える
  //   participantIds 出場した「人」。チーム戦ではメンバー全員が並ぶ。
  //                  選手ページ・選手削除の判定はこちら
  // 個人戦ではこの2つは同じ配列になるので、既存の挙動は変わらない。
  // teams は チーム戦のときだけ入る { id, name, memberIds: [], seed, placement }。
  tournaments: [],
  // 個人戦は winnerId/loserId、チーム戦は winnerTeamId/loserTeamId が入る（DB側の制約で排他）
  matches: [],        // { id, tournamentId, winnerId, loserId, winnerTeamId, loserTeamId, score, round }

  // ブラケットは対戦表を開いたときだけ取りに行く（中身が大きく、一覧では使わないため）。
  // brackets は読み込み済みのものだけを持つキャッシュで、bracketIds は
  // 「対戦表が組まれている大会」の一覧。入口を出すかどうかの判定はこちらで行う。
  brackets: {},       // tournamentId -> bracket object (js/bracket.js が構造を定義)
  bracketIds: new Set(),

  // 確定済みの成績。tournamentId -> { playerId: 勝ち上がりの深さ }。
  // 優勝=1、準優勝=2、ベストN=N で、小さいほど上位（DBの tournament_entries.placement）。
  placements: {},
  publishedRanking: null, // { publishedAt, periodMonths, rankings: [...] } | null（未公開）
  // ホーム画面の運営からのお知らせ。pinned優先＋新しい順で並べて持つ。
  announcements: [],  // { id, title, body, imageUrl, pinned, createdAt, updatedAt }
};

// 新しいレコードのID。DB側の主キーがuuidなので、クライアントで作るIDもuuidに揃える。
// crypto.randomUUID はセキュアコンテキスト（HTTPS / localhost）でのみ使えるが、
// Cloudflare Pagesは常にHTTPSなので問題ない。
export function newId() {
  return crypto.randomUUID();
}

// プレイヤーIDから表示用の現在名を取得する。BYE(null)は呼び出し側で扱う。
export function getPlayerName(id) {
  if (!id) return null;
  const player = state.players.find((p) => p.id === id);
  return player ? player.currentName : id;
}

// ---- 出場の単位（entrant）----
//
// 個人戦（1v1・リレー）は選手が、チーム戦（2v2）はチームがブラケットの枠に入る。
// ブラケットのJSONにはどちらのIDも同じ形で入っているので、大会の対戦方法を見て
// 名前の引き方だけを切り替える。

export function isTeamTournament(tournament) {
  return tournament?.matchType === '2v2';
}

export function findTournament(tournamentId) {
  return state.tournaments.find((t) => t.id === tournamentId) ?? null;
}

export function findTeam(tournamentId, teamId) {
  if (!teamId) return null;
  return findTournament(tournamentId)?.teams?.find((tm) => tm.id === teamId) ?? null;
}

// 出場枠の表示名。個人戦は選手名、チーム戦はチーム名。
export function getEntrantName(tournamentId, id) {
  if (!id) return null;
  return findTeam(tournamentId, id)?.name ?? getPlayerName(id);
}

// 出場枠に属する選手名の一覧。チーム戦ではメンバー名、個人戦は空配列
// （選手名は getEntrantName が返しているので、添える名前は無い）。
export function getEntrantMemberNames(tournamentId, id) {
  const team = findTeam(tournamentId, id);
  if (!team) return [];
  return team.memberIds.map((pid) => getPlayerName(pid));
}

// 出場枠に属する選手IDの一覧。個人戦はその選手1人。
export function getEntrantMemberIds(tournamentId, id) {
  const team = findTeam(tournamentId, id);
  return team ? [...team.memberIds] : (id ? [id] : []);
}

// 自分がこの大会に出ている場合の「出場枠のID」。出ていなければ null。
// 個人戦なら自分の選手ID、チーム戦なら所属チームのID。
export function entrantIdOfPlayer(tournament, playerId) {
  if (!tournament || !playerId) return null;
  if (isTeamTournament(tournament)) {
    return tournament.teams?.find((tm) => tm.memberIds.includes(playerId))?.id ?? null;
  }
  return tournament.entrantIds.includes(playerId) ? playerId : null;
}

// アプリ全体で共有する in-memory データストア。
// スキーマは doc/design.md のデータベース設計に準拠する。DBのsnake_caseとの変換は
// js/db.js が境界で行うため、ここから下の計算・描画ロジックはストレージを意識しない。
export const state = {
  // { id, currentName, pastNames: [], gameAccountId, bio, mainCharacters: [],
  //   snsX, snsTwitch, snsYoutube, role, userId }
  players: [],
  // { id, name, date, format, matchType, matchTypeNote, entrantIds: [], participantIds: [],
  //   teams: [], entrantCount, participantCount, weight, rules, imageUrl, status, capacity }
  //
  // 出場の単位が2つあることに注意（2v2でこの2つがズレる）。
  //   entrantIds     ブラケットの枠に入る単位。個人戦は選手ID、チーム戦はチームID。
  //                  シード・枠数・定員・大会規模Tierはすべてこちらで数える
  //   participantIds 出場した「人」。チーム戦ではメンバー全員が並ぶ。
  //                  選手ページ・選手削除の判定はこちら
  // 個人戦ではこの2つは同じ配列になるので、既存の挙動は変わらない。
  // teams は チーム戦のときだけ入る { id, name, memberIds: [], seed, placement }。
  //
  // 【重要】この3つの配列は「詳細を開いた大会」でしか埋まらない（db.js の
  // ensureTournamentDetail が読み込む）。まだ読んでいない大会では空配列になる。
  // 一覧に出す人数は、行を運ばずDB側で数えた entrantCount / participantCount を使うこと。
  // 「誰が出ているか」を配列から引く処理は、必ず先に ensureTournamentDetail を呼ぶ。
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
  //
  // 普段入っているのは優勝（=1）だけ。一覧に「優勝: ○○」を出すのに必要で、
  // かつ1大会1〜2行にしかならないため常に読む。それ以外の順位は、詳細を開いた大会と
  // 選手ページで読み込んだぶんだけ入る。
  placements: {},
  // チーム戦の優勝チーム名。tournamentId -> チーム名。
  // チームの行を読み込んでいない大会でも「優勝: ○○」を出せるようにするための控え。
  teamChampions: {},
  // { publishedAt, periodStart, periodEnd, periodMonths, rankings: [...] } | null（未公開）
  // periodStart/periodEnd はカレンダーで選んだ集計期間（'YYYY-MM-DD'、片側または両方
  // null なら無制限）。periodMonths は移行前の「直近Nか月」形式の古い公開データにだけ残る。
  publishedRanking: null,
  // ホーム画面の運営からのお知らせ。pinned優先＋新しい順で並べて持つ。
  announcements: [],  // { id, title, body, imageUrl, pinned, createdAt, updatedAt }

  // チャットからの運営への報告。RLSにより、運営には全件・一般の選手には
  // 自分が出したものだけが入る（ゲストは空）。新しい順。
  chatReports: [],    // { id, tournamentId, matchId, reporterId, body, createdAt, resolvedAt, resolvedBy }

  // 選手が入力し、相手の承認を待っているゲームカウント。1試合につき1件。
  // RLSにより、当事者と運営にしか入らない。承認されると消える。
  resultReports: [],  // { tournamentId, matchId, reportedBy, reporterPlayerId, score, winnerEntrantId, createdAt }

  // 回戦ごとの開始と配信台。行が無い回戦は「未開始・配信台未定」と同じ。
  rounds: [],         // { tournamentId, roundIndex, streamedMatchIds: [], startedAt, startedBy }

  // 対戦ごとのルームコード。RLSにより当事者と運営にしか入らない（ゲスト・観戦者は空）。
  roomCodes: [],      // { tournamentId, matchId, code, setBy, updatedAt }
};

// 回戦の状態。まだ触られていない回戦は行が無いので、既定の形を返す。
export function roundState(tournamentId, roundIndex) {
  return state.rounds.find(
    (r) => r.tournamentId === tournamentId && r.roundIndex === roundIndex,
  ) ?? { tournamentId, roundIndex, streamedMatchIds: [], startedAt: null, startedBy: null };
}

// 選手がゲームカウントを入力できるのは、運営がその回戦を開始してから。
export function isRoundStarted(tournamentId, roundIndex) {
  return Boolean(roundState(tournamentId, roundIndex).startedAt);
}

// この試合が配信台に乗っているか。
export function isStreamedMatch(tournamentId, roundIndex, matchId) {
  return roundState(tournamentId, roundIndex).streamedMatchIds.includes(matchId);
}

// この試合に出ている承認待ちのゲームカウント（無ければ null）。
export function pendingResultReport(tournamentId, matchId) {
  return state.resultReports.find(
    (r) => r.tournamentId === tournamentId && r.matchId === matchId,
  ) ?? null;
}

// この試合のルームコード（無ければ null）。当事者と運営以外は常に null。
export function matchRoomCode(tournamentId, matchId) {
  return state.roomCodes.find(
    (r) => r.tournamentId === tournamentId && r.matchId === matchId,
  ) ?? null;
}

// 未対応の報告。大会だけ・特定の試合だけに絞れる。
// 印を出すかどうかの判定はすべてこれを通す。
export function openChatReports(tournamentId = null, matchId = null) {
  return state.chatReports.filter((r) => !r.resolvedAt
    && (tournamentId == null || r.tournamentId === tournamentId)
    && (matchId == null || r.matchId === matchId));
}

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

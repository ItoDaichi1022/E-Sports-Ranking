// アプリ全体で共有する in-memory データストア。
// スキーマは doc/design.md のデータベース設計に準拠する。DBのsnake_caseとの変換は
// js/db.js が境界で行うため、ここから下の計算・描画ロジックはストレージを意識しない。
export const state = {
  // { id, currentName, pastNames: [], gameAccountId, bio, mainCharacters: [],
  //   snsX, snsTwitch, snsYoutube, role, userId }
  players: [],
  // { id, name, date, format, matchType, matchTypeNote, entrantIds: [], entrantSeeds: [],
  //   participantIds: [], teams: [], entrantCount, participantCount, weight, rules,
  //   imageUrl, status, capacity }
  //
  // 出場の単位が2つあることに注意（2v2でこの2つがズレる）。
  //   entrantIds     ブラケットの枠に入る単位。個人戦は選手ID、チーム戦はチームID。
  //                  シード・枠数・定員・大会規模Tierはすべてこちらで数える
  //   entrantSeeds   entrantIds と同じ並びのシード番号。募集中などシードが決まる前は
  //                  null が並ぶ（並びは登録順）。番号を画面に出してよいかの判定に使う
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

  // 選手ページからの通報。chatReports と同じくRLSで絞られ、運営には全件・
  // 一般の選手には自分が出したものだけが入る（ゲストは空）。新しい順。
  // 通報された本人には自分宛ての通報は入らない（誰が通報したかを見せないため）。
  playerReports: [],  // { id, targetId, reporterId, reason, body, createdAt, resolvedAt, resolvedBy, resolution }

  // 大会ごとの運営。誰でも読める（大会ページに「運営: ○○」として出す）。
  // 大会を作った人はDB側のトリガで必ずここに入る。
  tournamentOrganizers: [],  // { tournamentId, playerId }

  // 回戦ごとの開始と配信台。行が無い回戦は「未開始・配信台未定」と同じ。
  rounds: [],         // { tournamentId, roundIndex, streamedMatchIds: [], startedAt, startedBy }

  // 対戦ごとのルームコード。RLSにより当事者と運営にしか入らない（ゲスト・観戦者は空）。
  roomCodes: [],      // { tournamentId, matchId, code, setBy, updatedAt }
};

// この大会の運営に指名されている選手のID。
// 「操作してよいか」の判定は auth.js の canManageTournament を通すこと
// （サイト全体の運営はここに名前が無くても触れる）。ここは一覧の表示用。
export function organizerIdsOf(tournamentId) {
  return state.tournamentOrganizers
    .filter((o) => o.tournamentId === tournamentId)
    .map((o) => o.playerId);
}

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

// ---- 通報と利用停止（BAN）----
//
// 通報が何人ぶん集まったらBAN対象として運営の画面に並べるか。
// 【DB側にも同じ数がある】supabase/schema.sql の player_ban_threshold()。
// 変えるときは両方そろえること（片方だけ変えても画面とDBが食い違うだけで、
// どちらが正しいという作りにはしていない ── DBは数えるだけで、止める判断はしない）。
export const BAN_THRESHOLD = 3;

// この選手は利用停止中か。
export function isBannedPlayer(player) {
  return Boolean(player?.bannedAt);
}

// 停止されていない選手だけ。一覧・検索・相方選び・運営の指名はこれを通す。
//
// state.players そのものを絞らないのは、対戦表と戦績が名前を引けなくなるため
// （停止しても過去の記録は残す、というのがこの機能の前提）。見せる場所を選ぶのは
// 呼ぶ側の仕事で、名前解決（getPlayerName）は全員を対象にし続ける。
export function activePlayers() {
  return state.players.filter((p) => !isBannedPlayer(p));
}

// まだ運営が見ていない通報。選手を指定するとその人宛てのものだけ。
export function openPlayerReports(targetId = null) {
  return state.playerReports.filter((r) => !r.resolvedAt
    && (targetId == null || r.targetId === targetId));
}

// 未対応の通報を、通報された選手ごとにまとめる（運営の画面用）。
//
// 数えるのは「届いた件数」ではなく「通報した人の数」。DB側も同じ数え方で、
// 同じ人からの連投は部分ユニーク索引で1件に潰してある（schema.sql の
// player_reports_open_uniq）。多い順に並べて返す。
export function playerReportSummaries() {
  const byTarget = new Map();

  openPlayerReports().forEach((r) => {
    if (!byTarget.has(r.targetId)) {
      byTarget.set(r.targetId, { targetId: r.targetId, reports: [], reporterIds: new Set() });
    }
    const entry = byTarget.get(r.targetId);
    entry.reports.push(r);
    entry.reporterIds.add(r.reporterId);
  });

  return [...byTarget.values()]
    .map((entry) => ({
      targetId: entry.targetId,
      // 新しい順。運営が最初に読むのは直近の1件なので、先頭に置く
      reports: [...entry.reports].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
      reporterCount: entry.reporterIds.size,
      isCandidate: entry.reporterIds.size >= BAN_THRESHOLD,
    }))
    .sort((a, b) => b.reporterCount - a.reporterCount
      || String(b.reports[0].createdAt).localeCompare(String(a.reports[0].createdAt)));
}

// 自分がこの選手を通報済みか（未対応のものがあるか）。
// 運営が却下すると消えるので、そのあとは改めて通報できる。
export function hasOpenReportFrom(reporterId, targetId) {
  if (!reporterId || !targetId) return false;
  return state.playerReports.some(
    (r) => !r.resolvedAt && r.reporterId === reporterId && r.targetId === targetId,
  );
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

// 出場枠の名前。個人戦は選手名、チーム戦はチーム名。
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

import {
  state, getEntrantName, getEntrantMemberNames, getEntrantMemberIds, openChatReports,
  entrantIdOfPlayer, roundState, isRoundStarted, isStreamedMatch,
} from './state.js';
import { thirdPlaceMatchOf } from './bracket.js';
import { characterRowArtElement } from './characters.js';
import { auth, canManageTournament } from './auth.js';
import { canUseMatchChat, openMatchChat } from './matchChat.js';
import { makeIconButton } from './icons.js';
import { attachBracketZoom } from './bracketZoom.js';
import * as db from './db.js';

// 1回戦（葉ノード）1枠あたりの高さ。深いラウンドほど 2^round 倍のスロット高さになり、
// 実際のトーナメント表のように中央揃えで配置される。
//
// 画面の広さで変えることはしない。狭い画面には拡大縮小（js/bracketZoom.js）で
// 応じるので、表の形はどの画面でも同じ ── スマートフォンで見た形と、大きな画面で
// 見た形が食い違わない。
const LEAF_ROW_HEIGHT_PX = 100;

// 対戦表の見せ方。
//
//   tree    横に伸びる本来の対戦表。勝ち上がりの枝がそのまま見える
//   rounds  回戦ごとに1列で積む一覧。1試合ずつ大きく読める
//
// 既定はどの画面でも tree。表を見に来た人がいちばん見たいのは勝ち上がりの枝なので、
// 画面が狭いというだけで形を組み替えない。狭さには倍率で応じる（地図と同じで、
// 全体を眺めてから寄る。js/bracketZoom.js）。
//
// rounds は「いまの回戦の対戦カードだけを大きく読みたい」ときのための形として残す。
// 対戦カードそのもの（名前・シード・ゲームカウント・地模様）は tree と同じものを
// 並べるので、見た目の作りは変わらない ── 並べ方だけを変えている。
//
// 選択はページを開いているあいだ覚えておく。回戦が進むたびに描き直されるので、
// そのつど既定へ戻ると、選んだ形が勝手に元へ戻ってしまう。
let viewModeChoice = null;

function effectiveViewMode() {
  return viewModeChoice ?? 'tree';
}

// 回戦ごと表示で開いている回戦。大会が変わったら選び直す。
let openRound = { tournamentId: null, index: 0 };

let lastRenderArgs = null;

// いま画面に出ている対戦表の拡大縮小（js/bracketZoom.js）と、その倍率・位置。
// 表は更新のたびに丸ごと作り直されるので、作り直す直前にここへ控えて、描いたあとに
// 戻す ── そうしないと、見ていたところが更新のたびに左上へ飛んでしまう。
let activeZoom = null;
let savedTreeView = { tournamentId: null, scale: 1, left: 0, top: 0 };

function redraw() {
  if (!lastRenderArgs) return;
  renderBracket(
    lastRenderArgs.tournamentId, lastRenderArgs.containerEl,
    lastRenderArgs.onChanged, lastRenderArgs.options,
  );
}

function slotPlacement(roundIndex, matchIndex) {
  const rowSpan = 2 ** (roundIndex + 1);
  const rowStart = matchIndex * rowSpan + 1;
  return { rowStart, rowSpan };
}

// 確定済みスコア文字列 "3-1" を [player1のスコア, player2のスコア] に分解する。
function playerScores(match) {
  if (!match.score || typeof match.score !== 'string') return [null, null];
  const parts = match.score.split('-');
  if (parts.length !== 2) return [null, null];
  return [parts[0].trim(), parts[1].trim()];
}

// 運営が組み合わせを直しているときの状態。renderBracket が毎回入れ直す。
// 対戦表は同時に1つしか描かないので、引数で持ち回らずここに置いている。
let swapCtx = { active: false, selected: null, onPick: null };

// 選手名からその人のプロフィールへ。対戦相手がどんな選手なのかは、対戦表を見て
// いちばん気になるところなので、名前をそのまま入口にする。
// 誰が入るか決まっていない枠（TBD）は押せない文字のままにする。
// canLink は対戦表の中でだけ落ちる。対戦表の外（参加メンバー一覧）から呼ぶときは
// 入れ替えモードとは無関係なので、呼び出し側が true を渡す。
function playerNameLink(playerId, name, canLink = !swapCtx.active) {
  // 入れ替え中は名前を押しても選手ページへ飛ばさない（押す意味が「選ぶ」に変わるため）
  if (!playerId || !canLink) {
    const span = document.createElement('span');
    span.textContent = name;
    return span;
  }

  const link = document.createElement('a');
  link.className = 'player-name-link';
  link.href = `#player/${encodeURIComponent(playerId)}`;
  link.textContent = name;
  link.title = `${name} のプロフィール`;
  return link;
}

// Challonge風の1行（シード番号・名前・スコア枠）を作る。
// チーム戦では name にチーム名が入り、members にメンバー名が並ぶ。
// memberIds は members と同じ並び（個人戦はその選手1人）。
//
// showScore=false / canLink=true は対戦表の外（大会詳細の参加メンバー一覧）から
// 使うときの形。スコアを入れる場所が無く、入れ替えモードとも関係が無い。
function buildPlayerRow({
  seed, name, members = [], memberIds = [], isWinner,
  showScore = true, canLink = !swapCtx.active,
}) {
  const row = document.createElement('div');
  row.className = 'match-player' + (isWinner ? ' winner' : '');

  const seedBadge = document.createElement('span');
  seedBadge.className = 'seed-badge';
  if (seed != null) seedBadge.textContent = seed;
  else seedBadge.classList.add('seed-badge-empty');

  // チーム名だけだと誰が出ているか分からないので、メンバー名を小さく添える
  const nameEl = document.createElement('div');
  nameEl.className = 'player-name';
  if (members.length > 0) {
    // チーム名は選手ではないので押せない。プロフィールへ行けるのはメンバーの名前
    const teamName = document.createElement('span');
    teamName.className = 'entrant-team-name';
    teamName.textContent = name;

    const memberLine = document.createElement('span');
    memberLine.className = 'entrant-members';
    members.forEach((memberName, i) => {
      if (i > 0) memberLine.append(document.createTextNode(' / '));
      memberLine.appendChild(playerNameLink(memberIds[i], memberName, canLink));
    });

    nameEl.append(teamName, memberLine);
  } else {
    nameEl.appendChild(playerNameLink(memberIds[0], name, canLink));
  }

  const scoreSpan = document.createElement('span');
  scoreSpan.className = 'player-score';

  row.append(seedBadge, nameEl);
  if (showScore) row.appendChild(scoreSpan);

  // 誰と当たるのかは名前だけでは掴みにくい。ランキングの行と同じように、その枠の
  // メインキャラクターを地模様として敷いておく（登録していない枠には何も出さない）。
  const art = characterRowArtElement(
    memberIds.map((pid) => state.players.find((p) => p.id === pid)?.mainCharacters?.[0]),
  );
  if (art) {
    row.classList.add('has-match-art');
    row.appendChild(art);
  }

  return { row, scoreSpan, nameEl };
}

// 参加メンバー一覧（大会詳細）の1枠。対戦カードと同じ行をそのまま使う。
//
// 同じ大会の「誰が出ているか」を2通りの見た目で見せると、対戦表で覚えた顔ぶれと
// 一覧の顔ぶれが結び付かない。シード番号・名前・メンバー・キャラクターの地模様まで
// 対戦表と揃えておけば、一覧で見た枠がそのまま表の中で見つかる。
//
// seed に null を渡すとバッジは空欄になる（シードが決まる前の募集中の大会）。
export function buildEntrantRow(tournamentId, entrantId, seed = null) {
  const { row } = buildPlayerRow({
    seed,
    name: getEntrantName(tournamentId, entrantId),
    members: getEntrantMemberNames(tournamentId, entrantId),
    memberIds: getEntrantMemberIds(tournamentId, entrantId),
    showScore: false,
    canLink: true,
  });

  const box = document.createElement('div');
  box.className = 'match-box entrant-card';
  box.appendChild(row);
  return box;
}

function drawConnectorLines(bracket, wrapper, matchElements) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.classList.add('bracket-lines');
  svg.setAttribute('width', wrapper.scrollWidth);
  svg.setAttribute('height', wrapper.scrollHeight);

  const wrapperRect = wrapper.getBoundingClientRect();

  bracket.rounds.forEach((round) => {
    round.matches.forEach((match) => {
      if (!match.nextMatchId) return;
      const fromEl = matchElements.get(match.id);
      const toEl = matchElements.get(match.nextMatchId);
      if (!fromEl || !toEl) return;

      const fromRect = fromEl.getBoundingClientRect();
      const toRect = toEl.getBoundingClientRect();
      const startX = fromRect.right - wrapperRect.left;
      const startY = fromRect.top + fromRect.height / 2 - wrapperRect.top;
      const endX = toRect.left - wrapperRect.left;
      const endY = toRect.top + toRect.height / 2 - wrapperRect.top;
      const midX = (startX + endX) / 2;

      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('class', 'connector-line');
      path.setAttribute('d', `M ${startX} ${startY} H ${midX} V ${endY} H ${endX}`);
      svg.appendChild(path);
    });
  });

  wrapper.appendChild(svg);
}

// 入れ替え中は、選手の行そのものを「選ぶ」ボタンにする。
// 1人目を選ぶと印が付き、2人目を選んだ時点で入れ替わる（呼び出し側が実行する）。
function makeRowSwapTarget(row, entrantId) {
  if (!entrantId) return; // 空き枠（TBD・BYEの相手）は選べない

  row.row.classList.add('swap-target');
  if (swapCtx.selected === entrantId) row.row.classList.add('swap-selected');
  row.row.title = swapCtx.selected === entrantId
    ? '選択中（もう一度押すと取り消し）'
    : '入れ替える相手として選ぶ';
  row.row.addEventListener('click', () => swapCtx.onPick(entrantId));
}

// 対戦カードの右端に1つだけ置く鉛筆。ルームコード・チャット・ゲームカウントの入口。
//
// 出場者にとっての主な入口は画面下端の固定バー（ownMatchBar）で、こちらは
// 「どの試合にも入れる運営」と「自分の試合以外も見たい人」のための入口。
// 名前はプロフィールへ行く入口なので、対戦を開く操作はこのアイコンに集約する。
function cardEditButton(onOpen, label) {
  const btn = makeIconButton('pencil', label, { className: 'edit-match-btn' });
  btn.addEventListener('click', onOpen);
  return btn;
}

// 確定した試合の入口。もう記入するものが無いので鉛筆は置かず、下端の帯だけにする
// （運営が結果を直すときも、この帯から入ってチャットの中の「結果を編集」を押す）。
function chatButton(label, onOpen) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'match-chat-btn';
  btn.textContent = label;
  btn.addEventListener('click', onOpen);
  return btn;
}

// 当事者に出す1行。入力そのものはチャットの中で行うので、ここは今どうなっているかを
// 伝えて、チャットへ送り出すだけにする（対戦表の枠は狭く、入力欄には向かない）。
//
// 状態は2つだけ ── 開始を待っているか、始まっているか。ゲームカウントは入れた瞬間に
// 確定するので、「入力済み・相手待ち」のような途中の状態がそもそも無い。
// 始まったことは対戦表の上でも分かるようにする（回戦の見出しまで目を上げなくてよい）。
function resultStatusLine(tournamentId, roundIndex) {
  const started = isRoundStarted(tournamentId, roundIndex);

  const line = document.createElement('div');
  line.className = 'match-status result-status' + (started ? ' is-live' : '');
  line.textContent = started ? '試合開始 — 開いて対戦' : '運営の開始待ち';
  return line;
}

// 配信台に乗せる試合を選ぶトグル（運営・開始前だけ）。
// 一覧から選ばせるのではなく、対戦表そのものを押させる。どのカードを配信するかは
// 表を見ながら決めるものなので、そのほうが迷わない。
function streamToggle(tournamentId, roundIndex, match, onRefresh) {
  const on = isStreamedMatch(tournamentId, roundIndex, match.id);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'stream-toggle-btn' + (on ? ' on' : '');
  btn.textContent = on ? '配信台にする（解除）' : '配信台にする';

  btn.addEventListener('click', async () => {
    const current = roundState(tournamentId, roundIndex).streamedMatchIds;
    const next = on ? current.filter((id) => id !== match.id) : [...current, match.id];

    btn.disabled = true;
    try {
      await db.saveRoundStream(tournamentId, roundIndex, next);
      await onRefresh();
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
    }
  });

  return btn;
}

// 「いま行われている回戦」かどうか。開始済みで、まだ確定していない対戦が残っている
// 回戦を指す。配信台の色分けに使う（終わった回戦とこれからの回戦は落ち着いた色にする）。
function isRoundInProgress(tournamentId, roundIndex, round) {
  if (!isRoundStarted(tournamentId, roundIndex)) return false;
  return round.matches.some((m) => !m.confirmed && !m.isBye);
}

// まだ終わっていない自分の対戦を1つ探す。早い回戦から見ていくので、
// 見つかるのは「いま戦っている（これから戦う）試合」になる。
// BYE は生成時点で確定済みなので、ここには出てこない。
function findOwnMatch(tournament, bracket) {
  const myEntrant = entrantIdOfPlayer(tournament, auth.player?.id);
  if (!myEntrant) return null;

  for (let roundIndex = 0; roundIndex < bracket.rounds.length; roundIndex += 1) {
    const round = bracket.rounds[roundIndex];
    const match = round.matches.find(
      (m) => !m.confirmed && (m.player1Id === myEntrant || m.player2Id === myEntrant),
    );
    if (match) return { match, round, roundIndex, myEntrant };
  }
  return null;
}

// 画面の下端に貼り付ける「あなたの対戦」。
//
// 対戦表は縦にも横にも長く、回戦が進むほど自分の枠は端に寄っていく。表の中から
// 自分を探して、狭いカードの中の正しい場所を押す——という手順を踏ませる代わりに、
// 出場者にはここから直接ひらいてもらう。ページのどこを見ていても同じ位置に
// 出ているので、探す必要も、押し間違えて選手ページへ飛ぶこともない。
//
// CSS で position: fixed にしているが、対戦表のページ（#view-bracket）の中に
// 置いてあるので、他のページへ移れば hidden と一緒に消える。
function ownMatchBar(tournament, tournamentId, bracket, onRefresh, onChanged) {
  const own = findOwnMatch(tournament, bracket);
  if (!own) return null;

  const { match, round, roundIndex, myEntrant } = own;

  const bar = document.createElement('div');
  bar.className = 'own-match-bar';

  // 帯は画面の幅いっぱいに敷き、中身だけ本文と同じ幅に収める
  const panel = document.createElement('div');
  panel.className = 'own-match-panel';
  bar.appendChild(panel);

  const label = document.createElement('span');
  label.className = 'own-match-label';
  label.textContent = 'あなたの対戦';

  const roundChip = document.createElement('span');
  roundChip.className = 'own-match-round';
  // 三位決定戦は決勝と同じ回戦に属しているので、回戦名（F）ではなく試合の名前を出す
  roundChip.textContent = match.isThirdPlace ? '3位決定戦' : round.name;

  const opponentId = match.player1Id === myEntrant ? match.player2Id : match.player1Id;
  const vs = document.createElement('span');
  vs.className = 'own-match-vs';
  vs.textContent = opponentId
    ? `vs ${getEntrantName(tournamentId, opponentId)}`
    : '対戦相手はまだ決まっていません';

  panel.append(label, roundChip, vs);

  // 開始したかどうかを添える。この帯はページのどこを見ていても出ているので、
  // 対戦表を開いていない人にも合図がここで届く。
  const started = isRoundStarted(tournamentId, roundIndex);
  const status = document.createElement('span');
  status.className = 'own-match-status' + (started ? ' is-live' : '');
  status.textContent = started ? '試合開始' : '運営の開始待ち';
  panel.appendChild(status);

  // 相手が決まるまではチャットの部屋も作れない（canUseMatchChat も同じ判定）
  if (canUseMatchChat(tournament, match)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'own-match-open';
    btn.textContent = '対戦を開く';
    btn.addEventListener('click', () => {
      openMatchChat(tournament, match, roundIndex, onRefresh, onChanged);
    });
    panel.appendChild(btn);
  }

  return bar;
}

function renderMatchBox(
  tournament, tournamentId, roundIndex, match, onChanged, readOnly, seedOf, onRefresh,
  roundInProgress = true,
) {
  const box = document.createElement('div');
  box.className = 'match-box';
  if (match.confirmed) box.classList.add('confirmed');
  if (match.isBye) box.classList.add('bye');
  if (match.isWalkover) box.classList.add('walkover');

  const streamed = isStreamedMatch(tournamentId, roundIndex, match.id);
  if (streamed) {
    box.classList.add('streamed');
    // いま行われている回戦の配信台だけを目立つ色にする。終わった回戦や、
    // これから始まる回戦の配信台まで同じ色だと、どこが今の配信か分からない。
    if (!roundInProgress) box.classList.add('streamed-idle');
    const tag = document.createElement('div');
    tag.className = 'stream-tag';
    tag.textContent = '配信台';
    box.appendChild(tag);
  }

  // BYE（不戦勝）はラベルを出さず、進出した選手・チームの名前だけをそのまま表示する。
  if (match.isBye) {
    const byeRow = buildPlayerRow({
      seed: seedOf(match.winnerId),
      name: getEntrantName(tournamentId, match.winnerId),
      members: getEntrantMemberNames(tournamentId, match.winnerId),
      memberIds: getEntrantMemberIds(tournamentId, match.winnerId),
      isWinner: true,
    });
    // 不戦勝の枠も入れ替えの対象。「この人にBYEを回したい」を直せるようにする。
    if (swapCtx.active) makeRowSwapTarget(byeRow, match.winnerId);
    box.appendChild(byeRow.row);
    return box;
  }

  // player1Id / player2Id に入っているのは「出場枠」のID。チーム戦ではチームのIDになる
  // （フィールド名は保存済みのブラケットJSONと合わせるため変えていない）。
  const p1 = match.player1Id;
  const p2 = match.player2Id;
  const name1 = p1 ? getEntrantName(tournamentId, p1) : 'TBD';
  const name2 = p2 ? getEntrantName(tournamentId, p2) : 'TBD';

  const r1 = buildPlayerRow({
    seed: p1 ? seedOf(p1) : null,
    name: name1,
    members: getEntrantMemberNames(tournamentId, p1),
    memberIds: getEntrantMemberIds(tournamentId, p1),
    isWinner: match.winnerId && match.winnerId === p1,
  });
  const r2 = buildPlayerRow({
    seed: p2 ? seedOf(p2) : null,
    name: name2,
    members: getEntrantMemberNames(tournamentId, p2),
    memberIds: getEntrantMemberIds(tournamentId, p2),
    isWinner: match.winnerId && match.winnerId === p2,
  });

  // 対戦カードごとのチャット。入れるのは当事者と運営だけ（判定はDBのポリシーが持ち、
  // ここでの出し分けは押せないものを見せないための便宜）。
  // 勝敗の入力・確定もここ（対戦チャットのダイアログ）で行う。運営・選手とも、
  // 入れた時点でその場で確定する（js/matchChat.js）。
  const chatAvailable = canUseMatchChat(tournament, match);
  const openChat = () => openMatchChat(tournament, match, roundIndex, onRefresh, onChanged);

  // 未対応の報告がある試合は、運営の画面で枠ごと目立たせる。
  // 報告した本人にも見えるが、印は運営を探させるためのものなので運営にだけ出す。
  const reportCount = canManageTournament(tournamentId) ? openChatReports(tournamentId, match.id).length : 0;
  if (reportCount > 0) {
    box.classList.add('reported');
    const flag = document.createElement('div');
    flag.className = 'match-report-flag';
    flag.textContent = reportCount > 1 ? `⚠ 報告 ${reportCount}件` : '⚠ 報告あり';
    box.appendChild(flag);
  }

  // 自分がいる側の行に薄い地色を敷いて、対戦表の中の自分を見つけやすくする。
  // 押す操作は名前（プロフィール）と鉛筆（対戦を開く）に分かれているので、
  // ここでは目印を付けるだけ。
  if (chatAvailable) {
    box.classList.add('has-chat');
    [[p1, r1], [p2, r2]].forEach(([entrantId, row]) => {
      if (getEntrantMemberIds(tournamentId, entrantId).includes(auth.player?.id)) {
        row.nameEl.classList.add('own-chat-row');
      }
    });
  }

  // 入れ替え中は、この対戦カードで開けるのは「選ぶ」だけにする。
  // チャットや結果の入力を混ぜると、押し間違いで別の操作に入ってしまう。
  if (swapCtx.active) {
    makeRowSwapTarget(r1, p1);
    makeRowSwapTarget(r2, p2);
    box.appendChild(r1.row);
    box.appendChild(r2.row);
    return box;
  }

  box.appendChild(r1.row);
  box.appendChild(r2.row);

  if (match.confirmed) {
    if (match.isWalkover) {
      const winnerRow = match.winnerId === p1 ? r1 : r2;
      const loserRow = match.winnerId === p1 ? r2 : r1;
      winnerRow.scoreSpan.textContent = 'W';
      loserRow.scoreSpan.textContent = 'L';
      box.title = '不戦勝';
    } else {
      const [s1, s2] = playerScores(match);
      r1.scoreSpan.textContent = s1 ?? '';
      r2.scoreSpan.textContent = s2 ?? '';
    }

    // 確定した結果を直す操作は、対戦チャットの「ゲームカウント」の中に移した
    // （js/matchChat.js の renderResultPanel）。名前の隣に鉛筆を置くと、
    // 狙いを外して選手ページへ飛ぶ人がいるので、カードには入口だけを残す。
    if (chatAvailable) {
      box.appendChild(chatButton(canManageTournament(tournamentId) ? 'この対戦を開く' : 'チャットを見る', openChat));
    }
    return box;
  }

  if (!p1 || !p2) {
    const status = document.createElement('div');
    status.className = 'match-status';
    status.textContent = '対戦カード未確定';
    box.appendChild(status);
    return box;
  }

  if (!readOnly) {
    // 運営は開始前に配信台を決める。開始後は組み替えさせない
    // （選手には「配信台」と伝わっているので、始まってから動かすと混乱する）。
    if (!isRoundStarted(tournamentId, roundIndex)) {
      box.appendChild(streamToggle(tournamentId, roundIndex, match, onRefresh));
    }
    if (chatAvailable) box.appendChild(cardEditButton(openChat, 'この対戦を開く'));
    return box;
  }

  // 選手・観戦者向け。自分が戦っている対戦なら、いま何を待っているのかを1行で出す
  // （入力はチャットの中）。
  const myEntrant = entrantIdOfPlayer(tournament, auth.player?.id);
  if (myEntrant && (myEntrant === p1 || myEntrant === p2)) {
    const statusLine = resultStatusLine(tournamentId, roundIndex);
    if (statusLine) box.appendChild(statusLine);
  }

  if (chatAvailable) box.appendChild(cardEditButton(openChat, '開いて記入する'));
  return box;
}

// 回戦ごとの開始と配信台。ラウンドの見出しの下に置く。
//
// 運営には「配信台がいくつ選ばれているか」と開始／取り消しのボタン、
// 選手と観戦者には開始したかどうかだけを出す。
// 配信台は開始の条件ではない ── 配信を伴わない大会でも回戦は進むので、
// 未選択のままでも開始できる。
function roundControls(tournamentId, roundIndex, round, readOnly, onRefresh) {
  const wrap = document.createElement('div');
  wrap.className = 'round-controls';

  const started = isRoundStarted(tournamentId, roundIndex);
  const streamCount = roundState(tournamentId, roundIndex).streamedMatchIds.length;

  const status = document.createElement('span');
  status.className = 'round-status' + (started ? ' started' : '');
  status.textContent = started ? '進行中' : '開始待ち';
  wrap.appendChild(status);

  if (readOnly) {
    // 選手・観戦者にも配信台の数だけは見せる（どこが配信に乗るか分かるように）
    if (streamCount > 0) {
      const note = document.createElement('span');
      note.className = 'round-stream-note';
      note.textContent = `${streamCount}試合`;
      wrap.appendChild(note);
    }
    return wrap;
  }

  const note = document.createElement('span');
  note.className = 'round-stream-note';
  note.textContent = streamCount > 0 ? `配信台 ${streamCount}試合` : '配信台なし';
  wrap.appendChild(note);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = started ? 'btn-secondary' : '';
  btn.textContent = started ? '開始を取り消す' : `${round.name} を開始`;

  btn.addEventListener('click', async () => {
    // 配信台は任意（配信しない大会・その回戦だけ配信しない大会もある）。
    // ただ、決めるつもりで忘れたまま押した場合に気づけるよう、確認で一言添える。
    const startMessage = streamCount > 0
      ? `${round.name} を開始します。選手がゲームカウントを入力できるようになります。よろしいですか？`
      : `${round.name} を配信台なしで開始します。選手がゲームカウントを入力できるようになります。よろしいですか？`;
    const message = started
      ? `${round.name} の開始を取り消します。まだ確定していない対戦の入力欄が閉じます。よろしいですか？`
      : startMessage;
    if (!confirm(message)) return;

    btn.disabled = true;
    try {
      if (started) await db.stopRound(tournamentId, roundIndex);
      else await db.startRound(tournamentId, roundIndex, auth.player.id);
      await onRefresh();
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
    }
  });

  wrap.appendChild(btn);
  return wrap;
}

// ---- 回戦ごとの一覧（狭い画面の既定） ----
//
// 対戦表を1回戦ずつに切り分けて、縦に積むだけの形。横スクロールが要らず、
// 枝を描くための空白も生まれないので、20枠の大会でも指1本で端まで読める。
//
// 勝ち上がりの枝は見えなくなるが、その代わりに回戦の札（タブ）で行き来できる。
// 「いま自分はどこにいるか」は画面下端の「あなたの対戦」が受け持っているので、
// この一覧が担うのは「この回戦で誰と誰が当たっているか」だけでよい。

// 回戦の呼び名。表の中の見出し（.round-header）は R1 / SF / F と短くしてあるが、
// こちらは選ぶための札なので、そのまま日本語で言う。
function roundLabel(bracket, roundIndex) {
  const fromEnd = bracket.totalRounds - roundIndex;
  if (fromEnd === 1) return '決勝';
  if (fromEnd === 2) return '準決勝';
  if (fromEnd === 3) return '準々決勝';
  return `${roundIndex + 1}回戦`;
}

// その回戦の進み具合。数えるのは実際に行われる対戦だけで、不戦勝は別に添える
// （BYEは生成時点で確定済みなので、混ぜると「16試合中12試合が確定」のような、
// 何も起きていないのに終わりかけに見える数字になる）。
function roundProgress(round) {
  const byes = round.matches.filter((m) => m.isBye).length;
  const played = round.matches.filter((m) => !m.isBye);
  const done = played.filter((m) => m.confirmed).length;
  return { byes, total: played.length, done, finished: done === played.length };
}

// 最初に開く回戦。まだ終わっていない回戦のうち、いちばん早いもの＝いま動いている回戦。
// 全部終わっていれば決勝（最後の回戦）を出す。
function currentRoundIndex(bracket) {
  const i = bracket.rounds.findIndex((round) => !roundProgress(round).finished);
  return i === -1 ? bracket.rounds.length - 1 : i;
}

// いま開いている回戦。大会が変わったとき（と、まだ何も選んでいないとき）は
// 進行中の回戦から始める。人が札を押して選んだ回戦は、描き直しをまたいで残す。
function openRoundIndex(tournamentId, bracket) {
  if (openRound.tournamentId !== tournamentId) {
    openRound = { tournamentId, index: currentRoundIndex(bracket) };
  }
  return Math.min(openRound.index, bracket.rounds.length - 1);
}

// 回戦を選ぶ札。どの回戦がどこまで進んだかが、開かなくても分かるようにする。
function roundTabs(tournamentId, bracket, activeIndex) {
  const tabs = document.createElement('div');
  tabs.className = 'bracket-round-tabs';

  bracket.rounds.forEach((round, i) => {
    const { done, total, finished } = roundProgress(round);

    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'bracket-round-tab';
    if (i === activeIndex) tab.classList.add('is-active');
    if (finished) tab.classList.add('is-done');
    tab.setAttribute('aria-pressed', String(i === activeIndex));

    const name = document.createElement('span');
    name.className = 'bracket-round-tab-name';
    name.textContent = round.name;

    const count = document.createElement('span');
    count.className = 'bracket-round-tab-count';
    count.textContent = total === 0 ? '—' : `${done}/${total}`;

    tab.append(name, count);
    tab.addEventListener('click', () => {
      openRound = { tournamentId, index: i };
      redraw();
    });
    tabs.appendChild(tab);
  });

  return tabs;
}

// 前後の回戦への送り。札は上にあるので、読み終えた下からも戻れるようにする。
function roundStepper(tournamentId, bracket, activeIndex) {
  const nav = document.createElement('div');
  nav.className = 'bracket-round-nav';

  const step = (delta, text) => {
    const i = activeIndex + delta;
    if (i < 0 || i >= bracket.rounds.length) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-secondary';
    btn.textContent = text.replace('%s', roundLabel(bracket, i));
    btn.addEventListener('click', () => {
      openRound = { tournamentId, index: i };
      redraw();
      // 送った先の先頭から読ませる。押した場所（一覧の下）のままだと、
      // 切り替わったことに気づかないまま途中の対戦を見ることになる。
      lastRenderArgs?.containerEl.querySelector('.bracket-rounds')
        ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    nav.appendChild(btn);
  };

  step(-1, '← %s');
  step(1, '%s →');
  return nav;
}

function renderRoundList(ctx, containerEl) {
  const {
    tournament, tournamentId, bracket, onChanged, readOnly, seedOf, onRefresh,
  } = ctx;

  const wrap = document.createElement('div');
  wrap.className = 'bracket-rounds';

  const activeIndex = openRoundIndex(tournamentId, bracket);
  const round = bracket.rounds[activeIndex];
  const { byes, total, done } = roundProgress(round);

  wrap.appendChild(roundTabs(tournamentId, bracket, activeIndex));

  const head = document.createElement('div');
  head.className = 'bracket-round-head';

  const title = document.createElement('h3');
  title.className = 'bracket-round-name';
  title.textContent = roundLabel(bracket, activeIndex);

  const note = document.createElement('p');
  note.className = 'bracket-round-note';
  note.textContent = total === 0
    ? `不戦勝 ${byes}枠`
    : `${total}試合中 ${done}試合が確定${byes > 0 ? `・不戦勝 ${byes}枠` : ''}`;

  head.append(title, note);
  wrap.appendChild(head);

  // 回戦の開始・配信台は表と同じもの。列の高さをそろえる必要が無いので、
  // ここでは横に並べる（.bracket-rounds の中だけ形が変わる。css/style.css）。
  if (!swapCtx.active) {
    wrap.appendChild(roundControls(tournamentId, activeIndex, round, readOnly, onRefresh));
  }

  const roundInProgress = isRoundInProgress(tournamentId, activeIndex, round);

  const list = document.createElement('div');
  list.className = 'bracket-round-list';

  round.matches.forEach((match) => {
    const item = document.createElement('div');
    item.className = 'bracket-round-item';

    // 三位決定戦は決勝と同じ回戦に混ざっている。表では独立した列に出して
    // 見分けているので、こちらでは名前を添えて同じことをする。
    if (match.isThirdPlace) {
      const label = document.createElement('span');
      label.className = 'bracket-round-item-label';
      label.textContent = '3位決定戦';
      item.appendChild(label);
    }

    item.appendChild(renderMatchBox(
      tournament, tournamentId, activeIndex, match, onChanged, readOnly, seedOf, onRefresh,
      roundInProgress,
    ));
    list.appendChild(item);
  });

  wrap.appendChild(list);
  wrap.appendChild(roundStepper(tournamentId, bracket, activeIndex));
  containerEl.appendChild(wrap);
}

// ---- 見せ方の切り替え ----
//
// 既定はトーナメント表（枝ごと）。ただし「いまの回戦で誰と誰が当たっているか」だけを
// 大きく読みたいことはあるので、回戦ごとの一覧にも切り替えられるようにしておく。
function viewModeToggle(mode) {
  const wrap = document.createElement('div');
  wrap.className = 'bracket-view-toggle';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', '対戦表の見せ方');

  const add = (value, text, title) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bracket-view-btn' + (mode === value ? ' is-active' : '');
    btn.textContent = text;
    btn.title = title;
    btn.setAttribute('aria-pressed', String(mode === value));
    btn.addEventListener('click', () => {
      if (viewModeChoice === value) return;
      viewModeChoice = value;
      redraw();
    });
    wrap.appendChild(btn);
  };

  add('rounds', '回戦ごと', '選んだ回戦の対戦カードだけを縦に並べます');
  add('tree', 'トーナメント表', '勝ち上がりの枝ごと見ます。つまむと拡大・縮小できます');
  return wrap;
}

// ---- 拡大縮小の操作 ----
//
// つまむ・Ctrl＋ホイールを知らなくても倍率を変えられるように、表の右下に置く。
// 出すのは3つだけ ── 引く・寄る・全体。地図と同じ並びなので、押す前に分かる。
function zoomControls(zoom) {
  const wrap = document.createElement('div');
  wrap.className = 'bracket-zoom';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', '対戦表の拡大・縮小');

  const add = (text, label, onClick) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bracket-zoom-btn';
    btn.textContent = text;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.addEventListener('click', onClick);
    wrap.appendChild(btn);
  };

  add('−', '縮小', () => zoom.zoomBy(1 / 1.4));
  add('＋', '拡大', () => zoom.zoomBy(1.4));
  add('全体', '表全体が入る大きさにする', () => zoom.fit());
  return wrap;
}

// 操作の説明を1行だけ添える。つまめること自体に気づかないと、大きな表は
// 「端まで送れない読みにくい表」のままになる。
// 指の画面とマウスの画面で言うことが違うので、両方を書いて css で出し分ける。
function zoomHint() {
  const hint = document.createElement('p');
  hint.className = 'bracket-zoom-hint';

  const touch = document.createElement('span');
  touch.className = 'for-touch';
  touch.textContent = '2本指でつまむと拡大・縮小、1本指でなぞると表を動かせます。';

  const mouse = document.createElement('span');
  mouse.className = 'for-mouse';
  mouse.textContent = 'Ctrl（⌘）＋ホイールで拡大・縮小、掴んで動かせます。';

  hint.append(touch, mouse);
  return hint;
}

// options.onRefresh: 選手の操作（ゲームカウントの入力）のあとに呼ぶ再読み込み。
// onChanged（運営の勝敗入力）とは別にしてある。onChanged は対戦表そのものをDBへ
// 書き戻すので、選手が呼ぶとRLSで弾かれる。
export function renderBracket(tournamentId, containerEl, onChanged, options = {}) {
  const readOnly = !!options.readOnly;
  const onRefresh = options.onRefresh ?? (async () => {});

  // options.swap: 運営が組み合わせを直している間だけ渡される
  //   { selected, onPick } — selected は1人目に選んだ出場枠のID（まだ無ければ null）
  swapCtx = {
    active: Boolean(options.swap) && !readOnly,
    selected: options.swap?.selected ?? null,
    onPick: options.swap?.onPick ?? (() => {}),
  };

  // 同じ大会の描き直しでは、いま見ている倍率と位置を引き継ぐ。
  // 対戦表は Realtime の更新（他の画面の変更でも飛んでくる）のたびに丸ごと
  // 作り直されるので、これが無いと見ている最中に先頭へ戻ってしまう。
  // 別の大会を初めて描くときは引き継がない（前の大会の位置は無関係）。
  if (activeZoom && lastRenderArgs?.tournamentId === tournamentId) {
    savedTreeView = { tournamentId, ...activeZoom.view() };
  }
  activeZoom = null;
  const savedView = savedTreeView.tournamentId === tournamentId ? savedTreeView : null;

  lastRenderArgs = { tournamentId, containerEl, onChanged, options };

  const bracket = state.brackets[tournamentId];
  containerEl.innerHTML = '';

  if (!bracket) {
    containerEl.innerHTML = '<p class="empty-hint">まだブラケットが生成されていません。</p>';
    return;
  }

  // 出場枠のIDはシード順（index 0 = シード1位）で並んでいるので、そこから番号を引く。
  const tournament = state.tournaments.find((t) => t.id === tournamentId);
  const seedByEntrant = new Map();
  if (tournament) tournament.entrantIds.forEach((id, i) => seedByEntrant.set(id, i + 1));
  const seedOf = (id) => (id != null && seedByEntrant.has(id) ? seedByEntrant.get(id) : null);

  // 出場者への入口は画面下端に貼り付ける（位置決めはCSS）。表の中を探させない。
  // 入れ替え中は出さない（そのモードで押せるのは「選ぶ」だけにしてある）。
  if (tournament && !swapCtx.active) {
    const bar = ownMatchBar(tournament, tournamentId, bracket, onRefresh, onChanged);
    if (bar) containerEl.appendChild(bar);
  }

  const ctx = {
    tournament, tournamentId, bracket, onChanged, readOnly, seedOf, onRefresh,
  };

  const mode = effectiveViewMode();
  containerEl.appendChild(viewModeToggle(mode));

  if (mode === 'rounds') renderRoundList(ctx, containerEl);
  else renderTree(ctx, containerEl, savedView);
}

// 本来の対戦表。左から右へ、勝ち上がりの枝ごと1枚に描く。
//
// 表そのもの（.bracket）は倍率をかけられる1枚の板として作り、スクロールと
// 拡大縮小は外側の箱が受け持つ（js/bracketZoom.js）。板の中の作りは倍率と無関係
// なので、列の幅も枠の高さもどの画面でも同じ値でよい。
function renderTree(ctx, containerEl, savedView) {
  const {
    tournament, tournamentId, bracket, onChanged, readOnly, seedOf, onRefresh,
  } = ctx;

  const frame = document.createElement('div');
  frame.className = 'bracket-frame';

  const stage = document.createElement('div');
  stage.className = 'bracket-stage';
  stage.tabIndex = 0;
  stage.setAttribute('role', 'region');
  stage.setAttribute('aria-label', 'トーナメント表');

  const sizer = document.createElement('div');
  sizer.className = 'bracket-sizer';

  const wrapper = document.createElement('div');
  wrapper.className = 'bracket';

  const matchElements = new Map();
  const bodyHeight = bracket.bracketSize * LEAF_ROW_HEIGHT_PX;

  bracket.rounds.forEach((round, roundIndex) => {
    const col = document.createElement('div');
    col.className = 'round-column';

    const header = document.createElement('div');
    header.className = 'round-header';
    header.textContent = round.name;
    col.appendChild(header);

    // 入れ替え中は回戦の開始・配信台の操作を出さない（入れ替えが終わってから決める）
    if (!swapCtx.active) {
      col.appendChild(roundControls(tournamentId, roundIndex, round, readOnly, onRefresh));
    }

    const body = document.createElement('div');
    body.className = 'round-body';
    body.style.height = `${bodyHeight}px`;
    body.style.gridTemplateRows = `repeat(${bracket.bracketSize}, 1fr)`;

    const roundInProgress = isRoundInProgress(tournamentId, roundIndex, round);

    // 三位決定戦は勝ち上がりの枝から外れた試合なので、この並びには混ぜない
    // （下で決勝の隣に独立した列として出す）。
    round.matches.filter((m) => !m.isThirdPlace).forEach((match, matchIndex) => {
      const { rowStart, rowSpan } = slotPlacement(roundIndex, matchIndex);
      const slot = document.createElement('div');
      slot.className = 'match-slot';
      slot.style.gridRow = `${rowStart} / span ${rowSpan}`;

      const box = renderMatchBox(
        tournament, tournamentId, roundIndex, match, onChanged, readOnly, seedOf, onRefresh,
        roundInProgress,
      );
      matchElements.set(match.id, box);
      slot.appendChild(box);
      body.appendChild(slot);
    });

    col.appendChild(body);
    wrapper.appendChild(col);
  });

  // 三位決定戦の列。決勝と同じ回戦（同じタイミング）で行うので、決勝の右隣に置く。
  // 準決勝から線は引かない。勝ち上がりの線と混ざると、負けた側が上がってきたように見える。
  const thirdPlace = thirdPlaceMatchOf(bracket);
  if (thirdPlace) {
    const roundIndex = bracket.totalRounds - 1;
    const col = document.createElement('div');
    col.className = 'round-column';

    const header = document.createElement('div');
    header.className = 'round-header';
    header.textContent = '3位決定戦';
    col.appendChild(header);

    // 決勝の列と高さをそろえるための空欄。開始と配信台は決勝の回戦の操作が兼ねる
    // （同じ回戦に属する試合なので、開始も一緒）。
    if (!swapCtx.active) {
      const spacer = document.createElement('div');
      spacer.className = 'round-controls';
      col.appendChild(spacer);
    }

    const body = document.createElement('div');
    body.className = 'round-body';
    body.style.height = `${bodyHeight}px`;
    body.style.gridTemplateRows = `repeat(${bracket.bracketSize}, 1fr)`;

    const slot = document.createElement('div');
    slot.className = 'match-slot';
    slot.style.gridRow = `1 / span ${bracket.bracketSize}`;
    slot.appendChild(renderMatchBox(
      tournament, tournamentId, roundIndex, thirdPlace, onChanged, readOnly, seedOf, onRefresh,
      isRoundInProgress(tournamentId, roundIndex, bracket.rounds[roundIndex]),
    ));
    body.appendChild(slot);

    col.appendChild(body);
    wrapper.appendChild(col);
  }

  sizer.appendChild(wrapper);
  stage.appendChild(sizer);
  frame.appendChild(stage);
  containerEl.appendChild(frame);

  // 接続線は倍率をかける前（等倍）に描く。線の座標は getBoundingClientRect で
  // 測っていて、先に縮めると測り取る位置がその分ずれてしまう。
  // 描いた線は表の一部なので、あとは表ごと同じ倍率で縮む。
  drawConnectorLines(bracket, wrapper, matchElements);

  activeZoom = attachBracketZoom({
    stage,
    sizer,
    canvas: wrapper,
    contentW: Math.max(wrapper.scrollWidth, wrapper.offsetWidth),
    contentH: Math.max(wrapper.scrollHeight, wrapper.offsetHeight),
    savedView,
  });

  frame.appendChild(zoomControls(activeZoom));
  containerEl.appendChild(zoomHint());
}

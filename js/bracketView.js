import {
  state, getEntrantName, getEntrantMemberNames, getEntrantMemberIds, openChatReports,
  pendingResultReport, entrantIdOfPlayer, roundState, isRoundStarted, isStreamedMatch,
} from './state.js';
import { auth, isAdmin } from './auth.js';
import { canUseMatchChat, openMatchChat } from './matchChat.js';
import { makeIconButton } from './icons.js';
import * as db from './db.js';

// 1回戦（葉ノード）1枠あたりの高さ。深いラウンドほど 2^round 倍のスロット高さになり、
// 実際のトーナメント表のように中央揃えで配置される。
const LEAF_ROW_HEIGHT_PX = 100;

let lastRenderArgs = null;
let resizeRedrawTimer = null;

window.addEventListener('resize', () => {
  clearTimeout(resizeRedrawTimer);
  resizeRedrawTimer = setTimeout(() => {
    if (lastRenderArgs) {
      renderBracket(lastRenderArgs.tournamentId, lastRenderArgs.containerEl, lastRenderArgs.onChanged, lastRenderArgs.options);
    }
  }, 150);
});

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
function playerNameLink(playerId, name) {
  // 入れ替え中は名前を押しても選手ページへ飛ばさない（押す意味が「選ぶ」に変わるため）
  if (!playerId || swapCtx.active) {
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
function buildPlayerRow({ seed, name, members = [], memberIds = [], isWinner }) {
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
      memberLine.appendChild(playerNameLink(memberIds[i], memberName));
    });

    nameEl.append(teamName, memberLine);
  } else {
    nameEl.appendChild(playerNameLink(memberIds[0], name));
  }

  const scoreSpan = document.createElement('span');
  scoreSpan.className = 'player-score';

  row.append(seedBadge, nameEl, scoreSpan);
  return { row, scoreSpan, nameEl };
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

// 承認待ちのゲームカウントを、どちら側の数字か分かる形の文にする
// （"3-1" だけでは、上の行と下の行のどちらが3なのか読み取れない）。
function scoreSentence(name1, name2, score) {
  const [s1, s2] = score.split('-');
  return `${name1} ${s1} - ${s2} ${name2}`;
}

// 当事者に出す1行。入力そのものはチャットの中で行うので、ここは今どうなっているかを
// 伝えて、チャットへ送り出すだけにする（対戦表の枠は狭く、入力欄には向かない）。
function resultStatusLine(tournamentId, roundIndex, match, myEntrant, name1, name2) {
  const line = document.createElement('div');
  line.className = 'match-status result-status';

  if (!isRoundStarted(tournamentId, roundIndex)) {
    line.textContent = '運営の開始待ち';
    return line;
  }

  const pending = pendingResultReport(tournamentId, match.id);
  if (!pending) {
    return null;
  }

  line.classList.add('awaiting');
  line.textContent = pending.reportedBy === myEntrant
    ? `${scoreSentence(name1, name2, pending.score)}／相手の承認待ち`
    : `${scoreSentence(name1, name2, pending.score)}／承認してください`;
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
  roundChip.textContent = round.name;

  const opponentId = match.player1Id === myEntrant ? match.player2Id : match.player1Id;
  const vs = document.createElement('span');
  vs.className = 'own-match-vs';
  vs.textContent = opponentId
    ? `vs ${getEntrantName(tournamentId, opponentId)}`
    : '対戦相手はまだ決まっていません';

  panel.append(label, roundChip, vs);

  // いま何を待っているのかを一言添える。対戦表のカードにも同じことは出ているが、
  // ここだけ見て済ませられるようにする。
  const pending = pendingResultReport(tournamentId, match.id);
  const statusText = (() => {
    if (!isRoundStarted(tournamentId, roundIndex)) return '運営の開始待ち';
    if (!pending) return null;
    return pending.reportedBy === myEntrant ? '相手の承認待ち' : '承認してください';
  })();
  if (statusText) {
    const status = document.createElement('span');
    status.className = 'own-match-status';
    // 自分が動く番のときだけ強めに出す（待っているだけの状態と区別する）
    if (pending && pending.reportedBy !== myEntrant) status.classList.add('is-action');
    status.textContent = statusText;
    panel.appendChild(status);
  }

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
  // 勝敗の入力・確定もここ（対戦チャットのダイアログ）で行う。運営は直接確定、
  // 選手は報告して相手の承認を待つ（js/matchChat.js）。
  const chatAvailable = canUseMatchChat(tournament, match);
  const openChat = () => openMatchChat(tournament, match, roundIndex, onRefresh, onChanged);

  // 未対応の報告がある試合は、運営の画面で枠ごと目立たせる。
  // 報告した本人にも見えるが、印は運営を探させるためのものなので運営にだけ出す。
  const reportCount = isAdmin() ? openChatReports(tournamentId, match.id).length : 0;
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
      box.appendChild(chatButton(isAdmin() ? 'この対戦を開く' : 'チャットを見る', openChat));
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
    // 運営向け。承認待ちの報告があれば一言だけ添える。入力・確定は鉛筆から開く画面で行う。
    const pending = pendingResultReport(tournamentId, match.id);
    if (pending) {
      const note = document.createElement('div');
      note.className = 'match-status pending-note';
      note.textContent = `選手からの報告: ${scoreSentence(name1, name2, pending.score)}（承認待ち）`;
      box.appendChild(note);
    }

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
    const statusLine = resultStatusLine(
      tournamentId, roundIndex, match, myEntrant, name1, name2,
    );
    if (statusLine) box.appendChild(statusLine);
  }

  if (chatAvailable) box.appendChild(cardEditButton(openChat, '開いて記入する'));
  return box;
}

// 回戦ごとの開始と配信台。ラウンドの見出しの下に置く。
//
// 運営には「配信台がいくつ選ばれているか」と開始／取り消しのボタン、
// 選手と観戦者には開始したかどうかだけを出す。
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
  note.textContent = streamCount > 0 ? `配信台 ${streamCount}試合` : '配信台が未定';
  wrap.appendChild(note);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = started ? 'btn-secondary' : '';
  btn.textContent = started ? '開始を取り消す' : `${round.name} を開始`;
  // 配信台を決めるまで開始できない（DB側のCHECK制約でも同じ条件を持っている）
  btn.disabled = !started && streamCount === 0;
  if (btn.disabled) btn.title = '先に配信台にする試合を選んでください。';

  btn.addEventListener('click', async () => {
    const matchIds = round.matches.map((m) => m.id);
    const message = started
      ? `${round.name} の開始を取り消します。まだ確定していない対戦の入力欄が閉じ、承認待ちの報告も取り消されます。よろしいですか？`
      : `${round.name} を開始します。選手がゲームカウントを入力できるようになります。よろしいですか？`;
    if (!confirm(message)) return;

    btn.disabled = true;
    try {
      if (started) await db.stopRound(tournamentId, roundIndex, matchIds);
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

// options.onRefresh: 選手の操作（ゲームカウントの報告・承認）のあとに呼ぶ再読み込み。
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

  // 同じ大会の描き直しでは、横スクロール位置を引き継ぐ。
  // 対戦表は Realtime の更新（他の画面の変更でも飛んでくる）のたびに丸ごと
  // 作り直されるので、これが無いと見ている最中に先頭へ戻ってしまう。
  // 別の大会を初めて描くときは引き継がない（前の大会の位置は無関係）。
  const prevWrapper = containerEl.querySelector('.bracket');
  const keepScroll = prevWrapper && lastRenderArgs?.tournamentId === tournamentId;
  const prevScrollLeft = keepScroll ? prevWrapper.scrollLeft : 0;

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

    round.matches.forEach((match, matchIndex) => {
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

  containerEl.appendChild(wrapper);
  drawConnectorLines(bracket, wrapper, matchElements);

  // スクロールの復元は接続線を描いた後に行う。線の座標は getBoundingClientRect で
  // 測っていて、先にスクロールさせると測り取る位置がその分ずれてしまう。
  if (prevScrollLeft > 0) wrapper.scrollLeft = prevScrollLeft;
}

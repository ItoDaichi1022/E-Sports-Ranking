import {
  state, getEntrantName, getEntrantMemberNames, getEntrantMemberIds, openChatReports,
  pendingResultReport, entrantIdOfPlayer, roundState, isRoundStarted, isStreamedMatch,
} from './state.js';
import { editMatch } from './bracket.js';
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

// Challonge風の1行（シード番号・名前・スコア枠）を作る。
// チーム戦では name にチーム名が入り、members にメンバー名が並ぶ。
function buildPlayerRow({ seed, name, members = [], isWinner }) {
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
    const teamName = document.createElement('span');
    teamName.className = 'entrant-team-name';
    teamName.textContent = name;

    const memberLine = document.createElement('span');
    memberLine.className = 'entrant-members';
    memberLine.textContent = members.join(' / ');

    nameEl.append(teamName, memberLine);
  } else {
    nameEl.textContent = name;
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

// 「自分のいるところを押すと、その対戦の記入と相手とのチャットができる」ための仕掛け。
// 名前欄だけを押せるようにし、スコア入力や確定ボタンを押したときは開かない。
// own: 自分の対戦であることを示す行かどうか（運営がどちらの名前を押しても開ける
// 場合は own を付けない。地色で目立たせるのは本人の行だけにするため）。
function makeRowChatTarget(row, onOpen, { own = false } = {}) {
  const { nameEl } = row;
  nameEl.classList.add('chat-target');
  if (own) nameEl.classList.add('own-chat-row');
  nameEl.title = own ? '開いて記入する' : 'この対戦を開く';

  nameEl.addEventListener('click', (e) => {
    if (e.target.closest('input, button, select, label')) return;
    onOpen();
  });
}

// 対戦カードの下端に1つだけ置く鉛筆。見た目だけでは名前を押せると伝わらないので
// 印を出すが、行ごとに付けると（特に両方の行が入口になる運営には）うるさい。
function cardEditButton(onOpen, label) {
  const btn = makeIconButton('pencil', label, { className: 'edit-match-btn' });
  btn.addEventListener('click', onOpen);
  return btn;
}

// 対戦表の下端に付けるチャットの入口。自分の行を押す導線に気づかない人と、
// どの試合にも入れる運営のための、もう1つの入口。
function chatButton(match, onOpen) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'match-chat-btn';
  btn.textContent = match.confirmed ? 'チャットを見る' : 'チャット';
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

function renderMatchBox(
  tournament, tournamentId, roundIndex, match, onChanged, readOnly, seedOf, onRefresh,
) {
  const box = document.createElement('div');
  box.className = 'match-box';
  if (match.confirmed) box.classList.add('confirmed');
  if (match.isBye) box.classList.add('bye');
  if (match.isWalkover) box.classList.add('walkover');

  const streamed = isStreamedMatch(tournamentId, roundIndex, match.id);
  if (streamed) {
    box.classList.add('streamed');
    const tag = document.createElement('div');
    tag.className = 'stream-tag';
    tag.textContent = '配信台';
    box.appendChild(tag);
  }

  // BYE（不戦勝）はラベルを出さず、進出した選手・チームの名前だけをそのまま表示する。
  if (match.isBye) {
    const { row } = buildPlayerRow({
      seed: seedOf(match.winnerId),
      name: getEntrantName(tournamentId, match.winnerId),
      members: getEntrantMemberNames(tournamentId, match.winnerId),
      isWinner: true,
    });
    box.appendChild(row);
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
    isWinner: match.winnerId && match.winnerId === p1,
  });
  const r2 = buildPlayerRow({
    seed: p2 ? seedOf(p2) : null,
    name: name2,
    members: getEntrantMemberNames(tournamentId, p2),
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

  // 自分の試合、または運営が見ているときは名前欄が入口になるので、下のボタンは出さない
  // （入口は1つでいい）。運営はどちらの名前を押しても同じ画面（確定・チャット）を開ける。
  let ownRowIsChatEntry = false;
  if (chatAvailable) {
    box.classList.add('has-chat');
    if (!readOnly) {
      [r1, r2].forEach((row) => makeRowChatTarget(row, openChat));
      ownRowIsChatEntry = true;
    } else {
      // 自分がいる側の名前欄だけを押せるようにする。
      [[p1, r1], [p2, r2]].forEach(([entrantId, row]) => {
        if (getEntrantMemberIds(tournamentId, entrantId).includes(auth.player?.id)) {
          makeRowChatTarget(row, openChat, { own: true });
          ownRowIsChatEntry = true;
        }
      });
    }
  }
  const showChatButton = chatAvailable && !ownRowIsChatEntry;

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

    if (!readOnly) {
      const editBtn = makeIconButton('pencil', '結果を編集', { className: 'edit-match-btn' });
      editBtn.addEventListener('click', () => {
        const ok = confirm('この試合の結果を編集しますか？以降のラウンドに既に反映・確定している結果があれば、それらも未確定に戻ります。');
        if (!ok) return;
        const result = editMatch(tournamentId, match.id);
        if (!result.ok) {
          alert(result.error);
          return;
        }
        onChanged();
      });
      box.appendChild(editBtn);
    }
    if (showChatButton) box.appendChild(chatButton(match, openChat));
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
    // 運営向け。承認待ちの報告があれば一言だけ添える。入力・確定は名前欄から開く画面で行う。
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
    if (ownRowIsChatEntry) box.appendChild(cardEditButton(openChat, 'この対戦を開く'));
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

  if (ownRowIsChatEntry) box.appendChild(cardEditButton(openChat, '開いて記入する'));
  if (showChatButton) box.appendChild(chatButton(match, openChat));
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

    col.appendChild(roundControls(tournamentId, roundIndex, round, readOnly, onRefresh));

    const body = document.createElement('div');
    body.className = 'round-body';
    body.style.height = `${bodyHeight}px`;
    body.style.gridTemplateRows = `repeat(${bracket.bracketSize}, 1fr)`;

    round.matches.forEach((match, matchIndex) => {
      const { rowStart, rowSpan } = slotPlacement(roundIndex, matchIndex);
      const slot = document.createElement('div');
      slot.className = 'match-slot';
      slot.style.gridRow = `${rowStart} / span ${rowSpan}`;

      const box = renderMatchBox(
        tournament, tournamentId, roundIndex, match, onChanged, readOnly, seedOf, onRefresh,
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

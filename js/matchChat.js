// 対戦カードごとのチャット。
//
// 部屋はブラケットの試合1つにつき1つ。読み書きできるのは その試合の当事者と運営だけで、
// 判定はすべてDBのポリシー（can_use_match_chat）が持つ。ここでの出し分けは
// 押せないボタンを見せないための便宜で、防御ではない。
//
// 2v2ではチーム同士の4人が同じ部屋に入る（当事者の判定を「出場枠」で行うため）。
//
// 更新はRealtimeではなく、開いている間だけの間欠取得にしている。理由は2つ:
//   1. 既存の購読は「どれかのテーブルが変わったら全データを取り直す」作りなので、
//      チャット1通ごとに全員が全件取得することになる
//   2. 当事者にしか見せないデータをブロードキャストに載せると、購読側のRLS適用の
//      設定ミスがそのまま漏洩になる。SELECTで取りに行けば必ずポリシーを通る
// 取りに行くのはダイアログを開いている間だけなので、常時ポーリングにはならない。

import {
  state, getEntrantName, getEntrantMemberIds, openChatReports,
  findTournament, pendingResultReport, isRoundStarted, matchRoomCode,
} from './state.js';
import { auth, isAdmin } from './auth.js';
import { confirmMatch } from './bracket.js';
import { escapeHtml } from './util.js';
import * as db from './db.js';

const POLL_INTERVAL_MS = 5000;

const dialog = document.getElementById('match-chat-dialog');
const titleEl = document.getElementById('match-chat-title');
const metaEl = document.getElementById('match-chat-meta');
const logEl = document.getElementById('match-chat-log');
const formEl = document.getElementById('match-chat-form');
const inputEl = document.getElementById('match-chat-input');
const sendBtn = document.getElementById('match-chat-send-btn');
const closedNoteEl = document.getElementById('match-chat-closed-note');
const errorEl = document.getElementById('match-chat-error');
const closeBtn = document.getElementById('match-chat-close-btn');
const reportsEl = document.getElementById('match-chat-reports');
const reportBtn = document.getElementById('match-chat-report-btn');
const reportFormEl = document.getElementById('match-chat-report-form');
const reportInputEl = document.getElementById('match-chat-report-input');
const reportSendBtn = document.getElementById('match-chat-report-send-btn');
const reportCancelBtn = document.getElementById('match-chat-report-cancel-btn');
const resultEl = document.getElementById('match-chat-result');
const roomEl = document.getElementById('match-chat-room');
const tabsEl = document.getElementById('match-chat-tabs');
const tabTalkBtn = document.getElementById('match-chat-tab-talk');
const tabResultBtn = document.getElementById('match-chat-tab-result');
const tabDotEl = document.getElementById('match-chat-tab-dot');
const panelTalkEl = document.getElementById('match-chat-panel-talk');
const panelResultEl = document.getElementById('match-chat-panel-result');

// 開いている部屋。閉じている間は null。
let room = null; // { tournamentId, matchId, roundIndex, messages: [], lastAt, onRefresh, onChanged }
let pollTimer = null;

// 開いている部屋の試合を state から引き直す。
//
// ダイアログを開いたときのオブジェクトを持ち回ると、結果が確定したあとも
// 「未確定」のままの古い姿を見続けることになる。IDだけ覚えて毎回引く。
function currentMatch() {
  if (!room) return null;
  const bracket = state.brackets[room.tournamentId];
  if (!bracket) return null;

  for (const round of bracket.rounds) {
    const found = round.matches.find((m) => m.id === room.matchId);
    if (found) return found;
  }
  return null;
}

// 未対応の報告がある大会に付ける印。運営にだけ出す（運営に見つけさせるためのもので、
// 報告した本人には チャットの中に「報告済み」の控えが出る）。
export function reportChipHtml(tournamentId) {
  if (!isAdmin()) return '';
  const count = openChatReports(tournamentId).length;
  return count > 0
    ? `<span class="status-chip status-reported">⚠ 未対応の報告 ${count}件</span>`
    : '';
}

// この人がこの試合のチャットを使えるか。当事者（＝どちらかの枠のメンバー）か運営。
// 対戦カードが揃っていない試合とBYEには相手がいないので、部屋を作らない。
export function canUseMatchChat(tournament, match) {
  if (!auth.player || !tournament) return false;
  if (match.isBye || !match.player1Id || !match.player2Id) return false;
  if (isAdmin()) return true;

  return [match.player1Id, match.player2Id].some((entrantId) =>
    getEntrantMemberIds(tournament.id, entrantId).includes(auth.player.id));
}

// 自分がこの試合のどちら側にいるか。運営が他人の試合を覗いている場合は null。
function myEntrantIdIn(tournament, match) {
  return [match.player1Id, match.player2Id].find((entrantId) =>
    getEntrantMemberIds(tournament.id, entrantId).includes(auth.player?.id)) ?? null;
}

function timeLabel(iso) {
  const d = new Date(iso);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderLog(tournament, match) {
  // 描き直す前に、いちばん下まで見ていたかを覚えておく。読み返している最中に
  // 新着が来て勝手にスクロールが飛ぶのを防ぐ。
  const wasAtBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;

  if (room.messages.length === 0) {
    logEl.innerHTML = '<p class="empty-hint">まだ発言がありません。</p>';
    return;
  }

  const mySide = myEntrantIdIn(tournament, match);

  logEl.innerHTML = room.messages.map((m) => {
    const player = state.players.find((p) => p.id === m.playerId);
    const name = player ? player.currentName : '退会した選手';
    // 自分の側（チーム戦なら相方も含む）の発言を右に寄せる
    const ownSide = mySide != null
      && getEntrantMemberIds(tournament.id, mySide).includes(m.playerId);

    return `
      <div class="chat-message${ownSide ? ' own' : ''}" data-id="${escapeHtml(m.id)}">
        <div class="chat-message-head">
          <span class="chat-message-name">${escapeHtml(name)}</span>
          <span class="chat-message-time">${escapeHtml(timeLabel(m.createdAt))}</span>
          ${isAdmin() ? '<button type="button" class="chat-delete-btn" title="この発言を削除">✕</button>' : ''}
        </div>
        <p class="chat-message-body">${escapeHtml(m.body)}</p>
      </div>
    `;
  }).join('');

  if (wasAtBottom) logEl.scrollTop = logEl.scrollHeight;
}

function showError(message) {
  errorEl.textContent = message ?? '';
  errorEl.hidden = !message;
}

// ---- タブ ----
//
// 「待ち合わせて話す」と「ゲームカウントを入れる」は使う場面が違う。1画面に積むと、
// どちらも小さくなって、どこで何をするのか分からなくなる（新規の人がつまずいた点）。
// ゲームカウント欄が出ない相手（観戦者など）にはタブ自体を出さない。

let activeTab = 'talk';

function setChatTab(name) {
  activeTab = name;
  const talk = name === 'talk';

  tabTalkBtn.classList.toggle('is-active', talk);
  tabResultBtn.classList.toggle('is-active', !talk);
  tabTalkBtn.setAttribute('aria-selected', String(talk));
  tabResultBtn.setAttribute('aria-selected', String(!talk));
  panelTalkEl.hidden = !talk;
  panelResultEl.hidden = talk;

  // 隠れている間は高さが0で、いちばん下に寄せたつもりが先頭に戻っている。
  // 表示に戻した時点で寄せ直す。
  if (talk) logEl.scrollTop = logEl.scrollHeight;
}

tabTalkBtn.addEventListener('click', () => setChatTab('talk'));
tabResultBtn.addEventListener('click', () => setChatTab('result'));

// ゲームカウント側に用があるか。タブを開くまで気づけないので、印を出す。
function resultTabNeedsAttention() {
  const match = currentMatch();
  const tournament = findTournament(room?.tournamentId);
  if (!match || !tournament || match.confirmed) return false;

  const pending = pendingResultReport(room.tournamentId, room.matchId);
  if (!pending) return false;
  if (isAdmin()) return true;

  // 自分が承認する番のときだけ。自分が出した報告の待ちでは急かさない。
  const mySide = myEntrantIdIn(tournament, match);
  return !!mySide && pending.reportedBy !== mySide;
}

// 結果欄の出し分けに合わせてタブを整える。renderResultPanel のあとに呼ぶ。
function syncTabs() {
  const available = !resultEl.hidden;
  tabsEl.hidden = !available; // タブが1枚しか無いなら見せない
  tabDotEl.hidden = !(available && resultTabNeedsAttention());
  if (!available && activeTab !== 'talk') setChatTab('talk');
}

// ---- ルームコード ----
//
// 部屋のコードをチャットの発言で伝えると会話に埋もれ、さかのぼって探す羽目になる。
// 専用の欄としてダイアログの一番上に常に見せる。記入・書き直しは当事者と運営の
// 誰でもできる（判定はDBのポリシーが持つ）。運営が回戦の開始前に配信台のコードを
// 入れておけば、選手は開始と同時に確認できる。

// 書きかけの間はRealtimeの再描画で入力欄を書き換えない（syncOpenChat が見る）。
let roomCodeEditing = false;

function renderRoomCode() {
  const match = currentMatch();
  const tournament = findTournament(room?.tournamentId);
  if (!match || !tournament) {
    roomEl.hidden = true;
    roomEl.innerHTML = '';
    return;
  }

  roomCodeEditing = false;
  roomEl.innerHTML = '';

  const current = matchRoomCode(room.tournamentId, room.matchId);

  // 確定した試合ではもう部屋に入らない。残っていれば参考に見せるだけにする。
  if (match.confirmed && !current) {
    roomEl.hidden = true;
    return;
  }

  roomEl.hidden = false;

  const label = document.createElement('span');
  label.className = 'room-code-label';
  label.textContent = 'ルームコード';
  roomEl.appendChild(label);

  if (match.confirmed) {
    const value = document.createElement('span');
    value.className = 'room-code-value';
    value.textContent = current.code;
    roomEl.appendChild(value);
    return;
  }

  // 入力欄そのものを表示にも使う。「記入する」を押させると、書ける欄があること自体が
  // 伝わらないうえ、狭い画面では一手増えるだけになる。
  const form = document.createElement('form');
  form.className = 'room-code-form';

  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'match-chat-room-input';
  input.className = 'room-code-input';
  input.maxLength = 50;
  input.value = current?.code ?? '';
  input.placeholder = '例: ABC123';
  input.setAttribute('aria-label', 'ルームコード');

  // 書き写すのではなく貼り付けて入室したいので、コピーを1タップで済ませる
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'btn-secondary room-code-copy-btn';
  copyBtn.textContent = 'コピー';
  copyBtn.disabled = !input.value.trim();
  copyBtn.addEventListener('click', () => copyRoomCode(input, copyBtn));

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'room-code-save-btn';
  saveBtn.textContent = '保存';
  saveBtn.disabled = true;

  form.append(input, copyBtn, saveBtn);
  roomEl.appendChild(form);

  const saved = () => current?.code ?? '';
  const changed = () => input.value.trim() !== saved();

  input.addEventListener('input', () => {
    roomCodeEditing = changed();
    saveBtn.disabled = !roomCodeEditing;
    copyBtn.disabled = !input.value.trim();
  });
  // 触っている間は書き換えない。中身が同じでもカーソルが飛ぶ。
  input.addEventListener('focus', () => { roomCodeEditing = true; });
  input.addEventListener('blur', () => { roomCodeEditing = changed(); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = input.value.trim();
    saveBtn.disabled = true;
    showError(null);
    try {
      // 空欄で保存したら「消す」。書き間違いをまっさらに戻せるように。
      if (code) await db.saveMatchRoomCode(room.tournamentId, room.matchId, code, auth.player.id);
      else await db.clearMatchRoomCode(room.tournamentId, room.matchId);
      await room.onRefresh();
      input.blur();
      renderRoomCode();
      flashRoomCodeSaved();
    } catch (err) {
      showError(err.message);
      saveBtn.disabled = false;
    }
  });
}

let roomCodeCopyTimer = null;

// クリップボードに入れる。API が使えない環境（http接続や許可されていない場合）は、
// 入力欄を選択状態にして、手のコピーがすぐできるところまでやる。
async function copyRoomCode(input, btn) {
  const text = input.value.trim();
  if (!text) return;

  let copied = false;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    input.focus();
    input.select();
    try { copied = document.execCommand('copy'); } catch { copied = false; }
  }

  btn.textContent = copied ? 'コピーしました' : '選択しました';
  clearTimeout(roomCodeCopyTimer);
  roomCodeCopyTimer = setTimeout(() => { btn.textContent = 'コピー'; }, 1800);
}

// 保存ボタンは押すと押せなくなるだけなので、通ったことを一言添えて見せる。
let roomCodeSavedTimer = null;

function flashRoomCodeSaved() {
  clearTimeout(roomCodeSavedTimer);
  const note = document.createElement('span');
  note.className = 'room-code-saved';
  note.textContent = '保存しました';
  roomEl.appendChild(note);
  roomCodeSavedTimer = setTimeout(() => note.remove(), 2500);
}

// ---- ゲームカウントの入力 ----
//
// 対戦表の枠は狭く、待ち合わせの会話もここで起きているので、入力する場所は
// チャットに置く。入れただけでは確定せず、相手が承認して初めて対戦表が進む
// （判定はDB側の report_match_result / approve_match_result が持つ）。

function scoreSentence(name1, name2, score) {
  const [s1, s2] = score.split('-');
  return `${name1} ${s1} - ${s2} ${name2}`;
}

function scoreInput(label) {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.className = 'score-num-input';
  input.setAttribute('aria-label', `${label}のゲームカウント`);
  return input;
}

// 何かした後の共通の後始末。DBから取り直してから、ダイアログと後ろの画面を描き直す。
async function afterResultChange(btn) {
  try {
    await room.onRefresh();
    renderResultPanel();
    syncTabs();
    syncWriteState();
  } catch (err) {
    showError(err.message);
    if (btn) btn.disabled = false;
  }
}

function resultForm(match, name1, name2) {
  const form = document.createElement('form');
  form.className = 'chat-result-form';

  const input1 = scoreInput(name1);
  const input2 = scoreInput(name2);

  [[name1, input1], [name2, input2]].forEach(([name, input]) => {
    const row = document.createElement('label');
    row.className = 'chat-result-row';
    row.append(document.createTextNode(name), input);
    form.appendChild(row);
  });

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.textContent = 'この結果を報告する';
  form.appendChild(submitBtn);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const raw1 = input1.value.trim();
    const raw2 = input2.value.trim();
    if (raw1 === '' || raw2 === '') {
      alert('両者のゲームカウントを入力してください。');
      return;
    }
    const s1 = Number(raw1);
    const s2 = Number(raw2);
    if (!Number.isInteger(s1) || !Number.isInteger(s2) || s1 < 0 || s2 < 0) {
      alert('ゲームカウントは0以上の整数で入力してください。');
      return;
    }
    if (s1 === s2) {
      alert('ゲームカウントが同点のため勝者を判定できません。');
      return;
    }

    submitBtn.disabled = true;
    showError(null);
    try {
      const winnerId = s1 > s2 ? match.player1Id : match.player2Id;
      await db.reportMatchResult(room.tournamentId, room.matchId, `${s1}-${s2}`, winnerId);
    } catch (err) {
      showError(err.message);
      submitBtn.disabled = false;
      return;
    }
    await afterResultChange(submitBtn);
  });

  return form;
}

// 運営だけに出す欄。選手の報告と違い、承認を待たずその場で確定させる
// （対戦表の勝敗入力が持っていた権限をそのままここへ移した）。
function adminConfirmForm(match, name1, name2) {
  const form = document.createElement('form');
  form.className = 'chat-result-form';

  const input1 = scoreInput(name1);
  const input2 = scoreInput(name2);

  [[name1, input1], [name2, input2]].forEach(([name, input]) => {
    const row = document.createElement('label');
    row.className = 'chat-result-row';
    row.append(document.createTextNode(name), input);
    form.appendChild(row);
  });

  const walkoverLabel = document.createElement('label');
  walkoverLabel.className = 'walkover-toggle';
  const walkoverCheckbox = document.createElement('input');
  walkoverCheckbox.type = 'checkbox';
  walkoverLabel.append(walkoverCheckbox, document.createTextNode(' 不戦勝で確定（スコアなし）'));

  const walkoverWinnerWrap = document.createElement('div');
  walkoverWinnerWrap.className = 'walkover-winner';
  walkoverWinnerWrap.hidden = true;
  const walkoverSelect = document.createElement('select');
  walkoverSelect.append(
    new Option('勝者を選択', ''),
    new Option(name1, match.player1Id),
    new Option(name2, match.player2Id),
  );
  walkoverWinnerWrap.appendChild(walkoverSelect);

  walkoverCheckbox.addEventListener('change', () => {
    const isWalkover = walkoverCheckbox.checked;
    input1.disabled = isWalkover;
    input2.disabled = isWalkover;
    walkoverWinnerWrap.hidden = !isWalkover;
  });

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.textContent = '確定';

  form.append(walkoverLabel, walkoverWinnerWrap, submitBtn);

  form.addEventListener('submit', (e) => {
    e.preventDefault();

    if (walkoverCheckbox.checked) {
      if (!walkoverSelect.value) {
        alert('不戦勝の勝者を選択してください。');
        return;
      }
      const result = confirmMatch(room.tournamentId, room.matchId, walkoverSelect.value, null, { isWalkover: true });
      if (!result.ok) {
        alert(result.error);
        return;
      }
      room.onChanged?.();
      closeMatchChat();
      return;
    }

    const raw1 = input1.value.trim();
    const raw2 = input2.value.trim();
    if (raw1 === '' || raw2 === '') {
      alert('両者のスコアを入力してください。');
      return;
    }
    const s1 = Number(raw1);
    const s2 = Number(raw2);
    if (!Number.isFinite(s1) || !Number.isFinite(s2) || s1 < 0 || s2 < 0) {
      alert('スコアは0以上の数値で入力してください。');
      return;
    }
    if (s1 === s2) {
      alert('スコアが同点のため勝者を判定できません。');
      return;
    }
    const winnerId = s1 > s2 ? match.player1Id : match.player2Id;
    const result = confirmMatch(room.tournamentId, room.matchId, winnerId, `${s1}-${s2}`);
    if (!result.ok) {
      alert(result.error);
      return;
    }
    room.onChanged?.();
    closeMatchChat();
  });

  return form;
}

// 当事者には自分の対戦の報告欄、運営にはその場で確定できる欄を出す
// （スペクテーターや無関係の選手には何も出さない）。
function renderResultPanel() {
  resultEl.innerHTML = '';

  const match = currentMatch();
  const tournament = findTournament(room?.tournamentId);
  if (!match || !tournament) {
    resultEl.hidden = true;
    return;
  }

  const mySide = myEntrantIdIn(tournament, match);
  if (!mySide && !isAdmin()) {
    resultEl.hidden = true;
    return;
  }

  resultEl.hidden = false;
  const name1 = getEntrantName(tournament.id, match.player1Id);
  const name2 = getEntrantName(tournament.id, match.player2Id);

  const heading = document.createElement('h4');
  heading.className = 'chat-result-heading';
  heading.textContent = isAdmin() ? '結果の確定（運営）' : 'ゲームカウントの報告';
  resultEl.appendChild(heading);

  const note = document.createElement('p');
  note.className = 'chat-result-note';

  if (match.confirmed) {
    note.textContent = match.isWalkover
      ? '不戦勝で確定しました。'
      : `${scoreSentence(name1, name2, match.score ?? '')} で確定しました。`;
    resultEl.appendChild(note);
    return;
  }

  // 運営はラウンド開始前でも、承認待ちであっても、その場で直接確定できる
  // （対戦表の勝敗入力が持っていた権限をそのまま引き継ぐ）。
  if (isAdmin()) {
    const pending = pendingResultReport(room.tournamentId, room.matchId);
    if (pending) {
      const pendingNote = document.createElement('p');
      pendingNote.className = 'chat-result-note pending-note';
      pendingNote.textContent = `選手からの報告: ${scoreSentence(name1, name2, pending.score)}（承認待ち）`;
      resultEl.appendChild(pendingNote);
    }
    resultEl.appendChild(adminConfirmForm(match, name1, name2));
    return;
  }

  if (!isRoundStarted(room.tournamentId, room.roundIndex)) {
    note.textContent = '運営がこの回戦を開始すると、ここから結果を報告できます。';
    resultEl.appendChild(note);
    return;
  }

  const pending = pendingResultReport(room.tournamentId, room.matchId);
  if (!pending) {
    note.textContent = '結果を入力すると、相手の承認を経て確定します。';
    resultEl.append(note, resultForm(match, name1, name2));
    return;
  }

  const mine = pending.reportedBy === mySide;
  note.textContent = mine
    ? `${scoreSentence(name1, name2, pending.score)} で報告しました。相手の承認待ちです。`
    : `相手が ${scoreSentence(name1, name2, pending.score)} と報告しました。`;
  resultEl.appendChild(note);

  const actions = document.createElement('div');
  actions.className = 'row-actions';

  if (mine) {
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = '取り消す';
    cancelBtn.addEventListener('click', async () => {
      cancelBtn.disabled = true;
      showError(null);
      try {
        await db.withdrawMatchResult(room.tournamentId, room.matchId);
      } catch (err) {
        showError(err.message);
        cancelBtn.disabled = false;
        return;
      }
      await afterResultChange(cancelBtn);
    });
    actions.appendChild(cancelBtn);
  } else {
    const approveBtn = document.createElement('button');
    approveBtn.type = 'button';
    approveBtn.textContent = '承認して確定';
    approveBtn.addEventListener('click', async () => {
      if (!confirm(`${scoreSentence(name1, name2, pending.score)} で確定します。よろしいですか？`)) return;
      approveBtn.disabled = true;
      showError(null);
      try {
        await db.approveMatchResult(room.tournamentId, room.matchId);
      } catch (err) {
        showError(err.message);
        approveBtn.disabled = false;
        return;
      }
      await afterResultChange(approveBtn);
    });

    // 承認しない場合は「拒否」ではなく、自分のカウントを出し直してもらう。
    // 上書きされるので、相手に取り消してもらう往復が要らない。
    const differBtn = document.createElement('button');
    differBtn.type = 'button';
    differBtn.className = 'btn-secondary';
    differBtn.textContent = '違うカウントを出す';
    differBtn.addEventListener('click', () => {
      differBtn.disabled = true;
      resultEl.appendChild(resultForm(match, name1, name2));
    });

    actions.append(approveBtn, differBtn);
  }

  resultEl.appendChild(actions);
}

// 大会カードと対戦表の印を出し直してもらう。
//
// ここから app.js の再描画を直接呼ぶと、対戦表の onChanged（勝敗の保存を伴う）に
// 引きずられる。イベントで「報告が変わった」とだけ伝え、描き直し方は受け手に任せる。
function notifyReportsChanged() {
  document.dispatchEvent(new CustomEvent('chat-reports-changed'));
}

// この対戦に届いている報告。運営には全件、当事者には自分が出した分だけが
// state に入っている（RLSがそう返す）ので、ここでは絞り込まずそのまま出す。
function renderReports(tournament, match) {
  const reports = state.chatReports
    .filter((r) => r.tournamentId === tournament.id && r.matchId === match.id);

  if (reports.length === 0) {
    reportsEl.hidden = true;
    reportsEl.innerHTML = '';
    return;
  }

  reportsEl.hidden = false;
  reportsEl.innerHTML = reports.map((r) => {
    const reporter = state.players.find((p) => p.id === r.reporterId);
    const name = reporter ? reporter.currentName : '退会した選手';
    const done = Boolean(r.resolvedAt);
    return `
      <div class="chat-report${done ? ' resolved' : ''}" data-id="${escapeHtml(r.id)}">
        <div class="chat-report-head">
          <span class="chat-report-badge">${done ? '対応済み' : '運営に報告'}</span>
          <span class="chat-report-who">${escapeHtml(name)}</span>
        </div>
        <p class="chat-report-body">${escapeHtml(r.body)}</p>
        ${!done && isAdmin() ? '<button type="button" class="chat-resolve-btn">対応済みにする</button>' : ''}
      </div>
    `;
  }).join('');

  reportsEl.onclick = async (e) => {
    const btn = e.target.closest('.chat-resolve-btn');
    if (!btn) return;
    const id = btn.closest('.chat-report')?.dataset.id;
    if (!id) return;

    btn.disabled = true;
    try {
      await db.resolveChatReport(id, auth.player.id);
      await db.refreshChatReports();
      renderReports(tournament, match);
      // 大会カードや対戦表の印を消すため、開いている画面も描き直してもらう
      notifyReportsChanged();
    } catch (err) {
      showError(err.message);
      btn.disabled = false;
    }
  };
}

// 報告の入口を出すかどうか。運営は報告する側ではないので出さない。
function syncReportControls(tournament, match) {
  const alreadyOpen = openChatReports(tournament.id, match.id)
    .some((r) => r.reporterId === auth.player?.id);

  reportFormEl.hidden = true;
  reportInputEl.value = '';
  reportBtn.hidden = isAdmin() || alreadyOpen;
  reportBtn.disabled = false;
}

// 差分だけ取りに行く。開いている部屋が入れ替わっていたら結果を捨てる
// （通信の途中で別の試合を開いたときに、前の部屋の発言を混ぜないため）。
async function fetchNew(tournament, match) {
  const target = room;
  if (!target || target.matchId !== match.id) return;

  try {
    const fresh = await db.loadMatchChat(target.tournamentId, target.matchId, target.lastAt);
    if (room !== target) return;
    if (fresh.length === 0) return;

    room.messages.push(...fresh);
    room.lastAt = fresh[fresh.length - 1].createdAt;
    renderLog(tournament, match);
    showError(null);
  } catch (err) {
    if (room !== target) return;
    // 一時的な通信断で読んでいる内容を消さない。次の周期で取り直す。
    showError(err.message);
  }
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

// 開いているチャットを、いまの state に合わせ直す。
//
// 相手がゲームカウントを報告した・運営が回戦を開始した、といった変化はRealtimeで
// 届いて全件が読み直される。開きっぱなしのダイアログもそこで追従させないと、
// 相手の報告に気づけない。
export function syncOpenChat() {
  if (!room) return;
  syncWriteState();
  renderResultPanel();
  syncTabs();
  // 編集中に描き直すと入力欄ごと消えてしまうので、そのときだけ見送る
  if (!roomCodeEditing) renderRoomCode();
}

export function closeMatchChat() {
  stopPolling();
  room = null;
  roomCodeEditing = false;
  setChatTab('talk');
  reportFormEl.hidden = true;
  reportInputEl.value = '';
  resultEl.hidden = true;
  resultEl.innerHTML = '';
  roomEl.hidden = true;
  roomEl.innerHTML = '';
  if (dialog.open) dialog.close();
}

// 確定済みの試合のチャットは読むだけにする（運営は介入できるので書ける）。
// 承認で試合が確定した直後にも呼ぶので、state から引き直した姿で判断する。
function syncWriteState() {
  const match = currentMatch();
  const canWrite = isAdmin() || !match?.confirmed;
  formEl.hidden = !canWrite;
  closedNoteEl.hidden = canWrite;
}

// 対戦カードのチャットを開く。
//
// roundIndex は「その回戦が開始されたか」の判定に、onRefresh はゲームカウントを
// 報告・承認したあとの取り直しに使う（対戦表側と同じもの）。onChanged は運営が
// その場で勝敗を確定させたあと、対戦表をDBへ書き戻すためのもの。
export async function openMatchChat(tournament, match, roundIndex, onRefresh, onChanged) {
  if (!canUseMatchChat(tournament, match)) return;

  const name1 = getEntrantName(tournament.id, match.player1Id);
  const name2 = getEntrantName(tournament.id, match.player2Id);

  // 別の試合から開き直された場合、前の周期取得が残っていると、新しい部屋の発言を
  // 古い試合の見立てで描いてしまう。部屋を差し替える前に必ず止める。
  stopPolling();

  room = {
    tournamentId: tournament.id,
    matchId: match.id,
    roundIndex,
    messages: [],
    lastAt: null,
    onRefresh: onRefresh ?? (async () => {}),
    onChanged,
  };

  titleEl.textContent = `${name1} vs ${name2}`;
  metaEl.textContent = `${tournament.name} ・ ${match.round}`;
  syncWriteState();
  renderResultPanel();
  renderRoomCode();
  // 承認を待たせている相手を待たせ続けないよう、用があるときだけ結果側から開く
  setChatTab(!resultEl.hidden && resultTabNeedsAttention() ? 'result' : 'talk');
  syncTabs();
  inputEl.value = '';
  logEl.innerHTML = '<p class="empty-hint">読み込んでいます…</p>';
  showError(null);

  if (!dialog.open) dialog.showModal();

  renderReports(tournament, match);
  syncReportControls(tournament, match);

  reportBtn.onclick = () => {
    reportFormEl.hidden = false;
    reportBtn.hidden = true;
    reportInputEl.focus();
  };

  reportCancelBtn.onclick = () => {
    reportFormEl.hidden = true;
    reportInputEl.value = '';
    reportBtn.hidden = false;
  };

  reportFormEl.onsubmit = async (e) => {
    e.preventDefault();
    const body = reportInputEl.value.trim();
    if (!body) {
      alert('運営に伝えることを書いてください。');
      return;
    }

    reportSendBtn.disabled = true;
    try {
      await db.reportMatchChat(tournament.id, match.id, auth.player.id, body);
      await db.refreshChatReports();
      showError(null);
      renderReports(tournament, match);
      // 送信済みの状態に戻す（同じ試合に何度も出させない）
      syncReportControls(tournament, match);
      notifyReportsChanged();
    } catch (err) {
      showError(err.message);
    } finally {
      reportSendBtn.disabled = false;
    }
  };

  // ハンドラは最初の取得より先に付ける。フォームの submit を捕まえる前にEnterを
  // 押されると、ダイアログ内のフォームがそのまま送信されてページが再読み込みされる。
  //
  // 代入（addEventListener ではない）なのは、別の試合を開いたときに前の部屋の
  // ハンドラを積み重ねず、必ず今の部屋のものだけにするため。
  logEl.onclick = async (e) => {
    const btn = e.target.closest('.chat-delete-btn');
    if (!btn) return;
    const id = btn.closest('.chat-message')?.dataset.id;
    if (!id || !confirm('この発言を削除しますか？')) return;

    try {
      await db.deleteMatchChatMessage(id);
      // 消している間に閉じられた・別の試合に移ったなら、もう触らない
      if (room?.matchId !== match.id) return;
      room.messages = room.messages.filter((m) => m.id !== id);
      renderLog(tournament, match);
    } catch (err) {
      showError(err.message);
    }
  };

  formEl.onsubmit = async (e) => {
    e.preventDefault();
    const body = inputEl.value.trim();
    if (!body) return;

    sendBtn.disabled = true;
    try {
      await db.sendMatchChatMessage(tournament.id, match.id, auth.player.id, body);
      inputEl.value = '';
      showError(null);
      // 自分の発言も取得側から受け取る。手元で足すと、失敗した投稿が
      // 送れたように見えたり、順序が実際と食い違ったりする。
      await fetchNew(tournament, match);
      logEl.scrollTop = logEl.scrollHeight;
    } catch (err) {
      showError(err.message);
    } finally {
      sendBtn.disabled = false;
      inputEl.focus();
    }
  };

  await fetchNew(tournament, match);
  // 読み込み中に別の試合へ切り替えられていたら、この部屋の後始末はしない
  if (room?.matchId !== match.id) return;
  // 1件も無いときは fetchNew が描き直さないので、ここで「読み込んでいます…」を片付ける
  if (room.messages.length === 0) renderLog(tournament, match);
  logEl.scrollTop = logEl.scrollHeight;

  pollTimer = setInterval(() => fetchNew(tournament, match), POLL_INTERVAL_MS);
}

closeBtn.addEventListener('click', closeMatchChat);
// Escapeキーや外側の操作で閉じたときも、取得を止める
dialog.addEventListener('close', () => {
  stopPolling();
  room = null;
});

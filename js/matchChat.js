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

import { state, getEntrantName, getEntrantMemberIds } from './state.js';
import { auth, isAdmin } from './auth.js';
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

// 開いている部屋。閉じている間は null。
let room = null; // { tournamentId, matchId, canWrite, messages: [], lastAt: string|null }
let pollTimer = null;

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

export function closeMatchChat() {
  stopPolling();
  room = null;
  if (dialog.open) dialog.close();
}

// 対戦カードのチャットを開く。tournament と match は state / ブラケットのオブジェクト。
export async function openMatchChat(tournament, match) {
  if (!canUseMatchChat(tournament, match)) return;

  const name1 = getEntrantName(tournament.id, match.player1Id);
  const name2 = getEntrantName(tournament.id, match.player2Id);

  // 別の試合から開き直された場合、前の周期取得が残っていると、新しい部屋の発言を
  // 古い試合の見立てで描いてしまう。部屋を差し替える前に必ず止める。
  stopPolling();

  // 確定済みの試合は読むだけ（運営は介入できるので書ける）。判定はDB側にもある。
  const canWrite = isAdmin() || !match.confirmed;
  room = { tournamentId: tournament.id, matchId: match.id, canWrite, messages: [], lastAt: null };

  titleEl.textContent = `${name1} vs ${name2}`;
  metaEl.textContent = `${tournament.name} ・ ${match.round}`;
  formEl.hidden = !canWrite;
  closedNoteEl.hidden = canWrite;
  inputEl.value = '';
  logEl.innerHTML = '<p class="empty-hint">読み込んでいます…</p>';
  showError(null);

  if (!dialog.open) dialog.showModal();

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

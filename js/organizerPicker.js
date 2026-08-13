// 「この大会の運営」を選手名簿から選ぶ欄。大会作成と大会情報の編集で使う。
//
// 大会は誰でも開ける。その代わり触れるのは自分が運営に入っている大会だけなので、
// 当日に手伝ってもらう人をここで指名しておく必要がある（指名された人には、
// その大会の対戦表・回戦の開始・結果の確定・チャットの削除が開く）。
//
// 選び方は相方選び（js/entries.js の partnerPicker）と同じ形にしてある。
// 選手が数十人になるとドロップダウンから探すのは辛いので、名前で絞ってから押す。
//
// 「自分を外せない」を持っているのはこの部品。外せてしまうと、作った本人が自分の
// 大会を編集できなくなり、サイト全体の運営に頼むしかなくなる（DB側は外すことを
// 禁じていない ── 運営を入れ替える正当な操作と区別がつかないため、画面側で止める）。

import { state, UNKNOWN_PLAYER_NAME } from './state.js';
import { auth } from './auth.js';
import { escapeHtml, createSearchRunner } from './util.js';
import * as db from './db.js';

// 検索結果に出す上限。多すぎると押す前に読み切れないので、絞り込みを促す。
const MAX_RESULTS = 12;

function playerLabel(player) {
  return player.currentName;
}

// 札に出す名前。
//
// 【自分は auth.player から引くこと】この欄が最初に建つのは、選手の読み込みが
// 終わる前かもしれない。state.players だけを見ていると、自分の札が
// 「あなた」と書かれたUUIDになって出る（実際に大会作成で出た）。
// 自分の行はログインの時点で別に取れている（js/auth.js の refreshOwnPlayer）ので、
// そちらを先に見れば、読み込みの前後によらず必ず名前が出る。
function labelOf(id) {
  if (auth.player?.id === id) return playerLabel(auth.player);
  const player = state.players.find((p) => p.id === id);
  return player ? playerLabel(player) : UNKNOWN_PLAYER_NAME;
}

// containerEl に欄を建てて、選ばれているIDを読み出せる操作卓を返す。
//
// selectedIds  最初から選ばれている選手ID
// lockedId     外せない選手ID（普通は自分。null なら無し）
export function mountOrganizerPicker(containerEl, { selectedIds = [], lockedId = null } = {}) {
  const selected = new Set(selectedIds);
  if (lockedId) selected.add(lockedId);

  containerEl.innerHTML = '';
  containerEl.className = 'organizer-picker';

  const chosenEl = document.createElement('div');
  chosenEl.className = 'organizer-chosen';

  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'organizer-search';
  search.placeholder = '名前で検索して追加';
  search.setAttribute('aria-label', '運営にする選手を検索');

  const resultsEl = document.createElement('div');
  resultsEl.className = 'organizer-results';

  containerEl.append(chosenEl, search, resultsEl);

  function renderChosen() {
    chosenEl.innerHTML = '';
    if (selected.size === 0) {
      chosenEl.innerHTML = '<span class="empty-hint">運営が選ばれていません。</span>';
      return;
    }
    [...selected].forEach((id) => {
      const label = labelOf(id);
      const chip = document.createElement('span');
      chip.className = 'organizer-chip';
      chip.innerHTML = `<span>${escapeHtml(label)}</span>`;

      if (id !== lockedId) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'organizer-chip-remove';
        remove.textContent = '×';
        remove.title = `${label} を運営から外す`;
        remove.addEventListener('click', () => {
          selected.delete(id);
          renderChosen();
          renderResults();
        });
        chip.appendChild(remove);
      } else {
        // 自分の札だけ理由を添える。ボタンが無いことに気づいてもらうため。
        const note = document.createElement('span');
        note.className = 'organizer-chip-note';
        note.textContent = 'あなた';
        chip.appendChild(note);
      }

      chosenEl.appendChild(chip);
    });
  }

  // 検索の状態。'idle'（未入力） / 'loading' / 'done' / 'error'
  // 【結果を覚えておく必要がある】DBに問い合わせる形になったので、
  // 描き直し（選んだ・外した）のたびに投げ直さずに済むよう手元に置く。
  let hits = [];
  let status = 'idle';
  let errorText = '';

  function renderResults() {
    resultsEl.innerHTML = '';
    if (status === 'idle') return;

    if (status === 'error') {
      resultsEl.innerHTML = `<p class="empty-hint">${escapeHtml(errorText)}</p>`;
      return;
    }

    // 通信の途中に「一致する選手がいません」を挟まない（打つたびに一瞬出る）
    if (status === 'loading') {
      resultsEl.innerHTML = '<p class="status-line loading">検索しています...</p>';
      return;
    }

    // 既に選ばれている人は候補から外す。札のほうは消さない ── 停止する前から
    // 運営に入っていた人を、編集のたびに黙って外してしまわないため。
    // 利用停止中の選手はそもそも db.searchPlayers が返さない。
    const visible = hits.filter((p) => !selected.has(p.id));

    if (visible.length === 0) {
      resultsEl.innerHTML = '<p class="empty-hint">一致する選手がいません。</p>';
      return;
    }

    visible.slice(0, MAX_RESULTS).forEach((p) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'organizer-result';
      btn.textContent = playerLabel(p);
      btn.addEventListener('click', () => {
        selected.add(p.id);
        renderChosen();
        renderResults();
      });
      resultsEl.appendChild(btn);
    });

    if (visible.length > MAX_RESULTS) {
      const more = document.createElement('p');
      more.className = 'empty-hint';
      more.textContent = `他 ${visible.length - MAX_RESULTS}人。名前をもう少し入れて絞ってください。`;
      resultsEl.appendChild(more);
    }
  }

  // 打鍵ごとに投げない・古い応答に上書きさせない（js/util.js の注記を参照）
  const runSearch = createSearchRunner({
    search: (q) => db.searchPlayers(q),
    onStart: () => { status = 'loading'; errorText = ''; renderResults(); },
    onEmpty: () => { hits = []; status = 'idle'; renderResults(); },
    onResult: ({ players }) => { hits = players; status = 'done'; renderResults(); },
    onError: (err) => { status = 'error'; errorText = err.message; renderResults(); },
  });

  search.addEventListener('input', () => {
    runSearch(search.value);
  });

  // 検索欄でEnterを押しただけでフォームが送信されないようにする
  // （運営を1人足すつもりで大会を作ってしまう事故を防ぐ）。
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault();
  });

  renderChosen();
  renderResults();

  return {
    selectedIds: () => [...selected],

    // 札の名前だけ描き直す。
    //
    // 【建て直しではないこと】この欄は建て直すと、指名しかけた顔ぶれと
    // 打ちかけの検索文字が消える（Realtimeの更新でも画面は描き直されるので、
    // 呼ぶ側は建て直さない作りにしてある）。だが建てた時点ではまだ選手が
    // 届いていないことがあり、そのままでは名前が出ないまま固まる。
    // 名前だけを描き直せば、どちらも失わずに済む。
    refresh() { renderChosen(); },
  };
}

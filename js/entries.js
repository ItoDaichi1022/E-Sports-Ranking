// 大会の募集ページとエントリー。
//
// 流れ: draft（準備中） → recruiting（募集中） → running（進行中） → finished（終了）
// 参加希望者は募集中の大会に「エントリー」ボタン1つで登録できる。
// 運営が募集を締め切ると、それまでの戦績を元にシードを付けてブラケットを生成する。

import { state } from './state.js';
import { escapeHtml, safeUrl, initialOf } from './util.js';
import { auth, isLoggedIn, isAdmin } from './auth.js';
import { computeRankings } from './ranking.js';
import { createBracket } from './bracket.js';
import * as db from './db.js';

export const STATUS_LABELS = {
  draft: '準備中',
  recruiting: '募集中',
  running: '進行中',
  finished: '終了',
};

function isEntered(tournament) {
  return Boolean(auth.player) && tournament.participantIds.includes(auth.player.id);
}

function remainingSlots(tournament) {
  if (tournament.capacity == null) return null;
  return Math.max(0, tournament.capacity - tournament.participantIds.length);
}

// エントリー済みの選手を、現在のランキング順に並べてシード順を決める（⑤）。
// ランキングに載っていない選手（まだ試合をしていない人）は後ろにまとめ、
// その中では登録順を保つ。
export function seedByRanking(playerIds) {
  const rankByPlayer = new Map(computeRankings(state).map((r) => [r.id, r.rank]));
  return [...playerIds].sort((a, b) => {
    const ra = rankByPlayer.get(a) ?? Infinity;
    const rb = rankByPlayer.get(b) ?? Infinity;
    if (ra !== rb) return ra - rb;
    return playerIds.indexOf(a) - playerIds.indexOf(b);
  });
}

// 募集を締め切り、シードを確定してブラケットを生成する。
export async function closeRecruitmentAndStart(tournamentId) {
  const tournament = state.tournaments.find((t) => t.id === tournamentId);
  if (!tournament) throw new Error('大会が見つかりません。');
  if (tournament.participantIds.length < 2) {
    throw new Error('参加者が2人以上必要です。');
  }

  const seeded = seedByRanking(tournament.participantIds);
  await db.saveSeeds(tournamentId, seeded);

  // BYEはブラケット生成時に自動確定するが、対戦相手がいないので試合としては記録しない
  // （旧実装と同じ扱い。matchesに入るのは confirmMatch を通った実際の対戦だけ）。
  const bracket = createBracket(tournamentId, seeded);
  await db.saveBracket(tournamentId, bracket);
  await db.setTournamentStatus(tournamentId, 'running');

  state.brackets[tournamentId] = bracket;
  tournament.participantIds = seeded;
  tournament.status = 'running';
  return bracket;
}

// ---- 描画 ----

function entryButton(tournament, onChanged) {
  const btn = document.createElement('button');
  const entered = isEntered(tournament);
  const left = remainingSlots(tournament);

  // エントリーはこのページの主目的なので、その入口になるボタンは目立たせる
  // （ログイン・選手登録もエントリーへ向かう導線なので同じ扱いにする）。
  if (!isLoggedIn()) {
    btn.type = 'button';
    btn.className = 'btn-entry';
    btn.textContent = 'ログインしてエントリー';
    // ページ遷移せずダイアログだけ開く（見ていた大会を失わないように）
    btn.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('request-login'));
    });
    return btn;
  }

  if (!auth.player) {
    btn.type = 'button';
    btn.className = 'btn-entry';
    btn.textContent = '選手登録してエントリー';
    btn.addEventListener('click', () => { location.hash = '#profile'; });
    return btn;
  }

  btn.type = 'button';
  if (entered) {
    // 取り消しは主導線ではないので、目立たせない
    btn.className = 'btn-secondary';
    btn.textContent = 'エントリーを取り消す';
  } else if (left === 0) {
    btn.className = 'btn-secondary';
    btn.textContent = '定員に達しました';
    btn.disabled = true;
    return btn;
  } else {
    btn.className = 'btn-entry';
    btn.textContent = 'エントリーする';
  }

  btn.addEventListener('click', async () => {
    // 押し間違いで参加・辞退が確定しないよう、どちらも一度確認する
    const confirmed = entered
      ? confirm(`「${tournament.name}」のエントリーを取り消しますか？`)
      : confirm(`「${tournament.name}」にエントリーしますか？`);
    if (!confirmed) return;

    btn.disabled = true;
    try {
      if (entered) {
        await db.cancelEntry(tournament.id, auth.player.id);
      } else {
        await db.enterTournament(tournament.id, auth.player.id);
      }
      await onChanged();
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
    }
  });

  return btn;
}

function adminControls(tournament, onChanged) {
  const wrap = document.createElement('div');
  wrap.className = 'row-actions';

  if (tournament.status === 'draft') {
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.textContent = '募集を開始';
    openBtn.addEventListener('click', async () => {
      openBtn.disabled = true;
      try {
        await db.setTournamentStatus(tournament.id, 'recruiting');
        await onChanged();
      } catch (err) {
        alert(err.message);
        openBtn.disabled = false;
      }
    });
    wrap.appendChild(openBtn);
  }

  if (tournament.status === 'recruiting') {
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '締め切ってブラケット生成';
    closeBtn.addEventListener('click', async () => {
      if (!confirm(`「${tournament.name}」の募集を締め切り、現在の${tournament.participantIds.length}人でブラケットを生成します。よろしいですか？`)) return;
      closeBtn.disabled = true;
      try {
        await closeRecruitmentAndStart(tournament.id);
        location.hash = `#bracket/${encodeURIComponent(tournament.id)}`;
        // 既にその大会の詳細を開いていた場合は hashchange が起きず再描画されない。
        // 明示的に更新して、生成されたブラケットを出す。
        await onChanged();
      } catch (err) {
        alert(err.message);
        closeBtn.disabled = false;
      }
    });
    wrap.appendChild(closeBtn);

    const reopenBtn = document.createElement('button');
    reopenBtn.type = 'button';
    reopenBtn.className = 'btn-secondary';
    reopenBtn.textContent = '募集を止める';
    reopenBtn.addEventListener('click', async () => {
      reopenBtn.disabled = true;
      try {
        await db.setTournamentStatus(tournament.id, 'draft');
        await onChanged();
      } catch (err) {
        alert(err.message);
        reopenBtn.disabled = false;
      }
    });
    wrap.appendChild(reopenBtn);
  }

  return wrap;
}

// 大会詳細ページ用の操作。エントリーと、運営の募集操作をまとめて置く。
//
// 募集一覧のカードは大会名・画像・開催日だけの入口にしたので、実際に手を動かす
// 操作はすべてこちら（詳細）に集約する。一覧に操作を置くと、カード全体を
// タップ領域にできず（リンクの中にボタンが入れ子になる）、押し間違いも起きる。
export function renderTournamentActions(containerEl, tournament, onChanged) {
  containerEl.innerHTML = '';
  if (!tournament) return;

  const row = document.createElement('div');
  row.className = 'tournament-actions-row';

  if (tournament.status === 'recruiting') {
    row.appendChild(entryButton(tournament, onChanged));
  }
  if (isAdmin()) {
    const admin = adminControls(tournament, onChanged);
    if (admin.children.length > 0) row.appendChild(admin);
  }

  if (row.children.length === 0) return;
  containerEl.appendChild(row);
}

// 募集ページ。運営には準備中の大会も見せる。
//
// 一覧は「どの大会があるか」を見渡すための場所なので、大会名・画像・開催日だけを
// 出す。定員やルール、参加者、エントリーボタンは詳細ページの担当。
export function renderRecruitPage(containerEl) {
  containerEl.innerHTML = '';

  const visible = state.tournaments.filter((t) =>
    t.status === 'recruiting' || (isAdmin() && t.status === 'draft'));

  if (visible.length === 0) {
    containerEl.innerHTML = '<p class="empty-hint">現在募集中の大会はありません。</p>';
    return;
  }

  const list = document.createElement('div');
  list.className = 'recruit-list';

  visible.forEach((t) => {
    // カードの中にボタンやリンクを置かないので、カード全体を1つのリンクにできる。
    // どこを押しても詳細へ行くため、スマートフォンでも押し外しにくい。
    const card = document.createElement('a');
    card.className = 'recruit-card';
    card.href = `#bracket/${encodeURIComponent(t.id)}`;

    // 画像は切り抜かずに収める。無ければ大会名の頭文字で枠を埋め、
    // 画像の有無でカードの高さが変わらないようにする。
    const imageUrl = safeUrl(t.imageUrl);
    const thumb = document.createElement('div');
    thumb.className = 'recruit-thumb';
    if (imageUrl) {
      thumb.innerHTML = `<img src="${escapeHtml(imageUrl)}" alt="" loading="lazy">`;
    } else {
      thumb.classList.add('is-empty');
      thumb.textContent = initialOf(t.name);
    }

    const body = document.createElement('div');
    body.className = 'recruit-card-body';
    // 準備中はまだ公開していない大会。運営にしか見えないので、
    // 募集中のものと取り違えないよう印を付ける。
    body.innerHTML = `
      <h3 class="recruit-name">${escapeHtml(t.name)}</h3>
      <p class="recruit-date">${escapeHtml(t.date || '開催日未定')}</p>
      ${t.status === 'draft' ? `<span class="status-chip status-draft">${STATUS_LABELS.draft}</span>` : ''}
    `;

    card.append(thumb, body);
    list.appendChild(card);
  });

  containerEl.appendChild(list);
}

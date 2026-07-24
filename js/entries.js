// 大会の募集ページとエントリー。
//
// 流れ: draft（準備中） → recruiting（募集中） → running（進行中） → finished（終了）
// 参加希望者は募集中の大会に「エントリー」ボタン1つで登録できる。
// 運営が募集を締め切ると、それまでの戦績を元にシードを付けてブラケットを生成する。

import { state } from './state.js';
import { escapeHtml, safeUrl, avatarHtml } from './util.js';
import { auth, isLoggedIn, isAdmin } from './auth.js';
import { computeRankings } from './ranking.js';
import { tournamentTier } from './tournamentTier.js';
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

  if (!isLoggedIn()) {
    btn.type = 'button';
    btn.className = 'btn-secondary';
    btn.textContent = 'ログインしてエントリー';
    // ページ遷移せずダイアログだけ開く（募集一覧を見ていた場所を失わないように）
    btn.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('request-login'));
    });
    return btn;
  }

  if (!auth.player) {
    btn.type = 'button';
    btn.className = 'btn-secondary';
    btn.textContent = '選手登録してエントリー';
    btn.addEventListener('click', () => { location.hash = '#profile'; });
    return btn;
  }

  btn.type = 'button';
  if (entered) {
    btn.className = 'btn-secondary';
    btn.textContent = 'エントリーを取り消す';
  } else if (left === 0) {
    btn.className = 'btn-secondary';
    btn.textContent = '定員に達しました';
    btn.disabled = true;
    return btn;
  } else {
    btn.textContent = 'エントリー';
  }

  btn.addEventListener('click', async () => {
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

// エントリー済みの顔ぶれ。名前のチップを全員分並べると字の壁になるので、
// アイコンだけを並べて、入りきらない分は「+N」にまとめる。
// 名前は title 属性で読めるようにしておく。
const ENTRANT_FACES = 12;

function entrantStrip(tournament) {
  const el = document.createElement('div');
  el.className = 'entrant-strip';

  const ids = tournament.participantIds;
  if (ids.length === 0) {
    el.innerHTML = '<span class="entrant-empty">まだエントリーがありません</span>';
    return el;
  }

  const shown = ids.slice(0, ENTRANT_FACES);
  const rest = ids.length - shown.length;

  const faces = shown.map((id) => {
    const player = state.players.find((p) => p.id === id);
    const name = player ? player.currentName : id;
    return `<span class="entrant-avatar" title="${escapeHtml(name)}">`
      + `${avatarHtml(player ?? { currentName: name }, 'sm')}</span>`;
  }).join('');

  el.innerHTML = faces + (rest > 0 ? `<span class="entrant-more">+${rest}</span>` : '');
  return el;
}

// 日付と規模を「ラベル＋値」で並べる。1行の文章に繋げるより目で追いやすい。
function factsEl(tournament) {
  const el = document.createElement('div');
  el.className = 'recruit-facts';
  const facts = [
    ['開催日', tournament.date || '未定'],
    ['規模', tournamentTier(tournament.participantIds.length)],
  ];
  el.innerHTML = facts.map(([label, value]) => `
    <div class="fact">
      <span class="fact-label">${escapeHtml(label)}</span>
      <span class="fact-value">${escapeHtml(value)}</span>
    </div>
  `).join('');
  return el;
}

// 定員は数字だけでなく、埋まり具合をバーで見せる。
// 定員なしの大会はバーを出さず、現在の人数だけを示す。
function capacityEl(tournament) {
  const count = tournament.participantIds.length;
  const el = document.createElement('div');
  el.className = 'capacity';

  if (tournament.capacity == null) {
    el.innerHTML = `
      <div class="capacity-head">
        <span class="capacity-label">エントリー</span>
        <span class="capacity-text">${count}人（定員なし）</span>
      </div>
    `;
    return el;
  }

  const pct = Math.min(100, Math.round((count / tournament.capacity) * 100));
  if (count >= tournament.capacity) el.classList.add('full');
  el.innerHTML = `
    <div class="capacity-head">
      <span class="capacity-label">エントリー</span>
      <span class="capacity-text">${count} / ${tournament.capacity}人</span>
    </div>
    <div class="capacity-track">
      <span class="capacity-fill" style="width: ${pct}%"></span>
    </div>
  `;
  return el;
}

// 募集ページ。運営には準備中の大会も見せる。
export function renderRecruitPage(containerEl, onChanged) {
  containerEl.innerHTML = '';

  const visible = state.tournaments.filter((t) =>
    t.status === 'recruiting' || (isAdmin() && t.status === 'draft'));

  if (visible.length === 0) {
    containerEl.innerHTML = '<p class="empty-hint">現在募集中の大会はありません。</p>';
    return;
  }

  visible.forEach((t) => {
    const card = document.createElement('section');
    card.className = 'recruit-card';
    const detailHref = `#bracket/${encodeURIComponent(t.id)}`;

    // 画像があればカード上端に全幅のバナーとして敷く。押すと詳細へ。
    const imageUrl = safeUrl(t.imageUrl);
    if (imageUrl) {
      const banner = document.createElement('a');
      banner.className = 'recruit-banner';
      banner.href = detailHref;
      banner.innerHTML = `<img src="${escapeHtml(imageUrl)}" alt="" loading="lazy">`;
      card.appendChild(banner);
    }

    const body = document.createElement('div');
    body.className = 'recruit-body';

    // 状態 → 大会名 → 事実 → 定員 の順に、上から重要な情報を積む
    body.innerHTML = `
      <span class="status-chip status-${t.status}">${STATUS_LABELS[t.status]}</span>
      <h3 class="recruit-title"><a href="${escapeHtml(detailHref)}">${escapeHtml(t.name)}</a></h3>
    `;
    body.appendChild(factsEl(t));
    body.appendChild(capacityEl(t));

    if (t.rules) {
      const rules = document.createElement('p');
      rules.className = 'recruit-rules';
      rules.textContent = t.rules;
      body.appendChild(rules);
    }

    body.appendChild(entrantStrip(t));

    // 主導線のエントリーを先に置き、詳細と運営操作はその後ろへ回す。
    const actions = document.createElement('div');
    actions.className = 'recruit-actions';
    if (t.status === 'recruiting') actions.appendChild(entryButton(t, onChanged));

    const detail = document.createElement('a');
    detail.className = 'btn-secondary as-link';
    detail.href = detailHref;
    detail.textContent = '詳細を見る';
    actions.appendChild(detail);

    if (isAdmin()) actions.appendChild(adminControls(t, onChanged));
    body.appendChild(actions);

    card.appendChild(body);
    containerEl.appendChild(card);
  });
}

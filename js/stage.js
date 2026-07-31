// 「見せる面」（ホーム・はじめに・規約類）の演出をまとめる。
//
// このサイトは2つの層でできている。
//   見せる面 … ホームと読み物ページ。初めて来た人に、読ませて掴ませる面
//   使う面   … 大会・対戦表・エントリー・チャット。密度と即応が要る面
// このファイルが受け持つのは前者だけで、使う面には手を出さない。スクロールに
// 連動して要素が動く演出は、対戦表のような密な画面ではただの邪魔になるため。
//
// 外部ライブラリは使わない。IntersectionObserver と CSS だけで組む
// （このプロジェクトの「ビルド工程なし・CDN非依存」の方針を崩さないため）。
//
// 【重要】動きを止めている人（prefers-reduced-motion）を置き去りにしない作り
//   登場アニメは「最初は透明 → 見えたら不透明」で作るが、その初期状態の
//   opacity: 0 をCSSに素で書くと、動きを止めた環境で中身が永久に見えなくなる
//   （既存の一括停止は animation-duration を潰すだけで、opacity は戻らない）。
//   そこで <html class="stage-ready"> が付いているときだけ透明にする形にし、
//   その印は index.html の <head> の1行が、動きを許す人にだけ付ける。
//   結果、止めている人には「最初から全部見えている」状態になる。

import { state } from './state.js';
import { safeUrl } from './util.js';
import { STATUS_LABELS } from './entries.js';

const reduceMotionQuery = typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null;

// 判定は毎回問い合わせる。OSの設定は表示中に切り替えられる。
// ページ遷移の演出を出すかどうかの判断で js/app.js からも使う。
export const prefersReducedMotion = () => Boolean(reduceMotionQuery?.matches);

/* ---------------------------------------------------------------------------
   スクロールに合わせた登場
   --------------------------------------------------------------------------- */

let revealObserver = null;

function getRevealObserver() {
  if (revealObserver) return revealObserver;

  revealObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-in');
      // 一度出したものは二度と観測しない。Realtimeの更新でホームが描き直されても、
      // 既に出ているものが跳ね直さないようにするため（お知らせが1件増えるたびに
      // 画面全体が再生されると、見ている人には不具合に見える）。
      revealObserver.unobserve(entry.target);
      startCountUp(entry.target);
    });
  }, {
    // 画面の下端ちょうどではなく、少し入ってから出す。端でちらつくのを防ぐ。
    rootMargin: '0px 0px -10% 0px',
    threshold: 0.05,
  });

  return revealObserver;
}

// root の中の、まだ出ていない .reveal を観測に加える。
// 同じ要素を二重に渡しても IntersectionObserver 側で無視されるので、
// 何度呼んでも構わない。
function observeReveals(root) {
  // 動きを止めている人には .stage-ready が付いておらず、CSS上そもそも
  // 透明になっていない。観測する必要がない。
  if (prefersReducedMotion()) return;

  const observer = getRevealObserver();
  root.querySelectorAll('.reveal:not(.is-in)').forEach((el) => observer.observe(el));
}

/* ---------------------------------------------------------------------------
   大見出しの1文字送り
   --------------------------------------------------------------------------- */

// 文字を1つずつ <span> に割って、順番に出す。
//
// 読み上げには元の1語として伝えたいので、親に aria-label を置き、
// バラした文字は aria-hidden にする（そうしないと「I・g・n・i…」と
// 1文字ずつ読まれる）。
function splitChars(el) {
  if (el.dataset.splitDone === '1') return;

  const text = el.textContent.trim();
  if (!text) return;

  el.dataset.splitDone = '1';
  el.setAttribute('aria-label', text);

  const frag = document.createDocumentFragment();
  // スプレッドで回すのは、絵文字などの表現を途中で割らないため
  // （text[i] だと1文字が2つに割れることがある）。
  [...text].forEach((ch, i) => {
    const span = document.createElement('span');
    span.className = 'stage-char';
    span.setAttribute('aria-hidden', 'true');
    // 出る順番。CSS側で transition-delay に使う。
    span.style.setProperty('--char-i', String(i));
    // 空白は span に入れると潰れるので、潰れない空白に置き換える
    span.textContent = ch === ' ' ? ' ' : ch;
    frag.appendChild(span);
  });

  el.textContent = '';
  el.appendChild(frag);
}

/* ---------------------------------------------------------------------------
   数字のカウントアップ
   --------------------------------------------------------------------------- */

const COUNT_MS = 900;

// 画面に入った塊の中に data-count-to があれば、0からそこまで数える。
// 動きを止めている人には観測そのものが走らないので、最終値のまま動かない。
function startCountUp(root) {
  root.querySelectorAll('[data-count-to]').forEach((el) => {
    const to = Number(el.dataset.countTo);
    if (!Number.isFinite(to)) return;
    if (el.dataset.countDone === '1') return;
    el.dataset.countDone = '1';

    const started = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - started) / COUNT_MS);
      // 終わりに向かってゆっくり止まる。数字が「着地する」感じを出す。
      const eased = 1 - (1 - t) ** 3;
      el.textContent = String(Math.round(to * eased));
      if (t < 1) requestAnimationFrame(step);
      else el.textContent = String(to);
    };
    requestAnimationFrame(step);
  });
}

/* ---------------------------------------------------------------------------
   ホーム：大会サムネイルの帯
   --------------------------------------------------------------------------- */

// ホームに並べる大会の数。多く出すほど1枚あたりが小さくなって印象が薄れるので、
// 「最近どんな大会をやっている場所なのか」が伝わる枚数で止める。
const SHOWCASE_MAX = 8;

// 開催日の新しい順。日付が未定のものは末尾に送る
// （state.tournaments は日付の古い順で入っている）。
function byDateDesc(a, b) {
  if (!a.date && !b.date) return 0;
  if (!a.date) return 1;
  if (!b.date) return -1;
  if (a.date === b.date) return 0;
  return a.date < b.date ? 1 : -1;
}

// 画像を持つ大会だけを大きく見せる帯。ホームで唯一の「写真」の場所になる。
//
// 画像付きの大会が1件も無いあいだは、ブロックごと出さない。空の枠や頭文字だけの
// タイルを並べると、大会がまだ無いことがそのまま貧相さに見えるため
// （画像が読めないときにブロックごと隠す .hero-game と同じ考え方）。
export function renderShowcase(blockEl, railEl) {
  if (!blockEl || !railEl) return;

  const items = state.tournaments
    // 準備中はまだ公開していない大会。DBの読み取りは誰にでも開いているので、
    // ここで必ず落とす（運営の下書きがホームの一番目立つ場所に出てしまう）。
    .filter((t) => t.status !== 'draft' && safeUrl(t.imageUrl))
    .sort(byDateDesc)
    .slice(0, SHOWCASE_MAX);

  if (items.length === 0) {
    blockEl.hidden = true;
    railEl.replaceChildren();
    return;
  }

  const frag = document.createDocumentFragment();

  items.forEach((t) => {
    const card = document.createElement('a');
    card.className = 'showcase-card reveal';
    card.href = `#tournament/${encodeURIComponent(t.id)}`;

    const thumb = document.createElement('div');
    thumb.className = 'showcase-thumb';
    const img = document.createElement('img');
    // safeUrl は上のフィルタで通しているので、ここで null にはならない
    img.src = safeUrl(t.imageUrl);
    img.alt = '';
    img.loading = 'lazy';
    thumb.appendChild(img);

    const body = document.createElement('div');
    body.className = 'showcase-body';

    const meta = document.createElement('p');
    meta.className = 'showcase-meta';
    meta.textContent = `${t.date || '開催日未定'}・${STATUS_LABELS[t.status] ?? ''}`;

    const title = document.createElement('h3');
    title.className = 'showcase-title';
    title.textContent = t.name;

    body.append(meta, title);
    card.append(thumb, body);
    frag.appendChild(card);
  });

  railEl.replaceChildren(frag);
  blockEl.hidden = false;
  observeReveals(railEl);
}

/* ---------------------------------------------------------------------------
   ホーム：数字
   --------------------------------------------------------------------------- */

// 写真が1枚も無くても成立する、ホームのもう1本の柱。
//
// ここに出せるのは「起動時にまとめて読んでいるもの」だけ。試合数は
// db.loadAll が全件を読むのが詳細を開いたあと（fullDataLoaded）なので使えない。
// 代わりに、一覧カード用にDB側で数えてもらっている participantCount を足して
// 「延べ出場」を出す。これなら追加の通信がいらない。
export function renderStats(listEl) {
  if (!listEl) return;

  const held = state.tournaments.filter((t) => t.status !== 'draft');
  const entered = held.reduce((sum, t) => sum + (t.participantCount || 0), 0);

  const stats = [
    { label: 'Players', term: '登録選手', value: state.players.length, unit: '人' },
    { label: 'Tournaments', term: '開催した大会', value: held.length, unit: '大会' },
    { label: 'Entries', term: '延べ出場', value: entered, unit: '人' },
  ];

  const frag = document.createDocumentFragment();

  stats.forEach((s) => {
    const item = document.createElement('div');
    item.className = 'stat-item reveal';

    const label = document.createElement('p');
    label.className = 'stat-label';
    label.textContent = s.label;

    const value = document.createElement('p');
    value.className = 'stat-value';

    const num = document.createElement('span');
    num.className = 'stat-num';
    // 最終値をそのまま入れておく。動きを止めている人には観測が走らないので、
    // この値が出たままになる（0のまま止まる事故を防ぐ）。
    num.textContent = String(s.value);
    if (!prefersReducedMotion() && s.value > 0) {
      num.dataset.countTo = String(s.value);
      num.textContent = '0';
    }

    const unit = document.createElement('span');
    unit.className = 'stat-unit';
    unit.textContent = s.unit;

    const term = document.createElement('p');
    term.className = 'stat-term';
    term.textContent = s.term;

    value.append(num, unit);
    item.append(label, value, term);
    frag.appendChild(item);
  });

  listEl.replaceChildren(frag);
  observeReveals(listEl);
}

/* ---------------------------------------------------------------------------
   入口
   --------------------------------------------------------------------------- */

// いま表示している画面に演出を仕掛ける。
//
// 何度呼ばれても二重にならない（既に出たものは観測から外れ、分割済みの
// 見出しは印で弾く）。ルーティングのたび・読み物ページの読み込み後に呼ぶ。
export function initStage(viewEl) {
  if (!viewEl) return;

  if (!prefersReducedMotion()) {
    viewEl.querySelectorAll('[data-split]').forEach(splitChars);
  }

  observeReveals(viewEl);
}

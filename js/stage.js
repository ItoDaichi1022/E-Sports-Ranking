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
//
// 【ホームの最初の1画面はここでは扱わない】ヒーローは読み込んだ時点で既に画面の
//   中にいるので、スクロールを待つ理由が無い。それをこのファイルの .reveal に
//   載せていたせいで、モジュールが全部届くまでホームが白紙のままだった（実測
//   3,390ms、届かなければ永久）。いまは css/style.css の「ヒーローの登場
//   （JSを通さない）」がCSSだけで出している。ここへ戻さないこと。

import { state } from './state.js';
import { safeUrl } from './util.js';
import { STATUS_LABELS } from './tournamentState.js';
import { pathFor } from './router.js';

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
      const el = entry.target;

      // マスク開きの見出しには class を足さない。'is-in' を付けてしまうと
      // class 属性が生えて、既存の main h2:not([class]) 系の字組みが外れる。
      // 印は data 属性で持つ（値を 'on' から 'in' へ進めるだけ）。
      if (el.dataset.mask) el.dataset.mask = 'in';
      else el.classList.add('is-in');

      // 一度出したものは二度と観測しない。Realtimeの更新でホームが描き直されても、
      // 既に出ているものが跳ね直さないようにするため（お知らせが1件増えるたびに
      // 画面全体が再生されると、見ている人には不具合に見える）。
      revealObserver.unobserve(el);
      startCountUp(el);
    });
  }, {
    // 画面の下端ちょうどではなく、少し入ってから出す。端でちらつくのを防ぐ。
    rootMargin: '0px 0px -10% 0px',
    // 「どれだけ入ったら」ではなく「入ったら」で出す。
    // 割合で条件を付けると、まだ高さを持っていない要素（読み込み中の画像を
    // 抱えた箱など）が割合0のままいつまでも条件を満たさず、開かずに終わる。
    // 出すのを遅らせる役は、上の rootMargin だけに持たせる。
    threshold: 0,
  });

  return revealObserver;
}

// root の中の、まだ出ていないもの（.reveal と、マスクを掛けた見出し）を観測に加える。
// 同じ要素を二重に渡しても IntersectionObserver 側で無視されるので、
// 何度呼んでも構わない。
function observeReveals(root) {
  // 動きを止めている人には .stage-ready が付いておらず、CSS上そもそも
  // 透明になっていない。観測する必要がない。
  if (prefersReducedMotion()) return;

  const observer = getRevealObserver();
  root.querySelectorAll('.reveal:not(.is-in), [data-mask="on"]').forEach((el) => observer.observe(el));
}

/* ---------------------------------------------------------------------------
   見出しのマスク開き
   --------------------------------------------------------------------------- */

// 帯の下から文字が立ち上がってくる形にする。
//
// 仕組みは「親を overflow:hidden にして、中身を包んだ箱を下から押し上げる」だけ。
// 包む箱が要るのでJSで挟むが、動きそのものはCSSが受け持つ。
//
// 印を class ではなく data 属性で持つのは、見出しに class を生やすと
// main h2:not([class]) 系の字組み（左の縦線・余白）が外れてしまうため。
//
// 掛けてはいけない見出しがあることに注意（css の「ステージ」節に一覧がある）。
//   * 擬似要素で下線や光を持つもの … overflow:hidden で切り落とされる
//   * display:flex で番号と並んでいるもの … 包むと横並びが崩れる
// .page-head の中の題は、ページの題（h1）とホームのブロックの題（h2）の
// どちらもありうる（css/style.css の「見出しの3段」を参照）。両方を拾う。
const MASK_SELECTOR = '.page-head :is(h1, h2), .home-step-title';

function wrapMask(el) {
  if (el.dataset.mask) return;

  const body = document.createElement('span');
  body.className = 'stage-mask-body';
  // textContent ではなく子ノードごと移す。見出しの中にリンクや
  // <span>（固定の印など）が入っていることがある。
  while (el.firstChild) body.appendChild(el.firstChild);
  el.appendChild(body);

  // 'on' = 掛けたが、まだ画面に入っていない。observeReveals がこれを拾う。
  el.dataset.mask = 'on';
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
   ホーム：注目の大会
   --------------------------------------------------------------------------- */

// どこまで遡って選ぶか。ここを長くすると、何年も前の大きな大会が居座って
// 「いま動いている場所だ」という印象が出なくなる。
const FEATURED_MONTHS = 3;

// 「直近Nか月」の始まりの日を 'YYYY-MM-DD' で返す。
//
// t.date は日付だけの文字列なので、こちらも同じ形に揃えて文字列のまま比べる。
// Date に変換して比べると、時刻と時差の扱いを持ち込むことになる。
// toISOString() を使わないのも同じ理由 ── あれはUTCに寄せるので、日本時間の
// 朝に開くと1日前の日付になり、境目の大会が入ったり落ちたりする。
function monthsAgo(months) {
  const d = new Date();
  // 3月31日から3か月引くと「12月31日」になる。月末の繰り上がりは Date に任せる。
  d.setMonth(d.getMonth() - months);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 出場した「人」の数。2v2ではチーム数ではなくメンバー全員を数える
// （js/state.js の entrantIds と participantIds の説明を参照）。
// 一覧用にDB側で数えた値が loadAll で入っているので、追加の通信はいらない。
const peopleIn = (t) => t.participantCount || 0;

// 直近3か月でいちばん出場人数が多かった大会を1つだけ大きく見せる。
//
// 「画像を持っているか」では選ばない。絵があるという理由でより小さな大会を
// 選ぶと、この枠が示すはずの「いちばん大きかった大会」という意味が崩れるため。
// 画像が無い大会が選ばれたときは、写真の代わりに出場人数を大きく出す
// （素材が無くても成立させる、というホーム全体の作りに合わせる）。
//
// 直近3か月に大会が1つも無いあいだは、ブロックごと出さない。
export function renderFeatured(blockEl, slotEl) {
  if (!blockEl || !slotEl) return;

  const since = monthsAgo(FEATURED_MONTHS);

  const candidates = state.tournaments.filter((t) => (
    // 準備中はまだ公開していない大会。DBの読み取りは誰にでも開いているので、
    // ここで必ず落とす（運営の下書きがホームの一番目立つ場所に出てしまう）。
    t.status !== 'draft'
    // 開催日が入っていない大会は「直近3か月かどうか」を判断できないので外す
    && t.date
    && t.date >= since
  ));

  // 出場人数の多い順。同数なら新しいほうを採る。
  // filter が新しい配列を返しているので、ここでの sort は state を壊さない。
  candidates.sort((a, b) => peopleIn(b) - peopleIn(a) || (a.date < b.date ? 1 : -1));

  const pick = candidates[0];

  if (!pick) {
    blockEl.hidden = true;
    slotEl.replaceChildren();
    return;
  }

  const imageUrl = safeUrl(pick.imageUrl);

  const card = document.createElement('a');
  card.className = `featured-card reveal${imageUrl ? '' : ' is-textonly'}`;
  card.href = pathFor('tournament', pick.id);

  if (imageUrl) {
    const thumb = document.createElement('div');
    thumb.className = 'featured-thumb';
    const img = document.createElement('img');
    img.src = imageUrl;
    img.alt = '';
    img.loading = 'lazy';
    thumb.appendChild(img);
    card.appendChild(thumb);
  }

  const body = document.createElement('div');
  body.className = 'featured-body';

  const meta = document.createElement('p');
  meta.className = 'featured-meta';
  meta.textContent = `${pick.date}・${STATUS_LABELS[pick.status] ?? ''}`;

  const title = document.createElement('h3');
  title.className = 'featured-title';
  title.textContent = pick.name;

  const count = document.createElement('p');
  count.className = 'featured-count';
  const num = document.createElement('span');
  num.className = 'featured-count-num';
  num.textContent = String(peopleIn(pick));
  const unit = document.createElement('span');
  unit.className = 'featured-count-unit';
  unit.textContent = '人が出場';
  count.append(num, unit);

  body.append(meta, title, count);
  card.appendChild(body);

  slotEl.replaceChildren(card);
  blockEl.hidden = false;
  observeReveals(slotEl);
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
    // 【state.players.length ではないこと】あちらは「これまでに引けた人数」で、
    // ホームでは普通ゼロになる（js/state.js の注記）。総数はDB側で数えた値を使う。
    { label: 'Players', term: '登録選手', value: state.playerCount, unit: '人' },
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

// 導入の演出（開門）が終わるまで、仕掛けるのを控えておく画面。
// 幕が開いたところで一斉に仕掛けるので、ヒーローの登場はちゃんと見える。
const pendingViews = new Set();
let pendingSafetyTimer = null;

function flushPending() {
  clearTimeout(pendingSafetyTimer);
  pendingSafetyTimer = null;
  const views = [...pendingViews];
  pendingViews.clear();
  views.forEach(initStage);
}

// 保険。js/intro.js が 'intro-done' を投げ損ねても、控えたまま消えることはない。
// （印が残っていると initStage がまた控えに戻すので、そのときは印ごと諦める）
function armPendingSafety() {
  if (pendingSafetyTimer !== null) return;
  pendingSafetyTimer = setTimeout(() => {
    pendingSafetyTimer = null;
    document.documentElement.classList.remove('intro-hold');
    flushPending();
  }, 5000);
}

// このリスナーはモジュールを読んだ時点で付く。'intro-done' が飛ぶのは
// 最短でも1フレーム後なので、取りこぼすことはない。
document.addEventListener('intro-done', flushPending);

// いま表示している画面に演出を仕掛ける。
//
// 何度呼ばれても二重にならない（既に出たものは観測から外れ、分割済みの
// 見出しは印で弾く）。ルーティングのたび・読み物ページの読み込み後に呼ぶ。
export function initStage(viewEl) {
  if (!viewEl) return;

  // 導入の演出（js/intro.js）が幕を張っているあいだは仕掛けない。
  // ここで仕掛けてしまうと、登場アニメが幕の裏で終わってしまい、開門したときには
  // 静止した画面が出てくる。
  // 印は intro-playing ではなく intro-hold を見る ── 幕が消えきるのを待つと、
  // 門が開いていく0.6秒のあいだ、中身が空っぽのホームが見えてしまうため。
  //
  // 【ヒーローはここに載っていない】ホームの最初の1画面は css/style.css の
  // 「ヒーローの登場（JSを通さない）」がCSSだけで出す。ここで待たせているのは
  // 画面より下のものだけで、どのみちスクロールしなければ見えない位置にある。
  if (document.documentElement.classList.contains('intro-hold')) {
    pendingViews.add(viewEl);
    armPendingSafety();
    return;
  }

  // マスク開きは見出しの形で拾うが、その形は大会一覧など「使う面」にもある。
  // .stage が付いた画面（ホーム・はじめに・規約類・お知らせ）だけを対象にする。
  if (!prefersReducedMotion() && viewEl.classList.contains('stage')) {
    viewEl.querySelectorAll(MASK_SELECTOR).forEach(wrapMask);
  }

  observeReveals(viewEl);
}

// 最初の画面には、読み込んだ直後に自分から仕掛ける。
//
// 通常の入口は js/app.js の routeFromLocation() だが、そこへ辿り着くまでに
// initAuth() がセッションの確認と選手行の取得を await する（js/auth.js）。
// つまり通信1往復ぶん待つことになり、そのあいだヒーローは伏せられたまま
// 空っぽに見え、見出しは「素の文字が出てから割られて消える」ちらつきになる。
//
// index.html の時点で開いている画面（＝ホーム）はDOMを読み終えた時点で
// 分かるので、通信を待たずにここで仕掛けてしまう。
// initStage は何度呼んでも二重にならないので、後から routeFromLocation が
// 同じ画面に対して呼び直しても構わない。
//
// モジュールスクリプトは defer 扱いなので、ここが動く時点でDOMは揃っている。
const firstStageView = document.querySelector('.view.stage:not([hidden])');
if (firstStageView) initStage(firstStageView);

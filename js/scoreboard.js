// 配信用スコアボード（/tournaments/{大会ID}/scoreboard/?match={対戦ID}）
//
// 【これは「ページ」ではなく「素材」】
// OBSのブラウザソースにこのURLを貼ると、映像の上にスコアボードだけが乗る。
// だからこの画面には、ヘッダーもナビもフッターも背景も無い ── 背景が透けて
// いなければ、中継の画に黒い長方形が貼り付くことになる。打ち消しは
// css/style.css の body.scoreboard-only が担い（scoreboard.css ではない ──
// あちらは開いてから読まれるので、届くまでヘッダーが見えてしまう）、
// このモジュールはそのクラスの付け外しと、描く中身だけを受け持つ。
//
// 【ゲームカウントをどこから取るか】
// DBが持っているのは確定した最終スコア（matches.score の "3-1"）だけで、
// 試合の途中経過はどこにも無い ── ゲームカウントは入力した瞬間に確定する
// 作りなので、そもそも「1-0 の状態」が保存される場面が無い（js/matchChat.js）。
// そこで配信中は、この画面の上で人が動かす。
//
//   * 人がここにいると分かるのは、マウスが動くかキーを押したときだけ
//     （OBSのブラウザソースには基本どちらも届かない）。その瞬間に一度だけ
//     「操作している人のモード」に切り替わり、ボードは消えて操作パネルだけが残る
//     ── ボードと操作パネルが同時に出ている状態を作らない。OBS側はどちらの
//     入力も受け取らないので、この切り替えが起きることはなく、ボードだけが
//     ずっと映り続ける
//   * 配信卓の人は、同じURLを自分のブラウザでも開いて、そちらから操作する
//   * 2つのブラウザ（操作用とOBS）は Supabase Realtime のブロードキャストで
//     つなぐ。テーブルは増やさない ── 配信中の一時的な数字で、残す意味が無い
//
// 【まだ触っていないあいだはDBに従う】
// 開いた直後は、確定済みの対戦ならその最終スコアを出す（試合後のリザルト表示に
// そのまま使える）。人が一度でも±を押したら、そこから先は手元の数字が正になる
// ── 配信中に運営が結果を入れ直しても、映像の数字が勝手に飛ばないようにする。

import * as db from './db.js';
import { state, findTournament, getEntrantName, getEntrantMemberNames, getEntrantMemberIds }
  from './state.js';
import { supabase } from './supabaseClient.js';
import { escapeHtml, safeUrl, initialOf } from './util.js';
import { pathFor } from './router.js';

// 設計上の寸法（css/scoreboard.css と同じ値）。px で組んで最後に拡大縮小する
const DESIGN_W = 1300;
const DESIGN_H = 152;
// 画面のふちに残す余白の割合。ここを詰めすぎると、OBS側で少し縮めたときに
// ブレードの先端が切れる
const FIT_W = 0.965;
const FIT_H = 0.9;
// 画面の下に残す余白。css/scoreboard.css の .sb-viewport { padding-bottom } と
// 同じ値にしてあること ── ここだけ変えると、見た目の余白と拡大率の計算が
// 食い違い、ボードの下端が余白の外まではみ出す（＝画面の下辺で切れる）。
const BOTTOM_GAP_RATIO = 0.032;

// 回戦名の見せ方。ブラケットが持っているのは F / SF / QF / R3 という短い記号で、
// これは対戦表の中で場所を取らないための表記。中継の画に出す札は読ませる字にする。
const ROUND_LABEL = { F: '決勝', SF: '準決勝', QF: '準々決勝' };

function roundLabelOf(match, round) {
  if (match?.isThirdPlace) return '3位決定戦';
  const name = round?.name ?? '';
  if (ROUND_LABEL[name]) return ROUND_LABEL[name];
  const r = /^R(\d+)$/.exec(name);
  return r ? `${r[1]}回戦` : name;
}

// ---------------------------------------------------------------------------
// いま出している対戦
//
// この画面は Realtime の更新のたびに描き直される（js/app.js の routeFromLocation）。
// 数字をモジュール側で覚えておかないと、観戦者が1人チャットを送るたびに
// ゲームカウントが 0-0 に戻る、という壊れ方をする。
// ---------------------------------------------------------------------------
let live = null;   // { tournamentId, matchId, a, b, rev, touched, swapped }
let ui = null;     // 組み立て済みのDOM（作り直しを避けるために持つ）
let channel = null;
let teardown = [];

const storageKey = (tournamentId, matchId) => `scoreboard:${tournamentId}:${matchId}`;

// 手元の控え。配信中にブラウザを閉じてしまっても、開き直せば数字が戻る。
// 壊れた値・別のブラウザの値は無視して 0-0 から始める（読めないより害が無い）。
function loadSaved(tournamentId, matchId) {
  try {
    const raw = localStorage.getItem(storageKey(tournamentId, matchId));
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (typeof v?.a !== 'number' || typeof v?.b !== 'number') return null;
    return { a: v.a, b: v.b, swapped: Boolean(v.swapped) };
  } catch { return null; }
}

function save() {
  if (!live) return;
  try {
    localStorage.setItem(
      storageKey(live.tournamentId, live.matchId),
      JSON.stringify({ a: live.a, b: live.b, swapped: live.swapped }),
    );
  } catch { /* プライベートモードなどで書けなくても、画面は動き続けてよい */ }
}

// ---------------------------------------------------------------------------
// 出す対戦を決める
// ---------------------------------------------------------------------------

function eachMatch(bracket) {
  return bracket.rounds.flatMap((round, roundIndex) => round.matches.map(
    (match) => ({ match, round, roundIndex }),
  ));
}

function findMatch(bracket, matchId) {
  return eachMatch(bracket).find((m) => m.match.id === matchId) ?? null;
}

// ?match= が付いていないときの既定。対戦表のカードから開けば必ず付いてくるので、
// ここに来るのは「URLを手で叩いた」「前の試合のURLを使い回した」場合。
//   1. いま配信台に指定されていて、まだ確定していない対戦
//   2. まだ確定していない対戦のうち、いちばん早い回戦のもの
//   3. どれも終わっていれば決勝
// 配信卓の人が何も指定せずに開いても、たいてい出したい対戦が出る。
function defaultMatch(tournamentId, bracket) {
  const all = eachMatch(bracket).filter(({ match }) => !match.isBye);

  const streamed = all.find(({ match, roundIndex }) => !match.confirmed
    && (state.rounds.find(
      (r) => r.tournamentId === tournamentId && r.roundIndex === roundIndex,
    )?.streamedMatchIds ?? []).includes(match.id));
  if (streamed) return streamed;

  const pending = all.find(({ match }) => !match.confirmed && match.player1Id && match.player2Id);
  if (pending) return pending;

  return all[all.length - 1] ?? null;
}

// 確定済みの対戦の最終スコア。"3-1" の左が player1 側（対戦表の上の行）。
function confirmedCount(match) {
  const parts = String(match?.score ?? '').split('-');
  if (parts.length !== 2) return null;
  const a = Number(parts[0].trim());
  const b = Number(parts[1].trim());
  return Number.isFinite(a) && Number.isFinite(b) ? { a, b } : null;
}

// ---------------------------------------------------------------------------
// 部品づくり
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// 左右どちらかのブレード一式。板（装飾）と中身（文字）を別の層に分けてある
// ── 右側は板の層だけを scaleX(-1) で反転させるため（css/scoreboard.css）。
function buildSide(side) {
  const root = el('div', `sb-side sb-side-${side}`);

  const plates = el('div', 'sb-plates');
  plates.setAttribute('aria-hidden', 'true');
  for (const name of [
    'sb-plate-back', 'sb-plate-main', 'sb-plate-sheen', 'sb-plate-inner',
    'sb-plate-scorepad', 'sb-plate-accent', 'sb-plate-edgeline',
    'sb-plate-hairline', 'sb-plate-slits',
    'sb-plate-bolt sb-plate-bolt-t', 'sb-plate-bolt sb-plate-bolt-b',
  ]) plates.appendChild(el('span', `sb-plate ${name}`));

  const body = el('div', 'sb-side-body');

  const score = el('div', 'sb-score', '0');

  const id = el('div', 'sb-id');
  const name = el('p', 'sb-name');
  const sub = el('p', 'sb-sub');
  id.append(name, sub);

  const avatar = el('div', 'sb-avatar');
  const ring = el('span', 'sb-avatar-ring sb-hex');
  const tint = el('span', 'sb-avatar-tint sb-hex');
  const face = el('span', 'sb-avatar-face sb-hex');
  const gloss = el('span', 'sb-avatar-gloss sb-hex');
  avatar.append(ring, tint, face, gloss);

  body.append(score, id, avatar);
  root.append(plates, body);

  return { root, score, name, sub, face };
}

function buildCore() {
  const root = el('div', 'sb-core');

  const halo = el('span', 'sb-core-halo');
  const back = el('span', 'sb-core-back sb-emblem-shape');
  const ring = el('span', 'sb-core-ring sb-emblem-shape');
  const lip = el('span', 'sb-core-lip sb-emblem-shape');
  const well = el('span', 'sb-core-well sb-emblem-shape');
  const face = el('div', 'sb-core-face sb-emblem-shape');
  const gloss = el('span', 'sb-core-gloss sb-emblem-shape');
  const boltT = el('span', 'sb-core-bolt sb-core-bolt-t');
  const boltB = el('span', 'sb-core-bolt sb-core-bolt-b');

  // 銘板は1行（大会名 ｜ 回戦名）。2段に積むと 152px の高さに収まらない
  const tab = el('div', 'sb-core-tab');
  const event = el('span', 'sb-event');
  const round = el('span', 'sb-round');
  tab.append(event, el('span', 'sb-tab-sep'), round);

  // 【tab は最後に入れること】銘板はエンブレムの下の角に 8px ぶん被せてある。
  // 前に出ていないと、その重なりぶんが六角形の裏へ回って、ただ下に並べただけの
  // 見た目になる（重ね方は css/scoreboard.css の .sb-core-tab に書いてある）。
  root.append(halo, back, ring, lip, well, face, gloss, boltT, boltB, tab);
  return { root, event, face, round };
}

function buildBoard() {
  const viewport = el('div', 'sb-viewport');
  const board = el('div', 'sb-board');

  const left = buildSide('l');
  const core = buildCore();
  const right = buildSide('r');

  board.append(left.root, core.root, right.root);
  viewport.appendChild(board);

  return { viewport, board, left, core, right };
}

// ---------------------------------------------------------------------------
// 操作パネル
// ---------------------------------------------------------------------------

function buildControls(onDelta, onReset, onSwap) {
  const bar = el('div', 'sb-controls');

  const group = (side, label) => {
    const g = el('div', `sb-ctrl-group is-${side}`);
    const nameEl = el('span', 'sb-ctrl-label', label);
    const minus = el('button', 'sb-ctrl-btn', '−');
    const num = el('span', 'sb-ctrl-num', '0');
    const plus = el('button', 'sb-ctrl-btn', '＋');
    minus.type = 'button';
    plus.type = 'button';
    minus.addEventListener('click', () => onDelta(side, -1));
    plus.addEventListener('click', () => onDelta(side, +1));
    if (side === 'left') g.append(nameEl, minus, num, plus);
    else g.append(minus, num, plus, nameEl);
    return { root: g, num, nameEl };
  };

  const left = group('left', '');
  const right = group('right', '');

  const swap = el('button', 'sb-ctrl-mini', '左右を入れ替え');
  swap.type = 'button';
  swap.addEventListener('click', onSwap);

  const reset = el('button', 'sb-ctrl-mini', '0-0に戻す');
  reset.type = 'button';
  reset.addEventListener('click', onReset);

  const text = el('div', 'sb-ctrl-text');
  text.append(
    el('span', 'sb-ctrl-hint', 'Q/A＝左の＋−　P/L＝右の＋−　S＝左右入れ替え　R＝0-0'),
    el('span', 'sb-ctrl-hint', 'OBSのブラウザソースは 幅1920×高さ360 が目安。この操作欄は映像に出ません'),
  );

  const urlBox = el('div', 'sb-ctrl-url');
  const url = document.createElement('input');
  url.type = 'text';
  url.readOnly = true;
  url.setAttribute('aria-label', 'このスコアボードのURL');
  const copy = el('button', 'sb-ctrl-mini', 'URLをコピー');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    url.select();
    try {
      await navigator.clipboard.writeText(url.value);
      copy.textContent = 'コピーしました';
    } catch {
      // クリップボードが使えない環境（httpの直開きなど）。選択済みなので手で写せる
      copy.textContent = 'Ctrl+C で写してください';
    }
    setTimeout(() => { copy.textContent = 'URLをコピー'; }, 1800);
  });
  urlBox.append(url, copy);

  bar.append(
    left.root,
    el('span', 'sb-ctrl-sep'),
    right.root,
    el('span', 'sb-ctrl-sep'),
    swap, reset,
    el('span', 'sb-ctrl-sep'),
    text,
    el('span', 'sb-ctrl-sep'),
    urlBox,
  );

  return { root: bar, left, right, url };
}

// ---------------------------------------------------------------------------
// 描き込み
// ---------------------------------------------------------------------------

// 選手・チームの見た目1組ぶん。個人戦は選手のアイコン、チーム戦は先頭メンバーの
// アイコンを出し、メンバー名は名前の下に添える。
function fillSide(sideUi, tournamentId, entrantId, seed) {
  const name = entrantId ? getEntrantName(tournamentId, entrantId) : 'TBD';
  const members = entrantId ? getEntrantMemberNames(tournamentId, entrantId) : [];
  const memberIds = entrantId ? getEntrantMemberIds(tournamentId, entrantId) : [];

  sideUi.name.textContent = name ?? 'TBD';

  sideUi.sub.innerHTML = '';
  if (seed != null) {
    sideUi.sub.appendChild(el('span', 'sb-seed', `SEED ${seed}`));
  }
  // チーム名だけでは誰が出ているか分からないので、メンバー名を添える
  if (members.length > 0) {
    sideUi.sub.appendChild(el('span', null, members.join(' / ')));
  }

  const player = state.players.find((p) => p.id === memberIds[0]);
  const url = safeUrl(player?.avatarUrl);
  sideUi.face.innerHTML = url
    ? `<img src="${escapeHtml(url)}" alt="">`
    : escapeHtml(initialOf(name));
}

// 長い名前を枠に収める。設計上は26pxで、入らないぶんだけ段階的に落とす
// （落としきっても入らなければ、CSS側の text-overflow で「…」になる）。
//
// 【左右まとめて決めること】片方ずつ詰めると、名前の長さが違うだけで左右の
// 字の大きさが変わる ── 中継の画では「片方だけ小さい」がそのまま格の違いに
// 見えてしまう。両方が収まる大きさを1つ選んで、同じ値を入れる。
function fitNames(leftEl, rightEl) {
  for (let size = 26; size >= 16; size -= 2) {
    leftEl.style.fontSize = `${size}px`;
    rightEl.style.fontSize = `${size}px`;
    if (leftEl.scrollWidth <= leftEl.clientWidth
      && rightEl.scrollWidth <= rightEl.clientWidth) return;
  }
}

function fillCore(coreUi, tournament) {
  const name = tournament?.name ?? '';
  // 大会名は銘板が常に出す。エンブレムのほうは「絵」の担当。
  coreUi.event.textContent = name;

  const url = safeUrl(tournament?.imageUrl);
  coreUi.face.innerHTML = url
    ? `<img src="${escapeHtml(url)}" alt="">`
    // ロゴが登録されていない大会は、頭文字1文字を印として置く。
    // エンブレムの面は 106px しかなく、大会名をそのまま組むと行が割れて読めない
    // ── 名前は銘板のほうが最後まで出しているので、ここは絵の代わりで足りる。
    : `<span class="sb-core-word">${escapeHtml(initialOf(name))}</span>`;
}

// スコアの描き替え。数字が増えたときだけ一度だけ跳ねさせる
// （減らしたときは押し間違いの訂正なので、目立たせない）。
function paintScore(node, value, bump) {
  if (node.textContent === String(value)) return;
  node.textContent = String(value);
  if (!bump) return;
  node.classList.remove('is-bumped');
  // クラスを外した直後だとアニメーションが再生されない。1フレーム空ける
  requestAnimationFrame(() => node.classList.add('is-bumped'));
}

function paint({ bumpLeft = false, bumpRight = false } = {}) {
  if (!ui || !live) return;
  const [a, b] = live.swapped ? [live.b, live.a] : [live.a, live.b];
  paintScore(ui.board.left.score, a, bumpLeft);
  paintScore(ui.board.right.score, b, bumpRight);
  ui.controls.left.num.textContent = String(a);
  ui.controls.right.num.textContent = String(b);
}

// ---------------------------------------------------------------------------
// 拡大率
// ---------------------------------------------------------------------------

function applyScale() {
  if (!ui) return;
  // ボードは下辺に寄せてあるので、高さの側は「画面の高さそのもの」ではなく
  // 「下の余白を引いた、実際に置ける高さ」を基準にする。
  const usableHeight = window.innerHeight * (1 - BOTTOM_GAP_RATIO);
  const scale = Math.min(
    (window.innerWidth * FIT_W) / DESIGN_W,
    (usableHeight * FIT_H) / DESIGN_H,
    // 【1倍より上へは伸ばさない】ここを開けておくと、1920×1080 のブラウザソース
    // では横幅に合わせて 1.25 倍まで拡大され、設計上 180px のバナーが 225px で
    // 出る ── 「180pxに収まる」ではなくなる。狭い画面では縮むが、広い画面では
    // 設計どおりの大きさで止めて、余ったぶんは左右の余白にする。
    1,
  );
  ui.board.board.style.setProperty('--sb-scale', String(scale));
}

// ---------------------------------------------------------------------------
// 2つのブラウザをつなぐ（操作用とOBS）
//
// テーブルは作らない。配信中しか意味を持たない数字なので、Realtime の
// ブロードキャスト（DBを経由しない一時的な通知）だけで足りる。
//
// あとから開いたほうは数字を知らないので、つながった時点で hello を投げる。
// 数字を持っている側（一度でも操作した側）がそれに答える。
// ---------------------------------------------------------------------------

function connect(tournamentId, matchId) {
  disconnect();

  channel = supabase.channel(`scoreboard:${tournamentId}:${matchId}`, {
    config: { broadcast: { self: false } },
  });

  channel.on('broadcast', { event: 'count' }, ({ payload }) => {
    if (!live || !payload) return;
    // rev は送るたびに増える通し番号。行き違いで古い値が後から届いても、
    // 新しいほうを巻き戻さない（±を連打したときに起きる）。
    if (typeof payload.rev !== 'number' || payload.rev <= live.rev) return;

    // 跳ねさせるかどうかは「画面の左右」で比べる。a / b は対戦表の上下
    // （player1 / player2）なので、左右を入れ替えているときは向きが逆になる。
    const [beforeL, beforeR] = live.swapped ? [live.b, live.a] : [live.a, live.b];
    const hadSwapped = live.swapped;

    live.a = Number(payload.a) || 0;
    live.b = Number(payload.b) || 0;
    live.swapped = Boolean(payload.swapped);
    live.rev = payload.rev;
    live.touched = true;
    save();

    // 【入れ替えは名前とアイコンまで動く】ここを忘れると、向こうで S を押したとき
    // 数字だけが入れ替わって、名前は元のまま ── 誰が何点なのかが逆に見える。
    if (live.swapped !== hadSwapped) redrawEntrants();

    const [afterL, afterR] = live.swapped ? [live.b, live.a] : [live.a, live.b];
    paint({ bumpLeft: afterL > beforeL, bumpRight: afterR > beforeR });
  });

  // 後から開いた画面（たいていはOBS側）からの「いまいくつ？」
  channel.on('broadcast', { event: 'hello' }, () => {
    if (live?.touched) broadcast();
  });

  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') channel.send({ type: 'broadcast', event: 'hello', payload: {} });
  });
}

function disconnect() {
  if (!channel) return;
  supabase.removeChannel(channel);
  channel = null;
}

function broadcast() {
  if (!channel || !live) return;
  channel.send({
    type: 'broadcast',
    event: 'count',
    payload: { a: live.a, b: live.b, swapped: live.swapped, rev: live.rev },
  });
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

// 変更のたびに増える通し番号。
//
// 単なる連番にしてはいけない ── 操作用のブラウザを開き直すと 0 に戻り、そのあとの
// 操作がすべて「OBS側が持っている番号より小さい」ものになって、映像の数字だけが
// 更新されなくなる。時刻を混ぜておけば、開き直しをまたいでも必ず増える。
function nextRev() {
  return Math.max(Date.now(), (live?.rev ?? 0) + 1);
}

function bump(side, delta) {
  if (!live) return;
  // 表示上の左右と、対戦表の上下（player1 / player2）は入れ替えられる。
  // 押した側は「見えている側」なので、入れ替え中はここで読み替える
  const key = (side === 'left') === !live.swapped ? 'a' : 'b';
  const next = Math.max(0, Math.min(99, live[key] + delta));
  if (next === live[key]) return;

  live[key] = next;
  live.touched = true;
  live.rev = nextRev();
  save();
  paint({ bumpLeft: side === 'left' && delta > 0, bumpRight: side === 'right' && delta > 0 });
  broadcast();
}

function resetCount() {
  if (!live) return;
  live.a = 0;
  live.b = 0;
  live.touched = true;
  live.rev = nextRev();
  save();
  paint();
  broadcast();
}

function swapSides() {
  if (!live) return;
  live.swapped = !live.swapped;
  live.touched = true;
  live.rev = nextRev();
  save();
  // 名前・アイコンごと入れ替わるので、丸ごと描き直す
  redrawEntrants();
  paint();
  broadcast();
}

let redrawEntrants = () => {};

// ---------------------------------------------------------------------------
// 「操作している人」への切り替え
//
// マウスが動くかキーを押した時点で、この画面を開いているのはOBSではなく
// 人だと分かる（OBSのブラウザソースは「対話」を開かないかぎりどちらも送らない）。
// そこで一度だけ、ボードを隠して操作パネルだけを残す ── 両方が同時に
// 出ている状態を作らない。名前と数字はパネルの中にも出ているので、
// ボードが無くても何を操作しているかは分かる。
//
// 【一度切り替えたら戻さない】マウスが止まるたびにボードへ戻すと、
// 操作の合間にちらつく。人が使っているとすでに分かっている以上、
// 戻す理由が無い。
// ---------------------------------------------------------------------------

let operatorMode = false;

function enterOperatorMode() {
  if (!ui || operatorMode) return;
  operatorMode = true;
  document.body.classList.add('sb-operator-mode');
  ui.controls.root.classList.add('is-shown');
  // 役目を終えたので外す。以後は onKeyDown からだけ呼ばれる形になる
  window.removeEventListener('mousemove', enterOperatorMode);
}

const KEYS = {
  q: () => bump('left', +1),
  a: () => bump('left', -1),
  p: () => bump('right', +1),
  l: () => bump('right', -1),
  r: () => resetCount(),
  s: () => swapSides(),
};

function onKeyDown(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // URL欄にカーソルがあるときは、キーを操作として取らない
  if (e.target instanceof HTMLInputElement) return;
  const fn = KEYS[e.key.toLowerCase()];
  if (!fn) return;
  e.preventDefault();
  enterOperatorMode();
  fn();
}

// ---------------------------------------------------------------------------
// 画面の組み立て
// ---------------------------------------------------------------------------

function root() {
  return document.getElementById('scoreboard-root');
}

function showNotice(html) {
  closeScoreboard();
  const host = root();
  if (!host) return;
  document.body.classList.add('scoreboard-only');
  host.innerHTML = `<div class="sb-notice">${html}</div>`;
}

export async function renderScoreboardPage(tournamentId) {
  const host = root();
  if (!host) return;

  document.body.classList.add('scoreboard-only');

  const tournament = findTournament(tournamentId);
  if (!tournament) {
    // 届く前に「無い」と言い切らない（他のページと同じ扱い）
    if (!db.hasLoadedOnce()) return;
    showNotice('<h2>大会が見つかりません</h2>'
      + '<p>この大会は存在しないか、削除されています。</p>'
      + `<p><a href="${pathFor('tournaments')}">大会一覧へ</a></p>`);
    return;
  }

  try {
    await Promise.all([
      db.ensureTournamentDetail(tournamentId),
      db.ensureTournamentMatches(tournamentId),
    ]);
    if (!state.brackets[tournamentId] && state.bracketIds.has(tournamentId)) {
      await db.loadBracket(tournamentId);
    }
  } catch (err) {
    showNotice(`<h2>読み込めませんでした</h2><p>${escapeHtml(err.message)}</p>`);
    return;
  }

  const bracket = state.brackets[tournamentId];
  if (!bracket) {
    showNotice('<h2>対戦表がまだありません</h2>'
      + '<p>スコアボードは対戦カードから作ります。募集を締め切って対戦表を組むと使えるようになります。</p>'
      + `<p><a href="${pathFor('tournament', tournamentId)}">大会の詳細へ</a></p>`);
    return;
  }

  const wanted = new URLSearchParams(location.search).get('match');
  const found = (wanted ? findMatch(bracket, wanted) : null) ?? defaultMatch(tournamentId, bracket);
  if (!found) {
    showNotice('<h2>出せる対戦がありません</h2>'
      + '<p>この大会の対戦表に、表示できる対戦カードが見つかりませんでした。</p>'
      + `<p><a href="${pathFor('bracket', tournamentId)}">対戦表へ</a></p>`);
    return;
  }

  const { match, round } = found;

  // 同じ対戦を描き直しているだけなら、組み立て直さない。
  // この関数は Realtime の更新のたびに呼ばれるので、ここで作り直すと
  // 誰かがチャットを送るたびにスコアボードが跳ねることになる。
  const sameMatch = live && live.tournamentId === tournamentId && live.matchId === match.id;

  if (!sameMatch) {
    closeScoreboard();
    document.body.classList.add('scoreboard-only');

    const saved = loadSaved(tournamentId, match.id);
    const fromDb = confirmedCount(match);
    live = {
      tournamentId,
      matchId: match.id,
      a: saved?.a ?? fromDb?.a ?? 0,
      b: saved?.b ?? fromDb?.b ?? 0,
      swapped: saved?.swapped ?? false,
      rev: 0,
      // 控えがあるということは、この対戦をすでに配信卓で触っている
      touched: Boolean(saved),
    };

    const board = buildBoard();
    const controls = buildControls(bump, resetCount, swapSides);
    controls.url.value = location.href;

    host.innerHTML = '';
    host.append(board.viewport, controls.root);
    ui = { board, controls };

    connect(tournamentId, match.id);

    window.addEventListener('resize', applyScale);
    window.addEventListener('mousemove', enterOperatorMode);
    window.addEventListener('keydown', onKeyDown);
    teardown = [
      () => window.removeEventListener('resize', applyScale),
      () => window.removeEventListener('mousemove', enterOperatorMode),
      () => window.removeEventListener('keydown', onKeyDown),
    ];
  }

  // 出場枠のIDと、対戦表に出しているシード番号
  const seedOf = (entrantId) => {
    const i = tournament.entrantIds?.indexOf(entrantId) ?? -1;
    return i >= 0 ? (tournament.entrantSeeds?.[i] ?? null) : null;
  };

  redrawEntrants = () => {
    const [p1, p2] = live.swapped
      ? [match.player2Id, match.player1Id]
      : [match.player1Id, match.player2Id];
    fillSide(ui.board.left, tournamentId, p1, seedOf(p1));
    fillSide(ui.board.right, tournamentId, p2, seedOf(p2));
    ui.controls.left.nameEl.textContent = getEntrantName(tournamentId, p1) ?? 'TBD';
    ui.controls.right.nameEl.textContent = getEntrantName(tournamentId, p2) ?? 'TBD';
    fitNames(ui.board.left.name, ui.board.right.name);
  };

  redrawEntrants();
  fillCore(ui.board.core, tournament);
  ui.board.core.round.textContent = roundLabelOf(match, round);

  // まだ誰も触っていないうちは、確定済みの最終スコアに追従する
  // （試合が終わったあとのリザルト表示に、そのまま使えるようにするため）
  if (!live.touched) {
    const fromDb = confirmedCount(match);
    if (fromDb) { live.a = fromDb.a; live.b = fromDb.b; }
  }

  paint();
  applyScale();
  // 文字の大きさは、画面に入って幅が確定してからでないと測れない。
  // 組み立てた直後のこの1回だけは、枠の幅がまだ 0 のまま測れていることがある
  // （上の redrawEntrants の中でも呼んでいるが、そちらは器を足す前に走りうる）。
  requestAnimationFrame(() => {
    if (!ui) return;
    fitNames(ui.board.left.name, ui.board.right.name);
  });
}

// 別のページへ移るとき、js/app.js から呼ぶ。
// body のクラスを外し忘れると、移った先でヘッダーもナビも消えたままになる。
export function closeScoreboard() {
  document.body.classList.remove('scoreboard-only', 'sb-operator-mode');
  operatorMode = false;
  teardown.forEach((fn) => fn());
  teardown = [];
  disconnect();
  redrawEntrants = () => {};
  ui = null;
  live = null;
  const host = root();
  if (host) host.innerHTML = '';
}

// 配信用スコアボード。URLは2つあり、どちらもこのモジュールが受け持つ。
//
//   表示専用  /tournaments/{大会ID}/scoreboard/?match={対戦ID}
//             OBSのブラウザソースに貼るURL。スコアボードの絵だけを描く
//   操作画面  /tournaments/{大会ID}/scoreboard/control/?match={対戦ID}
//             配信卓の人がゲームカウントを動かす画面
//
// 【なぜ2つに分けたか】
// もとは1つのURLで、マウスが動いたかキーが押されたかで見た目を切り替えていた
// ── OBSのブラウザソースにはどちらも届かないので、「人が触ったら操作パネル」は
// 理屈としては通っていた。破れていたのは、読み込みに失敗したときの案内だけが
// その切り替えの外にあったこと。大会が取れなければ「大会が見つかりません」と
// いう文字がボードと入れ替わって出るので、それがそのまま中継の画に乗る。
//
// 表示専用を別のURLにして、あの画面には案内を描く道そのものを持たせない
// （下の fail() が、モードによって正反対に振る舞う）。うまく組めなかったときは
// 何も描かず、既に出ているボードはそのまま残す ── 中継の画にとっては、
// 数字が数秒古いことより、絵が文字に化けることのほうがずっと困る。
//
// 【表示専用が元のURLを引き継いでいる】OBSに貼られているURLはこの形なので、
// 操作画面と入れ替えると、配信中の設定が操作パネルを映し始めてしまう。
//
// 【これは「ページ」ではなく「素材」】
// 表示専用の側には、ヘッダーもナビもフッターも背景も無い ── 背景が透けて
// いなければ、中継の画に黒い長方形が貼り付くことになる。打ち消しは
// css/style.css の body.scoreboard-only が担い（scoreboard.css ではない ──
// あちらは開いてから読まれるので、届くまでヘッダーが見えてしまう）、
// このモジュールはそのクラスの付け外しと、描く中身だけを受け持つ。
//
// 【ゲームカウントをどこから取るか】
// DBが持っているのは確定した最終スコア（matches.score の "3-1"）だけで、
// 試合の途中経過はどこにも無い ── ゲームカウントは入力した瞬間に確定する
// 作りなので、そもそも「1-0 の状態」が保存される場面が無い（js/matchChat.js）。
// そこで配信中は、操作画面の上で人が動かす。
//
//   * 配信卓の人は操作画面を自分のブラウザで開き、OBSには表示専用のURLを貼る
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
const DESIGN_H = 132;
// 画面のふちに残す余白の割合。ここを詰めすぎると、OBS側で少し縮めたときに
// ブレードの先端が切れる
const FIT_W = 0.965;
const FIT_H = 0.9;
// 画面の下に残す余白。css/scoreboard.css の .sb-viewport { padding-bottom } と
// 同じ値にしてあること ── ここだけ変えると、見た目の余白と拡大率の計算が
// 食い違い、ボードの下端が余白の外まではみ出す（＝画面の下辺で切れる）。
const BOTTOM_GAP_RATIO = 0.032;

// 表示専用（OBS用）と操作画面。器（#scoreboard-root）は同じものを使い、
// 中身の作りと「失敗したときにどう振る舞うか」がこの値で変わる。
const MODE_VIEW = 'view';
const MODE_CONTROL = 'control';

// いまどちらのページを組んでいるか。closeScoreboard では戻さない
// ── 戻す相手がおらず、次に描くときは必ず render が入れ直すため。
let mode = MODE_VIEW;

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
//
// 【板は2枚しか無い】面（sb-plate-main）と、チームカラーの帯（sb-plate-accent）。
// 以前はここに背面板・光沢・彫り込み・スコア台・細線・スリット・ボルトまで
// 積んでいたが、中継の画では 1/3 以下に縮んで出るので、その大半は潰れた
// ノイズにしかならない。読ませたいのは名前とスコアの2つだけ。
function buildSide(side) {
  const root = el('div', `sb-side sb-side-${side}`);

  const plates = el('div', 'sb-plates');
  plates.setAttribute('aria-hidden', 'true');
  for (const name of ['sb-plate-main', 'sb-plate-accent']) {
    plates.appendChild(el('span', `sb-plate ${name}`));
  }

  const body = el('div', 'sb-side-body');

  const score = el('div', 'sb-score', '0');

  const id = el('div', 'sb-id');
  const name = el('p', 'sb-name');
  const sub = el('p', 'sb-sub');
  id.append(name, sub);

  // アイコンは六角形のまま。枠はチームカラーの単色1枚だけで、
  // 金属の環・内側の細線・ガラスの反射は持たない。
  const avatar = el('div', 'sb-avatar');
  const ring = el('span', 'sb-avatar-ring sb-hex');
  const face = el('span', 'sb-avatar-face sb-hex');
  avatar.append(ring, face);

  body.append(score, id, avatar);
  root.append(plates, body);

  return { root, score, name, sub, face };
}

// 中央のエンブレム。大会ロゴを収めた多角形と、その下の銘板。
// 面（face）とその下の枠（back）の2枚だけで、ベゼル・落とし込み・反射・
// ボルトは持たない ── ロゴそのものが絵なので、周りを作り込むほど絵が負ける。
function buildCore() {
  const root = el('div', 'sb-core');

  const back = el('span', 'sb-core-back sb-emblem-shape');
  const face = el('div', 'sb-core-face sb-emblem-shape');

  // 銘板は1行（大会名 ｜ 回戦名）。2段に積むと 132px の高さに収まらない
  const tab = el('div', 'sb-core-tab');
  const event = el('span', 'sb-event');
  const round = el('span', 'sb-round');
  tab.append(event, el('span', 'sb-tab-sep'), round);

  // 【tab は最後に入れること】銘板はエンブレムの下の角に 8px ぶん被せてある。
  // 前に出ていないと、その重なりぶんが多角形の裏へ回って、ただ下に並べただけの
  // 見た目になる（重ね方は css/scoreboard.css の .sb-core-tab に書いてある）。
  root.append(back, face, tab);
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
// 操作パネル（操作画面だけが持つ）
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
  );

  bar.append(
    left.root,
    el('span', 'sb-ctrl-sep'),
    right.root,
    el('span', 'sb-ctrl-sep'),
    swap, reset,
    el('span', 'sb-ctrl-sep'),
    text,
  );

  return { root: bar, left, right };
}

// OBSに貼るURLを渡す欄。操作画面の役目のうち、カウントを動かすことと並んで
// 大きいのがこれ ── 配信卓の人がまず要るのは「どのURLを貼るか」で、
// 操作画面のURL（いま開いているURL）をそのまま貼られると操作パネルが映る。
function buildObsUrl() {
  const box = el('div', 'sb-obs');

  const label = el('p', 'sb-obs-label', 'OBSのブラウザソースに貼るURL（表示専用）');

  const row = el('div', 'sb-obs-row');
  const url = document.createElement('input');
  url.type = 'text';
  url.readOnly = true;
  url.className = 'sb-obs-input';
  url.setAttribute('aria-label', 'OBSのブラウザソースに貼るURL');

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

  // 別のタブで開いて確かめられるようにしておく。貼る前に「本当にボードだけが
  // 出るURLか」を見られたほうが安心して使える。
  const open = el('a', 'sb-ctrl-mini', '別のタブで開く');
  open.target = '_blank';
  open.rel = 'noopener';

  row.append(url, copy, open);

  const note = el('p', 'sb-obs-note',
    '幅1920×高さ360が目安。この操作画面のURLではなく、上のURLを貼ってください。');

  box.append(label, row, note);
  return { root: box, url, open };
}

// 操作画面の見出し。いま何を操作しているのかを、ボードを見なくても分かる字で置く。
//
// 【戻る導線をここに持つ】この画面でも body に .scoreboard-only が付くので、
// ヘッダーもナビも消えている（css/style.css）。一本も置かないと、配信卓の人は
// ブラウザの戻るボタンしか手が無くなる ── 対戦表から別のタブで開いていれば、
// そこには戻り先の履歴も無い。
function buildHead(tournamentId) {
  const head = el('div', 'sb-panel-head');

  const back = el('a', 'sb-panel-back', '← 対戦表へ');
  back.href = pathFor('bracket', tournamentId);

  const title = el('h1', 'sb-panel-title', '配信スコアボード｜操作画面');
  const meta = el('p', 'sb-panel-meta');
  head.append(back, title, meta);
  return { root: head, meta };
}

// ボードを枠に収めた見本。操作画面には映像が無いので、ここが「いまOBSに
// 出ている絵」を確かめられる唯一の場所になる。
function buildPreview(viewport) {
  const box = el('div', 'sb-preview');
  box.append(el('p', 'sb-preview-label', 'OBSに映っている絵'), viewport);
  return box;
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
  // 操作パネルは操作画面にしか無い（表示専用のページは ui.controls を持たない）
  if (!ui.controls) return;
  ui.controls.left.num.textContent = String(a);
  ui.controls.right.num.textContent = String(b);
}

// ---------------------------------------------------------------------------
// 拡大率
// ---------------------------------------------------------------------------

// OBSに出す側。画面いっぱいを使い、下辺に寄せて置く。
function streamScale() {
  // ボードは下辺に寄せてあるので、高さの側は「画面の高さそのもの」ではなく
  // 「下の余白を引いた、実際に置ける高さ」を基準にする。
  const usableHeight = window.innerHeight * (1 - BOTTOM_GAP_RATIO);
  return Math.min(
    (window.innerWidth * FIT_W) / DESIGN_W,
    (usableHeight * FIT_H) / DESIGN_H,
    // 【1倍より上へは伸ばさない】ここを開けておくと、1920×1080 のブラウザソース
    // では横幅に合わせて 1.25 倍まで拡大され、設計上 180px のバナーが 225px で
    // 出る ── 「180pxに収まる」ではなくなる。狭い画面では縮むが、広い画面では
    // 設計どおりの大きさで止めて、余ったぶんは左右の余白にする。
    1,
  );
}

// 操作画面の見本。こちらは画面ではなく、見本の枠の幅に収める。
function previewScale() {
  const width = ui.board.viewport.clientWidth || window.innerWidth;
  return Math.min((width * FIT_W) / DESIGN_W, 1);
}

function applyScale() {
  if (!ui) return;
  // --sb-scale は .sb-viewport に入れる。.sb-board はこれを継いで scale() に使い、
  // 操作画面のほうは同じ値から見本の枠の高さも決める（css/scoreboard.css）。
  const scale = mode === MODE_CONTROL ? previewScale() : streamScale();
  ui.board.viewport.style.setProperty('--sb-scale', String(scale));
}

// ---------------------------------------------------------------------------
// 2つのブラウザをつなぐ（操作画面とOBS）
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

// キーで動かす。操作画面にしか付けない ── 表示専用のページは、何が届いても
// 数字が動かないほうが安全（OBSのブラウザソースは「対話」を開くとキーを送れる）。
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
  fn();
}

// ---------------------------------------------------------------------------
// 組めなかったとき
//
// ここがこの2ページを分けた理由そのもの。
//   操作画面 … 人が読む画面なので、理由と次の一手を文字で出す
//   表示専用 … 文字は出さない。出ているボードはそのまま残し、少し待って組み直す
// ---------------------------------------------------------------------------

// 表示専用が組み直すまでの待ち。続けて失敗するほど間隔を空ける
// （消えた大会のURLがOBSに残っていても、5秒ごとに問い合わせ続けないため）。
const RETRY_STEP_MS = 5000;
const RETRY_MAX_MS = 30000;

let retryTimer = null;
let retryCount = 0;

function clearRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryCount = 0;
}

// 【自分ではDBを読み直さない】データの取り直しは js/app.js が受け持っていて、
// Realtime が切れているあいだも1分ごとに全件を取り直している（保険の照合）。
// ここから loadAll を呼ぶと、あちらの読み込み中フラグと取り合うことになる。
// このタイマーがやるのは「届いているかもう一度見て、組めるなら組む」だけ。
function scheduleRetry(tournamentId) {
  if (retryTimer) return;
  retryCount += 1;
  const wait = Math.min(RETRY_STEP_MS * retryCount, RETRY_MAX_MS);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    // 別のページへ移っていたら、もう組み直す先が無い。
    //
    // 【器が出ているかどうかでは見分けられない】操作画面とは同じ <section> を
    // 共有しているので、あちらを開いていても器は出たままになる。URLで見ること
    // ── そうしないと、待ちの残ったまま操作画面へ移った人の画面を、
    // このタイマーが表示専用に組み替えてしまう。
    if (!root()) return;
    if (location.pathname !== pathFor('scoreboard', tournamentId)) return;
    renderScoreboardPage(tournamentId);
  }, wait);
}

function showNotice(html) {
  const host = root();
  if (!host) return;
  closeScoreboard();
  document.body.classList.add('scoreboard-only', 'sb-control-mode');
  host.innerHTML = `<div class="sb-notice">${html}</div>`;
}

function fail(tournamentId, html) {
  if (mode === MODE_CONTROL) {
    showNotice(html);
    return;
  }
  // 表示専用。中継の画に文字を出さない ── 描いてあるボードには触らず、
  // 何も描けていなければ透明なまま置いておく。
  scheduleRetry(tournamentId);
}

// ---------------------------------------------------------------------------
// 画面の組み立て
// ---------------------------------------------------------------------------

function root() {
  return document.getElementById('scoreboard-root');
}

// OBSのブラウザソースに貼るURL。操作画面だけが使う。
function obsUrlFor(tournamentId, matchId) {
  return new URL(pathFor('scoreboard', tournamentId, { match: matchId }), location.origin).href;
}

// OBS用（表示専用）。/tournaments/{大会ID}/scoreboard/
export function renderScoreboardPage(tournamentId) {
  return render(tournamentId, MODE_VIEW);
}

// 配信卓の操作画面。/tournaments/{大会ID}/scoreboard/control/
export function renderScoreboardControlPage(tournamentId) {
  return render(tournamentId, MODE_CONTROL);
}

async function render(tournamentId, wantMode) {
  const host = root();
  if (!host) return;

  // 2つのページは器を共有している。サイトの中で行き来したときは作りが違うので、
  // 組み立て直す前に前のページぶんを畳む。
  if (mode !== wantMode) {
    closeScoreboard();
    mode = wantMode;
  }

  document.body.classList.add('scoreboard-only');
  if (mode === MODE_CONTROL) document.body.classList.add('sb-control-mode');

  const tournament = findTournament(tournamentId);
  if (!tournament) {
    // 届く前に「無い」と言い切らない（他のページと同じ扱い）
    if (!db.hasLoadedOnce()) return;
    fail(tournamentId, '<h2>大会が見つかりません</h2>'
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
    fail(tournamentId, `<h2>読み込めませんでした</h2><p>${escapeHtml(err.message)}</p>`);
    return;
  }

  const bracket = state.brackets[tournamentId];
  if (!bracket) {
    fail(tournamentId, '<h2>対戦表がまだありません</h2>'
      + '<p>スコアボードは対戦カードから作ります。募集を締め切って対戦表を組むと使えるようになります。</p>'
      + `<p><a href="${pathFor('tournament', tournamentId)}">大会の詳細へ</a></p>`);
    return;
  }

  const wanted = new URLSearchParams(location.search).get('match');
  const found = (wanted ? findMatch(bracket, wanted) : null) ?? defaultMatch(tournamentId, bracket);
  if (!found) {
    fail(tournamentId, '<h2>出せる対戦がありません</h2>'
      + '<p>この大会の対戦表に、表示できる対戦カードが見つかりませんでした。</p>'
      + `<p><a href="${pathFor('bracket', tournamentId)}">対戦表へ</a></p>`);
    return;
  }

  // ここまで来られたので、組み直しの待ちは畳む
  clearRetry();

  const { match, round } = found;

  // 同じ対戦を描き直しているだけなら、組み立て直さない。
  // この関数は Realtime の更新のたびに呼ばれるので、ここで作り直すと
  // 誰かがチャットを送るたびにスコアボードが跳ねることになる。
  const sameMatch = live && live.tournamentId === tournamentId && live.matchId === match.id;

  if (!sameMatch) {
    closeScoreboard();
    document.body.classList.add('scoreboard-only');
    if (mode === MODE_CONTROL) document.body.classList.add('sb-control-mode');

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
    host.innerHTML = '';

    if (mode === MODE_CONTROL) {
      const head = buildHead(tournamentId);
      const controls = buildControls(bump, resetCount, swapSides);
      const obs = buildObsUrl();
      obs.url.value = obsUrlFor(tournamentId, match.id);
      obs.open.href = obs.url.value;

      const panel = el('div', 'sb-panel');
      panel.append(head.root, buildPreview(board.viewport), controls.root, obs.root);
      host.appendChild(panel);
      ui = { board, controls, head };

      window.addEventListener('keydown', onKeyDown);
      teardown.push(() => window.removeEventListener('keydown', onKeyDown));
    } else {
      host.appendChild(board.viewport);
      ui = { board, controls: null, head: null };
    }

    connect(tournamentId, match.id);

    window.addEventListener('resize', applyScale);
    teardown.push(() => window.removeEventListener('resize', applyScale));
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
    if (ui.controls) {
      ui.controls.left.nameEl.textContent = getEntrantName(tournamentId, p1) ?? 'TBD';
      ui.controls.right.nameEl.textContent = getEntrantName(tournamentId, p2) ?? 'TBD';
    }
    fitNames(ui.board.left.name, ui.board.right.name);
  };

  redrawEntrants();
  fillCore(ui.board.core, tournament);
  ui.board.core.round.textContent = roundLabelOf(match, round);

  // 操作画面の見出し。ボードの見本とは別に、字でも何を操作しているかを出す
  if (ui.head) {
    ui.head.meta.textContent = [tournament.name, roundLabelOf(match, round)]
      .filter(Boolean).join('　｜　');
  }

  // まだ誰も触っていないうちは、確定済みの最終スコアに追従する
  // （試合が終わったあとのリザルト表示に、そのまま使えるようにするため）
  if (!live.touched) {
    const fromDb = confirmedCount(match);
    if (fromDb) { live.a = fromDb.a; live.b = fromDb.b; }
  }

  paint();
  applyScale();
  // 文字の大きさと見本の枠の幅は、画面に入ってからでないと測れない。
  // 組み立てた直後のこの1回だけは、枠の幅がまだ 0 のまま測れていることがある
  // （上の redrawEntrants の中でも呼んでいるが、そちらは器を足す前に走りうる）。
  requestAnimationFrame(() => {
    if (!ui) return;
    applyScale();
    fitNames(ui.board.left.name, ui.board.right.name);
  });
}

// 別のページへ移るとき、js/app.js から呼ぶ。
// body のクラスを外し忘れると、移った先でヘッダーもナビも消えたままになる。
export function closeScoreboard() {
  document.body.classList.remove('scoreboard-only', 'sb-control-mode');
  clearRetry();
  teardown.forEach((fn) => fn());
  teardown = [];
  disconnect();
  redrawEntrants = () => {};
  ui = null;
  live = null;
  const host = root();
  if (host) host.innerHTML = '';
}

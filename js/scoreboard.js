// 配信用スコアボード。URLは2つあり、どちらもこのモジュールが受け持つ。
//
//   表示専用  /tournaments/{大会ID}/scoreboard/
//             OBSのブラウザソースに貼るURL。スコアボードの絵だけを描く
//   操作画面  /tournaments/{大会ID}/scoreboard/control/
//             配信卓の人が「どの対戦を出すか」とゲームカウントを動かす画面
//
// 【URLに対戦IDを持たせない】以前は ?match={対戦ID} で出す対戦を決めていたので、
// 試合が1つ進むたびにURLを取り直し、OBSのブラウザソースを貼り替える必要があった。
// いまは2つのURLが大会ごとに1本ずつで固定されていて、大会の前に一度貼れば済む。
// 出す対戦は操作画面の一覧から選び、表示専用の側はそれに付いて切り替わる。
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
//     つなぐ。チャンネルは大会に1本で、流すのは「いま出している対戦ID＋カウント」
//     の組。テーブルは増やさない ── 配信中の一時的な値で、残す意味が無い
//
// 【まだ誰も選んでいないあいだは自動】
// 操作画面で一度も対戦を選んでいなければ、両方の画面が同じ規則（defaultMatch）で
// 同じ対戦を出す。選んだ時点から、選んだものが正になる。
//
// 【まだ触っていないあいだはDBに従う】
// 選んだ直後は、確定済みの対戦ならその最終スコアを出す（試合後のリザルト表示に
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
//
// rev は「いつ決めた値か」の通し番号。0 は「まだ誰も選んでいない（自動）」で、
// そのあいだは matchId を描くたびに defaultMatch で選び直す。
// ---------------------------------------------------------------------------
let live = null;   // { tournamentId, matchId, a, b, swapped, touched, rev }
let ui = null;     // 組み立て済みのDOM（作り直しを避けるために持つ）
let channel = null;
let teardown = [];
// 操作画面の一覧に、結果の確定した対戦も並べるか
let showDone = false;

// 手元の控えは2種類。
//   scoreboard:{大会ID}           … いまどの対戦を出しているか（と、その rev）
//   scoreboard:{大会ID}:{対戦ID}  … 対戦ごとのカウント。一覧で別の対戦へ移って
//                                   戻ってきたときに、数字を失わないため
// 配信中にブラウザを閉じてしまっても、開き直せば同じところから続けられる。
// 壊れた値は無視する（読めないより害が無い）。
const selectionKey = (tournamentId) => `scoreboard:${tournamentId}`;
const countKey = (tournamentId, matchId) => `scoreboard:${tournamentId}:${matchId}`;

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* プライベートモードなどで書けなくても、画面は動き続けてよい */ }
}

function loadSelection(tournamentId) {
  const v = readJson(selectionKey(tournamentId));
  if (typeof v?.matchId !== 'string' || typeof v?.rev !== 'number') return null;
  return { matchId: v.matchId, rev: v.rev };
}

function loadCount(tournamentId, matchId) {
  const v = readJson(countKey(tournamentId, matchId));
  if (typeof v?.a !== 'number' || typeof v?.b !== 'number') return null;
  // touched の無い控えは、この項目を足す前のもの。控えがある＝触っていた
  return { a: v.a, b: v.b, swapped: Boolean(v.swapped), touched: v.touched ?? true };
}

function save() {
  if (!live) return;
  if (live.rev > 0) {
    writeJson(selectionKey(live.tournamentId), { matchId: live.matchId, rev: live.rev });
  }
  // 一度も触っていない対戦の控えは残さない ── 残すと、あとで運営が結果を
  // 入れたときに「触った数字」扱いになって、DBの最終スコアに追従しなくなる
  if (live.matchId && (live.touched || live.swapped)) {
    writeJson(countKey(live.tournamentId, live.matchId), {
      a: live.a, b: live.b, swapped: live.swapped, touched: live.touched,
    });
  }
}

// ある対戦を出し始めるときのカウント。控え → 確定済みの最終スコア → 0-0 の順
function countFor(tournamentId, match) {
  const saved = loadCount(tournamentId, match.id);
  if (saved) return saved;
  const fromDb = confirmedCount(match);
  return { a: fromDb?.a ?? 0, b: fromDb?.b ?? 0, swapped: false, touched: false };
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

function isStreamed(tournamentId, roundIndex, matchId) {
  return (state.rounds.find(
    (r) => r.tournamentId === tournamentId && r.roundIndex === roundIndex,
  )?.streamedMatchIds ?? []).includes(matchId);
}

// まだ操作画面で誰も選んでいないときの既定。
//   1. いま配信台に指定されていて、まだ確定していない対戦
//   2. まだ確定していない対戦のうち、いちばん早い回戦のもの
//   3. どれも終わっていれば決勝
// 表示専用と操作画面が同じ材料から同じ答えを出すので、何も選ばなくても
// 2つの画面は同じ対戦を出している。
function defaultMatch(tournamentId, bracket) {
  const all = eachMatch(bracket).filter(({ match }) => !match.isBye);

  const streamed = all.find(({ match, roundIndex }) => !match.confirmed
    && isStreamed(tournamentId, roundIndex, match.id));
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

// 配信台に出す対戦を選ぶ一覧。回戦ごとに対戦カードを並べ、押したカードが
// そのまま表示専用の画面（OBS）に出る。
//
// 【一覧は描くたびに作り直す】対戦表は Realtime で動く（勝者が上の回戦へ
// 上がる・結果が確定する）ので、組み立てた時点の一覧を持ち続けると、
// TBD のままのカードが残る。数十枚のボタンなので作り直しても軽い。
// 押したときの処理は枠に1つだけ付けておき（data-match で見分ける）、
// 作り直しのたびに付け直さないで済むようにする。
function buildPicker(onPick, onToggleDone) {
  const box = el('div', 'sb-pick');

  const head = el('div', 'sb-pick-head');
  const label = el('p', 'sb-pick-label', '配信台に出す対戦');

  const toggle = el('label', 'sb-pick-toggle');
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = showDone;
  check.addEventListener('change', () => onToggleDone(check.checked));
  toggle.append(check, document.createTextNode('終わった対戦も表示'));

  head.append(label, toggle);

  const note = el('p', 'sb-pick-note');
  note.hidden = true;

  const list = el('div', 'sb-pick-list');
  list.addEventListener('click', (e) => {
    const card = e.target.closest('button[data-match]');
    if (card) onPick(card.dataset.match);
  });

  box.append(head, note, list);
  return { root: box, list, note };
}

function tag(text, modifier) {
  return el('span', `sb-pick-tag${modifier ? ` is-${modifier}` : ''}`, text);
}

function pickCard(tournamentId, match, roundIndex) {
  const current = live?.matchId === match.id;
  const card = el('button', 'sb-pick-card');
  card.type = 'button';
  card.dataset.match = match.id;
  card.setAttribute('aria-pressed', String(current));
  if (current) card.classList.add('is-current');
  if (match.confirmed) card.classList.add('is-done');

  const names = el('span', 'sb-pick-names');
  names.append(
    el('span', 'sb-pick-name', match.player1Id ? getEntrantName(tournamentId, match.player1Id) : 'TBD'),
    el('span', 'sb-pick-vs', 'vs'),
    el('span', 'sb-pick-name', match.player2Id ? getEntrantName(tournamentId, match.player2Id) : 'TBD'),
  );

  const tags = el('span', 'sb-pick-tags');
  if (current) tags.appendChild(tag(live.rev > 0 ? '配信中' : '配信中（自動）', 'onair'));
  if (isStreamed(tournamentId, roundIndex, match.id)) tags.appendChild(tag('配信台', 'stream'));
  if (match.isThirdPlace) tags.appendChild(tag('3位決定戦'));
  if (match.confirmed) tags.appendChild(tag(`確定 ${match.score ?? ''}`.trim(), 'done'));

  card.append(names, tags);
  return card;
}

function fillPicker(pickUi, tournamentId, bracket, currentMatch) {
  pickUi.list.innerHTML = '';

  bracket.rounds.forEach((round, roundIndex) => {
    const matches = round.matches.filter((m) => !m.isBye
      // 確定した対戦は既定では隠す ── 大会が進むほど一覧の大半が終わった対戦に
      // なって、次に出す対戦が探しにくくなる。いま出している対戦だけは例外
      && (showDone || !m.confirmed || m.id === live?.matchId));
    if (matches.length === 0) return;

    const group = el('section', 'sb-pick-round');
    group.appendChild(el('h2', 'sb-pick-round-name', roundLabelOf(null, round)));
    const cards = el('div', 'sb-pick-cards');
    for (const m of matches) cards.appendChild(pickCard(tournamentId, m, roundIndex));
    group.appendChild(cards);
    pickUi.list.appendChild(group);
  });

  if (!pickUi.list.firstChild) {
    pickUi.list.appendChild(el('p', 'sb-pick-empty',
      '出せる対戦が残っていません。「終わった対戦も表示」で確定済みの対戦も選べます。'));
  }

  // 出している対戦の結果が入ったら、次を選ぶよう促す。映像のほうは確定した
  // 最終スコアのまま残る（リザルトとして見せられる）ので、自動では切り替えない
  // ── 配信の切り替えどきを決めるのは配信卓の人。
  if (!currentMatch) {
    pickUi.note.hidden = false;
    pickUi.note.textContent = '出していた対戦が対戦表から無くなりました（組み直された可能性があります）。下から選び直してください。';
  } else if (currentMatch.confirmed) {
    pickUi.note.hidden = false;
    pickUi.note.textContent = 'いま出している対戦は結果が確定しました。次の対戦を下から選んでください。';
  } else {
    pickUi.note.hidden = true;
  }
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
    '幅1920×高さ360が目安。このURLは大会ごとに1本で、対戦が変わっても貼り替える必要はありません'
    + '（出す対戦は上の一覧で選びます）。この操作画面のURLではなく、上のURLを貼ってください。');

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

// 出場枠のIDと、対戦表に出しているシード番号
function seedOf(tournament, entrantId) {
  const i = tournament.entrantIds?.indexOf(entrantId) ?? -1;
  return i >= 0 ? (tournament.entrantSeeds?.[i] ?? null) : null;
}

// いま出している対戦を、手元にあるデータで描き直す。
//
// 呼ばれるのは3つの場面 ── Realtime でデータが動いたとき（render から）、
// 操作画面で対戦を選び直したとき、向こうの画面から別の対戦が届いたとき。
// どれも「live.matchId の対戦をいまのデータで描く」で済むので、1か所にまとめる。
function refresh() {
  if (!ui || !live) return;
  const tournament = findTournament(live.tournamentId);
  const bracket = state.brackets[live.tournamentId];
  if (!tournament || !bracket) return;

  const found = live.matchId ? findMatch(bracket, live.matchId) : null;

  if (ui.picker) {
    fillPicker(ui.picker, live.tournamentId, bracket, found?.match ?? null);
  }

  // 選ばれた対戦がまだ手元に無い（向こうの画面のほうが先にデータを持っている、
  // 対戦表が組み直された、など）。表示専用は描いてあるボードをそのまま残す
  // ── 名前を空にするより、1つ前の対戦が数秒残るほうが中継の画としてはまし。
  if (!found) return;
  const { match, round } = found;

  // まだ誰も触っていないうちは、確定済みの最終スコアに追従する
  // （試合が終わったあとのリザルト表示に、そのまま使えるようにするため）
  if (!live.touched) {
    const fromDb = confirmedCount(match);
    if (fromDb) { live.a = fromDb.a; live.b = fromDb.b; }
  }

  const [p1, p2] = live.swapped
    ? [match.player2Id, match.player1Id]
    : [match.player1Id, match.player2Id];
  fillSide(ui.board.left, live.tournamentId, p1, seedOf(tournament, p1));
  fillSide(ui.board.right, live.tournamentId, p2, seedOf(tournament, p2));
  fillCore(ui.board.core, tournament);
  ui.board.core.round.textContent = roundLabelOf(match, round);

  if (ui.controls) {
    ui.controls.left.nameEl.textContent = p1 ? getEntrantName(live.tournamentId, p1) : 'TBD';
    ui.controls.right.nameEl.textContent = p2 ? getEntrantName(live.tournamentId, p2) : 'TBD';
  }

  // 操作画面の見出し。ボードの見本とは別に、字でも何を操作しているかを出す
  if (ui.head) {
    ui.head.meta.textContent = [tournament.name, roundLabelOf(match, round)]
      .filter(Boolean).join('　｜　');
  }

  paint();
  fitNames(ui.board.left.name, ui.board.right.name);
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
// テーブルは作らない。配信中しか意味を持たない値なので、Realtime の
// ブロードキャスト（DBを経由しない一時的な通知）だけで足りる。
//
// チャンネルは大会に1本。流すのは「いま出している対戦ID＋その対戦のカウント」
// を丸ごと1組 ── 対戦の切り替えもカウントの増減も同じ1通で済み、届く順が
// 前後しても rev の大きいほうを取るだけで食い違わない。
//
// 【どちらの画面も答える】あとから開いたほうは状態を知らないので、つながった
// 時点で hello を投げ、状態を持っている側（rev が 0 でない側）が答える。
// 答えるのは操作画面だけではない ── OBSは大会のあいだ開きっぱなしなので、
// 操作用のブラウザを閉じて開き直したとき（別のPCに移ったときも）、いま映っている
// 対戦とカウントをOBSの側から受け取れる。操作画面が古い控えを持っていても、
// rev で比べて新しいほうが残る。
// ---------------------------------------------------------------------------

function connect(tournamentId) {
  disconnect();

  channel = supabase.channel(`scoreboard:${tournamentId}`, {
    config: { broadcast: { self: false } },
  });

  channel.on('broadcast', { event: 'state' }, ({ payload }) => receive(payload));

  // 後から開いた画面からの「いまどうなってる？」
  channel.on('broadcast', { event: 'hello' }, () => {
    if (live?.rev > 0) broadcast();
  });

  channel.subscribe((status) => {
    if (status !== 'SUBSCRIBED') return;
    channel.send({ type: 'broadcast', event: 'hello', payload: {} });
    // 手元に控えがあれば、こちらからも1度出しておく。向こうのほうが新しければ
    // 向こうが捨てるだけ（そして hello への答えでこちらが新しいほうに揃う）。
    if (live?.rev > 0) broadcast();
  });
}

function disconnect() {
  if (!channel) return;
  supabase.removeChannel(channel);
  channel = null;
}

function broadcast() {
  if (!channel || !live || live.rev === 0) return;
  channel.send({
    type: 'broadcast',
    event: 'state',
    payload: {
      matchId: live.matchId,
      a: live.a,
      b: live.b,
      swapped: live.swapped,
      touched: live.touched,
      rev: live.rev,
    },
  });
}

function receive(payload) {
  if (!live || !payload || typeof payload.matchId !== 'string') return;
  // rev は送るたびに増える通し番号。行き違いで古い値が後から届いても、
  // 新しいほうを巻き戻さない（±を連打したときに起きる）。
  if (typeof payload.rev !== 'number' || payload.rev <= live.rev) return;

  const sameMatch = payload.matchId === live.matchId;
  // 跳ねさせるかどうかは「画面の左右」で比べる。a / b は対戦表の上下
  // （player1 / player2）なので、左右を入れ替えているときは向きが逆になる。
  const [beforeL, beforeR] = live.swapped ? [live.b, live.a] : [live.a, live.b];

  live.matchId = payload.matchId;
  live.a = Number(payload.a) || 0;
  live.b = Number(payload.b) || 0;
  live.swapped = Boolean(payload.swapped);
  live.touched = payload.touched !== false;
  live.rev = payload.rev;
  save();

  // 【入れ替えも対戦の切り替えも、名前とアイコンまで動く】refresh が丸ごと描き直す。
  // ここで数字だけを塗ると、向こうで S を押したとき名前は元のまま残って、
  // 誰が何点なのかが逆に見える。
  refresh();

  if (!sameMatch) return;
  const [afterL, afterR] = live.swapped ? [live.b, live.a] : [live.a, live.b];
  if (afterL > beforeL || afterR > beforeR) {
    // refresh の paint で数字はもう入っているので、跳ねだけを足す
    const bumpOnce = (node) => {
      node.classList.remove('is-bumped');
      requestAnimationFrame(() => node.classList.add('is-bumped'));
    };
    if (afterL > beforeL) bumpOnce(ui.board.left.score);
    if (afterR > beforeR) bumpOnce(ui.board.right.score);
  }
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

// 変更を確定させて向こうへ送る。操作はどれも最後にこれを通す
function commit() {
  live.rev = nextRev();
  save();
  broadcast();
}

function bump(side, delta) {
  if (!live?.matchId) return;
  // 表示上の左右と、対戦表の上下（player1 / player2）は入れ替えられる。
  // 押した側は「見えている側」なので、入れ替え中はここで読み替える
  const key = (side === 'left') === !live.swapped ? 'a' : 'b';
  const next = Math.max(0, Math.min(99, live[key] + delta));
  if (next === live[key]) return;

  live[key] = next;
  live.touched = true;
  paint({ bumpLeft: side === 'left' && delta > 0, bumpRight: side === 'right' && delta > 0 });
  commit();
}

function resetCount() {
  if (!live?.matchId) return;
  live.a = 0;
  live.b = 0;
  live.touched = true;
  paint();
  commit();
}

function swapSides() {
  if (!live?.matchId) return;
  live.swapped = !live.swapped;
  live.touched = true;
  // 名前・アイコンごと入れ替わるので、丸ごと描き直す
  refresh();
  commit();
}

// 一覧で対戦を選んだとき。カウントはその対戦の控えから始める
// （一度出して戻ってきた対戦なら、そのときの数字が戻る）。
function selectMatch(matchId) {
  if (!live) return;
  const bracket = state.brackets[live.tournamentId];
  const found = bracket ? findMatch(bracket, matchId) : null;
  if (!found) return;
  // 同じ対戦を押し直しただけ。自動で選ばれている対戦を押したときだけは、
  // 「これに決めた」として送る（そこから先は自動で動かなくなる）
  if (live.matchId === matchId && live.rev > 0) return;

  live.matchId = matchId;
  Object.assign(live, countFor(live.tournamentId, found.match));
  refresh();
  commit();
}

function toggleDone(checked) {
  showDone = checked;
  refresh();
}

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
function obsUrlFor(tournamentId) {
  return new URL(pathFor('scoreboard', tournamentId), location.origin).href;
}

// OBS用（表示専用）。/tournaments/{大会ID}/scoreboard/
export function renderScoreboardPage(tournamentId) {
  return render(tournamentId, MODE_VIEW);
}

// 配信卓の操作画面。/tournaments/{大会ID}/scoreboard/control/
export function renderScoreboardControlPage(tournamentId) {
  return render(tournamentId, MODE_CONTROL);
}

// 大会を開いた直後の状態。控えがあればその対戦とカウントから、無ければ自動
// （rev 0）で始める。自動のときの対戦は render が毎回選び直す。
function initialLive(tournamentId, bracket) {
  const selection = loadSelection(tournamentId);
  const found = selection ? findMatch(bracket, selection.matchId) : null;
  if (!found) {
    return { tournamentId, matchId: null, a: 0, b: 0, swapped: false, touched: false, rev: 0 };
  }
  return {
    tournamentId,
    matchId: found.match.id,
    ...countFor(tournamentId, found.match),
    rev: selection.rev,
  };
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
      + '<p>スコアボードは対戦表の対戦カードを映します。募集を締め切って対戦表を組むと使えるようになります。</p>'
      + `<p><a href="${pathFor('tournament', tournamentId)}">大会の詳細へ</a></p>`);
    return;
  }

  // 同じ大会を描き直しているだけなら、組み立て直さない。
  // この関数は Realtime の更新のたびに呼ばれるので、ここで作り直すと
  // 誰かがチャットを送るたびにスコアボードが跳ねることになる。
  if (!live || live.tournamentId !== tournamentId) {
    closeScoreboard();
    document.body.classList.add('scoreboard-only');
    if (mode === MODE_CONTROL) document.body.classList.add('sb-control-mode');

    live = initialLive(tournamentId, bracket);

    const board = buildBoard();
    host.innerHTML = '';

    if (mode === MODE_CONTROL) {
      const head = buildHead(tournamentId);
      const controls = buildControls(bump, resetCount, swapSides);
      const picker = buildPicker(selectMatch, toggleDone);
      const obs = buildObsUrl();
      obs.url.value = obsUrlFor(tournamentId);
      obs.open.href = obs.url.value;

      const panel = el('div', 'sb-panel');
      panel.append(head.root, buildPreview(board.viewport), controls.root, picker.root, obs.root);
      host.appendChild(panel);
      ui = { board, controls, head, picker };

      window.addEventListener('keydown', onKeyDown);
      teardown.push(() => window.removeEventListener('keydown', onKeyDown));
    } else {
      host.appendChild(board.viewport);
      ui = { board, controls: null, head: null, picker: null };
    }

    connect(tournamentId);

    window.addEventListener('resize', applyScale);
    teardown.push(() => window.removeEventListener('resize', applyScale));
  }

  // まだ誰も選んでいなければ、そのときのデータで出す対戦を選び直す
  // （回戦が進めば、自動で次の対戦へ移っていく）
  if (live.rev === 0) {
    const auto = defaultMatch(tournamentId, bracket);
    if (auto && auto.match.id !== live.matchId) {
      live.matchId = auto.match.id;
      Object.assign(live, countFor(tournamentId, auto.match));
    }
  }

  if (!live.matchId) {
    fail(tournamentId, '<h2>出せる対戦がありません</h2>'
      + '<p>この大会の対戦表に、表示できる対戦カードが見つかりませんでした。</p>'
      + `<p><a href="${pathFor('bracket', tournamentId)}">対戦表へ</a></p>`);
    return;
  }

  // ここまで来られたので、組み直しの待ちは畳む
  clearRetry();

  refresh();
  applyScale();
  // 文字の大きさと見本の枠の幅は、画面に入ってからでないと測れない。
  // 組み立てた直後のこの1回だけは、枠の幅がまだ 0 のまま測れていることがある
  // （上の refresh の中でも呼んでいるが、そちらは器を足す前に走りうる）。
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
  ui = null;
  live = null;
  const host = root();
  if (host) host.innerHTML = '';
}

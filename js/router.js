// URLとページの対応を決める場所。
//
// 【なぜハッシュをやめたか】
//   以前は #tournament/{id} のようにハッシュでページを切り替えていた。ハッシュは
//   ブラウザの中だけのもので、サーバーには送られない ── つまり検索エンジンにも
//   XやDiscordのプレビューにも「どのページか」が一切届かず、どのURLを見せても
//   同じトップページ扱いになる。大会ごとの共有だけは /t/{id} という別のURLを
//   用意して逃げていたが（いまは301の受け皿）、それ以外のページには手が無かった。
//
//   そこで、画面ごとに本物のパスを持たせる。/tournaments/{id}/ を開けば
//   サーバーにもそのURLが届くので、ページごとの title や og: を返せるようになる。
//
// 【このファイルの役目】
//   URLとページ名の変換だけを引き受ける。画面を描くのは js/app.js の仕事で、
//   ここは「どのURLがどのページか」「そのページのURLはどう組み立てるか」しか知らない。
//   ブラウザの機能（location・history・document）に触るのは関数の中だけにしてある ──
//   worker/index.js がこのファイルを読み込んで同じ対応表を使うため、
//   読み込んだだけで window を探しにいくと Cloudflare 側で落ちる。

// 大会一覧のタブ。URLでは /tournaments/?tab=running のようにクエリで持つ。
//
// タブは「並べ替えの条件」であってページではないので、パスに含めない。
// 戻るボタンで1タブずつ巻き戻るのも煩わしいので、押したときは履歴を積まずに
// 差し替える（index.html のタブに付けてある data-nav-replace がその指示）。
export const TOURNAMENT_TABS = ['recruiting', 'running', 'finished'];

// ページ名 → URLの形。:id はそのページが受け取る値（大会ID・選手ID・お知らせID）。
// ページ名は js/app.js の VIEW_IDS の見出しと同じものを使う。
//
// 【並び順に意味がある】上から順に照合するので、値を受ける形（/tournaments/:id/）より
// 先に決め打ちの形（/tournaments/new/）を置くこと。逆にすると "new" が大会IDとして
// 読まれ、大会作成ページへ二度と辿り着けなくなる。
//
// 【末尾のスラッシュは必ず付ける】これが正規の形で、付いていないURLは
// worker/index.js が301で付け直す。canonical との食い違いを作らないため、
// ここを崩さないこと。
export const ROUTES = [
  ['home', '/'],
  ['guide', '/guide/'],
  ['setup', '/setup/'],
  // お知らせは一覧と詳細で別のページ名にしてある（以前は #news の param 有無で
  // 分けていたが、URLの形が違うのだから名前も分けたほうが読みやすい）。
  ['newslist', '/news/'],
  ['news', '/news/:id/'],
  ['tournaments', '/tournaments/'],
  ['create', '/tournaments/new/'],
  ['tournament', '/tournaments/:id/'],
  // 対戦表と出場選手一覧は、その大会の下に置く。単独では意味を持たないページなので、
  // URLでも大会の一部だと分かる形にしておく。
  ['bracket', '/tournaments/:id/bracket/'],
  ['entrants', '/tournaments/:id/entrants/'],
  // 配信用スコアボード。OBSのブラウザソースにURLを直接貼って使う画面で、
  // ヘッダーもナビも背景も出さず、スコアボードの絵だけを描く。
  // どの対戦を出すかは ?match={対戦ID}（対戦表のカードから開くと付いてくる）。
  ['scoreboard', '/tournaments/:id/scoreboard/'],
  ['players', '/players/'],
  ['player', '/players/:id/'],
  ['entries', '/entries/'],
  ['profile', '/profile/'],
  ['reveal', '/reveal/'],
  // 届いている通報（運営専用）。以前は選手ページの中に混ぜていたが、
  // あそこは「選手を探す」場所で、通報の裁きはその用事ではない。
  ['reports', '/reports/'],
  ['terms', '/terms/'],
  ['privacy', '/privacy/'],
];

// ページ名 → その画面を入れてある <section> のID。
//
// ここに置いてあるのは、ブラウザ（js/app.js）と Cloudflare（worker/index.js）の
// 両方が要るため。あちらは「返すHTMLの時点でどの画面を出しておくか」を決めるのに使う ──
// 全部 hidden のまま返すと、JSが動き出すまで何も描かれず、そのあいだ画面が空になる。
export const VIEW_ID_OF = {
  home: 'view-home',
  guide: 'view-guide', // はじめに（静的ページ。描画関数は持たない）
  setup: 'view-setup', // 対戦環境を整える（静的ページ。描画関数は持たない）
  // /news/ がお知らせ一覧、/news/{id}/ が詳細。URLの形が違うのでページ名も分けてある
  news: 'view-news',
  newslist: 'view-news-list',
  // 大会一覧。募集中・進行中・終了はページ内タブ（/tournaments/?tab={タブ名}）
  tournaments: 'view-tournaments',
  // 自分がエントリー・出場した大会のまとめ
  entries: 'view-entries',
  // create=大会作成（運営）、tournament=大会詳細、bracket=対戦表。
  // 詳細と対戦表は別ページに分けてある。
  create: 'view-tournament',
  tournament: 'view-tournament-detail',
  bracket: 'view-bracket',
  // 出場選手一覧。詳細・対戦表と同じく大会ごとのページ
  entrants: 'view-entrants',
  // 配信用スコアボード（js/scoreboard.js）。他のページと違い、この画面が出ている
  // あいだは body に .scoreboard-only が付いて、サイトの装い一式が消える。
  scoreboard: 'view-scoreboard',
  player: 'view-player-detail',
  // 選手を探すページ。ランキングの表を置いていた頃の #ranking から来た人も、
  // pathFromLegacyHash が読み替えてここへ着く。
  players: 'view-players',
  // 順位発表（運営専用）。ランキングの表とは見せ方も操作もまるで違うので、
  // 同じページのモードにせず別のページにしてある（js/reveal.js）。
  reveal: 'view-reveal',
  // 届いている通報（運営専用）。選手・大会どちらへの通報もここに集める。
  reports: 'view-reports',
  profile: 'view-profile',
  // 規約類（静的ページ。フッターから開く。描画関数は持たない）
  terms: 'view-terms',
  privacy: 'view-privacy',
};

// パスを「/」で切って空を捨てる。前後のスラッシュの有無を気にせず比べられるようにする。
function segments(path) {
  return path.split('/').filter(Boolean);
}

// %が単独で入っているURLでは decodeURIComponent が例外を投げる。そこで止まる理由は
// 無いので、戻せなければ元の文字列のまま渡す（どのみち存在しないIDとして扱われる）。
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// パス → { page, param }。どの形にも当たらなければ null。
//
// 呼ぶ側で「知らないURLかどうか」を区別できるよう、当たらなかったときに
// ホームへ倒したりはしない（倒すかどうかは呼ぶ側が決める）。
export function matchPath(pathname) {
  const parts = segments(pathname);

  for (const [page, pattern] of ROUTES) {
    const want = segments(pattern);
    if (want.length !== parts.length) continue;

    let param = null;
    let ok = true;
    for (let i = 0; i < want.length; i += 1) {
      if (want[i] === ':id') {
        if (!parts[i]) { ok = false; break; }
        param = parts[i];
      } else if (want[i] !== parts[i]) {
        ok = false;
        break;
      }
    }

    if (ok) return { page, param: param == null ? null : safeDecode(param) };
  }

  return null;
}

// ページ名 → URL。href に入れる文字列を作るのはすべてここを通す。
// query は { tab: 'running' } のような形で渡す（省略可）。
export function pathFor(page, param = null, query = null) {
  const entry = ROUTES.find(([name]) => name === page);
  // 知らないページ名はホームに倒す。href が空文字になると、リンクが
  // 「いまのURL」を指してしまい、押しても何も起きないように見える。
  if (!entry) return '/';

  const path = entry[1].replace(':id', encodeURIComponent(param ?? ''));
  const search = query ? String(new URLSearchParams(query)) : '';
  return search ? `${path}?${search}` : path;
}

// 旧URL（ハッシュ）から新しいパスへの読み替え。
//
// ハッシュはサーバーに送られないので、サーバー側で301を返すことはできない。
// SNSやDMに残っている古いリンクで着地した人は、index.html が読み込まれてから
// このブラウザの中で新しいURLへ書き換えるしかない（migrateLegacyUrl）。
//
// 統合前の旧ページ（#recruit・#history）と、ランキングの表を置いていた頃の
// #ranking も、ハッシュだった頃と同じ行き先へ通す。
export function pathFromLegacyHash(hash) {
  const h = String(hash || '').replace(/^#/, '');
  if (!h) return null;

  const [name, rawParam] = h.split('/');
  const param = rawParam ? safeDecode(rawParam) : null;

  switch (name) {
    case 'home': return pathFor('home');
    case 'guide': return pathFor('guide');
    case 'setup': return pathFor('setup');
    case 'news': return param ? pathFor('news', param) : pathFor('newslist');
    case 'tournaments':
      return TOURNAMENT_TABS.includes(param)
        ? pathFor('tournaments', null, { tab: param })
        : pathFor('tournaments');
    // ページ統合前の旧URL
    case 'recruit': return pathFor('tournaments', null, { tab: 'recruiting' });
    case 'history': return pathFor('tournaments', null, { tab: 'finished' });
    case 'create': return pathFor('create');
    // パラメータを失っている（手で削られた等）ときは、その種類の一覧へ通す。
    // 存在しないIDのページを開かせるより、選び直せる場所に着けたほうがよい。
    case 'tournament': return param ? pathFor('tournament', param) : pathFor('tournaments');
    case 'bracket': return param ? pathFor('bracket', param) : pathFor('tournaments');
    case 'entrants': return param ? pathFor('entrants', param) : pathFor('tournaments');
    case 'player': return param ? pathFor('player', param) : pathFor('players');
    // ランキングの表を置いていた頃のリンク・ブックマークも選手のページへ
    case 'players':
    case 'ranking': return pathFor('players');
    case 'entries': return pathFor('entries');
    case 'profile': return pathFor('profile');
    case 'reveal': return pathFor('reveal');
    case 'terms': return pathFor('terms');
    case 'privacy': return pathFor('privacy');
    // #login はページではなくログインダイアログを開くための入口だった。
    // クエリに移して、開いた先で js/app.js が拾う。
    case 'login': return `${pathFor('home')}?login=1`;
    default: return null;
  }
}

// 読み込み直後に1回だけ呼ぶ。ハッシュ付きのURLで着地していたら新しいパスへ書き換える。
//
// replaceState を使うのは履歴を残さないため。push すると、着地した人が「戻る」を
// 押した瞬間に古いハッシュへ帰り、また前へ飛ばされて元のページから出られなくなる。
export function migrateLegacyUrl() {
  if (!location.hash) return;

  const path = pathFromLegacyHash(location.hash);
  // 知らないハッシュ（#見出し のようなページ内の目印かもしれない）は触らない
  if (!path) return;

  const url = new URL(path, location.origin);

  // いま付いているクエリは落とさない。ログインから戻ってきた直後のURLには
  // ?code=... が付いていて、これを消すと supabase-js がセッションを確立できず、
  // ログインしたはずなのにログアウト状態のまま画面が出る。
  new URLSearchParams(location.search).forEach((value, key) => {
    if (!url.searchParams.has(key)) url.searchParams.set(key, value);
  });

  history.replaceState(null, '', url.pathname + url.search);
}

// 画面を描き直したい、とアプリへ伝えるための窓口。startRouter で受け取る。
let routeHandler = null;

// URLが実際に変わったときだけ window に飛ばすイベント。名前はかつての hashchange の
// 代わりで、用途も同じ ── 「画面が変わったのだから畳んでおきたいもの」（メニューや
// 操作パネル）が拾う。
//
// 描き直し（routeHandler）と分けてあるのは、描き直しが Realtime の更新でも走るため。
// あちらに畳む処理を混ぜると、誰かが試合結果を入力するたびに、開いたばかりの
// メニューが勝手に閉じることになる。
export const ROUTE_CHANGE_EVENT = 'route-change';

function emit({ urlChanged }) {
  if (urlChanged) window.dispatchEvent(new Event(ROUTE_CHANGE_EVENT));
  routeHandler?.();
}

// URLを変えて画面を描き直す。ページの移動はすべてここを通る。
//
// replace を立てると履歴を積まずに差し替える。絞り込みの条件（大会一覧のタブ）は
// こちらを使う ── 積んでしまうと、戻るボタンがタブの切り替えを1回ずつ巻き戻し、
// 前のページへ帰るのに何度も押させることになる。
export function go(path, { replace = false } = {}) {
  const target = new URL(path, location.origin);
  const next = target.pathname + target.search;

  // 同じURLへの移動。履歴は動かさず、描き直しだけ行う。
  // （押したのが「いま開いているページ」へのリンクでも、内容が古くなっている
  //   ことはあるので、何も起きないより描き直したほうがよい）
  if (next === location.pathname + location.search) {
    emit({ urlChanged: false });
    return;
  }

  if (replace) history.replaceState(null, '', next);
  else history.pushState(null, '', next);

  emit({ urlChanged: true });
}

// ページ名を指定して移動する。go() の言い換えで、呼ぶ側がURLの形を知らずに済む。
export function navigate(page, param = null, { replace = false, query = null } = {}) {
  go(pathFor(page, param, query), { replace });
}

// ルーティングを動かし始める。onRoute には、いまのURLに合わせて画面を描く関数を渡す。
export function startRouter(onRoute) {
  routeHandler = onRoute;

  // スクロール位置はこちらで決める。既定（auto）のままだと、戻るボタンのときだけ
  // ブラウザが前の位置へ戻そうとして、描画後に位置を決める onRoute とぶつかる
  // （中身を入れ替える前の高さで戻されるので、狙った場所には着かない）。
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  // 戻る・進む。pushState を自分で呼んだときには発火しないので、
  // go() の側でも emit() している ── 両方の経路が同じ onRoute に集まる。
  window.addEventListener('popstate', () => emit({ urlChanged: true }));

  // サイト内のリンクを横取りして、ページを読み直さずに切り替える。
  //
  // document で受けるのは、大会カードやお知らせカードのように後から作られる
  // リンクにも効かせるため。1つずつ addEventListener して回ると、描き直すたびに
  // 付け直しが要る。
  document.addEventListener('click', (e) => {
    // 他の処理が既に引き取ったもの（「はじめに」の目次など）には手を出さない
    if (e.defaultPrevented) return;
    // 左クリック以外と、修飾キー付き（別タブ・別窓・保存）はブラウザに任せる
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    const a = e.target.closest?.('a[href]');
    if (!a) return;
    if (a.hasAttribute('download')) return;
    // target は属性から読む。SVGの中の <a> では a.target が文字列ではなく
    // SVGAnimatedString になり、比べると必ず「別窓」と判定されてしまう。
    const target = a.getAttribute('target');
    if (target && target !== '_self') return;

    const href = a.getAttribute('href');
    // ページ内の目印（#見出し）・mailto: ・tel: はページの移動ではない
    if (!href || href.startsWith('#')) return;

    let url;
    try { url = new URL(href, location.href); } catch { return; }

    // 外部サイトへのリンクはそのまま飛ばす
    if (url.origin !== location.origin) return;
    // 拡張子が付いているものはファイルへの直リンク（画像・PDFなど）
    if (/\.[a-z0-9]+$/i.test(url.pathname)) return;
    // 知らないURLはブラウザに任せる。ここで握り潰すと、SPAが扱えないURLへの
    // リンクを押しても何も起きない画面になる（サーバーに聞けば404が返るので、
    // そちらのほうが起きたことが分かる）。
    if (!matchPath(url.pathname)) return;

    e.preventDefault();
    go(url.pathname + url.search, { replace: a.hasAttribute('data-nav-replace') });
  });
}

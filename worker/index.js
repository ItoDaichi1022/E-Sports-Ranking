// このサイトのURLをサーバー側で受け持つ Worker。仕事は3つある。
//
// 【1. アプリのページを配る（SPAフォールバック）】
//   画面はハッシュ（#tournament/xxx）ではなくパス（/tournaments/xxx/）で切り替える。
//   パスはサーバーに届くので、そのURLに対して何かを返さなければならない ── ところが
//   このサイトに実在するHTMLは index.html 1本きりで、/tournaments/xxx/ という
//   ファイルはどこにも無い。何もしなければ、直リンクもリロードも全部404になる。
//
//   そこで、js/router.js が知っているURLの形に当たったら index.html を返す。
//   あとはブラウザの中で js/app.js がそのURLを読んで、該当のページを描く。
//   知らない形のURLは、これまでどおり404のまま（存在しないページを200で返すと、
//   検索エンジンに「中身のあるページ」として拾われてしまう）。
//
// 【2. そのページの title と og: を埋め込んで返す】
//   XやDiscordがリンクの中身を見に来るとき、向こうはJSを動かさない。素の index.html を
//   そのまま返すと、どの大会のURLを貼っても同じ ── サイト共通の ── プレビューになる。
//   検索エンジンも、JSを動かす前のHTMLを最初に読む。
//
//   そこで、返す直前に HTMLRewriter で <head> の meta だけを差し替える。文言を作るのは
//   ブラウザ側と同じ js/seo.js で、ここは「どのデータを渡すか」しか持たない。
//   HTMLの本体（SPA）には一切手を入れない。
//
//   【UA（User-Agent）は見ない】クローラーにだけ違うHTMLを返す作りにはしていない。
//   誰が来ても同じものを返す ── 出し分けはクローキングと判定される危険があるうえ、
//   判定を外した相手（新しいSNS、検索エンジンの別のクローラー）に何も届かなくなる。
//   確認するときは `curl -A "Twitterbot/1.0" <URL>` と UA 無しの結果を見比べること。
//   食い違っていたら、それはこのファイルの不具合。
//
// 【3. 古い共有リンク（/t/{大会ID}）を新しいURLへ送る】
//   og: を大会ごとに返す口が /t/{id} しか無かった頃の名残。いまは本来のURL
//   （/tournaments/{id}/）が同じものを返せるので、301で送るだけの受け皿にしてある。
//   SNSやDMに残っている古いリンクは、301を辿った先で正しいプレビューになる。
//
// 【ここに来るリクエスト】
//   静的アセット（css/・js/・img/ …）は Cloudflare がこのWorkerより先に返す。
//   例外は「/」だけで、こちらはトップページにも og: と構造化データを入れたいので、
//   wrangler.jsonc の assets.run_worker_first で先にこのWorkerへ回している。
//
// 【動作確認】
//   npx wrangler dev  → http://localhost:8787/tournaments/
//   静的ファイルをそのまま開く方式（file:// や素のhttpサーバー）ではWorkerが
//   動かないので、トップ以外のURLは404になる。これはデプロイ先でだけ効く機能。

// URLとページの対応表も、meta の文言も、ブラウザ側と同じものを読む。
// 写しを置くと、ページを1つ足したときに「アプリは知っているのにサーバーが404を返す」
// 「画面の題と検索結果の題が違う」というかたちで必ずずれる。
// どちらも読み込んだだけでは window に触らないので、Cloudflare 上でも動く。
import { matchPath, pathFor } from '../js/router.js';
import { buildPageMeta } from '../js/seo.js';

// 古い共有リンクの入口。中身は /tournaments/{id}/ に移した。
const SHARE_PREFIX = '/t/';

// 大会ID・お知らせID・選手IDはどれもUUID（supabase/schema.sql）。形が違うものは
// DBに問い合わせるまでもなく無いので、ここで弾く。
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 拡張子が付いているURL＝ファイルへの直リンク。ここまで来たということは、そのファイルが
// 実在しなかったということなので、index.html を返さずに404のままにする
// （/js/typo.js を index.html で応えると、ブラウザはHTMLをJSとして読んで落ちる）。
const LOOKS_LIKE_FILE = /\.[a-z0-9]+$/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 古い共有リンクは本来のURLへ送るだけ。IDの形が違っても大会ページへ通す
    // （そこで「大会が見つかりません」が出る。ここで別の文言を持つ必要はない）。
    if (url.pathname.startsWith(SHARE_PREFIX)) {
      const id = safeDecode(url.pathname.slice(SHARE_PREFIX.length).replace(/\/+$/, ''));
      return Response.redirect(`${url.origin}${pathFor('tournament', id)}`, 301);
    }

    // 実在するファイルは Cloudflare がこのWorkerより先に返している。ここへ来る
    // 拡張子付きのURLは、綴り違いか消したファイル。
    if (LOOKS_LIKE_FILE.test(url.pathname)) return env.ASSETS.fetch(request);

    // 末尾スラッシュありを正とする。無いものは301で付け直す。
    //
    // 2つのURLで同じページが出る状態にしないため。放っておくと、検索エンジンからは
    // 別々のページに見え、canonical（/tournaments/xxx/）と実際に開かれたURL
    // （/tournaments/xxx）が食い違う。
    if (!url.pathname.endsWith('/') && matchPath(`${url.pathname}/`)) {
      return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
    }

    const route = matchPath(url.pathname);
    // 知らないURL。存在しないページを200で返すと検索エンジンに拾われるので、
    // これまでどおり静的アセット側の404に任せる。
    if (!route) return env.ASSETS.fetch(request);

    return appShell(request, env, url, route);
  },
};

// %が単独で入っているURLでは decodeURIComponent が例外を投げる。
// そこで止まる理由は無いので、戻せなければ元の文字列のまま先へ渡す。
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// ---- アプリのページ ----

// index.html を取ってきて、<head> の meta だけを差し替えて返す。
// 本体（SPA）には触らない ── ここが太ると、画面の作りとサーバーの都合が絡み始める。
async function appShell(request, env, url, route) {
  // 条件付きリクエスト（If-None-Match など）はそのまま渡さない。渡すと 304 が
  // 返ってきて本文が無くなるが、こちらは中身のある200を返したい。
  const method = request.method === 'HEAD' ? 'HEAD' : 'GET';
  const shell = await env.ASSETS.fetch(new Request(`${url.origin}/index.html`, { method }));

  const data = await pageData(env, route);
  const meta = buildPageMeta(route.page, { param: route.param, ...data }, url.origin);

  const headers = new Headers(shell.headers);
  // Cache-Control を上書きするのは、_headers に書いた「/ と /index.html は毎回聞き直す」
  // が、Worker が組み立てたこの応答には効かないため（あれは静的アセットとして
  // 配られるときだけの設定）。ここで指定しないと既定の扱いになり、?v= を上げた
  // 新しい index.html が届かない端末が出る。
  headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  // 同じURLでも中身（meta）はDBの状態で変わるので、その旨を伝えておく。
  headers.delete('ETag');

  // 消えている大会やお知らせのURLは404で返す。200で返すと、検索エンジンは
  // 「中身のあるページ」として登録し続ける（ソフト404）。本文はいつもの
  // index.html なので、人が開けば「見つかりません」の画面が普通に出る。
  const status = data.notFound ? 404 : shell.status;

  return rewriteMeta(new Response(shell.body, { status, headers }), meta);
}

// そのページの meta を作るのに要るデータをDBから引く。
//
// 引きに行くのは詳細ページ（大会・お知らせ・選手）だけ。一覧や読み物ページの
// 文言は固定なので、通信を1往復増やす理由がない。
//
// 【失敗しても人の導線は止めない】DBに届かなかったときは空を返す。プレビューは
// サイト共通のものになるが、ページ自体はいつもどおり開き、ブラウザ側が読み直す。
async function pageData(env, { page, param }) {
  const needsTournament = page === 'tournament' || page === 'bracket' || page === 'entrants';
  if (!needsTournament && page !== 'news' && page !== 'player') return {};

  // IDの形が違うものは、DBに聞くまでもなく無い。
  if (!UUID.test(param ?? '')) return { notFound: true };

  try {
    if (needsTournament) {
      const row = await fetchOne(env, 'tournaments', param,
        'name,date,status,match_type,image_url,stream_url,entry_deadline,capacity,'
        + 'tournament_entries(count),tournament_teams(count)');
      if (!row) return { notFound: true };
      return { tournament: toTournament(row), entrantsText: entrantsTextOf(row) };
    }

    if (page === 'news') {
      const row = await fetchOne(env, 'announcements', param,
        'title,body,image_url,created_at,updated_at');
      if (!row) return { notFound: true };
      return {
        announcement: {
          title: row.title,
          body: row.body,
          imageUrl: row.image_url,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
      };
    }

    // 選手。順位（「公開ランキング7位」）はここでは付けない ── 順位表は
    // published_rankings に丸ごとJSONで入っていて、1人分を引くために全体を
    // 取ることになる。ブラウザ側は手元に持っているので、読み込んだ時点で足される。
    const row = await fetchOne(env, 'players', param, 'display_name,past_names');
    if (!row) return { notFound: true };
    return { player: { currentName: row.display_name, pastNames: row.past_names ?? [] } };
  } catch (err) {
    console.error('[meta] データの取得に失敗', err);
    return {};
  }
}

// 1行だけ引く。anonキーで読める範囲しか返らない ── これがそのまま公開範囲の境目になる。
//
// 【準備中の大会は引けない】公開前（status = 'draft'）の行はRLSが anon に返さない
// （supabase/migration-022.sql の tournaments_select）。0件＝「見つかりません」に
// なるので、共有URLを先に配られても、公開するまで大会名も画像も漏れない。
// 絞り込みをここのコードで書かないのは、書き忘れが即漏洩になるため ──
// 見えてよいかの判断はSQL側（RLS）に一本化しておく。
async function fetchOne(env, table, id, select) {
  const query = new URLSearchParams({ id: `eq.${id}`, select, limit: '1' });

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      Accept: 'application/json',
    },
    // 同じURLへの問い合わせは1分だけ使い回す。人がページを開くたびにここで
    // 1往復待たせることになるので、連続して開かれたときの待ちを削る。
    // 大会名を直した直後は最大1分だけ古いままになるが、SNS側はプレビューを
    // それよりずっと長く抱えるので、体感としての差は出ない。
    cf: { cacheTtl: 60, cacheEverything: true },
  });

  if (!res.ok) throw new Error(`PostgREST ${res.status} ${await res.text()}`);

  const rows = await res.json();
  return rows[0] ?? null;
}

// PostgREST の生の行（snake_case）を js/seo.js が読む形（camelCase）に直す。
//
// js/db.js を通さないのは、あれが supabaseClient.js ごとブラウザの世界を
// 引きずってくるため。変換の境界を1つにするという約束からは外れるが、
// ここで扱うのは meta に出す数項目だけで、書き込みは一切しない。
function toTournament(row) {
  return {
    name: row.name,
    date: row.date,
    status: row.status,
    matchType: row.match_type,
    imageUrl: row.image_url,
    streamUrl: row.stream_url,
    entryDeadline: row.entry_deadline,
    // 定員と出場枠の数は、js/tournamentState.js が「満員かどうか」を出すのに使う。
    // 落とすと、定員に達した大会でも検索結果には「エントリー受付中」と出てしまう。
    capacity: row.capacity,
    entrantCount: entrantCountOf(row),
  };
}

// 出場枠の数。2v2ではチームを数える（人ではない）。
// js/state.js の entrantCount と同じ数え方で、あちらはDB側で数えた値を
// まとめて持っている。ここでは埋め込みカウントの生の値から同じものを作る。
function entrantCountOf(row) {
  const people = row.tournament_entries?.[0]?.count ?? 0;
  const teams = row.tournament_teams?.[0]?.count ?? 0;
  return row.match_type === '2v2' && teams > 0 ? teams : people;
}

// 「24人」「12チーム（24人）」のような参加規模。
// js/app.js の entrantCountLabel と同じ形にそろえる。
function entrantsTextOf(row) {
  const people = row.tournament_entries?.[0]?.count ?? 0;

  if (row.match_type === '2v2') {
    return `${entrantCountOf(row)}チーム（${people}人）`;
  }
  return `${people}人`;
}

// ---- <head> の差し替え ----

function escapeAttr(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// index.html に既にある行は中身だけ差し替え、無い行はここで足す。
//
// 【二重に出さないための約束】下の tags() で足すのは、index.html に「無い」ものだけ。
// 足す側と差し替える側の両方に同じ meta を書くと、1ページに2つ並んで、
// どちらが読まれるかは相手次第になる。index.html の <head> を増やしたときは、
// こちらの振り分けも見直すこと。
function rewriteMeta(response, meta) {
  const setContent = (value) => ({
    element(el) { el.setAttribute('content', value); },
  });

  return new HTMLRewriter()
    // このページの先頭に大きな絵が出ることを、HTMLの時点で知らせる印。
    // css/style.css がこれを見て、絵が届く前からその場所を空けておく
    // （空けておかないと、届いた瞬間に下の中身が丸ごと押し下げられる）。
    .on('html', {
      element(el) {
        if (meta.heroImage) el.setAttribute('class', 'has-hero');
      },
    })
    .on('title', { element(el) { el.setInnerContent(meta.title); } })
    .on('meta[name="description"]', setContent(meta.description))
    .on('meta[property="og:title"]', setContent(meta.title))
    .on('meta[property="og:description"]', setContent(meta.description))
    .on('meta[property="og:image"]', setContent(absoluteImage(meta)))
    .on('meta[property="og:type"]', setContent(meta.ogType))
    .on('meta[name="twitter:card"]', setContent(meta.twitterCard))
    .on('head', { element(el) { el.append(tags(meta), { html: true }); } })
    .transform(response);
}

// og:image は絶対URLで出す。相対パスでも多くの相手は貼られたページを基準に
// 解決してくれるが、しない相手（一部のチャットアプリ）では画像なしになる。
// 大会のバナーは Supabase の絶対URLなのでそのまま通る。
function absoluteImage(meta) {
  return meta.image.startsWith('/')
    ? new URL(meta.image, meta.canonical).href
    : meta.image;
}

// index.html に無い分。canonical・og:url・twitter:site・構造化データ、
// それに拾わせたくないページだけ robots。
function tags(meta) {
  const rows = [
    `<link rel="canonical" href="${escapeAttr(meta.canonical)}">`,
    `<meta property="og:url" content="${escapeAttr(meta.canonical)}">`,
    `<meta name="twitter:site" content="${escapeAttr(meta.twitterSite)}">`,
  ];

  if (meta.robots) rows.push(`<meta name="robots" content="${escapeAttr(meta.robots)}">`);

  // ページの先頭に出る絵を、HTMLを読んだ時点で取りに行かせる。
  //
  // これが無いと、ブラウザがこの絵の在り処を知るのは
  // 「JSを30本読む → 認証 → Supabaseに問い合わせる → src を入れる」より後になる。
  // 画面で一番大きい絵＝表示できたと測られる相手（LCP）が、一番最後に始まっていた。
  if (meta.heroImage) {
    rows.push(
      `<link rel="preload" as="image" fetchpriority="high" href="${escapeAttr(meta.heroImage)}">`,
    );
  }

  // JSON-LD は属性ではなく <script> の中身なので、エスケープの作法が違う。
  // 気をつけるのは "</script>" が本文に現れることだけ（大会名に書かれうる）。
  // < を < にしておけば、JSONとしては同じ文字列のまま、タグは閉じない。
  const json = JSON.stringify(meta.jsonLd).replaceAll('<', '\\u003c');
  rows.push(`<script type="application/ld+json">${json}</script>`);

  return rows.join('\n');
}

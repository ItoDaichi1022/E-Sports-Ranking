// 大会の共有リンク（/t/{大会ID}）を返す Worker。
//
// 【なぜ要るか】
//   このサイトは #tournament/{id} というハッシュでページを切り替えている。
//   ハッシュはブラウザの中だけのもので、サーバーには送られない。XやDiscordが
//   貼られたリンクの中身を見に来るとき（プレビューを作るとき）に届くのは「/」だけで、
//   しかも向こうはJSを動かさないので、どの大会のリンクを貼っても同じ index.html の
//   ―― 中身が空の ―― 骨組みしか読めない。大会名も画像も取りようがない。
//
//   そこで、ハッシュを使わないURL /t/{id} を1本だけ用意する。ここではサーバー側
//   （このWorker）が大会をDBから引き、og: タグを埋め込んだHTMLを返す。
//   プレビューを作る側はそのタグだけを読んで帰る。人が同じURLを開いたときは、
//   その場で /#tournament/{id} へ送り返すので、見えるのはいつものアプリの画面になる。
//
// 【ここに来るリクエスト】
//   静的アセット（index.html・css/・js/ …）は Cloudflare がこのWorkerより先に返す。
//   つまりここへ来るのは「どのファイルにも当たらなかったURL」だけ。/t/ 以外は
//   env.ASSETS へそのまま渡して、これまでと同じ404にする（挙動を変えないため）。
//
// 【動作確認】
//   npx wrangler dev  → http://localhost:8787/t/{大会ID}
//   静的ファイルをそのまま開く方式（file:// や素のhttpサーバー）ではWorkerが
//   動かないので、共有リンクは404になる。これはデプロイ先でだけ効く機能。

const SITE_NAME = 'IgniteArena';
const SHARE_PREFIX = '/t/';

// 大会IDはUUID（supabase/schema.sql の tournaments.id）。形が違うものは
// DBに問い合わせるまでもなく無いので、ここで弾く。
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 進行状況の呼び名。js/entries.js の STATUS_LABELS と同じ内容を持っている。
// あちらはブラウザ用のESモジュールで、Workerからは読めない（importすると
// supabaseClient.js まで引きずられ、windowが無くて落ちる）ので写しを置く。
// 増やすときは両方直すこと。
const STATUS_LABELS = {
  draft: '準備中',
  recruiting: '募集中',
  running: '進行中',
  finished: '終了',
};

// プレビュー画像が無い大会のときに使う、サイト共通の絵。
// ?v= は index.html と同じ版数に合わせておく（/img/* は1年 immutable なので、
// 中身を差し替えたときは番号も上げる。_headers の説明を参照）。
const FALLBACK_IMAGE = '/img/icon.png?v=126';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith(SHARE_PREFIX)) return env.ASSETS.fetch(request);

    // 末尾のスラッシュは付いていても付いていなくても同じものとして扱う。
    // pathname はエスケープされたままなので戻す（戻さないと、UUID以外が来たときの
    // 「見つかりません」ページで %E3%81%82 のような文字列が二重に符号化される）。
    const id = safeDecode(url.pathname.slice(SHARE_PREFIX.length).replace(/\/+$/, ''));

    if (!UUID.test(id)) return sharePage(url.origin, id, null, 'missing');

    let tournament = null;
    try {
      tournament = await fetchTournament(env, id);
    } catch (err) {
      // DBに届かなかっただけで人の導線まで止める理由はない。プレビューは
      // 中身の無いものになるが、開いた人はいつもどおり大会ページへ着く
      // （そのときはアプリがDBから読み直すので、普通に大会が出る）。
      console.error('[share] 大会の取得に失敗', err);
      return sharePage(url.origin, id, null, 'unavailable');
    }

    return sharePage(url.origin, id, tournament, tournament ? 'found' : 'missing');
  },
};

// %が単独で入っているURLでは decodeURIComponent が例外を投げる。
// そこで止まる理由は無いので、戻せなければ元の文字列のまま先へ渡す（どのみちUUIDに
// ならないので「見つかりません」になる）。
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// 大会を1件だけ引く。anonキーで読める（supabase/schema.sql の tournaments_select は
// anon にも開いている）。参加数は js/db.js の一覧と同じ埋め込みカウントで取る。
//
// 【準備中の大会は引けない】公開前（status = 'draft'）の行はRLSが anon に返さない
// ので、0件＝「見つかりません」になる。共有URLを先に配られても、公開するまでは
// 大会名も画像も出ない ── 意図した動きで、直す対象ではない。
async function fetchTournament(env, id) {
  const query = new URLSearchParams({
    id: `eq.${id}`,
    select: 'name,date,status,match_type,image_url,rules,tournament_entries(count),tournament_teams(count)',
    limit: '1',
  });

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/tournaments?${query}`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) throw new Error(`PostgREST ${res.status} ${await res.text()}`);

  const rows = await res.json();
  return rows[0] ?? null;
}

// プレビューに出す1行。js/app.js の tournamentMetaEl と同じ並び（日付・参加数・状況）。
// 優勝者までは出さない ── あれは対戦表を読まないと分からず、そのために
// もう1往復するほどの値打ちは無い。
function summaryLine(t) {
  const isTeam = t.match_type === '2v2';
  const participants = t.tournament_entries?.[0]?.count ?? 0;
  const teams = t.tournament_teams?.[0]?.count ?? 0;
  const entrants = teams > 0 ? teams : participants;

  const count = isTeam
    ? `${entrants}チーム（${participants}人）参加`
    : `${entrants}人参加`;

  return [t.date || '日付未設定', count, STATUS_LABELS[t.status] ?? '—'].join(' ・ ');
}

// 説明文。1行目に日付や参加数、続けてルールの書き出しを添える。
// Discordは4行ほど、Xは2行ほどしか出さないので、長く積んでも読まれない。
function description(t) {
  const line = summaryLine(t);
  const rules = (t.rules ?? '').replace(/\s+/g, ' ').trim();
  if (!rules) return line;
  return `${line}\n${rules.length > 80 ? `${rules.slice(0, 80)}…` : rules}`;
}

// DBから来た画像URLをそのまま信用しない。og:image に javascript: のような
// ものが入っても害は無いが、http: の絵はXやDiscordに弾かれて「画像なし」に
// 見えるだけなので、https でなければ最初から共通の絵に倒す。
function imageUrl(origin, t) {
  const raw = t?.image_url ?? '';
  try {
    if (new URL(raw).protocol === 'https:') return raw;
  } catch { /* 空欄や壊れたURL */ }
  return `${origin}${FALLBACK_IMAGE}`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// 共有リンクを開いたときに返すページ。
//
// 中身はタグだけで、見せるための画面はほとんど持っていない。人が開いた場合は
// <head> のスクリプトが即座に /#tournament/{id} へ飛ばすので、この本文が
// 目に入るのは一瞬（またはJSを止めている人）だけ。
//
// 飛ばすのに location.replace を使うのは、履歴を残さないため。push してしまうと、
// 大会ページで「戻る」を押した人がこの中継ページに戻り、また前へ飛ばされて
// 一覧まで帰れなくなる。
//
// kind は3通り。「無い」と「読めなかった」を分けるのは、DBに届かなかっただけの
// ときに「削除されています」と言い切ってしまわないため（開けば普通に出る）。
//   found       … 大会が引けた
//   missing     … IDの形が違う、または消えている（404を返す）
//   unavailable … DBに届かなかった。人は開けるので200にしておく
function sharePage(origin, id, t, kind) {
  const found = kind === 'found';
  const heading = found ? t.name
    : kind === 'missing' ? '大会が見つかりません'
      : '大会ページを開いています';
  const title = `${heading}｜${SITE_NAME}`;
  const desc = found ? description(t)
    : kind === 'missing' ? 'この大会は存在しないか、削除されています。'
      : `${SITE_NAME} の大会ページです。`;
  const status = kind === 'missing' ? 404 : 200;
  const image = imageUrl(origin, t);
  const shareUrl = `${origin}${SHARE_PREFIX}${encodeURIComponent(id)}`;
  const appUrl = `/#tournament/${encodeURIComponent(id)}`;

  // 画像が大会のバナーなら大きく、共通のアイコンなら小さく出す。
  // アイコンを large_image で出すと、余白だらけの間の抜けた見た目になる。
  const card = found && image !== `${origin}${FALLBACK_IMAGE}` ? 'summary_large_image' : 'summary';

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(desc)}">
<link rel="canonical" href="${escapeHtml(shareUrl)}">
<link rel="icon" href="/img/icon.webp?v=126" type="image/webp">

<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:locale" content="ja_JP">
<meta property="og:url" content="${escapeHtml(shareUrl)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:image" content="${escapeHtml(image)}">
<meta property="og:image:alt" content="${escapeHtml(found ? `${t.name} の大会画像` : SITE_NAME)}">

<meta name="twitter:card" content="${card}">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(desc)}">
<meta name="twitter:image" content="${escapeHtml(image)}">

<!-- Discordの埋め込みの左端に入る線の色。サイトの地の色に合わせる -->
<meta name="theme-color" content="#050505">

<!-- 人が開いたときだけ動く。プレビューを作る側はJSを動かさないので、
     ここまでのタグを読んだ時点で帰っていく。 -->
<script>location.replace(${JSON.stringify(appUrl)});</script>
<!-- JSを止めている人向け。0秒指定でも、上のスクリプトが動いた場合は
     そちらが先に済んでいるので二重には飛ばない。 -->
<noscript><meta http-equiv="refresh" content="0; url=${escapeHtml(appUrl)}"></noscript>
<style>
  body {
    margin: 0; min-height: 100vh;
    display: grid; place-items: center; gap: 0.75rem;
    background: #050505; color: #f5f5f5;
    font-family: system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif;
    text-align: center; padding: 2rem;
  }
  a { color: #ff7a3d; }
</style>
</head>
<body>
<p>${escapeHtml(heading)}</p>
<p><a href="${escapeHtml(appUrl)}">大会ページを開く</a></p>
</body>
</html>`;

  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      // 大会名や画像は運営が直すことがあるので、長くは持たせない。
      // （XやDiscord側は一度作ったプレビューをこれよりずっと長く抱えるが、
      //   そちらは各サービスの都合なのでここからは決められない）
      'Cache-Control': 'public, max-age=300',
    },
  });
}

// ページごとの title・説明文・canonical・構造化データを差し替える。
//
// 【なぜ1か所にまとめるか】
//   この4つは「このページは何のページか」を別々の相手に伝えているだけで、中身は同じ。
//     title       … 検索結果の見出しと、ブラウザのタブ
//     description … 検索結果の説明文。SNSに貼ったときの下段にも使われる
//     canonical   … 同じ内容に複数のURLが付いたとき、どれが本物かの申告
//     JSON-LD     … 大会の日付や状態を、文章ではなくデータとして渡すためのもの
//   別々の場所で組み立てると、大会名を直したのに title だけ古い、といったずれが
//   必ず起きる。組み立てる場所を buildPageMeta ひとつにして、呼ぶ側は
//   「どのページで、どのデータか」だけを渡す。
//
// 【このファイルは state.js を読まない・DOM も触らない（buildPageMeta まで）】
//   同じ文言を2か所から使うため。
//     ブラウザ  … applyPageMeta が <head> に書き込む（画面を移るたび）
//     Cloudflare … worker/index.js が HTMLRewriter で埋め込む（返す直前）
//   XやDiscordのプレビューと検索エンジンの最初の一読みは、JSを動かす前のHTMLを
//   読む。そこに正しい値が入っていないと、どの大会のURLを貼っても同じ
//   プレビューになる ── だからサーバー側でも同じものを作れる必要がある。

import { pathFor } from './router.js';
// 大会の状態は画面のバッジと同じところから取る（js/tournamentState.js）。
// 二重に判定すると、画面には「終了」と出ているのに検索結果は「開催予定」のまま、
// という形でずれる。
import { eventStatusOf, entryState } from './tournamentState.js';
// 先頭に出る絵は、表示する大きさで配ってもらう。og:image はここを通さない
// （SNSのプレビューは大きいまま渡したい。理由は下の heroImage の指定を参照）。
import { heroImageUrl } from './imageUrl.js';

export const SITE_NAME = 'IgniteArena';
export const SITE_TAGLINE = 'どこでも熱く、遊べ。';

// 運営のアカウント。JSON-LD の sameAs でサイトと人を結び付け、
// twitter:site でXのカードに「どこが出しているか」を出す。
// index.html のフッター（お問い合わせ）と同じアカウントにそろえること。
const SITE_X_HANDLE = '@tomokkugyu';
const SITE_X_URL = `https://x.com/${SITE_X_HANDLE.slice(1)}`;

// 説明文が無いページで使う、サイト共通の一文。
const SITE_DESCRIPTION = 'コミュニティの大会運営と個人ランキングをまとめて扱う場所。'
  + '大会を開く・エントリーする・対戦表を追う。';

// プレビュー画像が無いときの絵。?v= は index.html と同じ版数に合わせる
// （/img/* は1年 immutable なので、差し替えたら番号も上げること）。
const FALLBACK_IMAGE = '/img/icon.png?v=165';

// ページの題（h1）と同じ言葉を使う。検索結果とページの中身で名前が違うと、
// 開いた人に「別のページに来た」と思わせる。
//
// 固有名を左・サイト名を右にするのは、スマートフォンの検索結果では末尾が
// 省略されるため。省かれてよいのはサイト名のほうで、大会名ではない。
const STATIC_TITLES = {
  tournaments: '大会一覧',
  create: '大会作成',
  players: '選手一覧',
  newslist: 'お知らせ',
  guide: 'はじめに（使い方）',
  setup: '対戦環境を整える',
  entries: 'エントリー状況',
  profile: 'マイページ',
  reveal: '順位発表',
  terms: '利用規約',
  privacy: 'プライバシーポリシー',
};

const STATIC_DESCRIPTIONS = {
  tournaments: `${SITE_NAME}で開催中・開催予定の大会一覧。募集中の大会にはその場でエントリーでき、`
    + '進行中・終了した大会は対戦表と最終順位を誰でも見られます。',
  create: '大会を作成します。日程・対戦方法・定員・締切を決めて公開すると、募集が始まります。',
  players: `${SITE_NAME}に登録している選手の一覧。名前で絞り込み、選手ページから戦歴と順位を確認できます。`,
  newslist: `${SITE_NAME}からのお知らせ一覧。大会の告知、ランキングの発表、仕様の変更などを掲載しています。`,
  guide: `${SITE_NAME}の使い方。アカウントの作り方から、大会へのエントリー、対戦表の見かた、`
    + 'ランキングの仕組み、大会の開き方までをまとめています。',
  setup: '大会当日までに整えておきたい対戦環境。回線・コントローラー・端末まわりの準備をまとめています。',
  entries: '自分がエントリー・出場した大会のまとめ。募集中・進行中・終了した大会を一覧で確認できます。',
  profile: 'プロフィールの確認と編集。プレイヤー名・アイコン・使用キャラクター・自己紹介を設定できます。',
  reveal: 'ランキングの順位発表（運営専用）。',
  terms: `${SITE_NAME}の利用規約。`,
  privacy: `${SITE_NAME}のプライバシーポリシー。取得する情報と、その使い道を記載しています。`,
};

// 検索結果に出したくないページ。
//   * 自分にしか意味がないもの（マイページ・エントリー状況）
//   * 操作の途中（大会作成）や運営専用（順位発表）
// 中身が薄いページを拾わせると、サイト全体の評価にも響く。
const NOINDEX_PAGES = new Set(['create', 'entries', 'profile', 'reveal']);

// ---- 出し入れの道具 ----

// <head> の中の1行を、無ければ作って、あれば書き換える。
// key は探すための属性（name か property）で、その値で1本に決まる。
function setMeta(attr, key, content) {
  const head = document.head;
  let el = head.querySelector(`meta[${attr}="${key}"]`);

  if (content == null || content === '') {
    el?.remove();
    return;
  }

  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    head.appendChild(el);
  }
  el.setAttribute('content', content);
}

function setLink(rel, href) {
  const head = document.head;
  let el = head.querySelector(`link[rel="${rel}"]`);
  if (!el) {
    el = document.createElement('link');
    el.setAttribute('rel', rel);
    head.appendChild(el);
  }
  el.setAttribute('href', href);
}

// 構造化データの器。1ページに1つだけ持ち、中身ごと入れ替える。
//
// JSON として壊れていても、ブラウザは何も言わずに読み飛ばす（<script> の中身は
// 実行されないため）。壊れていることに気付けるのは検索エンジンの検査ツールだけ
// なので、組み立てるときに undefined を混ぜないよう pruned() で掃除している。
function setJsonLd(data) {
  const head = document.head;
  let el = head.querySelector('script[type="application/ld+json"]');
  if (!el) {
    el = document.createElement('script');
    el.type = 'application/ld+json';
    head.appendChild(el);
  }
  el.textContent = JSON.stringify(data);
}

// 値の無い項目を落とす。null や undefined を残したまま出すと、
// 検索エンジン側の検査で「値が空」の警告になる。
function pruned(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  );
}

// 説明文は長すぎても切られるだけなので、文の切れ目で畳んでおく。
// 120文字前後を目安にする（検索結果に出るのはおおむねそのあたりまで）。
const DESCRIPTION_MAX = 120;

function trimDescription(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat.length <= DESCRIPTION_MAX) return flat;
  return `${flat.slice(0, DESCRIPTION_MAX - 1)}…`;
}

// 絶対URL。canonical と og:url は「どこから見ても同じ場所」を指す必要があるので、
// 相対パスのままでは使えない。独自ドメインを持っていないため、origin は
// 呼ぶ側から受け取る（ブラウザは location.origin、Worker はリクエストのURL）。
function absolute(path, origin) {
  return new URL(path, origin).href;
}

// ---- 文言の組み立て ----

// 日付（'2026-08-20'）を読ませる形に。曜日まで出すのは、大会が「いつ」なのかを
// 検索結果の1行で掴ませるため。壊れた値はそのまま返す（消してしまうより分かる）。
function dateText(ymd) {
  if (!ymd) return '';
  const d = new Date(`${ymd}T00:00:00+09:00`);
  if (Number.isNaN(d.getTime())) return String(ymd);
  const week = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日(${week})`;
}

// 締切（timestamptz）を絶対時刻で。「あと3日」のような相対表現にしないのは、
// 検索結果は作られた時点のまま何日も表示され続けるため ── 相対で書くと嘘になる。
function deadlineText(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const week = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()}(${week}) ${hh}:${mm}`;
}

// 検索結果に出す状態の言い方。画面のバッジ（entryState の label）とほぼ同じだが、
// 「募集中」だけは「エントリー受付中」に開く ── 検索結果は前後の文脈が無いところに
// 1行で出るので、何を募集しているのかまで書かないと伝わらない。
const SEARCH_STATE_TEXT = {
  draft: '準備中',
  open: 'エントリー受付中',
  'deadline-passed': 'エントリー受付中（締切時刻は過ぎています）',
  full: '定員に達しました',
  running: '進行中',
  finished: '終了',
};

// 大会ページの説明文。重要なものから順に置く（開催日 → 状態 → 規模 → 締切）。
// 後ろは切られる前提なので、切られて困る情報を後ろに置かない。
export function tournamentDescription(t, entrantsText = '') {
  if (!t) return SITE_DESCRIPTION;

  const parts = [];
  const when = dateText(t.date);
  parts.push(when ? `${when}開催の大会「${t.name}」。` : `大会「${t.name}」。`);

  // 状態は画面のバッジと同じ判定から取る（js/tournamentState.js）
  const state = entryState(t);
  const stateText = SEARCH_STATE_TEXT[state.key];
  if (stateText) parts.push(`${stateText}。`);
  if (entrantsText) parts.push(`${entrantsText}参加。`);

  // 締切を書くのは、まだ入れる大会だけ。終わった大会の締切は誰の役にも立たない。
  const deadline = deadlineText(t.entryDeadline);
  if (deadline && state.canEnter && !state.deadlinePassed) parts.push(`エントリー締切は${deadline}。`);

  return trimDescription(parts.join(''));
}

// 選手ページの説明文。順位は公開済みランキングから渡される（無い場合もある）。
function playerDescription(player, rankText) {
  const name = player?.currentName ?? '選手';
  const rank = rankText ? `${rankText}。` : '';
  return trimDescription(
    `${name}の戦歴と順位。${rank}出場した大会、対戦成績、使用キャラクターを${SITE_NAME}で確認できます。`,
  );
}

// お知らせの説明文は本文の書き出しをそのまま使う。要約を機械で作ると、
// 元の文章と食い違ったものが検索結果に出ることになる。
function announcementDescription(a) {
  const body = String(a?.body ?? '').replace(/\s+/g, ' ').trim();
  return trimDescription(body || `${SITE_NAME}からのお知らせ。`);
}

// ---- 構造化データ ----

// 全ページ共通。サイトそのものと、運営している組織の申告。
// @graph に並べるのは、1つの <script> で複数のものを説明するため。
function siteGraph(origin) {
  return [
    {
      '@type': 'WebSite',
      '@id': `${origin}/#website`,
      name: SITE_NAME,
      alternateName: SITE_TAGLINE,
      url: `${origin}/`,
      inLanguage: 'ja',
      publisher: { '@id': `${origin}/#organization` },
    },
    {
      '@type': 'Organization',
      '@id': `${origin}/#organization`,
      name: SITE_NAME,
      url: `${origin}/`,
      logo: `${origin}${FALLBACK_IMAGE}`,
      sameAs: [SITE_X_URL],
    },
  ];
}

// 大会。オンライン大会なので location は VirtualLocation にする
// （Place を使うと「住所が無い」という扱いでエラーになる）。
//
// 【startDate に時刻が入らない】DBが持っている開催日（tournaments.date）は
// 日付だけの列で、開始時刻をどこにも持っていない。schema.org は日付だけの
// ISO 8601 も認めるので、いまはそれで出している。時刻まで出したくなったら、
// 先に開始時刻の列を足すこと（推測で 00:00 を補うと、その時刻が検索結果に出る）。
function eventNode(t, { url, image, description, origin }) {
  return pruned({
    '@type': 'Event',
    name: t.name,
    url,
    description,
    image: image || undefined,
    startDate: t.date || undefined,
    eventStatus: eventStatusOf(t),
    eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
    location: pruned({
      '@type': 'VirtualLocation',
      // 配信があればその場所を、無ければ大会ページ自身を「開催の場所」とする
      url: t.streamUrl || url,
    }),
    organizer: pruned({
      '@type': 'Organization',
      name: SITE_NAME,
      url: `${origin}/`,
    }),
  });
}

function newsArticleNode(a, { url, image, description, origin }) {
  return pruned({
    '@type': 'NewsArticle',
    headline: a.title,
    url,
    description,
    image: image || undefined,
    datePublished: a.createdAt || undefined,
    dateModified: a.updatedAt || a.createdAt || undefined,
    publisher: { '@id': `${origin}/#organization` },
  });
}

function profilePageNode(player, { url, description }) {
  return pruned({
    '@type': 'ProfilePage',
    url,
    description,
    mainEntity: pruned({
      '@type': 'Person',
      name: player.currentName,
      alternateName: player.pastNames?.length ? player.pastNames.join(', ') : undefined,
      url,
    }),
  });
}

// ---- 入口 ----

// そのページの title・説明文・canonical・og:・構造化データを組み立てて返す。
//
// 【ここは DOM に触らない】返すのは値だけ。ブラウザ側は下の applyPageMeta が
// <head> に書き込み、Cloudflare 側（worker/index.js）は同じ値を HTMLRewriter で
// 埋め込む。同じ文言が2か所で作られると必ずずれるので、作るのはここ1か所にする。
//
// page      … js/router.js のページ名
// data      … そのページの中身。まだ読み込めていないときは空でよい
//   tournament / player / announcement … 表示している対象
//   entrantsText … 「12人」のような参加規模。数え方が対戦方法で変わるので、
//                  ここでは組み立てず、呼ぶ側（js/app.js・Worker）が渡す
//   rankText     … 「公開ランキング7位」のような順位の一行
//   notFound     … 対象が見つからなかった。検索結果に出さない
// origin    … 'https://example.workers.dev' のような、スキームとホストまで
export function buildPageMeta(page, data = {}, origin) {
  const {
    param = null, tournament = null, player = null, announcement = null,
    entrantsText = '', rankText = '', notFound = false,
  } = data;

  // canonical はクエリを含めない。大会一覧のタブ（?tab=running）は
  // 並べ替えの条件であって別のページではないので、代表は /tournaments/ のほう。
  const url = absolute(pathFor(page, param), origin);
  const fallbackImage = `${origin}${FALLBACK_IMAGE}`;

  let heading = '';
  let description = STATIC_DESCRIPTIONS[page] ?? SITE_DESCRIPTION;
  let image = fallbackImage;
  let extraNode = null;
  // ページの先頭に大きく出る絵（大会・お知らせのヘッダー画像）。
  // og:image と違ってサイト共通の代わりを入れない ── 「この画面に実際に出る絵」
  // だけを指す。無いのに場所を取ると、空の帯が残ってしまう。
  //
  // 【og:image（上の image）とは別に持つ理由がもう1つある】
  // こちらは heroImageUrl を通して、画面に出る大きさで配ってもらう（js/imageUrl.js）。
  // og:image は通さない ── SNSのプレビューは相手のレイアウトしだいで大きく出るし、
  // 一度取り込まれると差し替えが効かない。こちらの都合で小さくする場所ではない。
  let heroImage = null;

  if (notFound) {
    heading = 'ページが見つかりません';
    description = 'このページは存在しないか、削除されています。';
  } else if (page === 'tournament' && tournament) {
    heading = tournament.name;
    description = tournamentDescription(tournament, entrantsText);
    if (tournament.imageUrl) { image = tournament.imageUrl; heroImage = heroImageUrl(tournament.imageUrl); }
    extraNode = eventNode(tournament, { url, image, description, origin });
  } else if (page === 'bracket' && tournament) {
    heading = `${tournament.name} の対戦表`;
    // 大会ページの説明文をそのまま重ねると大会名を2回言うことになるので、
    // ここは対戦表そのものの話だけにして、日付と規模を短く添える。
    description = trimDescription([
      `大会「${tournament.name}」の対戦表。組み合わせと勝ち上がり、最終順位まで誰でも見られます。`,
      dateText(tournament.date) ? `${dateText(tournament.date)}開催。` : '',
      entrantsText ? `${entrantsText}参加。` : '',
    ].join(''));
    if (tournament.imageUrl) image = tournament.imageUrl;
  } else if (page === 'entrants' && tournament) {
    heading = `${tournament.name} の出場選手`;
    description = trimDescription(`大会「${tournament.name}」に出場する選手の一覧。${entrantsText ? `${entrantsText}が出場します。` : ''}`);
    if (tournament.imageUrl) image = tournament.imageUrl;
  } else if (page === 'player' && player) {
    heading = player.currentName;
    description = playerDescription(player, rankText);
    extraNode = profilePageNode(player, { url, description });
  } else if (page === 'news' && announcement) {
    heading = announcement.title;
    description = announcementDescription(announcement);
    if (announcement.imageUrl) { image = announcement.imageUrl; heroImage = heroImageUrl(announcement.imageUrl); }
    extraNode = newsArticleNode(announcement, { url, image, description, origin });
  } else if (page === 'home') {
    heading = '';
    description = `${SITE_NAME}は、大会の運営とランキングの集計をひとつにまとめた場所。`
      + '大会を開く・エントリーする・対戦表を追う。ログインなしで全部のぞけます。';
  } else {
    // データがまだ来ていない詳細ページも、いったんここに落ちる。
    // 「大会」「選手」のような入れ物の名前を出しておき、届いたら呼び直しで差し替える。
    heading = STATIC_TITLES[page] ?? '';
  }

  // ホームだけは「サイト名｜キャッチコピー」。ここに固有名は無く、
  // サイトそのものが主題なので、名乗りを先に置く。
  const title = page === 'home' && !notFound
    ? `${SITE_NAME}｜${SITE_TAGLINE}`
    : `${heading || SITE_NAME} | ${SITE_NAME}`;

  return {
    title,
    description: trimDescription(description),
    canonical: url,
    image,
    // 画面の先頭に出る絵。サーバー側（worker/index.js）が、これを先に取りに行かせ、
    // 場所も先に取っておくために使う ── ブラウザ任せにすると、この絵のURLが
    // 分かるのはJSがDBに問い合わせたあとで、一番大きい絵が一番遅く出ることになる。
    heroImage,
    ogType: page === 'news' ? 'article' : 'website',
    // カードの形。大会のバナーやお知らせの絵があるときだけ横長にする。
    // 正方形のサイト共通アイコンを横長で出すと、余白だらけの間の抜けた見た目になる。
    twitterCard: image === fallbackImage ? 'summary' : 'summary_large_image',
    twitterSite: SITE_X_HANDLE,
    // 見つからないページと、自分にしか意味の無いページは拾わせない。
    // follow は付ける ── そのページから先のリンクは辿ってよい。
    robots: (notFound || NOINDEX_PAGES.has(page)) ? 'noindex, follow' : null,
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': extraNode ? [...siteGraph(origin), extraNode] : siteGraph(origin),
    },
  };
}

// ページが決まるたびにブラウザ側から呼ぶ。同じページで何度呼んでも構わない
// （背景の更新で大会名が変わったときは、呼び直すことで題も追いつく）。
//
// 【サーバーが既に同じものを埋めている】worker/index.js が HTMLRewriter で
// 同じ値を入れて返すので、ここでの書き換えは普通は「同じ値で上書き」になる。
// それでも呼ぶのは、ページを読み直さずに移動したとき（SPAの画面遷移）は
// サーバーを通らないため ── そのときはここだけが title を更新できる。
export function applyPageMeta(page, data = {}) {
  const meta = buildPageMeta(page, data, location.origin);

  document.title = meta.title;

  setMeta('name', 'description', meta.description);
  setLink('canonical', meta.canonical);

  setMeta('property', 'og:title', meta.title);
  setMeta('property', 'og:description', meta.description);
  setMeta('property', 'og:url', meta.canonical);
  setMeta('property', 'og:image', meta.image);
  setMeta('property', 'og:type', meta.ogType);

  setMeta('name', 'twitter:card', meta.twitterCard);
  setMeta('name', 'twitter:site', meta.twitterSite);

  setMeta('name', 'robots', meta.robots);

  setJsonLd(meta.jsonLd);
}

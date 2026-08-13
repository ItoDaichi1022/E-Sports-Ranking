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
import { eventStatusOf } from './tournamentState.js';
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
const FALLBACK_IMAGE = '/img/icon.png?v=187';

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

// 【時刻は必ず日本時間で組み立てること】このファイルはブラウザと Worker の
// 両方で動く。Worker（Cloudflare）はUTCで走るので、Date の getHours() や
// getDay() をそのまま使うと、カードの文言だけ9時間ずれる ── 20:00開催の大会が
// 「11:00」、日をまたぐ大会は日付ごと前日になる。しかもSNSはカードを
// 共有された時点のまま抱えるので、間違ったまま残り続ける。
// Intl（timeZone: 'Asia/Tokyo'）に組み立てさせて、実行環境に依存させない。
const JST = 'Asia/Tokyo';

// Intl の出力から部品を取り出す。en-US を使うのは、返る値が数字と曜日の略号で
// そろっていて解析しやすいため（日本語ロケールだと「8月」のような単位が混ざる）。
function jstParts(d) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: JST,
    month: 'numeric', day: 'numeric', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  const WEEK = {
    Sun: '日', Mon: '月', Tue: '火', Wed: '水', Thu: '木', Fri: '金', Sat: '土',
  };
  return {
    month: get('month'),
    day: get('day'),
    week: WEEK[get('weekday')] ?? '',
    // 24時制の 24:xx は 0時のこと（環境によってこう返る）
    hour: get('hour') === '24' ? '00' : get('hour'),
    minute: get('minute'),
  };
}

// 開催日時（timestamptz）を読ませる形に。曜日と時刻まで出すのは、大会が
// 「いつ」なのかを検索結果の1行で掴ませるため。
// 壊れた値はそのまま返す（消してしまうより分かる）。
function dateText(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const { month, day, week, hour, minute } = jstParts(d);
  return `${month}月${day}日(${week}) ${hour}:${minute}`;
}

// 締切（timestamptz）を絶対時刻で。「あと3日」のような相対表現にしないのは、
// 検索結果は作られた時点のまま何日も表示され続けるため ── 相対で書くと嘘になる。
function deadlineText(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const { month, day, week, hour, minute } = jstParts(d);
  return `${month}/${day}(${week}) ${hour}:${minute}`;
}

// 【SEARCH_STATE_TEXT はここにあった】説明文に「募集中」「進行中」「終了」を
// 出すための言い換えの表で、下の tournamentDescription が使っていた。
//
// 消したのは、説明文から進行状況そのものを外したから。カードは一度取り込まれると
// 長く残るので、募集中に貼られたリンクが大会の終了後も「エントリー受付中」と
// 言い続けていた。理由は tournamentDescription の注記に書いてある。
//
// 構造化データ（JSON-LD）のほうには今も状態を入れている（下の eventStatusOf）。
// あちらは文章ではなくデータで、読む側が最新を取り直す前提のもの。

// 大会ページの説明文。出すのは大会名・開催日・エントリー締切の3つだけ。
//
// 【あとから変わるものを入れないこと】ここは og:description になり、XやDiscordは
// 一度取り込んだカードを長く持ち続ける。募集中に貼られたリンクは、大会が終わっても
// 「エントリー受付中」と言い続ける ── 貼った本人にも直しようがない。
// 検索結果も同じで、次に巡回されるまで古い文言が出たままになる。
//
// だからここに置くのは、時間が経っても嘘にならないものに限る。
//   大会名     … 変わらない
//   開催日     … 変わらない
//   締切の日時 … 「いつまでだったか」は過ぎても事実のまま
// 外したのは進行状況（募集中・進行中・終了）と参加人数。どちらも動く値で、
// カードに焼き付くと必ず食い違う。いまの状態はページを開けば正しいものが出る。
export function tournamentDescription(t) {
  if (!t) return SITE_DESCRIPTION;

  const parts = [];
  const when = dateText(t.date);
  parts.push(when ? `${when}開催の大会「${t.name}」。` : `大会「${t.name}」。`);

  // 締切は、過ぎていても書く。「いつまでだったか」は変わらない事実で、
  // 締切だけを状態で出し分けると、その出し分け自体がカードに焼き付いてしまう。
  const deadline = deadlineText(t.entryDeadline);
  if (deadline) parts.push(`エントリー締切は${deadline}。`);

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
// 【startDate は時刻込みのISOをそのまま出す】開催日時（tournaments.date）は
// timestamptz になった（supabase/migration-026.sql）。DBから来る値は
// 時差を持ったISO 8601（2026-08-15T11:00:00+00:00）で、schema.org が
// 求める形そのままなので、加工せずに渡す。
//
// 時刻が未設定だった頃の大会は、移行のときに日本時間の 0:00 になっている。
// そこだけは「本当に0時開催」と読まれるが、運営が大会情報を編集して
// 実際の時刻を入れれば直る（推測で書き換えると、当時の記録を捏造することになる）。
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
    description = tournamentDescription(tournament);
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

// 運営がアップロードした画像を、画面に出る大きさで配ってもらうためのURL組み立て。
//
// 【なぜ要るか】
// アップロード時に長辺1600pxまで縮めてはいる（js/util.js の downscaleImage）が、
// 実際に出る大きさはそれよりずっと小さい ── 大会詳細の先頭に出る絵は、スマホの
// 画面で最大 364×224 CSS px（css/style.css の .detail-hero img）。
// 実測した大会（1280×720・70.4KB）では、そのまま配ると Slow 4G で 3.36秒かかり、
// LCP（表示できたと測られる時刻）の 70% をこの1枚が占めていた。
//
// Supabase Storage には、保存してある原本から指定の幅で作り直して返す口がある。
//   原本   /storage/v1/object/public/{バケット}/{パス}
//   作り直し /storage/v1/render/image/public/{バケット}/{パス}?width=…&resize=contain&quality=…
// 実測（1280×720・原本72,138バイト）:
//   width=960 → 960×540・36,492バイト（-49%） / width=768 → 768×432・29,050バイト（-60%）
//
// 【原本より優れている点がもう1つある】
// 原本は Cache-Control: no-cache で返ってくる（Supabase側の既定）。同じ人が
// 翌日もう一度開くと、また70KBを取り直すことになる。作り直しの口は
// max-age=3600 を返すので、少なくとも1時間は取りに行かなくなる。
//
// 【必ずこのモジュールを通すこと】
// 同じ絵のURLを、サーバー（worker/index.js が返すHTMLの中の <img> と
// <link rel="preload">）とブラウザ（js/app.js の renderHero）の両方が組み立てる。
// 片方だけ書き方が違うとブラウザには別のURLに見えるので、同じ絵を2回
// ダウンロードすることになる ── しかも見た目は正しいので気付けない。
// 引数が同じなら必ず同じ文字列を返す、という約束でそれを防ぐ。

// Supabase Storage の公開オブジェクトの目印。ここを持たないURL（外部のサイトに
// 置かれた画像など）には手を出さない ── 作り直しの口は自分のStorageにある絵しか
// 扱えないので、書き換えると404になる。
const OBJECT_MARK = '/storage/v1/object/public/';
const RENDER_MARK = '/storage/v1/render/image/public/';

// 先頭に大きく出る絵（大会・お知らせのヘッダー）の幅。
//
// 画面に出るのは最大でも 364 CSS px（スマホ）／626 CSS px（PC。高さ22remと16:9から）。
// 高精細画面を考えて 960 にしてある。768 まで落とすとさらに6KB減るが、
// PCの高精細画面（626px × 2倍 = 1252px）で目に見えて甘くなる。
const HERO_WIDTH = 960;

// 一覧のカードに出る絵の幅。枠の高さが160px（お知らせは260px）なので、
// 16:9なら横は284px（お知らせは462px）。高精細画面ぶんを見て768にする。
const CARD_WIDTH = 768;

// 画質。75 は、この用途では原本との差が目で分からない範囲の下限あたり。
// 60 まで落とすとさらに15%小さくなるが、平坦な面にムラが出る。
const QUALITY = 75;

// 【resize=contain を絶対に外さないこと】
// この口の既定は cover（枠を埋めて、はみ出した分を切り落とす）。しかも height を
// 省くと原本の高さがそのまま使われるので、width=960 だけを渡すと
// 「1280×720 の絵を 960×720 の枠に cover」＝ 縦は無加工のまま横だけ 320px
// 切り落とされる、という結果になる。実際にそれを本番に出してしまい、
// 大会ヘッダーの絵が左右で欠けた。
//
// contain なら縦横比を保って枠に収めるので 960×540 になる。切らずに済むうえ、
// 本当に縮小されるぶんファイルも小さい（46,432 → 36,492バイト）。
//
// height を省いたままで問題ない ── contain の倍率は
// min(960/横, 原本の高さ/原本の高さ=1) なので、原本が 960px より細い絵は
// 1倍のまま（引き伸ばされない）、縦長の絵も縦横比を保ったまま収まる。
//
// なお、URLの文字列だけを見る検査ではこの取り違えは絶対に見つからない
// （URLは正しく組み立てられていた）。返ってきた絵の実寸を測ること。
const RESIZE = 'contain';

// 指定の幅で作り直してもらうURLにする。
//
// 次のものはそのまま返す（書き換えない）:
//   * 空 … 呼び出し側が「絵は無い」として扱う
//   * Supabase Storage の公開オブジェクトでないURL … 作り直しの口が扱えない
//   * すでに作り直しのURL … 二重に付けない（何度通しても同じ結果になるようにする）
function sized(url, width) {
  if (!url) return url;
  if (url.includes(RENDER_MARK)) return url;
  if (!url.includes(OBJECT_MARK)) return url;

  // 既にクエリが付いているURLが来ても壊さない。いま getPublicUrl が返すのは
  // クエリの無いURLだが、ライブラリの都合で付くことがある（ダウンロード指定など）。
  // 「?」で始めてしまうと2つ並んで、幅の指定ごと読み飛ばされる。
  const joiner = url.includes('?') ? '&' : '?';

  return `${url.replace(OBJECT_MARK, RENDER_MARK)}${joiner}width=${width}&resize=${RESIZE}&quality=${QUALITY}`;
}

// ページの先頭に大きく出る絵。LCPで測られる当の相手。
export function heroImageUrl(url) {
  return sized(url, HERO_WIDTH);
}

// 一覧のカードのサムネイル。
export function cardImageUrl(url) {
  return sized(url, CARD_WIDTH);
}

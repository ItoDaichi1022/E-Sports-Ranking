// index.html のキャッシュ更新用の版数（?v=）が、正しく全モジュールに行き渡っているか確認する。
//
//   node scripts/check-cache-version.mjs
//
// デプロイ前に実行すること。
//
// なぜ必要か:
//   エントリーポイント（app.js）の src にだけ ?v= を付けても、app.js が import する
//   各モジュールのURLは変わらないため、ブラウザは古いコピーを使い続ける。その結果
//   「新しいapp.js ＋ 古いstate.js」のようなちぐはぐな組み合わせになり、
//   存在しないexportを参照して起動に失敗する。
//   import文の解決先はインポートマップで差し替えているので、そこに漏れがないかを見る。

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let problems = 0;
const fail = (msg) => { console.error(`NG   ${msg}`); problems += 1; };

// ---- インポートマップ ----

const mapJson = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1];
if (!mapJson) {
  fail('index.html にインポートマップがありません');
  process.exit(1);
}

let imports;
try {
  imports = JSON.parse(mapJson).imports ?? {};
} catch (err) {
  fail(`インポートマップがJSONとして壊れています: ${err.message}`);
  process.exit(1);
}
console.log(`OK   インポートマップは正しいJSON（${Object.keys(imports).length}件）`);

// ---- 版数の収集 ----

const versions = new Set();
const collect = (v, what) => {
  if (!v) fail(`${what} に ?v= が付いていません`);
  else versions.add(v);
};

collect(html.match(/href="css\/style\.css\?v=(\d+)"/)?.[1], 'css/style.css');
collect(html.match(/<script type="module" src="js\/app\.js\?v=(\d+)"/)?.[1], 'js/app.js');
collect(html.match(/<script src="js\/vendor\/supabase\.js\?v=(\d+)"/)?.[1], 'js/vendor/supabase.js');
for (const [key, value] of Object.entries(imports)) {
  collect(value.match(/\?v=(\d+)$/)?.[1], `インポートマップの "${key}"`);
}

// 読み物ページ（pages/*.html）は data-src で読み込む。ここも同じ版数にそろえる。
const pageRefs = [...html.matchAll(/data-src="(pages\/[\w.-]+\.html)(\?v=(\d+))?"/g)];
for (const [, file, , v] of pageRefs) collect(v, file);

if (versions.size > 1) {
  fail(`版数がそろっていません: ${[...versions].sort().join(', ')}`);
} else if (versions.size === 1) {
  console.log(`OK   すべての ?v= が ${[...versions][0]} でそろっている`);
}

// ---- 網羅性 ----

const jsFiles = readdirSync(path.join(ROOT, 'js')).filter((n) => n.endsWith('.js'));

// 実際にどのモジュールが import されているかを集める
const used = new Set();
for (const f of jsFiles) {
  const src = readFileSync(path.join(ROOT, 'js', f), 'utf8');
  for (const m of src.matchAll(/from\s+'\.\/([^']+)'/g)) used.add(m[1]);
}

const missing = [...used].filter((t) => !(`./js/${t}` in imports));
if (missing.length) {
  missing.forEach((t) => fail(`"./js/${t}" がインポートマップに無い（古いキャッシュが読まれます）`));
} else {
  console.log(`OK   importされている${used.size}モジュールすべてが登録済み`);
}

const known = new Set(jsFiles.map((n) => `./js/${n}`));
for (const key of Object.keys(imports)) {
  if (!known.has(key)) fail(`"${key}" は存在しないファイルを指しています`);
}

// data-src の指す読み物ページが実在するか。綴りを間違えると、そのページを
// 開いたときに初めて白紙になるので、ここで気付けるようにする。
const pageFiles = new Set(
  readdirSync(path.join(ROOT, 'pages')).map((n) => `pages/${n}`),
);
for (const [, file] of pageRefs) {
  if (!pageFiles.has(file)) fail(`data-src の "${file}" が存在しません`);
}
if (pageRefs.length) console.log(`OK   読み物ページ${pageRefs.length}件がすべて存在する`);

// ---- ?v= の付け忘れ ----
//
// _headers で js/ css/ img/ pages/ を immutable（1年）にしている。ここに置いた
// ファイルを ?v= 無しで参照すると、一度配られたきり二度と更新できなくなる
// （版数を上げてもURLが変わらないため。名前を変えるしか手が無くなる）。
// 画像を足すときにいちばん踏みやすいので、デプロイ前にここで弾く。
//
// fonts/ は _headers 側で immutable から外してある（理由はそのファイルに記載）ので、
// ?v= が無くてよい ── ここでも見に行かない。

const IMMUTABLE_DIRS = ['js', 'css', 'img', 'pages'];

// href="..." / src="..." / data-src="..." / CSSの url(...) から、
// 上のディレクトリを指すローカルな参照を拾う。
function localRefs(source) {
  const found = [];
  const patterns = [
    /(?:href|src|data-src)="(?!https?:|\/\/|data:|#)([^"]+)"/g,
    /url\(\s*['"]?(?!https?:|\/\/|data:)([^'")]+)['"]?\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) found.push(m[1]);
  }
  return found;
}

const scanned = [
  ['index.html', html],
  ['css/style.css', readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8')],
  ...readdirSync(path.join(ROOT, 'pages')).map(
    (n) => [`pages/${n}`, readFileSync(path.join(ROOT, 'pages', n), 'utf8')],
  ),
];

let refCount = 0;
let refProblems = 0;
for (const [where, source] of scanned) {
  for (const ref of localRefs(source)) {
    // 先頭の ./ ../ / を落として、どのディレクトリ配下かだけを見る
    const dir = ref.replace(/^(\.\.?\/)+/, '').replace(/^\//, '').split('/')[0];
    if (!IMMUTABLE_DIRS.includes(dir)) continue;
    refCount += 1;
    if (!/\?v=\d+/.test(ref)) {
      refProblems += 1;
      fail(`${where} の "${ref}" に ?v= がありません`
        + '（_headers で1年キャッシュされる場所なので、更新できなくなります）');
    }
  }
}
if (refCount && refProblems === 0) {
  console.log(`OK   1年キャッシュされる${refCount}件の参照すべてに ?v= がある`);
}

// ---- キャラクターの画像 ----
//
// 一覧（js/characterData.js）は配布素材から自動生成される。生成が途中で
// 止まっていると、一覧には載っているのに画像が無い状態になり、プロフィールの
// 選ぶ画面に穴が開く。ここでしか気づけないので、実在するかを突き合わせる。
//
// 版数（ASSET_VERSION）は index.html の ?v= とは別に持つ。画像は毎回の
// デプロイで変わるものではないため。ずれていてよいので、そろっているかは見ない。

const catalogPath = path.join(ROOT, 'js', 'characterData.js');
if (!existsSync(catalogPath)) {
  fail('js/characterData.js がありません（node scripts/build-characters.mjs を実行してください）');
} else {
  const catalog = readFileSync(catalogPath, 'utf8');
  const assetVersion = /export const ASSET_VERSION = (\d+)/.exec(catalog)?.[1];
  if (!assetVersion) fail('js/characterData.js に ASSET_VERSION がありません');

  // 一覧を読み込まずに、必要な情報だけを字面から拾う。JSとして import すると
  // このスクリプトがブラウザ用モジュールの都合に引きずられる。
  let missingArt = 0;
  let artCount = 0;
  for (const block of catalog.split(/\n  \{\n/).slice(1)) {
    const charId = /id: '([^']+)'/.exec(block)?.[1];
    if (!charId) continue;
    for (const [, variantId] of block.matchAll(/\{ id: '([^']+)'/g)) {
      artCount += 1;
      for (const suffix of ['', '@lg']) {
        const file = path.join(ROOT, 'img', 'characters', charId, `${variantId}${suffix}.webp`);
        if (!existsSync(file)) {
          missingArt += 1;
          if (missingArt <= 5) fail(`img/characters/${charId}/${variantId}${suffix}.webp がありません`);
        }
      }
    }
  }
  if (missingArt > 5) fail(`...ほか${missingArt - 5}件の画像がありません`);
  if (artCount && missingArt === 0) {
    console.log(`OK   キャラクター画像${artCount}件がすべて存在する（版数 ${assetVersion}）`);
  }
}

// ---- img/ に重い形式が混ざっていないか ----
//
// リポジトリに入れる画像はWebPに統一している（img/README.md）。PNGやJPEGを1枚
// 置き忘れるだけで数百KB増え、_headers で1年キャッシュされるぶん取り返しも効かない。
// 例外は icon.png ── iOSのホーム画面のアイコンだけWebPを読まないので置いている。

const ALLOWED_NON_WEBP = new Set(['img/icon.png']);
const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|tiff?|avif)$/i;

function walkImages(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkImages(full, found);
    else if (IMAGE_EXT.test(entry.name)) found.push(path.relative(ROOT, full).replace(/\\/g, '/'));
  }
  return found;
}

const imgDir = path.join(ROOT, 'img');
if (existsSync(imgDir)) {
  const strays = walkImages(imgDir).filter((f) => !ALLOWED_NON_WEBP.has(f));
  for (const f of strays) fail(`${f} がWebPではありません（img/README.md を参照）`);
  if (strays.length === 0) console.log('OK   img/ の画像はWebPにそろっている（icon.png のみ例外）');
}

console.log(problems === 0 ? '\nすべて通りました。' : `\n${problems}件の問題があります。`);
process.exit(problems === 0 ? 0 : 1);

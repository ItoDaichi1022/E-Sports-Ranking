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

import { readFileSync, readdirSync } from 'node:fs';
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

console.log(problems === 0 ? '\nすべて通りました。' : `\n${problems}件の問題があります。`);
process.exit(problems === 0 ? 0 : 1);

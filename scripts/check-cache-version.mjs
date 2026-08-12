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

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
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

// index.html の中のURLはすべて「/」始まり。ページを /tournaments/{id}/ のような
// 深いURLでも同じHTMLで返すようになったため、相対パスだとその階層から解決されて
// 全部404になる（index.html の先頭に同じ注意書きがある）。
// ここの正規表現も「/」始まりだけを見る ── 相対パスに戻してしまったら、
// 版数が見つからず「?v= が付いていません」で止まる。
collect(html.match(/href="\/css\/style\.css\?v=(\d+)"/)?.[1], '/css/style.css');
// [^>]* を挟んであるのは、defer など属性が増えても拾い続けるため。
// ここが読めなくなると「?v= が付いていません」という的外れな指摘に化ける
// （実際、supabase.js に defer を足したときにそうなった）。
collect(html.match(/<script[^>]*\ssrc="\/js\/app\.js\?v=(\d+)"/)?.[1], '/js/app.js');
collect(html.match(/<script[^>]*\ssrc="\/js\/vendor\/supabase\.js\?v=(\d+)"/)?.[1], '/js/vendor/supabase.js');
for (const [key, value] of Object.entries(imports)) {
  collect(value.match(/\?v=(\d+)$/)?.[1], `インポートマップの "${key}"`);
}

// 読み物ページ（pages/*.html）は data-src で読み込む。ここも同じ版数にそろえる。
const pageRefs = [...html.matchAll(/data-src="\/(pages\/[\w.-]+\.html)(\?v=(\d+))?"/g)];
for (const [, file, , v] of pageRefs) collect(v, file);

// その画面を開いたときだけ読むCSS（data-css。js/app.js の loadViewCss）。
// <link> と違って <head> に無いので、版数の確認から抜け落ちやすい。
const viewCssRefs = [...html.matchAll(/data-css="\/(css\/[\w.-]+\.css)(\?v=(\d+))?"/g)];
for (const [, file, , v] of viewCssRefs) collect(v, file);

// CSSの中から img/ を指す url() も同じ版数にそろえる。ここだけ index.html の外に
// 版数があるので、まとめて上げるときに取り残されやすい ── 取り残すと、画像は
// 1年 immutable なので差し替えても古いまま配られ続ける。
const cssNames = readdirSync(path.join(ROOT, 'css')).filter((n) => n.endsWith('.css'));
for (const name of cssNames) {
  const source = readFileSync(path.join(ROOT, 'css', name), 'utf8');
  for (const [, ref] of source.matchAll(/url\(\s*['"]?((?:\.\.\/)?img\/[^'")]+)['"]?\s*\)/g)) {
    collect(ref.match(/\?v=(\d+)$/)?.[1], `css/${name} の "${ref}"`);
  }
}

if (versions.size > 1) {
  fail(`版数がそろっていません: ${[...versions].sort().join(', ')}`);
} else if (versions.size === 1) {
  console.log(`OK   すべての ?v= が ${[...versions][0]} でそろっている`);
}

// ---- 網羅性 ----

const jsFiles = readdirSync(path.join(ROOT, 'js')).filter((n) => n.endsWith('.js'));

// 静的な import 文から読み込み先を拾う正規表現。
//
// 【途中を [^'"] に限ること】import 文は
//     import {
//       a, b,
//     } from './state.js';
// のように複数行にまたがるので、途中は行をまたげる必要がある。しかし [\s\S] で
// 書くと、その手前にある副作用だけの import
//     import './intro.js';
// の行から探し始めたときに、引用符を越えて次の文の from まで一気に飲み込み、
// intro.js が「無かったこと」になる（実際にそうなっていた）。
// [^'"] にしておけば引用符で必ず止まるので、文をまたげない。
const STATIC_IMPORT = /^\s*import\s+(?:[^'"]*?\s+from\s+)?'\.\/([^']+)'/gm;

// 実際にどのモジュールが import されているかを集める
const used = new Set();
for (const f of jsFiles) {
  const src = readFileSync(path.join(ROOT, 'js', f), 'utf8');
  for (const m of src.matchAll(STATIC_IMPORT)) used.add(m[1]);
  // 開いたときに取りに行くモジュール（await import('/js/xxx.js')）。
  // こちらも版数の差し替えが要るので、同じように登録漏れを見る ── 見落とすと、
  // その画面だけが古いコピーのまま動き続ける。
  for (const m of src.matchAll(/\bimport\(\s*'\/js\/([^']+)'\s*\)/g)) used.add(m[1]);
}

// インポートマップの見出しは "/js/xxx.js"。モジュールの中の import './state.js' は
// 「そのモジュールから見た相対」なので /js/state.js に解決され、この見出しと一致する。
// 見出しのほうを "./js/state.js" と書くと、解決の基準がHTMLのURLになるため、
// /tournaments/{id}/ で開いたときだけ一致しなくなる（=版数が効かない）。
const missing = [...used].filter((t) => !(`/js/${t}` in imports));
if (missing.length) {
  missing.forEach((t) => fail(`"/js/${t}" がインポートマップに無い（古いキャッシュが読まれます）`));
} else {
  console.log(`OK   importされている${used.size}モジュールすべてが登録済み`);
}

const known = new Set(jsFiles.map((n) => `/js/${n}`));
for (const key of Object.keys(imports)) {
  if (!known.has(key)) fail(`"${key}" は存在しないファイルを指しています`);
}

// ---- 先読み（modulepreload）の過不足 ----
//
// ES モジュールは、親を読み終えて解析するまで子のURLが分からない。app.js から
// 静的にimportしているものを index.html で先に宣言しておかないと、その1本だけが
// 1往復ぶん遅れて届き、しかも app.js は静的importの木が全部そろうまで動き出さない
// ── つまり、たった1本の書き忘れがサイト全体の起動を待たせる。
// 画面上は「なんとなく遅い」だけで、壊れないぶん気付けないので、ここで数を合わせる。
//
// 逆に、開いた人だけが取りに行くもの（動的import）をここに並べてしまうと、その画面を
// 開かない人にも配ることになり、分けた意味が消える。そちらも余分として弾く。

const staticDeps = new Map();
for (const f of jsFiles) {
  const src = readFileSync(path.join(ROOT, 'js', f), 'utf8');
  staticDeps.set(f, [...src.matchAll(STATIC_IMPORT)].map((m) => m[1]));
}

// app.js から静的importだけで辿り着ける集合＝起動時に必ず落ちてくるもの。
// app.js 自身は <script type="module"> が取りに行くので、先読みの対象から外す。
const eager = new Set();
(function walk(f) {
  for (const d of staticDeps.get(f) ?? []) {
    if (eager.has(d)) continue;
    eager.add(d);
    walk(d);
  }
})('app.js');

const preloaded = new Set(
  [...html.matchAll(/<link rel="modulepreload" href="\/js\/([\w.-]+\.js)\?v=\d+">/g)].map((m) => m[1]),
);

const notPreloaded = [...eager].filter((f) => !preloaded.has(f)).sort();
const overPreloaded = [...preloaded].filter((f) => !eager.has(f)).sort();
notPreloaded.forEach((f) => fail(
  `"/js/${f}" は起動時に必ず要るのに <link rel="modulepreload"> がない`
  + '（その1本だけ1往復ぶん遅れ、app.js の起動全体がそれを待ちます）',
));
overPreloaded.forEach((f) => fail(
  `"/js/${f}" は起動時には要らないのに <link rel="modulepreload"> がある`
  + '（その画面を開かない人にも配ることになります）',
));
if (notPreloaded.length === 0 && overPreloaded.length === 0) {
  console.log(`OK   起動時に要る${eager.size}モジュールすべてが先読みされている`);
}

// ---- 先読みとインポートマップの並び順 ----
//
// 【インポートマップは、どのモジュールの読み込みより先に置くこと】
// <link rel="modulepreload"> はモジュールの読み込みそのものなので、これを
// インポートマップより前に書くと「読み込みが始まったあとに追加された
// インポートマップ」となり、ブラウザに無視される。
// そうなると import './db.js' は ?v= の付かない /js/db.js に解決され、
// _headers で1年 immutable にしている場所を版数なしで配ることになる
// ── つまりキャッシュの更新手段が丸ごと死ぬ。
// 実際に v158 でこれを踏んだ。画面は正常に動いてしまうので気付けない。

const posMap = html.indexOf('<script type="importmap">');
const posPreload = html.indexOf('<link rel="modulepreload"');
const posModule = html.indexOf('<script type="module" src=');
if (posMap === -1) {
  fail('インポートマップが見つかりません');
} else if (posPreload !== -1 && posPreload < posMap) {
  fail('<link rel="modulepreload"> がインポートマップより前にあります。'
    + '\n     モジュールの読み込みが先に始まるとインポートマップは無視され、'
    + '\n     ?v= の付かないURLで配られてキャッシュを更新できなくなります。'
    + '\n     インポートマップの <script> より後ろへ移すこと。');
} else if (posModule !== -1 && posModule < posMap) {
  fail('<script type="module"> がインポートマップより前にあります（同上）');
} else {
  console.log('OK   インポートマップが、どのモジュール読み込みより先にある');
}

// ---- supabase-js が app.js より先に実行されるか ----
//
// js/supabaseClient.js は window.supabase がある前提で書いてあり、無ければ
// モジュールの評価中に例外を投げる（＝サイトが起動しない）。それを保証している
// のは「defer 付きの通常スクリプトと type="module" は同じ列に並び、書いてある順に
// 実行される」というHTMLの決まりだけで、コードの上にはどこにも現れない。
//
// 崩れ方は2通りあり、どちらも静かに起きる:
//   * async を付ける … 列から外れて、読み終わり次第すぐ走る（app.js より後になり得る）
//   * app.js より下へ移す … 列の中の順番が逆になる
// defer を消すのは動作としては安全side（より早く走る）だが、そのぶん最初の描画を
// 止めて帯域を奪うので、消したことに気付けるようここで見る。

const posSupabase = html.indexOf('/js/vendor/supabase.js');
const supabaseTag = html.match(/<script([^>]*)src="\/js\/vendor\/supabase\.js[^"]*"[^>]*>/)?.[1] ?? '';
if (posSupabase === -1) {
  fail('js/vendor/supabase.js の <script> が見つかりません');
} else if (/\basync\b/.test(supabaseTag)) {
  fail('js/vendor/supabase.js に async が付いています。'
    + '\n     app.js より後に実行され得るため、起動時に window.supabase が無くて止まります。');
} else if (posModule !== -1 && posSupabase > posModule) {
  fail('js/vendor/supabase.js が app.js のモジュールより後ろにあります。'
    + '\n     js/supabaseClient.js が window.supabase を見つけられず、起動時に止まります。');
} else if (!/\bdefer\b/.test(supabaseTag)) {
  fail('js/vendor/supabase.js に defer がありません。'
    + '\n     HTMLの読み取りを止め、最優先で回線を取るため、最初の描画とLCPが遅れます。');
} else {
  console.log('OK   supabase-js は defer 付きで、app.js より先に実行される位置にある');
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

const IMMUTABLE_DIRS = ['js', 'css', 'img', 'pages', 'video'];

// href="..." / src="..." / data-src="..." / CSSの url(...) から、
// 上のディレクトリを指すローカルな参照を拾う。
function localRefs(source) {
  const found = [];
  const patterns = [
    // data-css は「その画面を開いたときに読むCSS」（js/app.js の loadViewCss）。
    // <link> と同じく1年キャッシュされる場所を指すので、ここも同じ検査に載せる。
    /(?:href|src|data-src|data-css)="(?!https?:|\/\/|data:|#)([^"]+)"/g,
    /url\(\s*['"]?(?!https?:|\/\/|data:)([^'")]+)['"]?\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) found.push(m[1]);
  }
  return found;
}

// CSSは css/ の中身をすべて見る。style.css だけを名指ししていたころに
// reveal.css の url() が検査から漏れていた ── 分割したファイルを足すたびに
// ここへ書き足すのを忘れるので、名指しをやめて拾い集める形にした。
const scanned = [
  ['index.html', html],
  ...readdirSync(path.join(ROOT, 'css')).filter((n) => n.endsWith('.css')).map(
    (n) => [`css/${n}`, readFileSync(path.join(ROOT, 'css', n), 'utf8')],
  ),
  ...readdirSync(path.join(ROOT, 'pages')).map(
    (n) => [`pages/${n}`, readFileSync(path.join(ROOT, 'pages', n), 'utf8')],
  ),
];

let refCount = 0;
let refProblems = 0;
let missingRefs = 0;
for (const [where, source] of scanned) {
  for (const ref of localRefs(source)) {
    // 先頭の ./ ../ / を落として、どのディレクトリ配下かだけを見る
    const relative = ref.replace(/^(\.\.?\/)+/, '').replace(/^\//, '');
    const dir = relative.split('/')[0];
    if (!IMMUTABLE_DIRS.includes(dir)) continue;
    refCount += 1;
    if (!/\?v=\d+/.test(ref)) {
      refProblems += 1;
      fail(`${where} の "${ref}" に ?v= がありません`
        + '（_headers で1年キャッシュされる場所なので、更新できなくなります）');
    }
    // 指し先が実在するかも見る。素材を差し替えて拡張子が変わったとき
    // （video/0204.mp4 → .mov）、参照だけが古いまま残ると本番で404になる。
    // ブラウザの<video>は読めなくても黙って止まるだけなので、ここで弾かないと
    // 収録の当日まで気づけない。
    if (!existsSync(path.join(ROOT, relative.replace(/\?.*$/, '')))) {
      missingRefs += 1;
      fail(`${where} の "${ref}" は存在しないファイルを指しています`);
    }
  }
}
if (refCount && refProblems === 0) {
  console.log(`OK   1年キャッシュされる${refCount}件の参照すべてに ?v= がある`);
}
if (refCount && missingRefs === 0) {
  console.log(`OK   同${refCount}件の指し先がすべて実在する`);
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

  // ---- 顔の位置の表（js/characterFocus.js）----
  //
  // 対戦表や一覧の行に敷く絵は、顔のあたりだけを切り出して見せている。その位置は
  // 目で読み取った表で持っていて、自動生成されない。キャラクターやスキンを足すと
  // ここだけ取り残され、既定値（当て推量）で切られて顔が窓の外に落ちる。
  // 画面を見ても「なんとなく変な絵」にしか見えず気付けないので、ここで数を突き合わせる。

  const focusPath = path.join(ROOT, 'js', 'characterFocus.js');
  if (!existsSync(focusPath)) {
    fail('js/characterFocus.js がありません');
  } else {
    const focusSrc = readFileSync(focusPath, 'utf8');
    const focusKeys = new Set(
      [...focusSrc.matchAll(/^\s*'([^']+)': \[\d+, \d+\],/gm)].map((m) => m[1]),
    );

    const artKeys = [];
    for (const block of catalog.split(/\n  \{\n/).slice(1)) {
      const charId = /id: '([^']+)'/.exec(block)?.[1];
      if (!charId) continue;
      for (const [, variantId] of block.matchAll(/\{ id: '([^']+)'/g)) {
        artKeys.push(`${charId}:${variantId}`);
      }
    }

    const noFocus = artKeys.filter((k) => !focusKeys.has(k));
    const strayFocus = [...focusKeys].filter((k) => !artKeys.includes(k));
    noFocus.slice(0, 5).forEach((k) => fail(
      `js/characterFocus.js に "${k}" の顔の位置がありません（既定値で切られて顔が外れます）`,
    ));
    if (noFocus.length > 5) fail(`...ほか${noFocus.length - 5}件の顔の位置がありません`);
    strayFocus.forEach((k) => fail(`js/characterFocus.js の "${k}" は存在しない画像を指しています`));
    if (noFocus.length === 0 && strayFocus.length === 0) {
      console.log(`OK   顔の位置${focusKeys.size}件が画像と1対1で対応している`);
    }
  }
}

// ---- img/ に重い形式が混ざっていないか ----
//
// リポジトリに入れる画像はWebPに統一している（img/README.md）。PNGやJPEGを1枚
// 置き忘れるだけで数百KB増え、_headers で1年キャッシュされるぶん取り返しも効かない。
// 例外は icon.png ── iOSのホーム画面のアイコンだけWebPを読まないので置いている。
//
// img/character/（単数）は見ない。あそこはPNGの配布素材を置く場所で、.gitignore と
// .assetsignore の両方で外してあるためGitにも配信にも載らない。普段は手元に無いので
// 気付きにくいが、キャラクターを足すときだけ置くことになり、そのとき必ず引っかかる。

const SKIP_DIRS = new Set([path.join(ROOT, 'img', 'character')]);
const ALLOWED_NON_WEBP = new Set(['img/icon.png']);
const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|tiff?|avif)$/i;

function walkImages(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (SKIP_DIRS.has(full)) continue;
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

// ---- index.html が直に指している画像の大きさ ----
//
// 【なぜ index.html の分だけを見るか】ここに書かれた画像は、最初の1本のHTMLに
// 載って全員に届く。ホームのロゴは画面に最初に出る大きなものなので、そのまま
// LCP（表示できたと測られる時刻）の相手になる。一方 img/ の奥にあるキャラクター
// 画像などは、その画面を開いた人だけが後から取りに行くので同じ物差しでは測れない。
//
// 【なぜこの検査が要るか】実際に見落とした。game-logo.webp は 93,724 バイト
// ありながら、スマホでの表示幅は 200 CSS px（css/style.css の .hero-game-logo）。
// 大会の写真より重い絵を、全員に、毎回配っていた。絵は見た目では重さが分からず、
// 差し替えるときにも気付けない ── 数字で止めるしかない。
// のちに計測で、これがホームのLCPの89%を占めていることが分かった
// （3,820ms のうち 3,390ms がこの1枚の取得）。書き出し直して 40,376 バイトにした。
const IMAGE_BUDGET = 40 * 1024;

// 【差し替え待ちの控え】いま基準を超えているが、差し替えが決まっているもの。
// 大きさ（バイト数）まで書いて留めてあるので、**中身が1バイトでも変われば
// この控えは効かなくなり、基準で測られる**。つまり、差し替えた絵が軽くなって
// いなければここで止まる。差し替えが済んだらこの行ごと消すこと。
//
// いまは空。game-logo.webp は 93,724 → 40,376 バイトに書き出し直したので、
// 控えずに基準で測れるようになった。
const BUDGET_PINNED = new Map();

const htmlImages = [...new Set(
  [...html.matchAll(/["'(]\/(img\/[\w./-]+\.(?:webp|png|jpe?g|gif|avif))(?:\?v=\d+)?/g)].map((m) => m[1]),
)].sort();

let budgetProblems = 0;
for (const rel of htmlImages) {
  const full = path.join(ROOT, rel);
  if (!existsSync(full)) continue; // 実在するかは上の別の検査が見ている
  const size = statSync(full).size;
  if (size <= IMAGE_BUDGET) continue;

  if (BUDGET_PINNED.get(rel) === size) {
    console.log(`--   ${rel} は ${size} バイト（基準 ${IMAGE_BUDGET} 超）。差し替え待ちとして留めてあります`);
    continue;
  }
  fail(`${rel} が ${size} バイトあります（基準 ${IMAGE_BUDGET} バイト）。`
    + '最初のHTMLに載る画像なので、表示される大きさに合わせて書き出し直してください');
  budgetProblems += 1;
}
if (budgetProblems === 0) {
  console.log(`OK   index.html が指す画像${htmlImages.length}件は大きさの基準内（${IMAGE_BUDGET} バイト）`);
}

// ---- ホームの最初の1画面がJSを待たないか ----
//
// ホームのヒーロー（ロゴ・名乗り・サブタイトル・ボタン）は css/style.css の
// 「ヒーローの登場（JSを通さない）」がCSSだけで出している。ここに .reveal を
// 付け直すと、透明を解けるのが js/stage.js だけになり、約148KiBのモジュールが
// 全部届くまでホームが白紙になる ── 届かなければ永久に真っ黒。
// 実際にそうなっていて、ダウンロードするものが何も無い文字が出るまでに
// 3,390ms かかっていた（Slow 4G・CPU4倍）。画面上は「なんとなく遅い」だけで、
// 壊れないぶん気付けないので、ここで弾く。

const css = readFileSync(path.join(ROOT, 'css', 'style.css'), 'utf8');

const heroBody = /<div class="hero-body">([\s\S]*?)\n      <\/div>/.exec(html)?.[1];
if (!heroBody) {
  fail('index.html に <div class="hero-body"> が見つかりません（検査できません）');
} else if (/class="[^"]*\breveal\b/.test(heroBody)) {
  fail('ホームのヒーローに class="reveal" が付いています。'
    + '\n     .reveal の opacity:0 を解けるのは js/stage.js だけなので、'
    + '\n     モジュールが全部届くまでホームが白紙になります（届かなければ永久に）。');
// 名前の終わりは \b ではなく \s*\{ で見る。\b はハイフンの手前でも成立するので、
// hero-in を hero-in-unused に書き換えても素通りしてしまう（実際に素通りした）。
} else if (!/@keyframes hero-in\s*\{/.test(css) || !/@keyframes hero-game-in\s*\{/.test(css)
  || !/\.stage-ready \.hero-body > :not\(\.hero-game\)/.test(css)) {
  fail('css/style.css の「ヒーローの登場（JSを通さない）」が見当たりません。'
    + '\n     .reveal から外したヒーローを出すものが無くなると、ホームが永久に白紙になります。');
} else {
  console.log('OK   ホームのヒーローはJSを待たずに出る（.reveal に載っていない）');
}

// 幕の待ち時間（.intro-half-* の animation-delay）と、ヒーローの待ち時間
// （--hero-gate）は同じ値でなければならない。片方だけ動かすと、幕が開いた先に
// 空っぽのホームが出る（または逆に、幕の裏でヒーローが立ち上がり終える）。
// 同じ数字が離れた2か所にあり、しかも画面を見比べないと分からないずれ方をする。
const gateDelays = [...css.matchAll(/animation: intro-open-[lr] [^;]*?([\d.]+)s both;/g)].map((m) => m[1]);
const heroGate = /--hero-gate:\s*([\d.]+)s/.exec(css)?.[1];
if (gateDelays.length !== 2 || !heroGate) {
  fail(`幕の animation-delay（${gateDelays.length}件）か --hero-gate（${heroGate ?? 'なし'}）が読めません`);
} else if (new Set([...gateDelays, heroGate]).size !== 1) {
  fail(`幕の待ち時間（${gateDelays.join(' / ')}s）とヒーローの待ち時間（${heroGate}s）が違います。`
    + '\n     幕が開いた先に空っぽのホームが出るか、幕の裏でヒーローが立ち上がり終えます。'
    + '\n     css/style.css の .intro-half-* と --hero-gate を同じ値にすること。');
} else {
  console.log(`OK   幕とヒーローの待ち時間がそろっている（${heroGate}s）`);
}

// ヒーローの待ち時間は <html class="intro-on"> が決める。付け忘れると幕より先に
// ヒーローが立ち上がり、幕の裏で登場が終わってしまう。
// 逆に、幕の後始末でこの印まで外すと animation-delay の指定が当たらなくなり、
// アニメーションが頭から掛け直される（立ち上がりかけたヒーローが伏せてやり直す）。
if (/\.intro-on\b/.test(css)) {
  if (!/classList\.add\([^)]*'intro-on'[^)]*\)/.test(html)) {
    fail("index.html の <head> が 'intro-on' を付けていません。"
      + '\n     ヒーローが幕より先に立ち上がり、幕の裏で登場が終わります。');
  } else if (/classList\.remove\([^)]*'intro-on'[^)]*\)/.test(html)) {
    fail("index.html が 'intro-on' を外しています。"
      + '\n     待ち時間の指定が途中で当たらなくなり、ヒーローの登場が頭から掛け直されます'
      + '\n     （立ち上がりかけた文字が一度伏せてやり直す）。外すのは js/intro.js の'
      + '\n     unlockHero だけで、あちらは開門が始まる前かどうかを確かめている。');
  } else {
    console.log("OK   'intro-on' は <head> で付き、途中で外れない");
  }
}

// ---- <img> の width/height が実寸と合っているか ----
//
// 【なぜ要るか】width/height は「画像の実寸」を書く決まりにしている（img/README.md）。
// ブラウザはこの比率で場所を先に取るので、実寸とずれると
//   * 場所の取り方がずれる … 画像が届いた瞬間に行が跳ねる（CLS）
//   * 縦横比がずれる      … 絵が伸びる／潰れる
// のどちらかになる。しかも絵を差し替えるときは src だけ直して数字を忘れやすい。
// 実際、ロゴを 700×623 から 466×415 に書き出し直したときに直す必要があった。
// 画面を見ても「なんとなく違う」としか分からないので、実物から読んで突き合わせる。

// WebPの見出しから縦横を読む。RIFF....WEBP のあとに続く塊の種類で書き方が違う。
function webpSize(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const tag = buf.toString('ascii', 12, 16);
  if (tag === 'VP8X') return { w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1 };
  if (tag === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  if (tag === 'VP8L') {
    const v = buf.readUInt32LE(21);
    return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 };
  }
  return null;
}

// ホームのロゴに loading="lazy" を書き込まないこと。ホームではこの絵が
// LCP要素そのもので、lazy を付けると最優先で取るべきものを後回しにする。
// ホーム以外のルートでだけ lazy を足すのは worker/index.js の役目で、
// あちらは配られる直前のHTMLに書き込むので、この元のHTMLには現れない。
const logoTag = /<img[^>]*id="hero-game-logo"[^>]*>/.exec(html)?.[0] ?? '';
if (!logoTag) {
  fail('index.html に id="hero-game-logo" の <img> がありません');
} else if (/\bloading=/.test(logoTag)) {
  fail('ホームのロゴに loading 属性が付いています。'
    + '\n     ホームではこの絵がLCP要素そのものなので、後回しにしてはいけません。'
    + '\n     ホーム以外で取りに行かせない手当ては worker/index.js が受け持ちます。');
} else if (!/\bfetchpriority="high"/.test(logoTag)) {
  fail('ホームのロゴに fetchpriority="high" がありません。'
    + '\n     ホームのLCP要素はこの絵で、実測でLCPの89%がこの1枚の取得でした。'
    + '\n     外すなら、ホームで最後に出るものが絵でなくなったことを先に確かめること'
    + '\n     （index.html のこのタグの上に経緯が書いてあります）。');
} else {
  console.log('OK   ホームのロゴは即取得（fetchpriority=high・loading なし）');
}

let sizeChecked = 0;
let sizeProblems = 0;
for (const tag of html.match(/<img[^>]*>/g) ?? []) {
  const src = /src="\/(img\/[^"?]+)/.exec(tag)?.[1];
  const w = Number(/\bwidth="(\d+)"/.exec(tag)?.[1]);
  const h = Number(/\bheight="(\d+)"/.exec(tag)?.[1]);
  if (!src || !w || !h) continue;

  const full = path.join(ROOT, src);
  if (!existsSync(full)) continue; // 実在するかは上の別の検査が見ている
  const real = webpSize(readFileSync(full));
  if (!real) continue; // WebP以外は読めないので見送る（img/ はWebPに統一済み）

  sizeChecked += 1;
  if (real.w !== w || real.h !== h) {
    sizeProblems += 1;
    fail(`index.html の <img src="/${src}"> が width="${w}" height="${h}" ですが、`
      + `実物は ${real.w}×${real.h} です。`
      + '\n     ブラウザはこの数字で場所を取るので、届いた瞬間に行が跳ねるか、絵が伸びます。'
      + '\n     画像を差し替えたら、この2つも実寸に書き直すこと（img/README.md）。');
  }
}
if (sizeChecked && sizeProblems === 0) {
  console.log(`OK   index.html の <img> ${sizeChecked}件の width/height が実寸と一致`);
}

// ---- 版数を過去に使った値へ戻していないか ----
//
// 【一度配ったURLは二度と別の中身にできない】_headers で /js/ /css/ /img/ /pages/ を
// immutable（1年）にしている。これは「URLが同じなら中身も同じ」という宣言なので、
// 同じ ?v= を別の中身で配り直すと、以前その番号を見た端末は取り直してくれない。
// index.html だけは毎回取り直すため、
//
//     新しい index.html ＋ キャッシュに残った古い js/app.js
//
// という食い違った組み合わせで動き、消したはずの要素を触って落ちる。
// 実際に起きた: 版数を93へ戻して94から振り直したところ、旧94を見ていた端末だけが
// `null is not an object (evaluating 'profileLinksEl.innerHTML=...')` で止まった。
//
// 戻して作り直すこと自体は問題ない。**番号だけは過去の最大値より先へ飛ばすこと。**

import { execFileSync } from 'node:child_process';

function versionsInHistory() {
  // index.html を変更したコミットだけを見る（全コミットを開くと遅くなる）
  const shas = execFileSync('git', ['rev-list', '--all', '--max-count=300', '--', 'index.html'],
    { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);

  const seen = new Map(); // 版数 → その番号を持つコミット
  for (const sha of shas) {
    const old = execFileSync('git', ['show', `${sha}:index.html`], { cwd: ROOT, encoding: 'utf8' });
    const v = /\?v=(\d+)/.exec(old)?.[1];
    if (v && !seen.has(Number(v))) seen.set(Number(v), sha.slice(0, 7));
  }
  return seen;
}

try {
  const version = Number([...versions][0]);
  const history = versionsInHistory();
  const highest = Math.max(0, ...history.keys());

  if (history.size === 0) {
    console.log('OK   版数の履歴が読めないので照合は省略した');
  } else if (version < highest) {
    fail(`版数 ${version} は過去に使った番号（最大 ${highest}、${history.get(highest)}）より小さい。`
      + `\n     同じ ?v= を別の中身で配ると、その番号を見たことがある端末が`
      + `\n     古いJSを使い続けて壊れる（index.html だけ新しくなるため）。`
      + `\n     ${highest} より大きい番号にすること。`);
  } else if (history.has(version)) {
    fail(`版数 ${version} は ${history.get(version)} で既に配信済み。中身が違うなら別の番号にすること。`);
  } else {
    console.log(`OK   版数 ${version} は未使用（過去の最大は ${highest}）`);
  }
} catch (err) {
  // Gitが無い環境や、履歴を持たない複製で動かすこともある。そこは止めない。
  console.log(`OK   版数の履歴を照合できなかったので省略した（${err.message.split('\n')[0]}）`);
}

console.log(problems === 0 ? '\nすべて通りました。' : `\n${problems}件の問題があります。`);
process.exit(problems === 0 ? 0 : 1);

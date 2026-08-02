// img/character/ に置いた配布素材から、サイトが実際に使う画像とキャラクター一覧を作る。
//
//   npm install --no-save sharp
//   node scripts/build-characters.mjs          画像と一覧を作り直す
//   node scripts/build-characters.mjs --dry    読み取り結果だけを表示する
//
// 作られるもの:
//   img/characters/<キャラID>/<スキンID>.webp     240px 角・選ぶ画面の一覧用
//   img/characters/<キャラID>/<スキンID>@lg.webp  長辺480px・大きく見せる用
//   js/characterData.js                            上の一覧（IDと名前の対応表）
//
// なぜ変換が要るか:
//   img/character/ に入っているのは配布された元素材で、合計2.3GB・1枚が最大145MBある。
//   Cloudflare Pages は1ファイル25MBまでなので、そのまま置くとデプロイが落ちる。
//   落ちなかったとしても、選ぶ画面に何百MBも流すわけにはいかない。
//   元素材は .assetsignore と .gitignore で配信にもGitにも載せず、ここで作った
//   軽い複製だけを配る（img/README.md の「軽くすること」と同じ考え方）。
//
// 元素材を足したり差し替えたりしたら、このスクリプトを流し直すこと。
// ASSET_VERSION は自動で1つ上がる（img/ は _headers で1年キャッシュされるので、
// URLが変わらないと更新が届かない）。
//
// なお img/character/ は普段この作業機に置いていない（2.3GB あり、Gitにも配信にも
// 載らないので、置いたままにする意味が無い）。流し直すときだけ配布元から取り直す。
// 出来上がりの img/characters/ と js/characterData.js はGitに入っているので、
// 素材が無くてもサイトはそのまま動く。

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'img', 'character');
const OUT_DIR = path.join(ROOT, 'img', 'characters');
const CATALOG = path.join(ROOT, 'js', 'characterData.js');

const DRY = process.argv.includes('--dry');

// ---------------------------------------------------------------------------
// 1. ファイル名からキャラクターとスキンを読み取る
// ---------------------------------------------------------------------------

// 配布素材のファイル名は開発中の内部名で付けられていて、公開されている
// キャラクター名と一致しない（ソフィア＝SnowWhite、S-17＝Athena など）。
// フォルダ名のほうが正しいので、ファイル名側に出てくる別名はここで捨てる。
//
// 新しいキャラクターのフォルダを足したら、ここにも足すこと
// （足し忘れは buildCatalog が例外で知らせる）。
const ALIASES = {
  alice: ['alice', '爱丽丝'],
  chilli: ['chilli', 'redhat'],
  'cookie-can': ['cookiecan', 'piepiecan', 'cookie', 'piepie', 'can', '饼饼'],
  cupid: ['cupid'],
  drake: ['drake', 'derek'],
  foxx: ['foxx', 'doctor'],
  goshion: ['goshion', 'ゴウシオン'],
  gwynn: ['gwynn', '格温'],
  heracles: ['heracles'],
  icey: ['icey'],
  lan: ['lan'],
  macaron: ['macaron', 'macalon'],
  magician: ['magician'],
  mikko: ['mikko', 'yeti'],
  'mr-5': ['mr.5', 'mr. 5', 'mr5', 'smith', '5号特工'],
  's-17': ['s-17', 's17', 'athena'],
  sandy: ['sandy', 'sandboy'],
  seaya: ['seaya', 'mermaidprincess'],
  sivi: ['sivi'],
  sophia: ['sophia', 'snowwhite'],
  tarara: ['tarara'],
  thanatos: ['thanatos', '塔纳托斯'],
  tina: ['tina', 'alita'],
  tong: ['tong'],
  tutu: ['tutu'],
  yuri: ['yuri'],
};

// スキン名とは関係のない、素材の作られ方だけを表す語。
// 「_Poster」「拷贝（コピー）」「Recovered」が混ざったままだと、
// 同じスキンが別物として並んでしまう。
//
// 語ではなく文字列として消す。ファイル名の区切りは統一されておらず
// （"RedHat" "Red_Hat" "Sport_Poster2"）、語に割ってから消すのでは取りこぼす。
const NOISE = [
  // "StandardSS" は "standard" より先に消す（先に短いほうを消すと "SS" が残る）。
  // NOISE は長い順に適用するので、並べる順序ではなく字数で決まる。
  'standardss', 'character', 'poster', 'render', 'standard', 'recovered',
  'polish', 'copy', '拷贝', '修改', 'skin', 'new', 'gai',
];

// 末尾に付く色違いの記号。同じスキンの色替えなので、スキンは1つにまとめて
// この記号を「色」として持たせる。
const COLORS = {
  bk: '黒', bu: '青', gn: '緑', pk: '桃', pl: '紫', wt: '白',
  gy: '灰', og: '橙', yl: '黄', rd: '赤', vl: '菫', bn: '茶',
};

// 中国語で色を書いてある素材（マカロンの「红」シリーズ、ソフィアの剣道など）。
// これも色違いなので、上の記号と同じ扱いにする。捨ててしまうと4枚の色違いが
// 「同じ名前の別カット」として並び、どれがどれだか分からなくなる。
// 値は [ファイル名に使う印, 画面に出す名前]。ファイル名にそのまま使うと
// URLがパーセント記号だらけになるので、印だけは英字にしておく。
const CJK_COLORS = {
  白紫色: ['wtpl', '白紫'], 橙黑色: ['ogbk', '橙黒'], 粉色: ['pk', '桃'],
  黑色: ['bk', '黒'], 棕色: ['bn', '茶'], 白色: ['wt', '白'],
  绿色: ['gn', '緑'], 蓝色: ['bu', '青'],
  // 「换色1」＝色替え1。名前が付いていないので、番号のまま出す
  换色: ['c', '色'],
};

// 中国語だけで名付けられた素材。読み取れないので、ここで対応を持つ。
const CJK_SKINS = {
  星浪潮: 'starwaves',
  竞技场幻彩: 'arena',
  星光遗迹: 'starlight-ruins',
};

// ファイル名からはスキン名が読み取れないもの。素材の名前が中身を表す語を
// 1つも含んでいない場合に、ここで名指しする。
const OVERRIDES = {
  'Icey_Skin_Poster修改.png': 'frost',
  'Sivi.png': 'wolf-spirit',
  'Tarara_recolored.png': 'muse',
};

// フォルダ名は「英語名 日本語名」（例: "Sivi シビ"）。
// 日本語が無いフォルダ（ICEY・Mr.5）もあるので、最初のCJK文字で切る。
function splitFolderName(name) {
  const at = name.search(/[\u3040-\u30ff\u4e00-\u9fff]/);
  if (at < 0) return { en: name.trim(), ja: name.trim() };
  return { en: name.slice(0, at).trim(), ja: name.slice(at).trim() };
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// 正規表現に入れる文字列を、そのままの文字として扱わせる（"Mr.5" の "." など）。
function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ファイル名からスキンを読み取る。返すのは { key, color }。
// 例: "Character_Sivi_FoolBU.png" → { key: 'fool', color: 'bu' }
function parseSkin(fileName, charId) {
  if (OVERRIDES[fileName]) return { key: OVERRIDES[fileName], color: null };

  // 版数（"2.0"）は先に落とす。このあと色の通し番号を数字で拾うので、
  // 残しておくと "白紫色2.0" の 2 を色番号として読んでしまう。
  let base = fileName.replace(/\.png$/i, '').replace(/\d+\.\d+/g, ' ');

  // 中国語で書かれた色は、消す前に拾っておく（"换色1" のような通し番号付きも拾う）。
  let cjkColor = null;
  for (const [word, [mark, label]] of Object.entries(CJK_COLORS)) {
    const hit = new RegExp(`${word}(\\d*)`).exec(base);
    if (!hit) continue;
    cjkColor = { id: mark + hit[1], label: label + hit[1] };
    base = base.replace(hit[0], ' ');
    break;
  }

  // 別名と余計な語を、語に割る前に文字列として消す。
  // 割ってからでは "RedHat" が Red と Hat に分かれて別名と一致しなくなる。
  // 長いものを先に消す（"Cookie" を先に消すと "PiepieCan" が拾えなくなる）。
  const strip = [...(ALIASES[charId] ?? []), ...NOISE]
    .sort((a, b) => b.length - a.length);
  for (const word of strip) {
    base = base.replace(new RegExp(escapeRe(word), 'gi'), ' ');
  }

  // 通し番号・版数を落とす（"(1)" "2.0"）。語に付いた数字もここで落ちる
  // （"Poster2" は "Poster" を消したあと "2" だけが残る）。
  base = base.replace(/\d+\.\d+/g, ' ').replace(/\d+/g, ' ');

  // 語に割る。区切りは記号のほか、camelCase の切れ目でも割る
  // （"WolfSpirit" → wolf spirit。ここで割らないと語ごとの判定ができない）。
  const words = base
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[_\-&\s.()]+/)
    .map((w) => w.trim())
    .filter(Boolean);

  // 中国語だけで名付けられた素材は、別名を消すと題だけが残る
  const cjk = words.find((w) => CJK_SKINS[w]);
  if (cjk) return { key: CJK_SKINS[cjk], color: cjkColor };

  // 末尾の色記号を切り出す。"SpaceBU" は camelCase では割れない（BUが両方大文字）
  // ので語の末尾2文字を見るが、"GN" のように1語で独立していることもある。
  let color = cjkColor;
  if (!color && words.length) {
    const last = words[words.length - 1];
    const tail = last.slice(-2).toLowerCase();
    if (COLORS[tail] && /[A-Z]{2}$/.test(last)) {
      color = { id: tail, label: COLORS[tail] };
      if (last.length === 2) words.pop();
      else words[words.length - 1] = last.slice(0, -2);
    }
  }

  // 何も残らなかったものは、そのキャラクターの既定の姿
  // （"Cupid_Default" と "Character_Cupid_StandardSS" はどちらもこれになる）。
  const key = slugify(words.join('-')) || 'default';
  return { key, color };
}

// ---------------------------------------------------------------------------
// 2. 読み取った結果を一覧に組み立てる
// ---------------------------------------------------------------------------

// スキンの表示名。ファイル名から機械的に作ると "Highscoregal" のような
// 読みにくい字面になるので、日本語をここで持つ。
// 対応が無いものは英語のまま出す（動かなくなるより、英語で出るほうがよい）。
const SKIN_LABELS = {
  default: 'デフォルト',
  // 季節・催し
  halloween: 'ハロウィン', summer: 'サマー', 'spring-poem': '春の詩',
  'warm-winter': 'ウォームウィンター', snow: 'スノー', skiing: 'スキー',
  'spring-festival': '春節', auspicious: '福来', picnic: 'ピクニック',
  swimming: 'スイミング', sport: 'スポーツ', hockey: 'ホッケー',
  'plum-on-snow': '雪中梅', race: 'レース', gift: 'ギフト',
  // 世界観
  universe: 'ユニバース', space: 'スペース', starwaves: '星の波',
  'starlight-ruins': '星光の遺跡', 'alter-verse': 'オルタバース',
  'cyber-fantasy': 'サイバーファンタジー', arena: 'アリーナ幻彩',
  'deep-sea-weapon': '深海兵装', soul: 'ソウル', arcade: 'アーケード',
  frost: 'フロスト', dsa: 'DSA',
  // 役どころ
  warrior: 'ウォリアー', 'warrior-saint': '武聖', knight: 'ナイト',
  detective: 'ディテクティブ', maid: 'メイド', doctor: 'ドクター',
  rider: 'ライダー', justice: 'ジャスティス', pirate: 'パイレーツ',
  'ace-agent': 'エースエージェント', hermit: '仙人', servant: 'サーヴァント',
  gladiator: 'グラディエーター', 'idol-trainee': '練習生', muse: 'ミューズ',
  'star-producer': 'スタープロデューサー', 'kitty-chef': 'キティシェフ',
  musicman: 'ミュージックマン', 'night-watcher': 'ナイトウォッチャー',
  shamman: 'シャーマン', 'financial-giant': 'フィナンシャルジャイアント',
  money: 'マネー', playernumberone: 'プレイヤーNo.1',
  highscoregal: 'ハイスコアギャル', valkyrie: 'ヴァルキリー',
  // 生き物・姿
  cat: 'キャット', frog: 'フロッグ', rainyfrog: 'レイニーフロッグ',
  'demonic-fox': '妖狐', phoenix: 'フェニックス', 'red-lion': 'レッドライオン',
  'wolf-spirit': 'ウルフスピリット', 'golden-snake': 'ゴールデンスネーク',
  'azura-gragon': 'アズラドラゴン', 'dragon-slayer': 'ドラゴンスレイヤー',
  goat: 'ゴート', bunny: 'バニー', 'dino-cub': 'ダイノカブ',
  'squirrel-cub': 'スクワールカブ', angel: 'エンジェル', silhouette: 'シルエット',
  rex: 'レックス', 'little-bee': 'リトルビー', strength: 'ストレングス',
  sarvainai: 'サルヴァイナイ', thor: 'トール', hipnos: 'ヒプノス',
  fool: 'フール', tribe: 'トライブ',
  // 服装・小物
  kendo: '剣道', jk: 'JK', jks: 'JKセーラー', 'meow-jk': 'にゃんこJK',
  dreadlock: 'ドレッドロック', mojito: 'モヒート', mocha: 'モカ',
  cocktail: 'カクテル', popcorn: 'ポップコーン', pizza: 'ピザ',
  'green-apple': 'グリーンアップル', inca: 'インカ',
  chinoiserie: 'シノワズリ', 'party-tricks': 'パーティトリック',
  'grey-suit': 'グレースーツ', 'gray-suit': 'グレースーツ',
  // 色だけで名付けられているもの
  red: 'レッド', blue: 'ブルー', green: 'グリーン', purple: 'パープル',
  pink: 'ピンク', yellow: 'イエロー', white: 'ホワイト', gray: 'グレー',
  grey: 'グレー', black: 'ブラック',
};

function skinLabel(key) {
  if (SKIN_LABELS[key]) return SKIN_LABELS[key];
  // 対応表に無いものは "wolf-spirit" → "Wolf Spirit"
  return key.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function buildCatalog() {
  const characters = [];

  // 素材は普段置いていない。ENOENT をそのまま投げると何が足りないのか分からないので、
  // ここで何をすればいいかまで書いて止める。
  if (!existsSync(SRC_DIR)) {
    throw new Error(
      `${path.relative(ROOT, SRC_DIR)} がありません。\n`
      + '配布素材（2.3GB）は容量が大きいため普段は置いていません。作り直すときだけ、\n'
      + '配布元から img/character/<英語名 日本語名>/ の形で取り直してから流してください。\n'
      + 'サイトが読むのは img/characters/（生成済み・Git管理下）なので、\n'
      + '作り直す用事が無ければこのスクリプトを流す必要はありません。',
    );
  }

  // 大文字小文字を区別せずに並べる（そのままだと "foxx" だけ最後に回る）
  const folders = readdirSync(SRC_DIR)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  for (const folder of folders) {
    const dir = path.join(SRC_DIR, folder);
    const files = readdirSync(dir).filter((f) => /\.png$/i.test(f)).sort();
    if (!files.length) continue;

    const { en, ja } = splitFolderName(folder);
    const id = slugify(en);
    if (!ALIASES[id]) {
      throw new Error(`フォルダ "${folder}" のキャラID "${id}" が ALIASES にありません。`
        + '新しいキャラクターを足したら、このスクリプトの ALIASES にも足してください。');
    }

    // 同じスキンの色違い・別カットをまとめる
    const skins = new Map();
    for (const file of files) {
      const { key, color } = parseSkin(file, id);
      if (!skins.has(key)) skins.set(key, { key, label: skinLabel(key), variants: [] });
      const skin = skins.get(key);

      // 色違いは <スキン>-<色>。色の指定が無い絵が同じスキンに2枚以上あるときは
      // 別カット（同じ服装の描き下ろし）なので、連番で分ける。
      let variantId = color ? `${key}-${color.id}` : key;
      if (skin.variants.some((v) => v.id === variantId)) {
        let n = 2;
        while (skin.variants.some((v) => v.id === `${variantId}-${n}`)) n += 1;
        variantId = `${variantId}-${n}`;
      }

      skin.variants.push({
        id: variantId,
        color: color?.label ?? null,
        src: path.join(dir, file),
      });
    }

    characters.push({ id, name: ja, nameEn: en, skins: [...skins.values()] });
  }

  return characters;
}

// 「そのキャラクターと言えばこれ」の1枚。キャラクター単位で1枚だけ要る場所
// （選ぶ画面の見出し、選手カードの背景）で使う。
function pickRepresentative(character) {
  const skin = character.skins.find((s) => s.key === 'default') ?? character.skins[0];
  return skin.variants[0].id;
}

// ---------------------------------------------------------------------------
// 3. 画像を書き出す
// ---------------------------------------------------------------------------

// 選ぶ画面の一覧用。角の正方形に収める。切り抜かずに全身を入れるのは、
// 同じキャラクターのスキン違いを見分ける手がかりが服装＝全身にあるため。
const THUMB = 240;
// 大きく見せる用。長辺だけを決めて、縦横比はそのまま残す。
const LARGE = 480;

async function writeImages(characters) {
  const { default: sharp } = await import('sharp');

  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });

  let count = 0;
  let bytes = 0;

  for (const character of characters) {
    const dir = path.join(OUT_DIR, character.id);
    mkdirSync(dir, { recursive: true });

    for (const skin of character.skins) {
      for (const variant of skin.variants) {
        // 配布素材は周囲に大きな透明の余白を持っている。落としてから縮めないと
        // 絵の中でキャラクターが小さくなってしまう（img/README.md と同じ話）。
        const trimmed = sharp(variant.src).trim({ threshold: 1 });

        const thumb = await trimmed.clone()
          .resize({
            width: THUMB,
            height: THUMB,
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          })
          .webp({ quality: 72 })
          .toBuffer();

        const large = await trimmed.clone()
          .resize({ width: LARGE, height: LARGE, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 74 })
          .toBuffer();

        writeFileSync(path.join(dir, `${variant.id}.webp`), thumb);
        writeFileSync(path.join(dir, `${variant.id}@lg.webp`), large);
        count += 2;
        bytes += thumb.length + large.length;
      }
    }
    const total = character.skins.reduce((n, s) => n + s.variants.length, 0);
    process.stdout.write(`  ${character.id.padEnd(12)} ${character.skins.length}スキン / ${total}枚\n`);
  }

  return { count, bytes };
}

// ---------------------------------------------------------------------------
// 4. 一覧をJSモジュールとして書き出す
// ---------------------------------------------------------------------------

function writeCatalog(characters, version) {
  const entries = characters.map((c) => {
    const skins = c.skins.map((s) => {
      const variants = s.variants
        .map((v) => `        { id: '${v.id}'${v.color ? `, color: '${v.color}'` : ''} },`)
        .join('\n');
      return `      {\n        key: '${s.key}',\n        label: '${s.label}',\n`
        + `        variants: [\n${variants}\n        ],\n      },`;
    }).join('\n');

    return `  {\n    id: '${c.id}',\n    name: '${c.name}',\n`
      + `    nameEn: '${c.nameEn.replace(/'/g, "\\'")}',\n`
      + `    representative: '${pickRepresentative(c)}',\n`
      + `    skins: [\n${skins}\n    ],\n  },`;
  }).join('\n');

  const source = `// キャラクターとスキンの一覧。
//
// 【自動生成】直接編集しないこと。img/character/ の配布素材から
// \`node scripts/build-characters.mjs\` が作り直す。名前を直したいときは、
// あのスクリプトの SKIN_LABELS や OVERRIDES を直してから流し直す。
//
// 画像は img/characters/<キャラID>/<スキンID>.webp（一覧用の角240px）と
// 同 @lg.webp（長辺480px）にある。URLの組み立ては js/characters.js。

// img/ は _headers で1年キャッシュされる。素材を作り直したらこの数字を上げること
// （上げないと、見ている人のブラウザが古い画像を使い続ける）。
// index.html の ?v= とは別に持つ ── 画像はCSSやJSと違い、毎回のデプロイで
// 変わるものではないため。参照側に付け忘れていないかは
// scripts/check-cache-version.mjs が見る。
export const ASSET_VERSION = ${version};

export const CHARACTERS = [
${entries}
];
`;

  writeFileSync(CATALOG, source);
}

// 版数は既存のファイルから引き継いで1つ上げる。
function nextVersion() {
  if (!existsSync(CATALOG)) return 1;
  const current = /export const ASSET_VERSION = (\d+)/.exec(readFileSync(CATALOG, 'utf8'))?.[1];
  return current ? Number(current) + 1 : 1;
}

// ---------------------------------------------------------------------------

const characters = buildCatalog();

if (DRY) {
  for (const c of characters) {
    console.log(`${c.id}  (${c.name} / ${c.nameEn})  代表: ${pickRepresentative(c)}`);
    for (const s of c.skins) {
      const colors = s.variants.map((v) => v.color ?? '—').join(' ');
      console.log(`    ${s.key.padEnd(20)} ${s.label.padEnd(16)} [${s.variants.length}] ${colors}`);
    }
  }
  const total = characters.reduce(
    (n, c) => n + c.skins.reduce((m, s) => m + s.variants.length, 0), 0,
  );
  console.log(`\nキャラクター ${characters.length}人 / 画像 ${total}枚`);
  process.exit(0);
}

const version = nextVersion();
console.log(`画像を書き出しています（版数 ${version}）...`);
const { count, bytes } = await writeImages(characters);
writeCatalog(characters, version);
console.log(`\n${count}ファイル / ${(bytes / 1024 / 1024).toFixed(1)}MB を img/characters/ に書き出しました。`);
console.log(`js/characterData.js を更新しました（ASSET_VERSION = ${version}）。`);

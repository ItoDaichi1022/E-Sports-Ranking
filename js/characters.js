// キャラクターとスキンの一覧を引くための道具。
//
// 一覧そのもの（js/characterData.js）は配布素材から自動生成される。こちらは
// 手で書く側で、「保存された文字列」と「画像のURL・表示名」の間を取り持つ。
//
// 【プロフィールに保存される形】
//   "sivi:wolf-spirit"  ＝ キャラID : スキン（色違いまで含めた1枚）のID
//   "シビ"               ＝ この仕組みより前に、文字で入力された使用キャラ
//
// 後者をそのまま残しているのは、選ぶ画面ができる前に登録した人の内容を
// 消さないため。読めない文字列は「絵の無いキャラクター」として、文字だけ出す。

import { CHARACTERS, ASSET_VERSION } from './characterData.js';
import { escapeHtml } from './util.js';

export { CHARACTERS };

// id から引く索引。一覧は25人・225枚しかないので、起動時に一度作れば足りる。
const BY_ID = new Map(CHARACTERS.map((c) => [c.id, c]));

// 画像1枚（色違いまで確定したもの）を、キャラクターとスキンごと引けるようにする。
const VARIANTS = new Map();
for (const character of CHARACTERS) {
  for (const skin of character.skins) {
    for (const variant of skin.variants) {
      VARIANTS.set(`${character.id}:${variant.id}`, { character, skin, variant });
    }
  }
}

export function getCharacter(id) {
  return BY_ID.get(id) ?? null;
}

// 保存された文字列を読み解く。
//
// 返すのは必ずオブジェクトで、絵が引けたかどうかは known で表す。
// null を返さないのは、呼び出し側が「読めなかった場合」を書き忘れて
// 画面から古い登録内容が消えてしまうのを防ぐため。
export function parseCharacterRef(value) {
  const text = (value ?? '').trim();
  if (!text) return null;

  const found = VARIANTS.get(text);
  if (!found) return { known: false, ref: text, label: text };

  const { character, skin, variant } = found;
  return {
    known: true,
    ref: text,
    characterId: character.id,
    name: character.name,
    skinLabel: skin.label,
    color: variant.color ?? null,
    // 「シビ（ウルフスピリット・青）」
    label: `${character.name}（${skin.label}${variant.color ? `・${variant.color}` : ''}）`,
    variantId: variant.id,
  };
}

// キャラクターの代表画像を指す文字列。キャラクターだけが分かっていて
// スキンまでは決まっていないとき（一覧の見出しなど）に使う。
export function representativeRef(character) {
  return `${character.id}:${character.representative}`;
}

// 画像のURL。size は 'thumb'（角240px・一覧用）か 'large'（長辺480px）。
//
// ?v= を必ず付ける。img/ は _headers で1年キャッシュされる場所なので、
// 付けずに配ると素材を作り直しても新しい絵が届かなくなる。
export function characterImageUrl(ref, size = 'thumb') {
  const parsed = typeof ref === 'string' ? parseCharacterRef(ref) : ref;
  if (!parsed?.known) return null;
  const suffix = size === 'large' ? '@lg' : '';
  return `img/characters/${parsed.characterId}/${parsed.variantId}${suffix}.webp?v=${ASSET_VERSION}`;
}

// 名前で絞り込む。日本語名・英語名・スキン名のどれに当たっても拾う
// （「シビ」でも「sivi」でも「ウルフ」でも出したい）。
export function searchCharacters(query) {
  const q = query.trim().toLowerCase();
  if (!q) return CHARACTERS;
  return CHARACTERS.filter((c) => c.name.toLowerCase().includes(q)
    || c.nameEn.toLowerCase().includes(q)
    || c.id.includes(q)
    || c.skins.some((s) => s.label.toLowerCase().includes(q) || s.key.includes(q)));
}

// ---------------------------------------------------------------------------
// 表示に使う部品
// ---------------------------------------------------------------------------
//
// 選ぶ画面（js/characterPicker.js）とは分けてある。一覧に絵を敷くだけの場所から
// あのダイアログ一式を読み込ませないため。

// 選手ページに、名前と絵を並べた「使用キャラクター」の項目は出さない。
// 選んだキャラクターの見せ場は背景（js/app.js の playerArtHtml）と
// 一覧の行（下の characterRowArtHtml）の2つで、札を並べると同じ絵が重なる。

// 一覧の行（ランキング・選手検索）の右端に敷く、その人のメインキャラクター。
//
// 表の中なので、絵は情報ではなく「その行の地の色」として扱う。行の高さは
// 変えず、名前とスコアの読みやすさも壊さない濃さまで落とす（CSSの .row-art）。
// 登録していない人の行には何も出さない ── 代わりの絵を置くと、選んでいない人まで
// 選んだように見えてしまう。
//
// <img> で置くのは、画面に入るまで読み込ませないため（CSSの背景画像にすると、
// 60人並ぶランキングで全員ぶんを一度に取りに行ってしまう）。
export function characterRowArtHtml(mainCharacters) {
  const url = characterImageUrl(mainCharacters?.[0], 'thumb');
  if (!url) return '';
  return `<span class="row-art" aria-hidden="true">`
    + `<img src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async"></span>`;
}

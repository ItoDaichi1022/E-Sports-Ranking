// キャラクターとスキンの一覧。
//
// 【自動生成】直接編集しないこと。img/character/ の配布素材から
// `node scripts/build-characters.mjs` が作り直す。名前を直したいときは、
// あのスクリプトの SKIN_LABELS や OVERRIDES を直してから流し直す。
//
// 画像は img/characters/<キャラID>/<スキンID>.webp（一覧用の角240px）と
// 同 @lg.webp（長辺480px）にある。URLの組み立ては js/characters.js。

// img/ は _headers で1年キャッシュされる。素材を作り直したらこの数字を上げること
// （上げないと、見ている人のブラウザが古い画像を使い続ける）。
// index.html の ?v= とは別に持つ ── 画像はCSSやJSと違い、毎回のデプロイで
// 変わるものではないため。参照側に付け忘れていないかは
// scripts/check-cache-version.mjs が見る。
export const ASSET_VERSION = 1;

export const CHARACTERS = [
  {
    id: 'alice',
    name: 'アリス',
    nameEn: 'Alice',
    representative: 'default',
    skins: [
      {
        key: 'default',
        label: 'デフォルト',
        variants: [
        { id: 'default' },
        ],
      },
      {
        key: 'hipnos',
        label: 'ヒプノス',
        variants: [
        { id: 'hipnos' },
        ],
      },
      {
        key: 'purple',
        label: 'パープル',
        variants: [
        { id: 'purple' },
        ],
      },
      {
        key: 'rainyfrog',
        label: 'レイニーフロッグ',
        variants: [
        { id: 'rainyfrog' },
        ],
      },
      {
        key: 'spring-poem',
        label: '春の詩',
        variants: [
        { id: 'spring-poem' },
        ],
      },
      {
        key: 'summer',
        label: 'サマー',
        variants: [
        { id: 'summer' },
        { id: 'summer-gn', color: '緑' },
        { id: 'summer-og', color: '橙' },
        { id: 'summer-pk', color: '桃' },
        { id: 'summer-wt', color: '白' },
        ],
      },
      {
        key: 'warm-winter',
        label: 'ウォームウィンター',
        variants: [
        { id: 'warm-winter' },
        ],
      },
      {
        key: 'starwaves',
        label: '星の波',
        variants: [
        { id: 'starwaves' },
        ],
      },
    ],
  },
  {
    id: 'chilli',
    name: 'チリ',
    nameEn: 'Chilli',
    representative: 'default',
    skins: [
      {
        key: 'halloween',
        label: 'ハロウィン',
        variants: [
        { id: 'halloween-bu', color: '青' },
        { id: 'halloween-gn', color: '緑' },
        { id: 'halloween-pk', color: '桃' },
        { id: 'halloween-pl', color: '紫' },
        { id: 'halloween' },
        ],
      },
      {
        key: 'default',
        label: 'デフォルト',
        variants: [
        { id: 'default' },
        ],
      },
      {
        key: 'picnic',
        label: 'ピクニック',
        variants: [
        { id: 'picnic' },
        ],
      },
      {
        key: 'sport',
        label: 'スポーツ',
        variants: [
        { id: 'sport' },
        ],
      },
      {
        key: 'tribe',
        label: 'トライブ',
        variants: [
        { id: 'tribe' },
        ],
      },
    ],
  },
  {
    id: 'cookie-can',
    name: 'クッキー&カン',
    nameEn: 'Cookie & Can',
    representative: 'default',
    skins: [
      {
        key: 'default',
        label: 'デフォルト',
        variants: [
        { id: 'default' },
        { id: 'default-2' },
        ],
      },
      {
        key: 'purple',
        label: 'パープル',
        variants: [
        { id: 'purple' },
        ],
      },
      {
        key: 'kitty-chef',
        label: 'キティシェフ',
        variants: [
        { id: 'kitty-chef' },
        ],
      },
      {
        key: 'doctor',
        label: 'ドクター',
        variants: [
        { id: 'doctor' },
        ],
      },
      {
        key: 'arena',
        label: 'アリーナ幻彩',
        variants: [
        { id: 'arena' },
        ],
      },
    ],
  },
  {
    id: 'cupid',
    name: 'キューピッド',
    nameEn: 'Cupid',
    representative: 'default',
    skins: [
      {
        key: 'default',
        label: 'デフォルト',
        variants: [
        { id: 'default' },
        { id: 'default-2' },
        ],
      },
      {
        key: 'angel',
        label: 'エンジェル',
        variants: [
        { id: 'angel' },
        ],
      },
      {
        key: 'bunny',
        label: 'バニー',
        variants: [
        { id: 'bunny' },
        ],
      },
      {
        key: 'dino-cub',
        label: 'ダイノカブ',
        variants: [
        { id: 'dino-cub' },
        ],
      },
      {
        key: 'mocha',
        label: 'モカ',
        variants: [
        { id: 'mocha' },
        ],
      },
      {
        key: 'squirrel-cub',
        label: 'スクワールカブ',
        variants: [
        { id: 'squirrel-cub' },
        ],
      },
      {
        key: 'auspicious',
        label: '福来',
        variants: [
        { id: 'auspicious' },
        ],
      },
      {
        key: 'musicman',
        label: 'ミュージックマン',
        variants: [
        { id: 'musicman' },
        ],
      },
    ],
  },
  {
    id: 'drake',
    name: 'ドレイク',
    nameEn: 'Drake',
    representative: 'default',
    skins: [
      {
        key: 'arcade',
        label: 'アーケード',
        variants: [
        { id: 'arcade-bu', color: '青' },
        { id: 'arcade-gn', color: '緑' },
        { id: 'arcade-pl', color: '紫' },
        { id: 'arcade-wt', color: '白' },
        ],
      },
      {
        key: 'blue',
        label: 'ブルー',
        variants: [
        { id: 'blue' },
        ],
      },
      {
        key: 'detective',
        label: 'ディテクティブ',
        variants: [
        { id: 'detective' },
        ],
      },
      {
        key: 'default',
        label: 'デフォルト',
        variants: [
        { id: 'default' },
        ],
      },
      {
        key: 'playernumberone',
        label: 'プレイヤーNo.1',
        variants: [
        { id: 'playernumberone' },
        ],
      },
    ],
  },
  {
    id: 'foxx',
    name: 'フォックス',
    nameEn: 'foxx',
    representative: 'default',
    skins: [
      {
        key: 'warrior',
        label: 'ウォリアー',
        variants: [
        { id: 'warrior' },
        ],
      },
      {
        key: 'spring-poem',
        label: '春の詩',
        variants: [
        { id: 'spring-poem' },
        ],
      },
      {
        key: 'default',
        label: 'デフォルト',
        variants: [
        { id: 'default' },
        ],
      },
    ],
  },
  {
    id: 'goshion',
    name: 'ゴウシオン',
    nameEn: 'Goshion',
    representative: 'default',
    skins: [
      {
        key: 'default',
        label: 'デフォルト',
        variants: [
        { id: 'default' },
        ],
      },
    ],
  },
  {
    id: 'gwynn',
    name: 'グウェン',
    nameEn: 'Gwynn',
    representative: 'default',
    skins: [
      {
        key: 'red',
        label: 'レッド',
        variants: [
        { id: 'red' },
        ],
      },
      {
        key: 'default',
        label: 'デフォルト',
        variants: [
        { id: 'default' },
        ],
      },
      {
        key: 'starwaves',
        label: '星の波',
        variants: [
        { id: 'starwaves' },
        ],
      },
    ],
  },
  {
    id: 'heracles',
    name: 'ヘラクレス',
    nameEn: 'Heracles',
    representative: 'default',
    skins: [
      {
        key: 'default',
        label: 'デフォルト',
        variants: [
        { id: 'default' },
        ],
      },
      {
        key: 'dragon-slayer',
        label: 'ドラゴンスレイヤー',
        variants: [
        { id: 'dragon-slayer' },
        ],
      },
      {
        key: 'goat',
        label: 'ゴート',
        variants: [
        { id: 'goat' },
        ],
      },
      {
        key: 'popcorn',
        label: 'ポップコーン',
        variants: [
        { id: 'popcorn' },
        ],
      },
      {
        key: 'red',
        label: 'レッド',
        variants: [
        { id: 'red' },
        ],
      },
      {
        key: 'shamman',
        label: 'シャーマン',
        variants: [
        { id: 'shamman' },
        ],
      },
      {
        key: 'warrior',
        label: 'ウォリアー',
        variants: [
        { id: 'warrior' },
        ],
      },
    ],
  },
  {
    id: 'icey',
    name: 'ICEY',
    nameEn: 'ICEY',
    representative: 'default',
    skins: [
      {
        key: 'default',
        label: 'デフォルト',
        variants: [
        { id: 'default' },
        { id: 'default-2' },
        ],
      },
      {
        key: 'warrior',
        label: 'ウォリアー',
        variants: [
        { id: 'warrior' },
        ],
      },
      {
        key: 'frost',
        label: 'フロスト',
        variants: [
        { id: 'frost' },
        ],
      },
    ],
  },
  {
    id: 'lan',
    name: '嵐',
    nameEn: 'Lan',
    representative: 'default',
    skins: [
      {
        key: 'soul',
        label: 'ソウル',
        variants: [
        { id: 'soul-bk', color: '黒' },
        { id: 'soul-bu', color: '青' },
        { id: 'soul-rd', color: '赤' },
        { id: 'soul-yl', color: '黄' },
        ],
      },
      {
        key: 'azura-gragon',
        label: 'アズラドラゴン',
        variants: [
        { id: 'azura-gragon' },
        ],
      },
      {
        key: 'default',
        label: 'デフォルト',
        variants: [
        { id: 'default' },
        ],
      },
      {
        key: 'golden-snake',
        label: 'ゴールデンスネーク',
        variants: [
        { id: 'golden-snake' },
        ],
      },
      {
        key: 'night-watcher',
        label: 'ナイトウォッチャー',
        variants: [
        { id: 'night-watcher' },
        ],
      },
    ],
  },
  {
    id: 'macaron',
    name: 'マカロン',
    nameEn: 'Macaron',
    representative: 'default',
    skins: [
      {
        key: 'knight',
        label: 'ナイト',
        variants: [
        { id: 'knight' },
        ],
      },
      {
        key: 'default',
        label: 'デフォルト',
        variants: [
        { id: 'default' },
        ],
      },
      {
        key: 'inca',
        label: 'インカ',
        variants: [
        { id: 'inca' },
        ],
      },
      {
        key: 'purple',
        label: 'パープル',
        variants: [
        { id: 'purple' },
        ],
      },
      {
        key: 'red',
        label: 'レッド',
        variants: [
        { id: 'red-bn', color: '茶' },
        { id: 'red-wt', color: '白' },
        { id: 'red-gn', color: '緑' },
        { id: 'red-bu', color: '青' },
        ],
      },
      {
        key: 'skiing',
        label: 'スキー',
        variants: [
        { id: 'skiing' },
        ],
      },
      {
        key: 'spring-festival',
        label: '春節',
        variants: [
        { id: 'spring-festival' },
        ],
      },
      {
        key: 'swimming',
        label: 'スイミング',
        variants: [
        { id: 'swimming' },
        ],
      },
      {
        key: 'rex',
        label: 'レックス',
        variants: [
        { id: 'rex' },
        ],
      },
    ],
  },
  {
    id: 'magician',
    name: 'マジシャン',
    nameEn: 'Magician',
    representative: 'default',
    skins: [
      {
        key: 'warrior',
        label: 'ウォリアー',
        variants: [
        { id: 'warrior' },
        ],
      },
      {
        key: 'money',
        label: 'マネー',
        variants: [
        { id: 'money' },
        ],
      },
      {
        key: 'purple',
        label: 'パープル',
        variants: [
        { id: 'purple' },
        ],
      },
      {
        key: 'ace-agent',
        label: 'エースエージェント',
        variants: [
        { id: 'ace-agent' },
        ],
      },
      {
        key: 'default',
        label: 'デフォルト',
        variants: [
        { id: 'default' },
        ],
      },
      {
        key: 'financial-giant',
        label: 'フィナンシャルジャイアント',
        variants: [
        { id: 'financial-giant' },
        ],
      },
      {
        key: 'pirate',
        label: 'パイレーツ',
        variants: [
        { id: 'pirate' },
        ],
      },
      {
        key: 'starwaves',
        label: '星の波',
        variants: [
        { id: 'starwaves' },
        ],
      },
      {
        key: 'gift',
        label: 'ギフト',
        variants: [
        { id: 'gift' },
        ],
      },
    ],
  },
  {
    id: 'mikko',
    name: 'ミッコ',
    nameEn: 'Mikko',
    representative: 'default',
    skins: [
      {
        key: 'cat',
        label: 'キャット',
        variants: [
        { id: 'cat-bn', color: '茶' },
        { id: 'cat-gy', color: '灰' },
        { id: 'cat-og', color: '橙' },
        { id: 'cat-vl', color: '菫' },
        { id: 'cat' },
        { id: 'cat-2' },
        ],
      },
      {
        key: 'default',
        label: 'デフォルト',
        variants: [
        { id: 'default' },
        ],
      },
      {
        key: 'detective',
        label: 'ディテクティブ',
        variants: [
        { id: 'detective' },
        ],
      },
      {
        key: 'gladiator',
        label: 'グラディエーター',
        variants: [
        { id: 'gladiator' },
        ],
      },
      {
        key: 'purple',
        label: 'パープル',
        variants: [
        { id: 'purple' },
        ],
      },
      {
        key: 'sarvainai',
        label: 'サルヴァイナイ',
        variants: [
        { id: 'sarvainai' },
        ],
      },
      {
        key: 'thor',
        label: 'トール',
        variants: [
        { id: 'thor' },
        ],
      },
    ],
  },
  {
    id: 'mr-5',
    name: 'Mr.5',
    nameEn: 'Mr.5',
    representative: 'default',
    skins: [
      {
        key: 'arena',
        label: 'アリーナ幻彩',
        variants: [
        { id: 'arena' },
        ],
      },
      {
        key: 'default',
        label: 'デフォルト',
        variants: [
        { id: 'default' },
        ],
      },
      {
        key: 'grey-suit',
        label: 'グレースーツ',
        variants: [
        { id: 'grey-suit' },
        ],
      },
      {
        key: 'detective',
        label: 'ディテクティブ',
        variants: [
        { id: 'detective' },
        ],
      },
      {
        key: 'hermit',
        label: '仙人',
        variants: [
        { id: 'hermit' },
        ],
      },
    ],
  },
  {
    id: 's-17',
    name: 'S-17',
    nameEn: 'S-17',
    representative: 'default',
    skins: [
      {
        key: 'arena',
        label: 'アリーナ幻彩',
        variants: [
        { id: 'arena' },
        ],
      },
      {
        key: 'green',
        label: 'グリーン',
        variants: [
        { id: 'green' },
        ],
      },
      {
        key: 'space',
        label: 'スペース',
        variants: [
        { id: 'space' },
        { id: 'space-bk', color: '黒' },
        { id: 'space-bu', color: '青' },
        { id: 'space-gy', color: '灰' },
        { id: 'space-pl', color: '紫' },
        ],
      },
      {
        key: 'pizza',
        label: 'ピザ',
        variants: [
        { id: 'pizza' },
        ],
      },
      {
        key: 'default',
        label: 'デフォルト',
        variants: [
        { id: 'default' },
        ],
      },
      {
        key: 'gray',
        label: 'グレー',
        variants: [
        { id: 'gray' },
        ],
      },
      {
        key: 'maid',
        label: 'メイド',
        variants: [
        { id: 'maid' },
        ],
      },
      {
        key: 'alter-verse',
        label: 'オルタバース',
        variants: [
        { id: 'alter-verse' },
        ],
      },
      {
        key: 'deep-sea-weapon',
        label: '深海兵装',
        variants: [
        { id: 'deep-sea-weapon' },
        ],
      },
    ],
  },
  {
    id: 'sandy',
    name: 'サンディー',
    nameEn: 'Sandy',
    representative: 'default',
    skins: [
      {
        key: 'chinoiserie',
        label: 'シノワズリ',
        variants: [
        { id: 'chinoiserie' },
        ],
      },
      {
        key: 'detective',
        label: 'ディテクティブ',
        variants: [
        { id: 'detective' },
        ],
      },
      {
        key: 'blue',
        label: 'ブルー',
        variants: [
        { id: 'blue' },
        ],
      },
      {
        key: 'dsa',
        label: 'DSA',
        variants: [
        { id: 'dsa' },
        ],
      },
      {
        key: 'default',
        label: 'デフォルト',
        variants: [
        { id: 'default' },
        ],
      },
      {
        key: 'warrior',
        label: 'ウォリアー',
        variants: [
        { id: 'warrior' },
        ],
      },
      {
        key: 'pink',
        label: 'ピンク',
        variants: [
        { id: 'pink' },
        ],
      },
    ],
  },
  {
    id: 'seaya',
    name: 'シーヤ',
    nameEn: 'Seaya',
    representative: 'default',
    skins: [
      {
        key: 'warrior',
        label: 'ウォリアー',
        variants: [
        { id: 'warrior' },
        { id: 'warrior-2' },
        ],
      },
      {
        key: 'cyber-fantasy',
        label: 'サイバーファンタジー',
        variants: [
        { id: 'cyber-fantasy' },
        ],
      },
      {
        key: 'dsa',
        label: 'DSA',
        variants: [
        { id: 'dsa' },
        ],
      },
      {
        key: 'default',
        label: 'デフォルト',
        variants: [
        { id: 'default' },
        ],
      },
      {
        key: 'idol-trainee',
        label: '練習生',
        variants: [
        { id: 'idol-trainee' },
        ],
      },
      {
        key: 'snow',
        label: 'スノー',
        variants: [
        { id: 'snow' },
        ],
      },
    ],
  },
  {
    id: 'sivi',
    name: 'シビ',
    nameEn: 'Sivi',
    representative: 'default',
    skins: [
      {
        key: 'universe',
        label: 'ユニバース',
        variants: [
        { id: 'universe-bk', color: '黒' },
        { id: 'universe-bu', color: '青' },
        { id: 'universe-og', color: '橙' },
        { id: 'universe-pk', color: '桃' },
        { id: 'universe' },
        ],
      },
      {
        key: 'fool',
        label: 'フール',
        variants: [
        { id: 'fool-bu', color: '青' },
        { id: 'fool-gn', color: '緑' },
        { id: 'fool-pk', color: '桃' },
        { id: 'fool-wt', color: '白' },
        ],
      },
      {
        key: 'warrior',
        label: 'ウォリアー',
        variants: [
        { id: 'warrior' },
        ],
      },
      {
        key: 'wolf-spirit',
        label: 'ウルフスピリット',
        variants: [
        { id: 'wolf-spirit' },
        { id: 'wolf-spirit-2' },
        ],
      },
      {
        key: 'alter-verse',
        label: 'オルタバース',
        variants: [
        { id: 'alter-verse' },
        ],
      },
      {
        key: 'blue',
        label: 'ブルー',
        variants: [
        { id: 'blue' },
        ],
      },
      {
        key: 'default',
        label: 'デフォルト',
        variants: [
        { id: 'default' },
        ],
      },
      {
        key: 'gray',
        label: 'グレー',
        variants: [
        { id: 'gray' },
        ],
      },
      {
        key: 'party-tricks',
        label: 'パーティトリック',
        variants: [
        { id: 'party-tricks' },
        ],
      },
      {
        key: 'race',
        label: 'レース',
        variants: [
        { id: 'race' },
        ],
      },
      {
        key: 'red',
        label: 'レッド',
        variants: [
        { id: 'red' },
        ],
      },
      {
        key: 'yellow',
        label: 'イエロー',
        variants: [
        { id: 'yellow' },
        ],
      },
    ],
  },
  {
    id: 'sophia',
    name: 'ソフィア',
    nameEn: 'Sophia',
    representative: 'default',
    skins: [
      {
        key: 'rider',
        label: 'ライダー',
        variants: [
        { id: 'rider' },
        ],
      },
      {
        key: 'halloween',
        label: 'ハロウィン',
        variants: [
        { id: 'halloween' },
        ],
      },
      {
        key: 'kendo',
        label: '剣道',
        variants: [
        { id: 'kendo-wtpl', color: '白紫' },
        { id: 'kendo-ogbk', color: '橙黒' },
        { id: 'kendo-pk', color: '桃' },
        { id: 'kendo-bk', color: '黒' },
        { id: 'kendo' },
        ],
      },
      {
        key: 'space',
        label: 'スペース',
        variants: [
        { id: 'space' },
        ],
      },
      {
        key: 'blue',
        label: 'ブルー',
        variants: [
        { id: 'blue' },
        ],
      },
      {
        key: 'default',
        label: 'デフォルト',
        variants: [
        { id: 'default' },
        ],
      },
      {
        key: 'green-apple',
        label: 'グリーンアップル',
        variants: [
        { id: 'green-apple' },
        ],
      },
      {
        key: 'justice',
        label: 'ジャスティス',
        variants: [
        { id: 'justice' },
        ],
      },
      {
        key: 'little-bee',
        label: 'リトルビー',
        variants: [
        { id: 'little-bee' },
        ],
      },
      {
        key: 'meow-jk',
        label: 'にゃんこJK',
        variants: [
        { id: 'meow-jk' },
        ],
      },
    ],
  },
  {
    id: 'tarara',
    name: 'タララ',
    nameEn: 'Tarara',
    representative: 'default',
    skins: [
      {
        key: 'default',
        label: 'デフォルト',
        variants: [
        { id: 'default' },
        { id: 'default-2' },
        ],
      },
      {
        key: 'muse',
        label: 'ミューズ',
        variants: [
        { id: 'muse' },
        { id: 'muse-2' },
        ],
      },
      {
        key: 'summer',
        label: 'サマー',
        variants: [
        { id: 'summer' },
        { id: 'summer-2' },
        { id: 'summer-3' },
        { id: 'summer-4' },
        { id: 'summer-5' },
        ],
      },
      {
        key: 'maid',
        label: 'メイド',
        variants: [
        { id: 'maid' },
        ],
      },
      {
        key: 'highscoregal',
        label: 'ハイスコアギャル',
        variants: [
        { id: 'highscoregal' },
        ],
      },
    ],
  },
  {
    id: 'thanatos',
    name: 'タナトス',
    nameEn: 'Thanatos',
    representative: 'default',
    skins: [
      {
        key: 'default',
        label: 'デフォルト',
        variants: [
        { id: 'default' },
        { id: 'default-2' },
        ],
      },
      {
        key: 'halloween',
        label: 'ハロウィン',
        variants: [
        { id: 'halloween' },
        ],
      },
      {
        key: 'hockey',
        label: 'ホッケー',
        variants: [
        { id: 'hockey' },
        ],
      },
      {
        key: 'servant',
        label: 'サーヴァント',
        variants: [
        { id: 'servant' },
        ],
      },
      {
        key: 'silhouette',
        label: 'シルエット',
        variants: [
        { id: 'silhouette' },
        ],
      },
      {
        key: 'space',
        label: 'スペース',
        variants: [
        { id: 'space' },
        ],
      },
      {
        key: 'white',
        label: 'ホワイト',
        variants: [
        { id: 'white' },
        ],
      },
      {
        key: 'starlight-ruins',
        label: '星光の遺跡',
        variants: [
        { id: 'starlight-ruins' },
        { id: 'starlight-ruins-2' },
        ],
      },
    ],
  },
  {
    id: 'tina',
    name: 'ティナ',
    nameEn: 'Tina',
    representative: 'default',
    skins: [
      {
        key: 'dreadlock',
        label: 'ドレッドロック',
        variants: [
        { id: 'dreadlock-c1', color: '色1' },
        { id: 'dreadlock-c2', color: '色2' },
        { id: 'dreadlock-c3', color: '色3' },
        { id: 'dreadlock-c4', color: '色4' },
        { id: 'dreadlock' },
        ],
      },
      {
        key: 'green',
        label: 'グリーン',
        variants: [
        { id: 'green' },
        ],
      },
      {
        key: 'strength',
        label: 'ストレングス',
        variants: [
        { id: 'strength' },
        ],
      },
      {
        key: 'alter-verse',
        label: 'オルタバース',
        variants: [
        { id: 'alter-verse' },
        ],
      },
      {
        key: 'dsa',
        label: 'DSA',
        variants: [
        { id: 'dsa' },
        ],
      },
      {
        key: 'default',
        label: 'デフォルト',
        variants: [
        { id: 'default' },
        ],
      },
      {
        key: 'jk',
        label: 'JK',
        variants: [
        { id: 'jk' },
        ],
      },
      {
        key: 'mojito',
        label: 'モヒート',
        variants: [
        { id: 'mojito' },
        ],
      },
      {
        key: 'red-lion',
        label: 'レッドライオン',
        variants: [
        { id: 'red-lion' },
        ],
      },
      {
        key: 'star-producer',
        label: 'スタープロデューサー',
        variants: [
        { id: 'star-producer' },
        ],
      },
      {
        key: 'valkyrie',
        label: 'ヴァルキリー',
        variants: [
        { id: 'valkyrie' },
        ],
      },
    ],
  },
  {
    id: 'tong',
    name: 'トウ',
    nameEn: 'Tong',
    representative: 'default',
    skins: [
      {
        key: 'warrior',
        label: 'ウォリアー',
        variants: [
        { id: 'warrior' },
        ],
      },
      {
        key: 'default',
        label: 'デフォルト',
        variants: [
        { id: 'default' },
        ],
      },
      {
        key: 'demonic-fox',
        label: '妖狐',
        variants: [
        { id: 'demonic-fox' },
        ],
      },
      {
        key: 'green',
        label: 'グリーン',
        variants: [
        { id: 'green' },
        ],
      },
      {
        key: 'phoenix',
        label: 'フェニックス',
        variants: [
        { id: 'phoenix' },
        ],
      },
      {
        key: 'warrior-saint',
        label: '武聖',
        variants: [
        { id: 'warrior-saint' },
        ],
      },
    ],
  },
  {
    id: 'tutu',
    name: 'トゥトゥ',
    nameEn: 'Tutu',
    representative: 'default',
    skins: [
      {
        key: 'frog',
        label: 'フロッグ',
        variants: [
        { id: 'frog' },
        ],
      },
      {
        key: 'default',
        label: 'デフォルト',
        variants: [
        { id: 'default' },
        ],
      },
    ],
  },
  {
    id: 'yuri',
    name: 'ユリ',
    nameEn: 'Yuri',
    representative: 'default',
    skins: [
      {
        key: 'arcade',
        label: 'アーケード',
        variants: [
        { id: 'arcade' },
        ],
      },
      {
        key: 'jks',
        label: 'JKセーラー',
        variants: [
        { id: 'jks-bk', color: '黒' },
        { id: 'jks-bu', color: '青' },
        { id: 'jks-wt', color: '白' },
        { id: 'jks-yl', color: '黄' },
        { id: 'jks' },
        ],
      },
      {
        key: 'black',
        label: 'ブラック',
        variants: [
        { id: 'black' },
        ],
      },
      {
        key: 'cocktail',
        label: 'カクテル',
        variants: [
        { id: 'cocktail' },
        ],
      },
      {
        key: 'halloween',
        label: 'ハロウィン',
        variants: [
        { id: 'halloween' },
        ],
      },
      {
        key: 'jk',
        label: 'JK',
        variants: [
        { id: 'jk' },
        ],
      },
      {
        key: 'plum-on-snow',
        label: '雪中梅',
        variants: [
        { id: 'plum-on-snow' },
        ],
      },
      {
        key: 'default',
        label: 'デフォルト',
        variants: [
        { id: 'default' },
        ],
      },
      {
        key: 'starwaves',
        label: '星の波',
        variants: [
        { id: 'starwaves' },
        ],
      },
    ],
  },
];

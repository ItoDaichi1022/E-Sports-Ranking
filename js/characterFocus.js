// キャラクター画像の「顔（目のあたり）」がどこにあるかの表。
//
// 対戦表の選手行や一覧の行に敷く絵は、行の高さしか無い細長い窓から覗く形になる。
// 何も指定しないと画像の上端から切ることになり、素材によっては武器・帽子・
// 手だけが出て、肝心の顔が窓の外へ落ちる（配布素材のポーズはバラバラで、
// 顔が真ん中にある保証がまったく無い）。そこで1枚ずつ目の位置を持っておき、
// そこが窓の中心に来るように置く（使う側は js/characters.js の characterFocus）。
//
// 値は [x, y] で、画像の幅・高さに対する百分率。240px角の切り抜き
// （img/characters/<キャラID>/<スキンID>.webp）を目視で読み取ったもの。
// キーは保存される使用キャラクターの文字列と同じ "<キャラID>:<スキンID>"。
//
// 【載っていないキャラクターが出たら】既定値（顔は上のほう、という当て推量）で
// 表示されるだけで、壊れはしない。ただし外れることが多いので、
// キャラクターやスキンを足したら（scripts/build-characters.mjs を流したら）
// ここにも足すこと。抜けは `node scripts/check-cache-version.mjs` が知らせる。
//
// 読み取り方: 240px角の切り抜きを方眼に載せ、目の位置を百分率で読む。
// 行に出るのは絵のおよそ 幅40%×高さ24% ぶんなので、±5%ずれても顔は窓に収まる。
//
// 色違い（同じスキンの色替え）でも別々に持っている。色替えのつもりで
// ポーズごと描き直されている素材があり（alice の summer、s-17 の space など）、
// まとめると片方がずれるため。

export const DEFAULT_FOCUS = [50, 20];

export const CHARACTER_FOCUS = {
  // アリス
  'alice:default': [59, 21],
  'alice:hipnos': [58, 22],
  'alice:purple': [34, 16],
  'alice:rainyfrog': [59, 22],
  'alice:spring-poem': [46, 36],
  'alice:summer': [54, 50],
  'alice:summer-gn': [53, 50],
  'alice:summer-og': [52, 52],
  'alice:summer-pk': [53, 51],
  'alice:summer-wt': [52, 54],
  'alice:warm-winter': [46, 31],
  'alice:starwaves': [47, 17],

  // チリ
  'chilli:halloween-bu': [60, 50],
  'chilli:halloween-gn': [60, 50],
  'chilli:halloween-pk': [60, 50],
  'chilli:halloween-pl': [60, 50],
  'chilli:halloween': [60, 50],
  'chilli:default': [50, 34],
  'chilli:picnic': [46, 35],
  'chilli:sport': [55, 27],
  'chilli:tribe': [83, 52],

  // クッキーカン
  'cookie-can:default': [58, 20],
  'cookie-can:default-2': [53, 15],
  'cookie-can:purple': [54, 15],
  'cookie-can:kitty-chef': [53, 46],
  'cookie-can:doctor': [47, 26],
  'cookie-can:arena': [67, 24],

  // キューピッド
  'cupid:default': [50, 28],
  'cupid:default-2': [50, 40],
  'cupid:angel': [49, 42],
  'cupid:bunny': [46, 44],
  'cupid:dino-cub': [46, 40],
  'cupid:mocha': [51, 46],
  'cupid:squirrel-cub': [45, 40],
  'cupid:auspicious': [49, 44],
  'cupid:musicman': [40, 32],

  // ドレイク
  'drake:arcade-bu': [54, 17],
  'drake:arcade-gn': [54, 17],
  'drake:arcade-pl': [54, 17],
  'drake:arcade-wt': [54, 17],
  'drake:blue': [49, 20],
  'drake:detective': [57, 22],
  'drake:default': [43, 22],
  'drake:playernumberone': [50, 17],

  // フォックス
  'foxx:warrior': [55, 16],
  'foxx:spring-poem': [52, 11],
  'foxx:default': [63, 14],

  // ゴウシオン
  'goshion:default': [30, 32],

  // グウェン
  'gwynn:red': [62, 32],
  'gwynn:default': [56, 32],
  'gwynn:starwaves': [63, 30],

  // ヘラクレス
  'heracles:default': [53, 42],
  'heracles:dragon-slayer': [54, 46],
  'heracles:goat': [58, 54],
  'heracles:popcorn': [57, 55],
  'heracles:red': [51, 46],
  'heracles:shamman': [54, 39],
  'heracles:warrior': [57, 34],

  // ICEY
  'icey:default': [42, 18],
  'icey:default-2': [54, 10],
  'icey:warrior': [59, 15],
  'icey:frost': [52, 22],

  // ラン
  'lan:soul-bk': [54, 29],
  'lan:soul-bu': [54, 29],
  'lan:soul-rd': [54, 29],
  'lan:soul-yl': [54, 29],
  'lan:azura-gragon': [41, 14],
  'lan:default': [56, 23],
  'lan:golden-snake': [51, 27],
  'lan:night-watcher': [49, 15],

  // マカロン
  'macaron:knight': [78, 36],
  'macaron:default': [52, 42],
  'macaron:inca': [61, 29],
  'macaron:purple': [54, 48],
  'macaron:red-bn': [54, 48],
  'macaron:red-wt': [54, 48],
  'macaron:red-gn': [54, 48],
  'macaron:red-bu': [54, 48],
  'macaron:skiing': [64, 19],
  'macaron:spring-festival': [47, 41],
  'macaron:swimming': [55, 47],
  'macaron:rex': [56, 45],

  // マジシャン
  'magician:warrior': [62, 29],
  'magician:money': [49, 28],
  'magician:purple': [62, 29],
  'magician:ace-agent': [45, 35],
  'magician:default': [53, 33],
  'magician:financial-giant': [56, 29],
  'magician:pirate': [44, 38],
  'magician:starwaves': [56, 28],
  'magician:gift': [50, 32],

  // ミッコ
  'mikko:cat-bn': [47, 28],
  'mikko:cat-gy': [47, 28],
  'mikko:cat-og': [47, 28],
  'mikko:cat-vl': [47, 28],
  'mikko:cat': [52, 44],
  'mikko:cat-2': [47, 28],
  'mikko:default': [47, 37],
  'mikko:detective': [49, 27],
  'mikko:gladiator': [50, 40],
  'mikko:purple': [47, 37],
  'mikko:sarvainai': [50, 35],
  'mikko:thor': [56, 44],

  // Mr.5
  'mr-5:arena': [59, 8],
  'mr-5:default': [56, 8],
  'mr-5:grey-suit': [85, 8],
  'mr-5:detective': [43, 15],
  'mr-5:hermit': [50, 33],

  // S-17
  's-17:arena': [50, 16],
  's-17:green': [48, 14],
  's-17:space': [58, 12],
  's-17:space-bk': [65, 22],
  's-17:space-bu': [65, 22],
  's-17:space-gy': [65, 22],
  's-17:space-pl': [63, 22],
  's-17:pizza': [52, 25],
  's-17:default': [55, 20],
  's-17:gray': [45, 18],
  's-17:maid': [50, 13],
  's-17:alter-verse': [55, 15],
  's-17:deep-sea-weapon': [45, 45],

  // サンディ
  'sandy:chinoiserie': [46, 26],
  'sandy:detective': [49, 27],
  'sandy:blue': [53, 26],
  'sandy:dsa': [53, 53],
  'sandy:default': [50, 30],
  'sandy:warrior': [51, 29],
  'sandy:pink': [47, 26],

  // セイヤ
  'seaya:warrior': [53, 14],
  'seaya:warrior-2': [51, 9],
  'seaya:cyber-fantasy': [54, 12],
  'seaya:dsa': [54, 34],
  'seaya:default': [51, 16],
  'seaya:idol-trainee': [54, 15],
  'seaya:snow': [52, 28],

  // シビ
  'sivi:universe-bk': [52, 17],
  'sivi:universe-bu': [52, 17],
  'sivi:universe-og': [52, 17],
  'sivi:universe-pk': [52, 17],
  'sivi:universe': [45, 17],
  'sivi:fool-bu': [47, 24],
  'sivi:fool-gn': [47, 24],
  'sivi:fool-pk': [47, 24],
  'sivi:fool-wt': [47, 24],
  'sivi:warrior': [47, 28],
  'sivi:wolf-spirit': [45, 14],
  'sivi:wolf-spirit-2': [46, 27],
  'sivi:alter-verse': [42, 19],
  'sivi:blue': [39, 16],
  'sivi:default': [44, 17],
  'sivi:gray': [35, 16],
  'sivi:party-tricks': [47, 17],
  'sivi:race': [39, 15],
  'sivi:red': [36, 14],
  'sivi:yellow': [33, 23],

  // ソフィア
  'sophia:rider': [50, 14],
  'sophia:halloween': [50, 12],
  'sophia:kendo-wtpl': [47, 44],
  'sophia:kendo-ogbk': [47, 44],
  'sophia:kendo-pk': [47, 44],
  'sophia:kendo-bk': [47, 44],
  'sophia:kendo': [47, 44],
  'sophia:space': [47, 15],
  'sophia:blue': [49, 15],
  'sophia:default': [45, 15],
  'sophia:green-apple': [47, 15],
  'sophia:justice': [50, 18],
  'sophia:little-bee': [46, 16],
  'sophia:meow-jk': [47, 17],

  // タララ
  'tarara:default': [52, 12],
  'tarara:default-2': [51, 13],
  'tarara:muse': [46, 14],
  'tarara:muse-2': [47, 15],
  'tarara:summer': [50, 25],
  'tarara:summer-2': [51, 25],
  'tarara:summer-3': [51, 24],
  'tarara:summer-4': [51, 24],
  'tarara:summer-5': [51, 24],
  'tarara:maid': [50, 32],
  'tarara:highscoregal': [47, 16],

  // タナトス
  'thanatos:default': [56, 19],
  'thanatos:default-2': [48, 14],
  'thanatos:halloween': [49, 19],
  'thanatos:hockey': [42, 15],
  'thanatos:servant': [43, 16],
  'thanatos:silhouette': [63, 38],
  'thanatos:space': [36, 17],
  'thanatos:white': [47, 15],
  'thanatos:starlight-ruins': [49, 24],
  'thanatos:starlight-ruins-2': [49, 23],

  // ティナ
  'tina:dreadlock-c1': [47, 9],
  'tina:dreadlock-c2': [47, 9],
  'tina:dreadlock-c3': [49, 10],
  'tina:dreadlock-c4': [46, 10],
  'tina:dreadlock': [47, 10],
  'tina:green': [50, 10],
  'tina:strength': [45, 30],
  'tina:alter-verse': [49, 13],
  'tina:dsa': [46, 16],
  'tina:default': [47, 12],
  'tina:jk': [45, 13],
  'tina:mojito': [49, 10],
  'tina:red-lion': [44, 14],
  'tina:star-producer': [50, 20],
  'tina:valkyrie': [47, 15],

  // トン
  'tong:warrior': [50, 18],
  'tong:default': [49, 13],
  'tong:demonic-fox': [47, 15],
  'tong:green': [50, 16],
  'tong:phoenix': [50, 17],
  'tong:warrior-saint': [43, 47],

  // ツツ
  'tutu:frog': [49, 25],
  'tutu:default': [50, 22],

  // ユリ
  'yuri:arcade': [50, 24],
  'yuri:jks-bk': [51, 13],
  'yuri:jks-bu': [52, 13],
  'yuri:jks-wt': [52, 13],
  'yuri:jks-yl': [52, 13],
  'yuri:jks': [54, 14],
  'yuri:black': [47, 14],
  'yuri:cocktail': [49, 13],
  'yuri:halloween': [53, 20],
  'yuri:jk': [49, 14],
  'yuri:plum-on-snow': [47, 13],
  'yuri:default': [51, 15],
  'yuri:starwaves': [49, 15],
};

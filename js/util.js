// 画面を組み立てるときの共通処理。
// 表示に関わる小さな道具をここに集めておくことで、players.js と profile.js が
// 互いに import し合う（循環参照）のを避けている。

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// href や src に入れてよいURLだけを通す。javascript: や data: を弾かないと、
// プロフィールに書かれた文字列がそのままスクリプト実行に使われてしまう。
export function safeUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : null;
  } catch {
    return null;
  }
}

// アイコン未設定のときに出す頭文字。
export function initialOf(name) {
  return (name ?? '').trim().charAt(0) || '?';
}

// アイコンのHTML。未設定なら頭文字の丸を返す。
// URLはDBから来るが、safeUrl を通してから src に入れる（不正な値を描画に使わない）。
export function avatarHtml(player, size = 'md') {
  const url = safeUrl(player?.avatarUrl);
  if (url) {
    return `<span class="avatar avatar-${size}"><img src="${escapeHtml(url)}" alt="" loading="lazy"></span>`;
  }
  return `<span class="avatar avatar-${size}">${escapeHtml(initialOf(player?.currentName))}</span>`;
}

// 一覧に並ぶカード（募集・大会履歴・お知らせ）の画像枠。
//
// 枠の高さは固定し、中の画像は切り抜かずに全体を収める。画像が無いときは
// 見出しの頭文字で枠を埋めるので、画像の有無でカードの高さが変わらず一覧が乱れない。
// tall は、詳細ページを持たず一覧が画像を見る唯一の場所になる用途（お知らせ）向け。
export function cardThumb(imageUrl, fallbackName, { tall = false } = {}) {
  const el = document.createElement('div');
  el.className = `card-thumb${tall ? ' is-tall' : ''}`;

  const url = safeUrl(imageUrl);
  if (url) {
    el.innerHTML = `<img src="${escapeHtml(url)}" alt="" loading="lazy">`;
  } else {
    el.classList.add('is-empty');
    el.textContent = initialOf(fallbackName);
  }
  return el;
}

// アップロード前に画像を縮小する。
//
// スマートフォンの写真は数千ピクセル・数MBあるが、この画面で使うのはせいぜい
// 数百ピクセル。そのまま保存すると保管容量と通信量を無駄に食うので、表示に
// 必要な大きさまで落としてから送る（無料枠を長持ちさせるための要）。
//
// 触らずにそのまま返す場合:
//   * アニメーションGIF … canvasに描くと1コマ目だけになってしまう
//   * 画像として読めなかった … 判断はStorage側の検査に任せる
//   * 変換しても小さくならなかった … 元より悪くしない
export async function downscaleImage(file, maxDimension) {
  if (!file?.type?.startsWith('image/') || file.type === 'image/gif') return file;
  if (typeof createImageBitmap !== 'function') return file;

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }

  try {
    // 長辺を maxDimension に収める。元から小さければ拡大はしない。
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, maxDimension / longest);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);

    // WebPを使うのは、JPEGと違って透過を保てるため（アイコンのPNGが黒く潰れない）。
    const blob = await new Promise((resolve) => {
      canvas.toBlob(resolve, 'image/webp', 0.85);
    });

    if (!blob || blob.size >= file.size) return file;

    const name = `${file.name.replace(/\.[^.]+$/, '')}.webp`;
    return new File([blob], name, { type: 'image/webp' });
  } catch {
    return file;
  } finally {
    bitmap.close?.();
  }
}

// 大会・お知らせの画像アップロード用ピッカー。HTML側に用意した
// ファイル入力・プレビュー用img・「画像を外す」ボタンを配線する。
// 大会作成／編集／お知らせの3フォームで同じ配線を使い回すためのもの。
//
// setCurrent(url) で既存の画像URLをセットし直す（編集フォームを開くたびに呼ぶ）。
// get() は保存時に呼び、{ file, remove, currentUrl } を返す:
//   file       … 新しく選ばれた画像（未選択ならnull）
//   remove     … 「外す」が押されたか
//   currentUrl … 元の画像URL（据え置きの判定に使う）
export function setupImagePicker({ fileInput, preview, removeBtn }) {
  let currentUrl = '';
  let file = null;
  let remove = false;
  // 選択中ファイルのプレビューURL。作り直すたびに前のものを解放する。
  let objectUrl = null;

  function releaseObjectUrl() {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  }

  function render() {
    releaseObjectUrl();
    let shown = null;
    if (file) {
      objectUrl = URL.createObjectURL(file);
      shown = objectUrl;
    } else if (!remove) {
      shown = safeUrl(currentUrl);
    }

    if (shown) {
      preview.src = shown;
      preview.hidden = false;
    } else {
      preview.removeAttribute('src');
      preview.hidden = true;
    }
    if (removeBtn) removeBtn.hidden = !(file || (currentUrl && !remove));
  }

  fileInput.addEventListener('change', () => {
    const picked = fileInput.files?.[0];
    if (!picked) return;
    file = picked;
    remove = false;
    render();
  });

  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      file = null;
      remove = true;
      fileInput.value = '';
      render();
    });
  }

  return {
    setCurrent(url) {
      currentUrl = url || '';
      file = null;
      remove = false;
      fileInput.value = '';
      render();
    },
    get() {
      return { file, remove, currentUrl };
    },
  };
}

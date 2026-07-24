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

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

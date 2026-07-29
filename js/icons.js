// プロジェクト共通のアイコン。
//
// 絵文字は端末ごとに見た目が変わり、UIの中で浮く（「変なアイコン」と言われた）ので、
// 線画のインラインSVGに統一する。線の太さと丸めはすべて同じにして、どの画面でも
// 同じ筆致に見えるようにする。色は currentColor で、置いた場所の文字色に従う。
//
// アイコンだけのボタンには必ず aria-label と title を付けること（makeIconButton を
// 使えば漏れない）。意味が絵で伝わらない操作（エントリー・確定など）は文字のまま。

const PATHS = {
  // 記入できる場所を示す鉛筆
  pencil: 'M12 20h9 M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z',
  // 削除（ゴミ箱）
  trash: 'M3 6h18 M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2 M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6 M10 11v6 M14 11v6',
  // 取り除く・閉じる
  x: 'M18 6 6 18 M6 6l12 12',
  // 並び替え
  arrowUp: 'M12 19V5 M5 12l7-7 7 7',
  arrowDown: 'M12 5v14 M19 12l-7 7-7-7',
  // チャットの送信（紙飛行機）
  send: 'M22 2 11 13 M22 2 15 22l-4-9-9-4z',
  // クリップボードへコピー
  copy: 'M8 8h12v12H8z M16 8V4H4v12h4',
  // 成功の印（コピー完了などの一時表示）
  check: 'M20 6 9 17l-5-5',
};

export function iconSvg(name) {
  // 1つの d に複数の M（サブパス）を書ける。fill を使わない線画なので問題ない
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="${PATHS[name]}" />
    </svg>`;
}

// アイコンだけのボタン。文字が無いぶん、読み上げとホバーの説明を必ず持たせる。
export function makeIconButton(name, label, { className = '' } = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `icon-btn ${className}`.trim();
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = iconSvg(name);
  return btn;
}

// 既にあるボタンの中身をアイコンに差し替える（文字ラベルは読み上げ用に残す）。
export function setButtonIcon(btn, name, label) {
  btn.classList.add('icon-btn');
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = iconSvg(name);
}

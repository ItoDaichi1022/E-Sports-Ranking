// 入力中の下書きを控えておき、フォームを建て直したときに書き戻す。
//
// なぜ必要か:
//   スマートフォンで他のアプリへ移って戻ってくると、ブラウザがメモリを空けるために
//   ページごと捨てていることがある。戻ってきたときに起きているのは「再読み込み」なので、
//   画面の作り方をどう工夫しても、入力中の文字はその時点で失われている。
//   書いたそばから控えておいて、次に同じフォームが建ったら書き戻すしかない。
//
// なぜ sessionStorage か:
//   これは「そのタブに戻ってきた人」のための控えだから。localStorage に置くと、
//   何日も前に書きかけて放置した内容が、別の日に何の脈絡もなく蘇ってしまう。
//   タブを閉じたら消えるのが、この用途では正しい寿命になる。
//
// 控えないもの:
//   画像（input[type=file]）。ファイルの中身は保存できず、ファイル名だけ持っていても
//   選び直しにはならないので、対象から外している（画像だけは選び直してもらう）。

const PREFIX = 'draft:';

// 打つたびに書き出すと、長文の自己紹介やルール欄で書き込みが積み上がる。
// 手が止まったところで1回だけ書く。
const SAVE_DELAY_MS = 400;

// sessionStorage はプライベートモードや容量超過で落ちることがある。
// 下書きは「あれば嬉しい」ものなので、失敗しても本来の入力を止めない。
function readStore(key) {
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStore(key, data) {
  try {
    sessionStorage.setItem(PREFIX + key, JSON.stringify(data));
  } catch {
    // 何もしない（下書きが残らないだけ）
  }
}

export function clearFormDraft(key) {
  try {
    sessionStorage.removeItem(PREFIX + key);
  } catch {
    // 何もしない
  }
}

// name か id のどちらかがある欄だけを扱う。どちらも無い欄は書き戻す先を
// 特定できない（フォームを建て直すと並び順で当てるしかなくなる）。
function fieldKey(el) {
  return el.name || el.id || '';
}

function targetFields(formEl) {
  return [...formEl.elements].filter((el) => {
    if (!fieldKey(el) || el.disabled) return false;
    if (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    return !['file', 'password', 'submit', 'button', 'reset', 'hidden'].includes(el.type);
  });
}

function snapshot(formEl) {
  const data = {};
  targetFields(formEl).forEach((el) => {
    const key = fieldKey(el);
    if (el.type === 'radio') {
      // 同じ name の中から、選ばれている1つの値だけを控える
      if (el.checked) data[key] = el.value;
      return;
    }
    if (el.type === 'checkbox') {
      data[key] = el.checked;
      return;
    }
    data[key] = el.value;
  });
  return data;
}

// 書き戻したあと input と change を投げるのは、その欄に連動して出し分けている部分
// （対戦方法に応じた説明欄、参加者の集め方、選手の絞り込みなど）を追従させるため。
// 値だけ戻して合図を出さないと、見た目と中身が食い違ったフォームができあがる。
// 呼ばれる側はどれも「今の値から画面を作り直す」処理なので、二重に呼ばれても困らない。
function apply(formEl, data) {
  targetFields(formEl).forEach((el) => {
    const key = fieldKey(el);
    if (!(key in data)) return;
    // 先に戻した欄の合図で、この欄が閉じられている（無効になった）ことがある。
    // その場合は書き戻さない ＝ 今の画面の言い分を優先する。
    if (el.disabled) return;

    const value = data[key];
    if (el.type === 'radio') el.checked = el.value === value;
    else if (el.type === 'checkbox') el.checked = Boolean(value);
    else el.value = value ?? '';

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

// 今この画面に建っている、控える対象のフォーム。
// プロフィール欄のように要素ごと作り直されるものがあるので、キーではなく要素で持ち、
// 画面から外れたものは書き出すときに落とす。
const watched = new Map(); // formEl -> { key, timer }

// 手が止まってから書く方式なので、その待ち時間の途中で画面が閉じられると取りこぼす。
// 離れる合図が来たら、待たずに今の内容を書き出す。
// pagehide はタブごと捨てられるとき、visibilitychange は他のアプリへ移るときに来る。
// どちらもページ全体の出来事なので、配線はこのファイルに1組だけ置く。
function flushAll() {
  watched.forEach((entry, formEl) => {
    if (!formEl.isConnected) {
      watched.delete(formEl);
      return;
    }
    clearTimeout(entry.timer);
    writeStore(entry.key, snapshot(formEl));
  });
}

window.addEventListener('pagehide', flushAll);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) flushAll();
});

// フォームに下書きを書き戻し、以後の入力を控え続ける。
//
// 呼ぶのは、そのフォームに「本来の値」（編集なら保存済みの内容）を入れ終えた後。
// 下書きはその上に重ねる ＝ 書きかけがあればそちらを優先する。
export function keepFormDraft(formEl, key) {
  if (!formEl) return;

  const saved = readStore(key);
  if (saved) apply(formEl, saved);

  // 同じ要素に二度配線しない（静的なフォームは起動時に1回だけ登録される）
  if (watched.has(formEl)) {
    watched.get(formEl).key = key;
    return;
  }

  const entry = { key, timer: null };
  watched.set(formEl, entry);

  const save = () => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => writeStore(entry.key, snapshot(formEl)), SAVE_DELAY_MS);
  };

  formEl.addEventListener('input', save);
  formEl.addEventListener('change', save);
}

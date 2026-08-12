// 導入の演出「点火 → 開門」を終わらせる係。
//
// 動かしているのは css/style.css の「導入の演出（開門）」の節で、
// このモジュールは動きを一切作らない。出すか出さないかも index.html の
// <head> が最初の描画より前に決めている（ここで決めると、いつものホームが
// 一瞬見えてから幕が被さる）。
//
// ここが持つのは「必ず終わらせる」責任だけ。幕が開かないまま残ると
// サイトが二度と使えなくなるので、終わり方を4通り用意してある。
//
//   1. 開門アニメーションの完了（正規の道）
//   2. クリック・キー・スクロールで飛ばす
//   3. 4秒の保険タイマー（1も2も来なかったとき）
//   4. さらに index.html の <head> に6秒の保険（このファイルが読めなかったとき）
//
// 合図は2段階に分けてある。
//
//   release() … 門が「開き始めた」ところ。intro-hold を外し、'intro-done' を投げる。
//               js/stage.js がこれを待って、画面より下の登場アニメを始める。
//               ホームのヒーローはここを待たない ── css/style.css の
//               「ヒーローの登場（JSを通さない）」がCSSだけで出す。このファイルが
//               1バイトも届かなくてもヒーローは出る、という状態を崩さないこと。
//               閉じきるまで待たせると、開いていく0.6秒のあいだ中身が空っぽの
//               ホームが見えてしまう。開きながら中身が立ち上がるほうが自然。
//   finish()  … 幕そのものを片付ける。印を外し、器をDOMから外す。
//
// document にカスタムイベントを投げる形は、既存の 'chat-reports-changed' と同じ作法。

const SAFETY_MS = 4000;

const root = document.documentElement;
const introEl = document.getElementById('intro');

// 開門を載せてある器。「幕がいつ動き出すか」の基準がここの animation にある。
const gate = introEl?.querySelector('.intro-half-r') ?? null;

let released = false;
let done = false;

// 幕を飛ばされたとき、ヒーローの待ちも一緒に解く。
//
// ヒーローの登場は css/style.css の「ヒーローの登場（JSを通さない）」に載っていて、
// <html class="intro-on"> が付いているあいだは開門と同じだけ待つ。飛ばした人に
// その待ち時間をそのまま押しつけると、幕が消えたあとに何も無い画面が残る。
//
// 【まだ開門が始まっていないときだけ外すこと】animation-delay を決めている指定が
// 当たらなくなると、アニメーションは頭から掛け直される。始まったあとに外すと、
// 立ち上がりかけたヒーローが一度伏せてやり直す（目に見えるちらつきになる）。
//
// 待ち時間の値は幕の animation から読む。ここに 1.9 を書き写すと、CSS側だけを
// 直したときに気付けないずれになる。
function unlockHero() {
  const anim = typeof gate?.getAnimations === 'function' ? gate.getAnimations()[0] : null;
  if (anim && (anim.currentTime ?? 0) >= (anim.effect?.getTiming?.().delay ?? 0)) return;
  root.classList.remove('intro-on');
}

// 門が開き始めた ── ホームに「もう動いていい」と伝える
function release() {
  if (released) return;
  released = true;
  root.classList.remove('intro-hold');
  unlockHero();
  document.dispatchEvent(new CustomEvent('intro-done'));
}

function finish() {
  if (done) return;
  done = true;

  release();
  // 印を外す。CSSの既定（display: none）に戻るので、この時点で幕は消える。
  root.classList.remove('intro-playing');
  // 器そのものをDOMから外す。画面を覆う要素を残さないための後始末。
  introEl?.remove();

  window.removeEventListener('pointerdown', finish);
  window.removeEventListener('keydown', finish);
  window.removeEventListener('wheel', finish);
  window.removeEventListener('touchmove', finish);
  window.removeEventListener('scroll', finish);
}

if (introEl && root.classList.contains('intro-playing')) {
  // 飛ばす操作。幕の中に押せるものは置いていないので、画面のどこでも受ける。
  // passive: true ── ここでは既定の動作を止めないので、スクロールを妨げない。
  const skipOpts = { passive: true, once: true };
  window.addEventListener('pointerdown', finish, skipOpts);
  window.addEventListener('keydown', finish, skipOpts);
  window.addEventListener('wheel', finish, skipOpts);
  window.addEventListener('touchmove', finish, skipOpts);
  window.addEventListener('scroll', finish, skipOpts);

  // 正規の終わり方。
  //
  // animationend を聞くだけにすると、回線が遅くてこのモジュールの評価が
  // 2.5秒より後になったとき、イベントを取り逃して保険タイマーまで待つことになる。
  // getAnimations() は「もう終わっている」場合も finished が解決済みで返るので、
  // 遅れて読み込まれても即座に追いつける。

  // 開門の始まり。animationstart は待ち時間（animation-delay）が明けたときに来るので、
  // これがそのまま「門が動き出した瞬間」になる。
  introEl.addEventListener('animationstart', (e) => {
    if (e.target === gate) release();
  });

  const anims = typeof gate?.getAnimations === 'function' ? gate.getAnimations() : [];

  if (anims.length) {
    // 途中で器を消すと finished は reject する（＝飛ばされたとき）。allSettled で受ける。
    Promise.allSettled(anims.map((a) => a.finished)).then(finish);
  } else {
    // getAnimations が無いブラウザ向け。開門は右の器に載せてあるので、そこだけ見る。
    introEl.addEventListener('animationend', (e) => {
      if (e.target === gate) finish();
    });
  }

  // 保険。上のどれも来なくても、ここで必ず開く。
  setTimeout(finish, SAFETY_MS);
} else {
  // 演出を出さない回（2回目以降・ホーム以外・動きを止めている人）。
  // 器は最初から display: none だが、残しておく意味も無いので片付ける。
  // intro-done は投げない ── js/stage.js は印が無ければそもそも待たない。
  introEl?.remove();
}

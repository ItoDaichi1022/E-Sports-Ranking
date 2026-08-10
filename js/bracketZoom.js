// 対戦表の拡大・縮小と送り（js/bracketView.js の renderTree から使う）。
//
// トーナメント表は枠が増えるほど大きくなる（32枠で 1700×3200px ほど）。狭い画面に
// 収める道は2つある ── 形そのものを組み替える（回戦ごとの一覧にする）か、形は
// そのままで見る側の倍率を変えるか。前者だと「トーナメント表を見に来た」人が
// いちばん見たかったもの（勝ち上がりの枝）が画面から消えてしまうので、ここでは
// 後者を用意する。地図と同じで、全体を眺めてから気になるところへ寄る。
//
// 仕組みは3枚重ね。
//
//   stage   実際にスクロールする箱。指1本の送りはブラウザ本来のスクロールに任せる
//   sizer   「倍率をかけた大きさ」を持つだけの箱。transform はレイアウト上の大きさを
//           変えないので、スクロールできる範囲はこれで作る
//   canvas  対戦表そのもの（.bracket）。transform: scale で縮む
//
// 指1本を自前で処理しないのは、端まで送ったときにページのスクロールへ続いてほしい
// ため（自前で受け止めると、表の中に指が捕まってページを動かせなくなる）。
// こちらが受け持つのは2本指のつまみ、Ctrl＋ホイール、ボタン、余白のダブルクリック。

// 寄れる上限。対戦カードは元々読める大きさなので、大きくするのは細かいところを
// 確かめたいときだけ。上げすぎると迷子になる。
const MAX_SCALE = 2;

// 引ける下限。ただし表が大きいときは「全体が入る大きさ」まで引けないと意味が無いので、
// 全体表示の倍率のほうが小さければそちらに合わせる（minScale）。
const MIN_SCALE = 0.15;

// 開いた時点で全体を出すかどうかの境目。全体が入る倍率がこれ以上なら、最初から
// 表全体を見せる（8枠までの大会はたいていここに入る）。これより小さくなる大きな表は
// 等倍で開いて、全体は「全体」ボタンかつまみに任せる ── いきなり読めない大きさで
// 出しても、何が書いてあるか分からない。
const FIT_ON_OPEN = 0.75;

// 送った指を離した直後のクリックを捨てる時間（ミリ秒）。表を掴んで動かした流れで
// 下にあった選手名を押したことにされると、勝手に選手ページへ飛んでしまう。
const CLICK_SUPPRESS_MS = 250;

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

// touches から2点の距離と中点（stage の左上から測った位置）を出す。
function pinchInfo(stage, touches) {
  const rect = stage.getBoundingClientRect();
  // TouchList は配列ではないので、番号で取り出す（分割代入できない環境がある）
  const a = touches[0];
  const b = touches[1];
  return {
    dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
    x: (a.clientX + b.clientX) / 2 - rect.left,
    y: (a.clientY + b.clientY) / 2 - rect.top,
  };
}

// stage に操作を取り付ける。表は更新のたびに丸ごと作り直されるが、そのとき stage ごと
// 捨てられるので、ここで付けた listener も一緒に消える（後片付けは要らない）。
// savedView（{ scale, left, top }）を渡すと、その倍率と位置で開く。
export function attachBracketZoom({ stage, sizer, canvas, contentW, contentH, savedView }) {
  let scale = 1;
  let suppressClickUntil = 0;

  const viewW = () => stage.clientWidth || 1;
  const viewH = () => stage.clientHeight || 1;

  // 表全体が画面に入る倍率
  function fitScale() {
    if (contentW <= 0 || contentH <= 0) return 1;
    return Math.min(viewW() / contentW, viewH() / contentH);
  }

  function minScale() {
    return Math.max(0.05, Math.min(MIN_SCALE, fitScale()));
  }

  // 縮めて箱より小さくなった分は、余白として左右（上下）に等分する。
  // 引ききった表が箱の左上に貼り付いていると、周りの余白が一方に寄って
  // 「まだ続きがあるのに見えていない」ように読めてしまう。
  const offsetX = () => Math.max(0, (viewW() - contentW * scale) / 2);
  const offsetY = () => Math.max(0, (viewH() - contentH * scale) / 2);

  function applySize() {
    // 先に箱の大きさを決める。stage の高さはこれで決まるので、余白の計算はその後。
    sizer.style.width = `${Math.round(contentW * scale)}px`;
    sizer.style.height = `${Math.round(contentH * scale)}px`;
    // translate は scale より先に書く（＝あとから効く）ので、ここの px は
    // 倍率をかけたあとの画面上の px。余白をそのまま渡せる。
    canvas.style.transform = `translate(${offsetX()}px, ${offsetY()}px) scale(${scale})`;
  }

  // anchorX / anchorY は stage の左上から測った「動かしたくない点」。
  // つまんだ指の間や、ホイールを回したカーソルの下がその場に留まるようにする。
  function zoomTo(next, anchorX, anchorY) {
    const before = scale;
    const after = clamp(next, minScale(), MAX_SCALE);
    if (Math.abs(after - before) < 0.0005) return;

    // その点が表のどこ（倍率をかける前の座標）を指しているか
    const cx = (stage.scrollLeft + anchorX - offsetX()) / before;
    const cy = (stage.scrollTop + anchorY - offsetY()) / before;

    scale = after;
    applySize();

    // 同じところが同じ位置に来るようにスクロールを取り直す（範囲外は自動で丸まる）
    stage.scrollLeft = cx * after + offsetX() - anchorX;
    stage.scrollTop = cy * after + offsetY() - anchorY;
  }

  function fit() {
    zoomTo(fitScale(), viewW() / 2, viewH() / 2);
  }

  // ---- 2本指でつまむ ----
  let pinch = null;

  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return;
    const info = pinchInfo(stage, e.touches);
    pinch = { dist: info.dist, scale, x: info.x, y: info.y };
  }, { passive: true });

  stage.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    // 止めないと、ブラウザがページごと拡大してしまう
    if (e.cancelable) e.preventDefault();

    const info = pinchInfo(stage, e.touches);
    zoomTo(pinch.scale * (info.dist / pinch.dist), info.x, info.y);

    // つまんだまま滑らせた分は送りとして扱う。寄せながら位置も直せる
    stage.scrollLeft -= info.x - pinch.x;
    stage.scrollTop -= info.y - pinch.y;
    pinch.x = info.x;
    pinch.y = info.y;
  }, { passive: false });

  const endPinch = (e) => { if (e.touches.length < 2) pinch = null; };
  stage.addEventListener('touchend', endPinch);
  stage.addEventListener('touchcancel', endPinch);

  // iOS Safari は2本指に独自の gesture イベントも出す。止めておかないと、
  // こちらで表を拡大するのと同時にページまで拡大されることがある。
  stage.addEventListener('gesturestart', (e) => e.preventDefault());
  stage.addEventListener('gesturechange', (e) => e.preventDefault());

  // ---- ホイール ----
  // 素の回転は今までどおりのスクロール。Ctrl（Macは⌘）を押している間だけ倍率を変える
  // ── 拡大縮小の合図としてどのアプリでも同じ押し方なので、説明が要らない。
  stage.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    zoomTo(scale * Math.exp(-e.deltaY * 0.0025), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });

  // ---- 掴んで送る（マウス）----
  // 指で送るのと同じことをマウスでもできるようにする。少し動かすまでは送りを始めない
  // ので、対戦カードの中のボタンや選手名は今までどおり押せる。
  let drag = null;

  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || e.button !== 0) return;
    drag = {
      x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop, moved: false,
    };
  });

  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      stage.setPointerCapture(e.pointerId);
      stage.classList.add('is-panning');
    }
    stage.scrollLeft = drag.left - dx;
    stage.scrollTop = drag.top - dy;
  });

  const endDrag = () => {
    if (drag?.moved) suppressClickUntil = performance.now() + CLICK_SUPPRESS_MS;
    stage.classList.remove('is-panning');
    drag = null;
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  stage.addEventListener('click', (e) => {
    if (performance.now() >= suppressClickUntil) return;
    e.stopPropagation();
    e.preventDefault();
  }, true);

  // 余白のダブルクリックで寄る。対戦カードの上では効かせない
  // （カードを開く操作と重なって、開いた先で表が動いていることになる）。
  stage.addEventListener('dblclick', (e) => {
    if (e.target.closest('.match-box')) return;
    const rect = stage.getBoundingClientRect();
    zoomTo(scale * 1.5, e.clientX - rect.left, e.clientY - rect.top);
  });

  applySize();

  if (savedView) {
    // 更新（Realtime の描き直し）をまたいで、見ていた倍率と位置をそのまま続ける
    scale = clamp(savedView.scale, minScale(), MAX_SCALE);
    applySize();
    stage.scrollLeft = savedView.left;
    stage.scrollTop = savedView.top;
  } else if (fitScale() >= FIT_ON_OPEN) {
    fit();
  }

  return {
    view: () => ({ scale, left: stage.scrollLeft, top: stage.scrollTop }),
    zoomBy: (factor) => zoomTo(scale * factor, viewW() / 2, viewH() / 2),
    fit,
  };
}

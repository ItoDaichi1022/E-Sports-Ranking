// 「はじめに」の図を動かす。
//
// 【なぜ動かすのか】1章「このサイトの各ページ」は、どの画面が何をする場所かを
// 伝えるところ。止まった図を並べると、読む人は「押したら何が起きるのか」を
// 頭の中で補うことになる。押す前と後を続けて見せれば、その手間が要らない。
//
// 【図そのものは pages/guide.html にある】このファイルがするのは、いま何段目かに
// 合わせて印のクラス（.is-shown / .is-tapped / 状態クラス）を付け外しすることだけ。
// 見た目を決めるのは css/guide.css の「動く図」の節で、どの段で何が出るかは
// HTMLの属性が持っている ── 3つに分けてあるので、このファイルが届かなくても
// 図そのものは並んだまま読める。
//
// 【属性の決まり】figure に data-steps（段の数）を付け、中の要素に次を付ける。
//   data-demo-in="2"                  … 2段目から現れる
//   data-demo-out="3"                 … 3段目からは消える（in と組で使う）
//   data-demo-act="2"                 … 2段目から状態クラスが付く
//   data-demo-actout="3" / -actclass  … その終わりと、付けるクラス名（既定 is-active）
//   data-demo-tap="1"                 … 1段目で「ここを押す」の輪を出す
// 説明の文は figure の中の .guide-demo-steps の各 li。段と同じ順に並べること。
//
// 【動きを止めている人には出さない】prefers-reduced-motion のときは自動で
// 進めず、最後の段の形で置く。ボタンは「1段ずつ見る」に変わり、押すたびに
// 1段進む ── 動きを止めていても、途中の段を読めなくはしない。

import { prefersReducedMotion } from './stage.js';

// 1段あたりの表示時間。図の中の文は短いので、読み切れて、かつ待たされない長さ。
const HOLD_MS = 3200;

function setupDemo(figure) {
  const total = Number(figure.dataset.steps) || 1;
  const captions = [...figure.querySelectorAll('.guide-demo-steps > li')];
  const replayBtn = figure.querySelector('.guide-demo-replay');

  const ins = [...figure.querySelectorAll('[data-demo-in]')];
  const acts = [...figure.querySelectorAll('[data-demo-act]')];
  const taps = [...figure.querySelectorAll('[data-demo-tap]')];

  // 何もしていないあいだも1段目は出したままにする。0段目（どれも出ていない状態）を
  // 作ると、図が画面に入るまで空の枠が置かれることになる。
  let step = 1;
  let timer = null;

  const still = () => prefersReducedMotion();

  // ここまで来て初めて「段に分けてよい」と CSS に伝える。
  // この印が付くまで、図は全部の段が縦に並んだまま出ている（css/guide.css）──
  // このファイルが届かなかったときに、図が空の箱にならないようにするため。
  figure.classList.add('is-playable');

  function render() {
    figure.dataset.step = String(step);

    for (const el of ins) {
      const from = Number(el.dataset.demoIn);
      const until = el.dataset.demoOut ? Number(el.dataset.demoOut) : Infinity;
      el.classList.toggle('is-shown', step >= from && step < until);
    }

    for (const el of acts) {
      const from = Number(el.dataset.demoAct);
      const until = el.dataset.demoActout ? Number(el.dataset.demoActout) : Infinity;
      el.classList.toggle(el.dataset.demoActclass || 'is-active', step >= from && step < until);
    }

    for (const el of taps) {
      // 動きを止めている人に光の輪は出さない（点滅そのものが避けたいものなので）
      el.classList.toggle('is-tapped', !still() && Number(el.dataset.demoTap) === step);
    }

    captions.forEach((li, i) => {
      li.classList.toggle('is-current', i + 1 === step);
      li.classList.toggle('is-done', i + 1 < step);
    });
  }

  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  function advance() {
    step = Math.min(step + 1, total);
    render();
    if (step < total) timer = setTimeout(advance, HOLD_MS);
  }

  function play({ fromStart = false } = {}) {
    stop();
    if (still()) { step = total; render(); return; }
    if (fromStart || step >= total) step = 1;
    render();
    timer = setTimeout(advance, HOLD_MS);
  }

  // 画面に入っているあいだだけ動かす。出ていったら止める ── 見えていない図を
  // 動かし続けても誰も読まないし、長い章を開いているあいだ動き続けることになる。
  // 途中で出ていった図は、その段のまま止めて、戻ってきたら続きから進める。
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        if (!timer) play({ fromStart: step === 1 });
      } else {
        stop();
      }
    }
  }, { threshold: 0.3 });
  io.observe(figure);

  if (replayBtn) {
    replayBtn.addEventListener('click', () => {
      if (still()) {
        // 自動で進まないので、押すたびに1段ずつ。最後まで行ったら頭に戻る。
        step = step >= total ? 1 : step + 1;
        render();
        return;
      }
      play({ fromStart: true });
    });
  }

  // 動きを止めている人には、ボタンの言葉も役目に合わせる
  if (still() && replayBtn) replayBtn.textContent = '1段ずつ見る';

  render();
}

// 「はじめに」の本文が入ったあとに1回だけ呼ぶ（js/app.js の loadStaticPage）。
// 図が1つも無いページ（利用規約など）では何もしない。
export function initGuideDemos(root) {
  root.querySelectorAll('.guide-demo').forEach(setupDemo);
}

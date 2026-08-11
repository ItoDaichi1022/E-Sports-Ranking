// 大会が「いま何を受け付けているか」を1か所で決める。
//
// 【なぜ切り出したか】
//   同じ判断が、離れた3か所で要る。
//     * エントリーボタンを押せるか（js/entries.js）
//     * 状態のバッジに何と書くか（js/app.js）
//     * 構造化データの eventStatus に何を入れるか（js/seo.js → worker/index.js）
//   それぞれの場所で `status === 'recruiting'` を書いていくと、定員や締切の扱いが
//   少しずつ食い違う ── 画面には「募集中」と出ているのにボタンが押せない、
//   検索結果には「開催予定」と出るのに実は満員、といった形で表に出る。
//   だから判断そのものはここに集め、呼ぶ側は結果を読むだけにする。
//
// 【このファイルは何も読み込まない】
//   state.js も DOM も触らない。渡された大会1件だけを見て答える。
//   worker/index.js（Cloudflare 上）からも同じ判断を使うため。

// 進行状況の呼び名。DBの status（supabase/schema.sql）と1対1で対応する。
export const STATUS_LABELS = {
  draft: '準備中',
  recruiting: '募集中',
  running: '進行中',
  finished: '終了',
};

// 出場枠の数え方の呼び名。チーム戦の定員16は「16チーム」であって16人ではない。
export function entrantUnit(tournament) {
  return tournament?.matchType === '2v2' ? 'チーム' : '人';
}

// 締切のDate。未設定と、壊れた値（手で書き換えられた場合）はどちらも null にして、
// 呼び出し側では「締切が無い」と同じ扱いにする。
export function entryDeadlineAt(tournament) {
  if (!tournament?.entryDeadline) return null;
  const at = new Date(tournament.entryDeadline);
  return Number.isNaN(at.getTime()) ? null : at;
}

// 残り枠。数えるのは出場枠なので、チーム戦ではチーム数で見る
// （DBの定員トリガーが count(distinct coalesce(team_id, player_id)) で数えるのと同じ）。
// 定員を決めていない大会では null（＝上限なし）。
export function remainingSlots(tournament) {
  if (tournament?.capacity == null) return null;
  return Math.max(0, tournament.capacity - (tournament.entrantCount ?? 0));
}

// 大会の受付状況。
//
// 返すもの:
//   key           … 'draft' | 'open' | 'deadline-passed' | 'full' | 'running' | 'finished'
//   label         … 画面に出す短い言葉。バッジの文字になる
//   tone          … 色分けの手がかり（css の .status-chip.status-*）。
//                   【色だけで意味を伝えない】label を必ず一緒に出すこと。
//                   色の見え方は人によって違い、白黒印刷でも消える。
//   canEnter      … いまエントリーを受け付けているか
//   blockedReason … 受け付けていない理由。null なら理由を出す必要がない
//   deadlineAt / deadlinePassed / remaining … 締切と残り枠（画面で使う）
//
// 【締切を過ぎてもエントリーは止めない】これは仕様。締め切ってブラケットを作るのは
// 運営が押したときだけで（js/entries.js の closeRecruitmentAndStart）、時刻はその
// 判断材料と、選手に見せる目安として置いている。集まりが悪ければ延ばす・早く揃えば
// 早める、という判断は現場にあるもの。だからここでは canEnter を落とさず、
// 「過ぎている」という事実だけを label と deadlinePassed で伝える ── 押せないように
// 見せてしまうと、実際には入れる人を追い返すことになる。
export function entryState(tournament, now = Date.now()) {
  const status = tournament?.status;
  const deadlineAt = entryDeadlineAt(tournament);
  const remaining = remainingSlots(tournament);
  const unit = entrantUnit(tournament);

  const base = { deadlineAt, deadlinePassed: false, remaining };

  if (status === 'finished') {
    return {
      ...base, key: 'finished', label: '終了', tone: 'finished',
      canEnter: false, blockedReason: 'この大会は終了しました。',
    };
  }

  if (status === 'running') {
    return {
      ...base, key: 'running', label: '進行中', tone: 'running',
      canEnter: false, blockedReason: 'この大会はすでに始まっているため、エントリーは締め切られています。',
    };
  }

  if (status === 'draft') {
    return {
      ...base, key: 'draft', label: '準備中', tone: 'draft',
      canEnter: false, blockedReason: 'この大会はまだ公開されていません。',
    };
  }

  // ここから先は募集中。押せなくなるのは定員に達したときだけ。
  if (remaining === 0) {
    return {
      ...base, key: 'full', label: '定員に達しました', tone: 'pending',
      canEnter: false,
      blockedReason: `定員${tournament.capacity}${unit}に達したため、これ以上エントリーできません。`,
    };
  }

  if (deadlineAt && deadlineAt.getTime() <= now) {
    return {
      ...base, deadlinePassed: true,
      key: 'deadline-passed', label: '締切時刻を過ぎています', tone: 'pending',
      canEnter: true,
      // 押せる状態なので blockedReason ではない。「まだ入れる」ことを伝える一文。
      blockedReason: null,
    };
  }

  return {
    ...base, key: 'open', label: '募集中', tone: 'recruiting',
    canEnter: true, blockedReason: null,
  };
}

// 構造化データ（schema.org）の eventStatus。
//
// このサイトの状態（準備中・募集中・進行中・終了）はどれも「予定どおり」の並びで、
// 中止や延期にあたるものが無い。中止・延期を持てるようにしたときだけここを足す
// （schema.org 側は EventPostponed / EventCancelled / EventMovedOnline を持つ）。
//
// バッジと同じ entryState から導くのは、二重管理にしないため ── 片方だけ直すと、
// 画面には「終了」と出ているのに検索結果では「開催予定」のまま、という形でずれる。
export function eventStatusOf(tournament) {
  const { key } = entryState(tournament);
  switch (key) {
    // いまは全部これに落ちる。switch の形にしてあるのは、増えたときに
    // 「どの状態がどれに対応するのか」をここだけ見れば足りるようにするため。
    case 'draft':
    case 'open':
    case 'deadline-passed':
    case 'full':
    case 'running':
    case 'finished':
    default:
      return 'https://schema.org/EventScheduled';
  }
}

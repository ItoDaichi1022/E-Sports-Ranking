// 大会の募集ページとエントリー。
//
// 流れ: draft（準備中） → recruiting（募集中） → running（進行中） → finished（終了）
// 参加希望者は募集中の大会に「エントリー」ボタン1つで登録できる。
// 運営が募集を締め切ると、それまでの戦績を元にシードを付けてブラケットを生成する。

import {
  state, isTeamTournament, entrantIdOfPlayer, getEntrantMemberIds, getPlayerName,
  isBannedPlayer,
} from './state.js';
import { escapeHtml, cardThumb, skeletonCards, createSearchRunner } from './util.js';
import { auth, isLoggedIn, canManageTournament } from './auth.js';
import { computeRankings } from './ranking.js';
import { createBracket } from './bracket.js';
import { reportChipHtml } from './matchChat.js';
import { pathFor, navigate } from './router.js';
import {
  STATUS_LABELS, entrantUnit, entryDeadlineAt, remainingSlots, entryState,
} from './tournamentState.js';
import * as db from './db.js';


// ---- エントリー締切 ----
//
// 運営が掲げる「いつまでに入ればよいか」。開催日とは別に持つ（当日の朝まで受け付ける
// 大会もあれば、前日に締める大会もあるため）。
//
// 【時刻が来ても自動では何も起きない】締め切ってブラケットを作るのは、今までどおり
// 運営が押したときだけ。集まりが悪ければ延ばす・早く揃えば早める、という判断は
// 現場にあるもので、時刻はその判断材料と、選手に見せる目安として置いている。
// だから締切を過ぎてもエントリーは受け付けたままで、画面には「過ぎた」とだけ出す。

const DEADLINE_FORMAT = {
  year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short',
  hour: '2-digit', minute: '2-digit',
};

// 「2026/8/15(金) 21:00」。見る人の地域時刻に直して出す（DBは timestamptz）。
export function entryDeadlineText(tournament) {
  const at = entryDeadlineAt(tournament);
  return at ? at.toLocaleString('ja-JP', DEADLINE_FORMAT) : '';
}

// 残り時間。刻みは、その場面で人が気にする単位までにする ── 3日先の大会に
// 「あと2日3時間41分」まで出しても読めないし、毎分書き換わって落ち着かない。
function remainingLabel(at) {
  const ms = at.getTime() - Date.now();
  // 言い方はバッジ（js/tournamentState.js の entryState）とそろえる。
  // 同じ画面に「過ぎました」と「過ぎています」が並ぶと、別の話に見える。
  if (ms <= 0) return { text: '締切時刻を過ぎています', passed: true };

  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return { text: 'まもなく締切', soon: true };
  if (minutes < 60) return { text: `あと${minutes}分`, soon: true };

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { text: `あと${hours}時間${minutes % 60}分`, soon: hours < 3 };

  const days = Math.floor(hours / 24);
  return { text: `あと${days}日${hours % 24}時間` };
}

// 書き換えの間隔。残り1時間を切ったら分単位で動くので短く、それより先は
// 1時間・1日の桁しか動かないので長くしておく。
function repaintDelay(at) {
  return at.getTime() - Date.now() > 3600_000 ? 60_000 : 15_000;
}

// 締切の表示（時刻＋残り時間）。締切が無い大会では null を返す。
//
// withNote は、締切を過ぎたときに「それでもエントリーはできる」と添えるかどうか。
// エントリーボタンの隣（大会詳細）では必要だが、一覧のカードには押す先が無いので出さない。
//
// 【タイマーの後始末】画面が描き直されるとこの要素はDOMから外れて捨てられる。
// どこかに控えておくと、消えた要素を掴んだままタイマーが回り続けるので、
// 「繋がっていなければ終わり」で自分から畳む。
export function entryDeadlineElement(tournament, { withNote = false } = {}) {
  const at = entryDeadlineAt(tournament);
  if (!at) return null;

  const box = document.createElement('div');
  box.className = 'entry-deadline';

  const chip = document.createElement('span');
  chip.className = 'entry-deadline-chip';

  const note = document.createElement('span');
  note.className = 'entry-deadline-note';
  note.textContent = '運営が締め切るまではエントリーできます。';
  note.hidden = true;

  const paint = () => {
    const left = remainingLabel(at);
    chip.textContent = `エントリー締切 ${at.toLocaleString('ja-JP', DEADLINE_FORMAT)}（${left.text}）`;
    chip.classList.toggle('is-passed', Boolean(left.passed));
    chip.classList.toggle('is-soon', Boolean(left.soon));
    if (withNote) note.hidden = !left.passed;
  };

  const tick = () => {
    if (!box.isConnected) return;
    paint();
    setTimeout(tick, repaintDelay(at));
  };

  paint();
  setTimeout(tick, repaintDelay(at));

  box.append(chip);
  if (withNote) box.append(note);
  return box;
}

// 自分が入っている出場枠のID（個人戦なら自分の選手ID、チーム戦なら所属チームのID）。
function myEntrantId(tournament) {
  return auth.player ? entrantIdOfPlayer(tournament, auth.player.id) : null;
}

// エントリー済みの出場枠を、現在のランキング順に並べてシード順を決める（⑤）。
// チームのランクは「メンバーの中で最も上位のランク」とする。ランキングに載っていない
// 選手・チームは後ろにまとめ、その中では登録順を保つ。
export function seedEntrants(tournament) {
  const rankByPlayer = new Map(computeRankings(state).map((r) => [r.id, r.rank]));
  const order = tournament.entrantIds;

  // メンバーが1人（個人戦）ならその選手のランクそのもの。誰もランキングに
  // 載っていなければ Infinity になり、後ろにまとまる。
  const rankOf = (entrantId) => Math.min(
    ...getEntrantMemberIds(tournament.id, entrantId).map((id) => rankByPlayer.get(id) ?? Infinity),
  );

  return [...order].sort((a, b) => {
    const ra = rankOf(a);
    const rb = rankOf(b);
    if (ra !== rb) return ra - rb;
    return order.indexOf(a) - order.indexOf(b);
  });
}

// 募集を締め切り、シードを確定してブラケットを生成する。
export async function closeRecruitmentAndStart(tournamentId) {
  // シードは全期間のランキングで決まるので、ここで初めて全データを読み込む
  // （普段は試合結果を持っていない。js/db.js の ensureFullData を参照）。
  await db.ensureFullData();

  const tournament = state.tournaments.find((t) => t.id === tournamentId);
  if (!tournament) throw new Error('大会が見つかりません。');
  if (tournament.entrantIds.length < 2) {
    throw new Error(`参加${entrantUnit(tournament)}が2${entrantUnit(tournament)}以上必要です。`);
  }

  const seeded = seedEntrants(tournament);
  if (isTeamTournament(tournament)) await db.saveTeamSeeds(tournamentId, seeded);
  else await db.saveSeeds(tournamentId, seeded);

  // BYEはブラケット生成時に自動確定するが、対戦相手がいないので試合としては記録しない
  // （旧実装と同じ扱い。matchesに入るのは confirmMatch を通った実際の対戦だけ）。
  const bracket = createBracket(tournamentId, seeded, {
    thirdPlace: tournament.thirdPlaceMatch,
  });
  await db.saveBracket(tournamentId, bracket);
  await db.setTournamentStatus(tournamentId, 'running');

  state.brackets[tournamentId] = bracket;
  state.bracketIds.add(tournamentId);
  tournament.entrantIds = seeded;
  // シード番号はいま saveSeeds / saveTeamSeeds が index+1 で書き込んだところ。
  // 次の読み込みを待たずに画面へ出せるよう、同じ値をここでも入れておく。
  tournament.entrantSeeds = seeded.map((_, i) => i + 1);
  tournament.participantIds = seeded.flatMap((id) => getEntrantMemberIds(tournamentId, id));
  tournament.entrantCount = tournament.entrantIds.length;
  tournament.participantCount = tournament.participantIds.length;
  tournament.status = 'running';
  return bracket;
}

// ---- 描画 ----

// 押せないときのボタン。灰色にして止めるだけでは「壊れている」のか
// 「自分には押せない」のか分からないので、理由は必ず renderEntryCta が
// 文字でも添える（色と非活性だけで意味を伝えない）。
//
// disabled のボタンは読み上げの移動先からも外れるため、理由の文と
// aria-describedby で結び、ボタンに辿り着かなくても事情が読めるようにしてある。
function blockedButton(label, reasonId) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-secondary';
  btn.textContent = label;
  btn.disabled = true;
  if (reasonId) btn.setAttribute('aria-describedby', reasonId);
  return btn;
}

// 個人戦（1v1・リレー）のエントリー。ボタン1つで登録・取り消しができる。
function soloEntryButton(tournament, onChanged) {
  const entered = Boolean(myEntrantId(tournament));
  const btn = document.createElement('button');
  btn.type = 'button';

  if (entered) {
    // 取り消しは主導線ではないので、目立たせない
    btn.className = 'btn-secondary';
    btn.textContent = 'エントリーを取り消す';
  } else if (remainingSlots(tournament) === 0) {
    return blockedButton('定員に達しました', BLOCKED_REASON_ID);
  } else {
    btn.className = 'btn-entry';
    btn.textContent = 'エントリーする';
  }

  btn.addEventListener('click', async () => {
    // 押し間違いで参加・辞退が確定しないよう、どちらも一度確認する
    const confirmed = entered
      ? confirm(`「${tournament.name}」のエントリーを取り消しますか？`)
      : confirm(`「${tournament.name}」にエントリーしますか？`);
    if (!confirmed) return;

    btn.disabled = true;
    try {
      if (entered) {
        await db.cancelEntry(tournament.id, auth.player.id);
      } else {
        await db.enterTournament(tournament.id, auth.player.id);
      }
      await onChanged();
    } catch (err) {
      alert(err.message);
      btn.disabled = false;
    }
  });

  return btn;
}

// 開いているチームエントリーのフォームと、入力途中の値。
//
// 募集中の大会は、他の人のエントリーがRealtimeで届くたびに画面が描き直される。
// 覚えておかないと、チーム名を打っている最中に入力が消えてしまう。
let openTeamForm = null; // { tournamentId, teamName, partnerId, partnerQuery } | null

// プレイヤー名。同姓同名や表記ゆれで取り違えないよう、あればゲームIDも添える。
function playerLabel(player) {
  return player.gameAccountId
    ? `${player.currentName}（${player.gameAccountId}）`
    : player.currentName;
}

// 相方を選ぶ欄。選択肢が数十人になるとドロップダウンから探すのが辛いので、
// 名前かゲームIDで検索して選ぶ形にする。
//
// 検索欄が空のうちは候補を出さない。選んだ相手は一覧から消えても分かるよう、
// 常に上に出しておく。
// excludeIds には自分と、既にこの大会に出ている選手を入れる。
// （検索そのものはDB側。利用停止中の選手は db.searchPlayers が返さない）
function partnerPicker(excludeIds) {
  const wrap = document.createElement('div');
  wrap.className = 'partner-picker';

  const chosen = document.createElement('p');
  chosen.className = 'partner-chosen';

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'partner-search';
  search.placeholder = '選手を検索（名前・ゲームID）';
  search.value = openTeamForm.partnerQuery ?? '';
  search.setAttribute('aria-label', '相方を検索');
  // 検索欄でEnterを押しただけでエントリーが確定してしまわないようにする
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault();
  });

  const list = document.createElement('div');
  list.className = 'scroll-box';

  // 選んだ相手は state.players から引く。検索の結果は db.searchPlayers が
  // state.players に混ぜているので、一度見かけた人はここで引ける。
  const syncChosen = () => {
    const picked = state.players.find((p) => p.id === openTeamForm.partnerId);
    chosen.textContent = picked ? `相方: ${playerLabel(picked)}` : '相方が選ばれていません';
    chosen.classList.toggle('is-empty', !picked);
  };

  // 検索の状態。'idle'（未入力） / 'loading' / 'done' / 'error'
  let hits = [];
  let status = 'idle';
  let errorText = '';

  const renderList = () => {
    list.innerHTML = '';

    // 何も打っていないうちは候補を出さない。全員を並べても目当ての人は結局探せず、
    // たまたま先頭に来た人を押し間違えるほうが起きやすいため。
    if (status === 'idle') {
      list.innerHTML = '<p class="empty-hint">名前かゲームIDを入力すると候補が出ます。</p>';
      return;
    }

    if (status === 'error') {
      list.innerHTML = `<p class="empty-hint">${escapeHtml(errorText)}</p>`;
      return;
    }

    // 通信の途中に「一致する選手がいません」を挟まない（打つたびに一瞬出る）
    if (status === 'loading') {
      list.innerHTML = '<p class="status-line loading">検索しています...</p>';
      return;
    }

    const visible = hits.filter((p) => !excludeIds.has(p.id));

    if (visible.length === 0) {
      list.innerHTML = '<p class="empty-hint">条件に一致する選手がいません。</p>';
      return;
    }

    visible.forEach((p) => {
      const label = document.createElement('label');
      label.className = 'checkbox-item';

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'team-partner';
      radio.value = p.id;
      radio.checked = openTeamForm.partnerId === p.id;
      radio.addEventListener('change', () => {
        openTeamForm.partnerId = p.id;
        syncChosen();
      });

      label.append(radio, document.createTextNode(` ${playerLabel(p)}`));
      list.appendChild(label);
    });
  };

  // 打鍵ごとに投げない・古い応答に上書きさせない（js/util.js の注記を参照）
  const runSearch = createSearchRunner({
    search: (q) => db.searchPlayers(q),
    onStart: () => { status = 'loading'; errorText = ''; renderList(); },
    onEmpty: () => { hits = []; status = 'idle'; renderList(); },
    onResult: ({ players }) => { hits = players; status = 'done'; renderList(); },
    onError: (err) => { status = 'error'; errorText = err.message; renderList(); },
  });

  search.addEventListener('input', () => {
    openTeamForm.partnerQuery = search.value;
    runSearch(search.value);
  });

  renderList();
  syncChosen();
  // 画面が描き直されても（Realtimeで他の人のエントリーが届くたびに起きる）、
  // 打ってあった文字から候補を出し直す。
  if (openTeamForm.partnerQuery) runSearch(openTeamForm.partnerQuery);

  wrap.append(chosen, search, list);
  return wrap;
}

// チーム戦のエントリーフォーム。チーム名と相方を決めないと登録できないので、
// ボタン1つでは終わらない。送信するとチーム行とメンバー2人のエントリー行が
// DBのRPCで1回にまとめて作られる（片方だけ登録された状態が起きない）。
function teamEntryForm(tournament, onChanged, onCancel) {
  const form = document.createElement('form');
  form.className = 'team-entry-form';

  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'チーム名';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.required = true;
  nameInput.maxLength = 24;
  nameInput.placeholder = '例: チームぐんぐん';
  nameInput.value = openTeamForm.teamName;
  nameInput.addEventListener('input', () => { openTeamForm.teamName = nameInput.value; });
  nameLabel.appendChild(nameInput);

  // 自分と、既にこの大会に出ている選手は選べない（DB側でも弾かれるが、
  // 選べてしまうと送信して初めてエラーになり分かりにくい）。
  // 利用停止中の選手も同じ理由で候補に出さない（enter_tournament_as_team が弾く）。
  const excludeIds = new Set([...tournament.participantIds, auth.player.id]);

  // 選んでいた相手が先に他のチームで埋まっていたら、選択を空に戻す
  if (openTeamForm.partnerId && excludeIds.has(openTeamForm.partnerId)) {
    openTeamForm.partnerId = '';
  }

  const partnerField = document.createElement('div');
  partnerField.className = 'partner-field';
  const partnerHeading = document.createElement('span');
  partnerHeading.className = 'partner-heading';
  partnerHeading.textContent = '相方';
  partnerField.append(partnerHeading, partnerPicker(excludeIds));

  form.append(nameLabel, partnerField);

  // 【「組める相手がいません」を先に出さない】以前は候補の配列を持っていたので
  // 0人かどうかが分かったが、検索がDB側に移り、探す前に「居ない」とは言えなくなった。
  // 探した結果が0件なら、候補欄が「条件に一致する選手がいません」と出す。

  const actions = document.createElement('div');
  actions.className = 'row-actions';

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn-entry';
  submitBtn.textContent = 'エントリーする';
  // 相方が選ばれていないまま押されたら submit 側で止める（下の form.submit）。
  // 候補が0人かどうかは探すまで分からないので、ここでは伏せない。

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn-secondary';
  cancelBtn.textContent = 'やめる';
  cancelBtn.addEventListener('click', onCancel);

  actions.append(submitBtn, cancelBtn);
  form.appendChild(actions);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const teamName = nameInput.value.trim();
    if (!teamName) {
      alert('チーム名を入力してください。');
      return;
    }
    if (!openTeamForm.partnerId) {
      alert('相方を選んでください。');
      return;
    }

    submitBtn.disabled = true;
    try {
      await db.enterTournamentAsTeam(
        tournament.id, teamName, [auth.player.id, openTeamForm.partnerId],
      );
      openTeamForm = null;
      await onChanged();
    } catch (err) {
      alert(err.message);
      submitBtn.disabled = false;
    }
  });

  return form;
}

function teamEntryControls(tournament, onChanged) {
  const wrap = document.createElement('div');
  wrap.className = 'team-entry';

  const myTeamId = myEntrantId(tournament);
  const myTeam = tournament.teams.find((tm) => tm.id === myTeamId);

  if (myTeam) {
    const status = document.createElement('p');
    status.className = 'team-entry-status';
    const members = myTeam.memberIds.map((id) => getPlayerName(id)).join(' / ');
    status.textContent = `「${myTeam.name}」でエントリー済み（${members}）`;

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = 'エントリーを取り消す';
    cancelBtn.addEventListener('click', async () => {
      // 2人組は片方が抜けたら成立しないので、取り消すとチームごと消える。
      // 相方の参加も消えることを必ず伝えてから実行する。
      const partners = myTeam.memberIds
        .filter((id) => id !== auth.player.id)
        .map((id) => getPlayerName(id))
        .join('・');
      const note = partners ? `${partners}さんの参加も取り消しになります。` : '';
      if (!confirm(`「${myTeam.name}」のエントリーを取り消しますか？${note}`)) return;

      cancelBtn.disabled = true;
      try {
        await db.cancelTeamEntry(myTeam.id);
        await onChanged();
      } catch (err) {
        alert(err.message);
        cancelBtn.disabled = false;
      }
    });

    wrap.append(status, cancelBtn);
    return wrap;
  }

  if (remainingSlots(tournament) === 0) {
    wrap.appendChild(blockedButton('定員に達しました', BLOCKED_REASON_ID));
    return wrap;
  }

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'btn-entry';
  openBtn.textContent = 'チームでエントリー';

  const showForm = () => {
    openBtn.hidden = true;
    wrap.appendChild(teamEntryForm(tournament, onChanged, () => {
      openTeamForm = null;
      wrap.querySelector('.team-entry-form')?.remove();
      openBtn.hidden = false;
    }));
  };

  openBtn.addEventListener('click', () => {
    openTeamForm = {
      tournamentId: tournament.id, teamName: '', partnerId: '', partnerQuery: '',
    };
    showForm();
  });

  wrap.appendChild(openBtn);
  // 描き直される前に開いていたなら、入力途中の値ごと開き直す
  if (openTeamForm?.tournamentId === tournament.id) showForm();
  return wrap;
}

function entryControls(tournament, onChanged) {
  // エントリーはこのページの主目的なので、その入口になるボタンは目立たせる
  // （ログイン・選手登録もエントリーへ向かう導線なので同じ扱いにする）。
  if (!isLoggedIn()) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-entry';
    btn.textContent = 'ログインしてエントリー';
    // ページ遷移せずダイアログだけ開く（見ていた大会を失わないように）
    btn.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('request-login'));
    });
    return btn;
  }

  if (!auth.player) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-entry';
    btn.textContent = '選手登録してエントリー';
    btn.addEventListener('click', () => { navigate('profile'); });
    return btn;
  }

  // 利用停止中はエントリーできない（DB側の entries_insert と
  // enter_tournament_as_team も同じ判定を持つ）。押せないボタンを出すより、
  // なぜ押せないのかをここで言い切る。
  if (isBannedPlayer(auth.player)) {
    const note = document.createElement('p');
    note.className = 'entry-cta-reason';
    note.textContent = 'このアカウントは利用を停止されているため、エントリーできません。';
    return note;
  }

  return isTeamTournament(tournament)
    ? teamEntryControls(tournament, onChanged)
    : soloEntryButton(tournament, onChanged);
}

function adminControls(tournament, onChanged) {
  const wrap = document.createElement('div');
  wrap.className = 'row-actions';

  // 準備中を出るボタン＝この大会を世に出すボタン。押すまでは運営にしか見えない。
  //
  // 行き先は大会の作り方で変わる。エントリーを募集する大会は募集中へ、
  // 運営が参加者を直接選んだ大会は（作った時点で組み合わせが出来ているので）
  // そのまま進行中へ。どちらも「公開」という一度きりの操作としてまとめてある。
  if (tournament.status === 'draft') {
    const ready = state.bracketIds.has(tournament.id);
    const nextStatus = ready ? 'running' : 'recruiting';

    // 既定のボタン（アクセント色）のまま。.btn-entry の光る扱いは
    // 「エントリー」だけのもので、ここで借りると印の意味が薄まる。
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.textContent = ready ? '公開して大会を開始' : '公開して募集を開始';
    openBtn.addEventListener('click', async () => {
      const message = ready
        ? `「${tournament.name}」を公開して開始します。対戦表が選手とゲストに見えるようになります。よろしいですか？`
        : `「${tournament.name}」を公開して募集を始めます。大会一覧に並び、誰でもエントリーできるようになります。よろしいですか？`;
      if (!confirm(message)) return;

      openBtn.disabled = true;
      try {
        await db.setTournamentStatus(tournament.id, nextStatus);
        await onChanged();
      } catch (err) {
        alert(err.message);
        openBtn.disabled = false;
      }
    });
    wrap.appendChild(openBtn);
  }

  if (tournament.status === 'recruiting') {
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '締め切ってブラケット生成';
    closeBtn.addEventListener('click', async () => {
      const count = `${tournament.entrantCount}${entrantUnit(tournament)}`;
      if (!confirm(`「${tournament.name}」の募集を締め切り、現在の${count}でブラケットを生成します。よろしいですか？`)) return;
      closeBtn.disabled = true;
      try {
        await closeRecruitmentAndStart(tournament.id);
        navigate('bracket', tournament.id);
        // 移動しても、生成されたばかりのブラケットはまだ手元のデータに無い。
        // 明示的に更新して出し直す。
        await onChanged();
      } catch (err) {
        alert(err.message);
        closeBtn.disabled = false;
      }
    });
    wrap.appendChild(closeBtn);

    // 募集を止める＝準備中に戻す＝公開を取り下げる。エントリー済みの人には
    // 大会ごと見えなくなるので、押す前にそこまで伝える。
    const reopenBtn = document.createElement('button');
    reopenBtn.type = 'button';
    reopenBtn.className = 'btn-secondary';
    reopenBtn.textContent = '募集を止めて非公開に戻す';
    reopenBtn.addEventListener('click', async () => {
      if (!confirm(`「${tournament.name}」を準備中に戻します。公開が取り下げられ、選手とゲストには大会ごと見えなくなります（エントリーは残ります）。よろしいですか？`)) return;

      reopenBtn.disabled = true;
      try {
        await db.setTournamentStatus(tournament.id, 'draft');
        await onChanged();
      } catch (err) {
        alert(err.message);
        reopenBtn.disabled = false;
      }
    });
    wrap.appendChild(reopenBtn);
  }

  return wrap;
}

// エントリー済みの人に、本番までの環境づくり（#setup）を案内する小さな帯。
//
// 【エントリーの前には出さない】エントリーはこのページの主目的なので、その手前に
// 別の誘導を挟むと主導線が濁る。参加が決まったあと、当日まで時間が残っている
// この瞬間にだけ出す。案内先のページは広告を含むので、なおさら順序を守ること。
//
// 【しつこくしない】閉じたら覚えて、その大会では二度と出さない。エントリー済みの
// 大会は開始までに何度も開かれるので、毎回出ると催促になる。
const SETUP_PROMPT_KEY = 'ignitearena.setupPrompt.dismissed';

function dismissedSetupPrompts() {
  try {
    return new Set(JSON.parse(localStorage.getItem(SETUP_PROMPT_KEY) ?? '[]'));
  } catch {
    return new Set(); // 読めなくても案内が出るだけなので、空で続ける
  }
}

function setupPrompt(tournament) {
  if (!myEntrantId(tournament)) return null; // エントリーした人にだけ
  if (dismissedSetupPrompts().has(tournament.id)) return null;

  const box = document.createElement('aside');
  box.className = 'setup-prompt';

  const text = document.createElement('p');
  text.className = 'setup-prompt-text';
  text.textContent = '本番までにできることがあります。';

  // 主導線（エントリー）より弱く見せるため、ボタンではなくリンクで置く
  const link = document.createElement('a');
  link.className = 'setup-prompt-link';
  link.href = '#setup';
  link.textContent = '対戦環境を整える';

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'setup-prompt-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'この案内を閉じる');
  close.addEventListener('click', () => {
    const seen = dismissedSetupPrompts();
    seen.add(tournament.id);
    try {
      localStorage.setItem(SETUP_PROMPT_KEY, JSON.stringify([...seen]));
    } catch { /* 保存できなくても、閉じる動作だけは済ませる */ }
    box.remove();
  });

  box.append(text, link, close);
  return box;
}

// 準備中の大会の帯（運営だけが見る）。
//
// 「まだ誰にも見えていない」ことは、画面を見ただけでは分からない ── 運営には
// 普通の大会ページとして見えているので、公開したつもりのまま放置される。
// 状態と、公開までに何が残っているかを、操作の真上で1つだけ言う。
function draftNotice(tournament) {
  const box = document.createElement('aside');
  box.className = 'draft-notice';

  const title = document.createElement('span');
  title.className = 'draft-notice-title';
  title.textContent = 'この大会はまだ公開されていません';

  const text = document.createElement('p');
  text.className = 'draft-notice-text';
  text.textContent = state.bracketIds.has(tournament.id)
    ? '見えているのは運営だけです。選手とゲストには大会も対戦表も出ません。内容と組み合わせを確かめてから、下のボタンで公開してください。'
    : '見えているのは運営だけです。選手とゲストには大会一覧にも共有リンクにも出ません。内容を確かめてから、下のボタンで公開してください。';

  box.append(title, text);
  return box;
}

// 大会詳細ページ用の操作。エントリーと、運営の募集操作をまとめて置く。
//
// 募集一覧のカードは大会名・画像・開催日だけの入口にしたので、実際に手を動かす
// 操作はすべてこちら（詳細）に集約する。一覧に操作を置くと、カード全体を
// タップ領域にできず（リンクの中にボタンが入れ子になる）、押し間違いも起きる。
export function renderTournamentActions(containerEl, tournament, onChanged) {
  containerEl.innerHTML = '';
  if (!tournament) return;

  // まだ公開していない大会。ここに立てるのは運営だけ（DBが draft の行を
  // 運営以外に返さない。supabase/migration-022.sql）なので、その人に向けて
  // 「いま誰に見えているか」と「公開すると何が起きるか」を言い切る。
  if (tournament.status === 'draft' && canManageTournament(tournament.id)) {
    containerEl.appendChild(draftNotice(tournament));
  }

  const row = document.createElement('div');
  row.className = 'tournament-actions-row';

  // 運営の操作はこの大会の運営に出す。サイト全体の運営かどうかではない
  // （大会は誰でも作れるので、作った本人に出ないと公開できなくなる）。
  if (canManageTournament(tournament.id)) {
    const admin = adminControls(tournament, onChanged);
    if (admin.children.length > 0) row.appendChild(admin);
  }

  if (row.children.length > 0) containerEl.appendChild(row);

  // 環境づくりの案内は、まだ当日まで間に合う「募集中」のあいだだけ。
  // 始まってしまえば手の打ちようがなく、出しても広告にしかならない。
  if (tournament.status === 'recruiting') {
    const prompt = setupPrompt(tournament);
    if (prompt) containerEl.appendChild(prompt);
  }
}

// エントリーの理由文につける印。押せないボタンから aria-describedby で指す。
const BLOCKED_REASON_ID = 'entry-blocked-reason';

// エントリーの導線（大会詳細の上部）。
//
// 【なぜページの上に置くか】以前はルールや参加者を確認したあとに押せるよう、
// ページの一番下に置いていた。読む順としては正しいが、募集中の大会を開いた人が
// 最初に知りたいのは「自分は出られるのか、いつまでか」で、それが画面外にあると
// 一度スクロールしないと分からない。確認したい人は下まで読めるが、
// 決めている人まで下まで歩かせる理由はない。
//
// 【押せる入口はこの1つだけ】下の renderTournamentActions にエントリーは置かない。
// 2か所に出すと、片方を押した後にもう片方が残って「まだ押していない」ように見える。
export function renderEntryCta(containerEl, tournament, onChanged) {
  containerEl.innerHTML = '';
  containerEl.hidden = true;
  if (!tournament) return;

  const st = entryState(tournament);

  // エントリーが話題になるのは募集中のあいだだけ。進行中・終了した大会に
  // 「エントリーできません」と大きく出しても、読む人には何も残らない
  // （状態は見出しの隣のバッジが伝えている）。準備中は運営向けの案内
  // （draftNotice）が別に出る。
  if (tournament.status !== 'recruiting') return;

  const entered = Boolean(myEntrantId(tournament));

  const box = document.createElement('div');
  box.className = 'entry-cta';
  if (!st.canEnter && !entered) box.classList.add('is-blocked');
  if (entered) box.classList.add('is-entered');

  // エントリー済みなら、まずそう言い切る。個人戦のボタンは「エントリーを取り消す」に
  // 変わるだけなので、それだけでは「済んでいるから取り消せる」のか「間違って
  // 押しかけている」のかが読み取れない。
  // チーム戦は .team-entry-status が同じことを（チーム名つきで）言うので重ねない。
  if (entered && !isTeamTournament(tournament)) {
    const done = document.createElement('p');
    done.className = 'entry-cta-entered';
    done.textContent = 'この大会にエントリー済みです。募集中のあいだはいつでも取り消せます。';
    box.appendChild(done);
  }

  box.appendChild(entryControls(tournament, onChanged));

  // 締切はボタンのすぐ隣。押すかどうかを決めるのはこの場所で、
  // 大会情報の表まで下りないと期限が分からないのでは間に合わない。
  const deadline = entryDeadlineElement(tournament, { withNote: true });
  if (deadline) box.appendChild(deadline);

  // 押せない理由は必ず文字で出す。灰色になっているだけでは、
  // 壊れているのか自分には押せないのかが分からない。
  if (st.blockedReason) {
    const reason = document.createElement('p');
    reason.className = 'entry-cta-reason';
    reason.id = BLOCKED_REASON_ID;
    reason.textContent = st.blockedReason;
    box.appendChild(reason);
  } else if (st.remaining !== null && st.remaining > 0) {
    // 残り枠は「押せるうち」だけ添える。埋まってからは上の理由が受け持つ。
    const left = document.createElement('p');
    left.className = 'entry-cta-slots';
    left.textContent = `残り${st.remaining}${entrantUnit(tournament)}（定員${tournament.capacity}${entrantUnit(tournament)}）`;
    box.appendChild(left);
  }

  containerEl.appendChild(box);
  containerEl.hidden = false;
}

// 募集ページ。運営には準備中の大会も見せる。
//
// 一覧は「どの大会があるか」を見渡すための場所なので、大会名・画像・開催日だけを
// 出す。定員やルール、参加者、エントリーボタンは詳細ページの担当。
export function renderRecruitPage(containerEl) {
  containerEl.innerHTML = '';

  // 準備中は、その大会の運営にだけ並べる（そもそもDBが他の人には返さない）。
  // サイト全体の運営かどうかで見るのではない ── 大会は誰でも作れるので、
  // 作った本人の手元に出ないと、公開する場所へ辿り着けなくなる。
  const visible = state.tournaments.filter((t) =>
    t.status === 'recruiting' || (t.status === 'draft' && canManageTournament(t.id)));

  if (visible.length === 0) {
    // まだ届いていないだけかもしれないので、そのときは仮置きを出す
    // （「募集中の大会はありません」を読み込み中に出すと、来た人を追い返す）。
    if (!db.hasLoadedOnce()) {
      containerEl.appendChild(skeletonCards(3));
      return;
    }
    containerEl.innerHTML = '<p class="empty-hint">現在募集中の大会はありません。</p>';
    return;
  }

  // カードの形は募集・大会履歴・お知らせで共通（css の .card 系）
  const list = document.createElement('div');
  list.className = 'card-grid';

  visible.forEach((t) => {
    // カードの中にボタンやリンクを置かないので、カード全体を1つのリンクにできる。
    // どこを押しても詳細へ行くため、スマートフォンでも押し外しにくい。
    const card = document.createElement('a');
    card.className = 'card';
    card.href = pathFor('tournament', t.id);

    const body = document.createElement('div');
    body.className = 'card-body';
    // 準備中はまだ公開していない大会。運営にしか見えないので、
    // 募集中のものと取り違えないよう印を付ける。
    body.innerHTML = `
      <h2 class="card-title">${escapeHtml(t.name)}</h2>
      <p class="card-date">${escapeHtml(t.date || '開催日未定')}</p>
      ${t.status === 'draft' ? `<span class="status-chip status-draft">${STATUS_LABELS.draft}</span>` : ''}
      ${reportChipHtml(t.id)}
    `;

    // 締切は開催日のすぐ下に。一覧に出す数少ない値なのは、どの大会に急いで
    // 入るべきかが、開いて回らなくても分かるようにするため。
    const deadline = t.status === 'recruiting' ? entryDeadlineElement(t) : null;
    if (deadline) body.querySelector('.card-date').after(deadline);

    card.append(cardThumb(t.imageUrl, t.name), body);
    list.appendChild(card);
  });

  containerEl.appendChild(list);
}

// 大会の募集ページとエントリー。
//
// 流れ: draft（準備中） → recruiting（募集中） → running（進行中） → finished（終了）
// 参加希望者は募集中の大会に「エントリー」ボタン1つで登録できる。
// 運営が募集を締め切ると、それまでの戦績を元にシードを付けてブラケットを生成する。

import {
  state, isTeamTournament, entrantIdOfPlayer, getEntrantMemberIds, getPlayerName,
} from './state.js';
import { escapeHtml, cardThumb } from './util.js';
import { auth, isLoggedIn, isAdmin } from './auth.js';
import { computeRankings } from './ranking.js';
import { createBracket } from './bracket.js';
import { reportChipHtml } from './matchChat.js';
import * as db from './db.js';

export const STATUS_LABELS = {
  draft: '準備中',
  recruiting: '募集中',
  running: '進行中',
  finished: '終了',
};

// 出場枠の数え方の呼び名。チーム戦の定員16は「16チーム」であって16人ではない。
export function entrantUnit(tournament) {
  return isTeamTournament(tournament) ? 'チーム' : '人';
}

// 自分が入っている出場枠のID（個人戦なら自分の選手ID、チーム戦なら所属チームのID）。
function myEntrantId(tournament) {
  return auth.player ? entrantIdOfPlayer(tournament, auth.player.id) : null;
}

// 残り枠。数えるのは出場枠なので、チーム戦ではチーム数で見る
// （DBの定員トリガーが count(distinct coalesce(team_id, player_id)) で数えるのと同じ）。
function remainingSlots(tournament) {
  if (tournament.capacity == null) return null;
  return Math.max(0, tournament.capacity - tournament.entrantCount);
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

function fullSlotsButton() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-secondary';
  btn.textContent = '定員に達しました';
  btn.disabled = true;
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
    return fullSlotsButton();
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
function partnerPicker(candidates) {
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

  const syncChosen = () => {
    const picked = candidates.find((p) => p.id === openTeamForm.partnerId);
    chosen.textContent = picked ? `相方: ${playerLabel(picked)}` : '相方が選ばれていません';
    chosen.classList.toggle('is-empty', !picked);
  };

  const renderList = () => {
    list.innerHTML = '';

    const query = search.value.trim().toLowerCase();

    // 何も打っていないうちは候補を出さない。全員を並べても目当ての人は結局探せず、
    // たまたま先頭に来た人を押し間違えるほうが起きやすいため。
    if (!query) {
      list.innerHTML = '<p class="empty-hint">名前かゲームIDを入力すると候補が出ます。</p>';
      return;
    }

    const visible = candidates.filter((p) => p.currentName.toLowerCase().includes(query)
      || (p.gameAccountId ?? '').toLowerCase().includes(query));

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

  search.addEventListener('input', () => {
    openTeamForm.partnerQuery = search.value;
    renderList();
  });

  renderList();
  syncChosen();

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
  // 選べてしまうと送信して初めてエラーになり分かりにくい）
  const taken = new Set(tournament.participantIds);
  const candidates = state.players.filter((p) => p.id !== auth.player.id && !taken.has(p.id));

  // 選んでいた相手が先に他のチームで埋まっていたら、選択を空に戻す
  if (openTeamForm.partnerId && !candidates.some((p) => p.id === openTeamForm.partnerId)) {
    openTeamForm.partnerId = '';
  }

  const partnerField = document.createElement('div');
  partnerField.className = 'partner-field';
  const partnerHeading = document.createElement('span');
  partnerHeading.className = 'partner-heading';
  partnerHeading.textContent = '相方';
  partnerField.append(partnerHeading, partnerPicker(candidates));

  form.append(nameLabel, partnerField);

  if (candidates.length === 0) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = '組める相手がいません。相方がまだ選手登録していない場合は、運営に連絡してください。';
    form.appendChild(note);
  }

  const actions = document.createElement('div');
  actions.className = 'row-actions';

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'btn-entry';
  submitBtn.textContent = 'エントリーする';
  submitBtn.disabled = candidates.length === 0;

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
    wrap.appendChild(fullSlotsButton());
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
    btn.addEventListener('click', () => { location.hash = '#profile'; });
    return btn;
  }

  return isTeamTournament(tournament)
    ? teamEntryControls(tournament, onChanged)
    : soloEntryButton(tournament, onChanged);
}

function adminControls(tournament, onChanged) {
  const wrap = document.createElement('div');
  wrap.className = 'row-actions';

  if (tournament.status === 'draft') {
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.textContent = '募集を開始';
    openBtn.addEventListener('click', async () => {
      openBtn.disabled = true;
      try {
        await db.setTournamentStatus(tournament.id, 'recruiting');
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
        location.hash = `#bracket/${encodeURIComponent(tournament.id)}`;
        // 既にその大会の詳細を開いていた場合は hashchange が起きず再描画されない。
        // 明示的に更新して、生成されたブラケットを出す。
        await onChanged();
      } catch (err) {
        alert(err.message);
        closeBtn.disabled = false;
      }
    });
    wrap.appendChild(closeBtn);

    const reopenBtn = document.createElement('button');
    reopenBtn.type = 'button';
    reopenBtn.className = 'btn-secondary';
    reopenBtn.textContent = '募集を止める';
    reopenBtn.addEventListener('click', async () => {
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

// 大会詳細ページ用の操作。エントリーと、運営の募集操作をまとめて置く。
//
// 募集一覧のカードは大会名・画像・開催日だけの入口にしたので、実際に手を動かす
// 操作はすべてこちら（詳細）に集約する。一覧に操作を置くと、カード全体を
// タップ領域にできず（リンクの中にボタンが入れ子になる）、押し間違いも起きる。
export function renderTournamentActions(containerEl, tournament, onChanged) {
  containerEl.innerHTML = '';
  if (!tournament) return;

  const row = document.createElement('div');
  row.className = 'tournament-actions-row';

  if (tournament.status === 'recruiting') {
    row.appendChild(entryControls(tournament, onChanged));
  }
  if (isAdmin()) {
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

// 募集ページ。運営には準備中の大会も見せる。
//
// 一覧は「どの大会があるか」を見渡すための場所なので、大会名・画像・開催日だけを
// 出す。定員やルール、参加者、エントリーボタンは詳細ページの担当。
export function renderRecruitPage(containerEl) {
  containerEl.innerHTML = '';

  const visible = state.tournaments.filter((t) =>
    t.status === 'recruiting' || (isAdmin() && t.status === 'draft'));

  if (visible.length === 0) {
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
    card.href = `#tournament/${encodeURIComponent(t.id)}`;

    const body = document.createElement('div');
    body.className = 'card-body';
    // 準備中はまだ公開していない大会。運営にしか見えないので、
    // 募集中のものと取り違えないよう印を付ける。
    body.innerHTML = `
      <h3 class="card-title">${escapeHtml(t.name)}</h3>
      <p class="card-date">${escapeHtml(t.date || '開催日未定')}</p>
      ${t.status === 'draft' ? `<span class="status-chip status-draft">${STATUS_LABELS.draft}</span>` : ''}
      ${reportChipHtml(t.id)}
    `;

    card.append(cardThumb(t.imageUrl, t.name), body);
    list.appendChild(card);
  });

  containerEl.appendChild(list);
}

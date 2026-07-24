import { state, newId, getPlayerName } from './state.js';
import { renderPlayerTable, updatePlayer } from './players.js';
import { escapeHtml, avatarHtml, safeUrl, setupImagePicker } from './util.js';
import {
  createBracket, updateTournament, getChampionId, allMatchesDecided, finalStandings,
} from './bracket.js';
import { renderBracket } from './bracketView.js';
import { computeRankings, computeRankingsForPeriod, withRankChange, rankChangeInfo } from './ranking.js';
import { renderRankingTable } from './rankingView.js';
import { downloadRankingCards } from './rankingCard.js';
import { getPlayerStats } from './playerStats.js';
import { tournamentTier } from './tournamentTier.js';
import { renderProfileForm, profileSectionHtml, isProfileFormMounted } from './profile.js';
import { renderRecruitPage, STATUS_LABELS } from './entries.js';
import {
  auth, initAuth, isAdmin, isLoggedIn, needsOnboarding, accountLabel,
  signInWithProvider, signInWithEmail, signUpWithEmail, signOut, reloadOwnPlayer,
} from './auth.js';
import { isConfigured } from './supabaseClient.js';
import * as db from './db.js';

// 大会作成画面でのシード順（index 0 = シード1位）。ブラケット生成前の一時的な状態。
let selectedParticipantIds = [];
let participantSearchQuery = '';
let playerSearchQuery = '';
let currentBracketTournamentId = null;

const $ = (id) => document.getElementById(id);

const playerForm = $('player-form');
const playerIdInput = $('player-id-input');
const playerNameInput = $('player-name-input');
const playerFormNote = $('player-form-note');
const playerListEl = $('player-list');
const playerSearchInput = $('player-search-input');

const participantSearchInput = $('participant-search-input');
const participantCheckboxesEl = $('participant-checkboxes');
const selectedListEl = $('selected-participant-list');
const selectedCountEl = $('selected-count');
const shuffleBtn = $('shuffle-btn');
const seedByRankingBtn = $('seed-by-ranking-btn');
const manualParticipantsEl = $('manual-participants');

const tournamentForm = $('tournament-form');
const tournamentNameInput = $('tournament-name-input');
const tournamentDateInput = $('tournament-date-input');
const tournamentCapacityInput = $('tournament-capacity-input');
const tournamentRulesInput = $('tournament-rules-input');
const tournamentSubmitBtn = $('tournament-submit-btn');

// 大会作成・大会編集・お知らせの画像アップロード。HTML側の入力を配線する。
const tournamentImagePicker = setupImagePicker({
  fileInput: $('tournament-image-input'),
  preview: $('tournament-image-preview'),
  removeBtn: $('tournament-image-remove-btn'),
});
const tournamentEditImagePicker = setupImagePicker({
  fileInput: $('tournament-edit-image-input'),
  preview: $('tournament-edit-image-preview'),
  removeBtn: $('tournament-edit-image-remove-btn'),
});
const announcementImagePicker = setupImagePicker({
  fileInput: $('announcement-image-input'),
  preview: $('announcement-image-preview'),
  removeBtn: $('announcement-image-remove-btn'),
});

const recruitListEl = $('recruit-list');
const historyListEl = $('history-list');

const bracketTitleEl = $('bracket-title');
const bracketMetaEl = $('bracket-meta');
const bracketContainer = $('bracket-container');
const tournamentEditBtn = $('tournament-edit-btn');
const tournamentDeleteBtn = $('tournament-delete-btn');
const tournamentEditForm = $('tournament-edit-form');
const tournamentEditNameInput = $('tournament-edit-name-input');
const tournamentEditDateInput = $('tournament-edit-date-input');
const tournamentEditRulesInput = $('tournament-edit-rules-input');
const tournamentEditCancelBtn = $('tournament-edit-cancel-btn');
const tournamentInfoEl = $('tournament-info');
const resultSectionEl = $('result-section');
const bracketBackLink = $('bracket-back-link');
const tournamentEditCapacityInput = $('tournament-edit-capacity-input');

const playerDetailEl = $('player-detail');
const playerBackBtn = $('player-back-btn');

const profileTitleEl = $('profile-title');
const profileNoteEl = $('profile-note');
const profileFormContainer = $('profile-form-container');
const profileLinksEl = $('profile-links');
const profileLoginPanel = $('profile-login-panel');
const profileLoginErrorEl = $('profile-login-error');
const profileGoogleBtn = $('profile-google-btn');
const profileDiscordBtn = $('profile-discord-btn');
const profileEmailBtn = $('profile-email-btn');
const profileAccountActions = $('profile-account-actions');
const profileAccountEmail = $('profile-account-email');

const rankingContainer = $('ranking-container');
const rankingEditorEl = $('ranking-editor');
const rankingPeriodSelect = $('ranking-period-select');
const rankingExportBtn = $('ranking-export-btn');
const rankingPublishBtn = $('ranking-publish-btn');
const rankingPublishedStatusEl = $('ranking-published-status');
const rankingEditorNoteEl = $('ranking-editor-note');

const appStatusEl = $('app-status');
const syncBarEl = $('sync-bar');
const accountAvatarEl = $('account-avatar');
const loginBtn = $('login-btn');
const logoutBtn = $('logout-btn');
const navTournamentLink = $('nav-tournament-link');
const mainNav = $('main-nav');
const navToggle = $('nav-toggle');

const announcementListEl = $('announcement-list');
const announcementNewBtn = $('announcement-new-btn');
const announcementForm = $('announcement-form');
const announcementIdInput = $('announcement-id-input');
const announcementTitleInput = $('announcement-title-input');
const announcementBodyInput = $('announcement-body-input');
const announcementPinnedInput = $('announcement-pinned-input');
const announcementFormErrorEl = $('announcement-form-error');
const announcementSubmitBtn = $('announcement-submit-btn');
const announcementCancelBtn = $('announcement-cancel-btn');

const loginDialog = $('login-dialog');
const emailForm = $('email-form');
const emailInput = $('email-input');
const passwordInput = $('password-input');
const loginErrorEl = $('login-error');
const emailLoginBtn = $('email-login-btn');
const signupBtn = $('signup-btn');
const googleLoginBtn = $('google-login-btn');
const discordLoginBtn = $('discord-login-btn');
const loginCancelBtn = $('login-cancel-btn');

// メッセージが無いときは行ごと隠す。空のまま置いておくとヘッダーが
// 常に2段になり、上段が中途半端に見えるため。
function setStatus(text, type) {
  appStatusEl.textContent = text;
  appStatusEl.className = `status-line${type ? ` ${type}` : ''}`;
  syncBarEl.hidden = !text;
}

// 保存処理をまとめて包む。書き込みに失敗したら画面を最新に戻し、
// ローカルだけ変わって見える状態を残さない。
async function persist(action, label) {
  setStatus('保存中...', 'loading');
  try {
    await action();
    setStatus(`保存しました（${formatTime(new Date())}）`, 'success');
    return true;
  } catch (err) {
    setStatus(err.message, 'error');
    alert(`${label}に失敗しました。\n${err.message}`);
    await refreshFromDb();
    return false;
  }
}

// ログイン状態に応じて、運営専用・ログイン専用のUIをまとめて出し分ける。
function applyAuthUI() {
  const admin = isAdmin();
  const loggedIn = isLoggedIn();

  navTournamentLink.hidden = !admin;
  announcementNewBtn.hidden = !admin;
  rankingEditorEl.hidden = !admin;
  rankingEditorNoteEl.hidden = !admin;
  tournamentEditBtn.hidden = !admin;
  tournamentDeleteBtn.hidden = !admin;
  playerForm.hidden = !admin;
  playerFormNote.hidden = !admin;
  if (!admin) tournamentEditForm.hidden = true;
  // 運営でなくなったら投稿フォームも畳む
  if (!admin) closeAnnouncementForm();

  loginBtn.hidden = loggedIn;
  accountAvatarEl.hidden = !loggedIn;

  // ログイン中は名前ではなくアイコンを出す。選手登録がまだなら頭文字が入る。
  if (loggedIn) {
    accountAvatarEl.innerHTML = avatarHtml(auth.player ?? { currentName: accountLabel() }, 'sm');
    accountAvatarEl.title = admin ? `${accountLabel()}（運営）` : accountLabel();
  } else {
    accountAvatarEl.innerHTML = '';
  }
}

// ---- ルーティング ----

const VIEW_IDS = {
  home: 'view-home',
  recruit: 'view-recruit',
  tournament: 'view-tournament',
  history: 'view-history',
  bracket: 'view-bracket',
  players: 'view-players',
  player: 'view-player-detail',
  ranking: 'view-ranking',
  profile: 'view-profile',
};

// ナビのハイライト用：詳細ページは親メニューに対応付ける
const NAV_PAGE_OF = { bracket: 'history', player: 'players' };

function parseHash() {
  const h = location.hash.replace(/^#/, '');
  const [page, param] = h.split('/');
  return { page: page || 'home', param: param ? decodeURIComponent(param) : null };
}

function routeFromHash() {
  const { page, param } = parseHash();

  // #login はページではなくログインダイアログを開くための入口
  if (page === 'login') {
    location.replace('#home');
    if (!isLoggedIn()) openLoginDialog();
    return;
  }

  let target = VIEW_IDS[page] ? page : 'home';

  // 大会作成は運営限定。マイページはログアウト中でも開ける（そこからログインする）
  if (target === 'tournament' && !isAdmin()) {
    location.replace('#home');
    target = 'home';
  }

  Object.entries(VIEW_IDS).forEach(([name, id]) => {
    $(id).hidden = name !== target;
  });

  const navPage = NAV_PAGE_OF[target] || target;
  mainNav.querySelectorAll('a').forEach((a) => {
    a.classList.toggle('active', a.dataset.page === navPage);
  });

  if (target === 'home') renderHome();
  else if (target === 'recruit') renderRecruit();
  else if (target === 'tournament') { renderParticipantCheckboxes(); renderSelectedList(); }
  else if (target === 'history') renderHistoryList();
  else if (target === 'bracket') renderBracketPage(param);
  else if (target === 'players') refreshPlayerUI();
  else if (target === 'player') renderPlayerDetail(param);
  else if (target === 'ranking') renderRankingPage();
  else if (target === 'profile') renderProfilePage();
}

// ---- ホーム（お知らせ） ----

// 投稿・編集フォームを開く。announcement を渡すと編集、null なら新規。
function openAnnouncementForm(announcement) {
  announcementIdInput.value = announcement?.id ?? '';
  announcementTitleInput.value = announcement?.title ?? '';
  announcementBodyInput.value = announcement?.body ?? '';
  announcementPinnedInput.checked = Boolean(announcement?.pinned);
  announcementImagePicker.setCurrent(announcement?.imageUrl || '');
  announcementFormErrorEl.textContent = '';
  announcementSubmitBtn.textContent = announcement ? '更新する' : '投稿する';
  announcementForm.hidden = false;
  announcementTitleInput.focus();
}

function closeAnnouncementForm() {
  announcementForm.hidden = true;
  announcementForm.reset();
  announcementIdInput.value = '';
  announcementImagePicker.setCurrent('');
  announcementFormErrorEl.textContent = '';
}

function renderHome() {
  announcementListEl.innerHTML = '';
  const admin = isAdmin();

  if (state.announcements.length === 0) {
    announcementListEl.innerHTML = '<p class="empty-hint">まだお知らせはありません。</p>';
    return;
  }

  state.announcements.forEach((a) => {
    const card = document.createElement('article');
    card.className = `announcement${a.pinned ? ' pinned' : ''}`;

    const head = document.createElement('div');
    head.className = 'announcement-head';

    const title = document.createElement('h3');
    title.className = 'announcement-title';
    if (a.pinned) {
      const pin = document.createElement('span');
      pin.className = 'pin-badge';
      pin.textContent = '固定';
      title.appendChild(pin);
    }
    title.appendChild(document.createTextNode(a.title));
    head.appendChild(title);

    const date = document.createElement('span');
    date.className = 'announcement-date';
    date.textContent = formatDateTime(a.createdAt);
    head.appendChild(date);

    card.appendChild(head);

    const imageUrl = safeUrl(a.imageUrl);
    if (imageUrl) {
      const img = document.createElement('img');
      img.className = 'announcement-image';
      img.src = imageUrl;
      img.alt = '';
      img.loading = 'lazy';
      card.appendChild(img);
    }

    if (a.body) {
      // 本文はユーザー入力。textContentで入れ、改行はCSS(white-space:pre-wrap)で見せる
      const body = document.createElement('p');
      body.className = 'announcement-body';
      body.textContent = a.body;
      card.appendChild(body);
    }

    if (admin) {
      const actions = document.createElement('div');
      actions.className = 'announcement-actions';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn-secondary';
      editBtn.textContent = '編集';
      editBtn.addEventListener('click', () => openAnnouncementForm(a));

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-secondary';
      delBtn.textContent = '削除';
      delBtn.addEventListener('click', async () => {
        if (!confirm(`お知らせ「${a.title}」を削除しますか？`)) return;
        const ok = await persist(() => db.deleteAnnouncement(a.id), 'お知らせの削除');
        if (ok) {
          if (a.imageUrl) await db.removeImageByUrl(a.imageUrl).catch(() => {});
          await refreshFromDb();
        }
      });

      actions.append(editBtn, delBtn);
      card.appendChild(actions);
    }

    announcementListEl.appendChild(card);
  });
}

// ---- 選手 ----

function refreshPlayerUI() {
  renderPlayerTable(playerListEl, {
    ownPlayerId: auth.player?.id ?? null,
    isAdmin: isAdmin(),
    filterQuery: playerSearchQuery,
    onDelete: async (player) => {
      await db.deletePlayer(player.id);
      selectedParticipantIds = selectedParticipantIds.filter((id) => id !== player.id);
      await refreshFromDb();
    },
    onMerge: async (sourceId, targetId) => {
      await db.mergePlayers(sourceId, targetId);
      await reloadOwnPlayer();
      await refreshFromDb();
    },
  });
  renderParticipantCheckboxes();
}

function renderParticipantCheckboxes() {
  participantCheckboxesEl.innerHTML = '';

  if (state.players.length === 0) {
    participantCheckboxesEl.innerHTML = '<p class="empty-hint">先に選手を登録してください。</p>';
    return;
  }

  const query = participantSearchQuery.trim().toLowerCase();
  const visiblePlayers = query
    ? state.players.filter((p) =>
        (p.gameAccountId ?? '').toLowerCase().includes(query)
        || p.currentName.toLowerCase().includes(query))
    : state.players;

  if (visiblePlayers.length === 0) {
    participantCheckboxesEl.innerHTML = '<p class="empty-hint">検索条件に一致する選手がいません。</p>';
    return;
  }

  visiblePlayers.forEach((p) => {
    const label = document.createElement('label');
    label.className = 'checkbox-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = p.id;
    checkbox.checked = selectedParticipantIds.includes(p.id);

    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        if (!selectedParticipantIds.includes(p.id)) selectedParticipantIds.push(p.id);
      } else {
        selectedParticipantIds = selectedParticipantIds.filter((id) => id !== p.id);
      }
      renderSelectedList();
    });

    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(
      p.gameAccountId ? ` ${p.currentName} (${p.gameAccountId})` : ` ${p.currentName}`,
    ));
    participantCheckboxesEl.appendChild(label);
  });
}

function renderSelectedList() {
  selectedListEl.innerHTML = '';
  selectedCountEl.textContent = selectedParticipantIds.length
    ? `（選択中: ${selectedParticipantIds.length}人）`
    : '';

  if (selectedParticipantIds.length === 0) {
    selectedListEl.innerHTML = '<p class="empty-hint">参加者が選択されていません。</p>';
    return;
  }

  selectedParticipantIds.forEach((id, index) => {
    const player = state.players.find((p) => p.id === id);
    const li = document.createElement('li');
    li.className = 'selected-item';

    const seedLabel = document.createElement('span');
    seedLabel.className = 'seed-label';
    seedLabel.textContent = `シード${index + 1}`;

    const nameLabel = document.createElement('span');
    nameLabel.className = 'seed-name';
    nameLabel.textContent = player ? player.currentName : id;

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'btn-secondary';
    upBtn.textContent = '↑';
    upBtn.disabled = index === 0;
    upBtn.addEventListener('click', () => {
      [selectedParticipantIds[index - 1], selectedParticipantIds[index]] =
        [selectedParticipantIds[index], selectedParticipantIds[index - 1]];
      renderSelectedList();
    });

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'btn-secondary';
    downBtn.textContent = '↓';
    downBtn.disabled = index === selectedParticipantIds.length - 1;
    downBtn.addEventListener('click', () => {
      [selectedParticipantIds[index + 1], selectedParticipantIds[index]] =
        [selectedParticipantIds[index], selectedParticipantIds[index + 1]];
      renderSelectedList();
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-secondary';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => {
      selectedParticipantIds = selectedParticipantIds.filter((pid) => pid !== id);
      renderParticipantCheckboxes();
      renderSelectedList();
    });

    li.append(seedLabel, nameLabel, upBtn, downBtn, removeBtn);
    selectedListEl.appendChild(li);
  });
}

function shuffleSelected() {
  for (let i = selectedParticipantIds.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [selectedParticipantIds[i], selectedParticipantIds[j]] = [selectedParticipantIds[j], selectedParticipantIds[i]];
  }
  renderSelectedList();
}

// 現在のランキング順（上位ほどシード上位）に並び替える。ランキング未算出の選手は末尾にまとめる。
function seedBySelectedRanking() {
  const rankings = computeRankings(state);
  if (rankings.length === 0) {
    alert('確定した試合がまだないため、ランキング順には並び替えられません。');
    return;
  }
  const rankIndex = new Map(rankings.map((r) => [r.id, r.rank]));
  selectedParticipantIds = [...selectedParticipantIds].sort((a, b) => {
    const ra = rankIndex.has(a) ? rankIndex.get(a) : Infinity;
    const rb = rankIndex.has(b) ? rankIndex.get(b) : Infinity;
    return ra - rb;
  });
  renderSelectedList();
}

// ---- 募集ページ ----

function renderRecruit() {
  renderRecruitPage(recruitListEl, async () => {
    await refreshFromDb();
  });
}

// ---- マイページ ----

// ログイン直後で選手行がまだ無ければ新規登録、あれば編集フォームを出す。
// いま建てているフォームの種別。背景の自動更新でフォームを作り直すと
// 入力途中の内容が消えてしまうため、同じ種別のまま再描画が来たら建て替えない。
// （入力を終えてボタンへマウスを動かす一瞬はフォーカスが外れており、
//   isUserTyping() では守れない。編集内容が保存済みの値に巻き戻ってしまう。）
// 種別が変わったとき（未登録→登録済み、別アカウントでログイン）は建て直す。
let profileFormMode = null;

// フォームが選んだ画像を実際にアップロードし、保存すべきURLを決める。
// 画像を選んでいなければ今のURLを据え置き、「外す」を押されていれば空にする。
async function resolveAvatar(profile, currentUrl) {
  if (profile.avatarFile) return db.uploadAvatar(auth.user.id, profile.avatarFile);
  if (profile.removeAvatar) return '';
  return currentUrl ?? '';
}

// 画像ピッカーの状態から、保存すべき画像URLを決める。
// 新しい画像を選んでいればアップロードし、「外す」なら空、どちらでもなければ据え置き。
async function resolveImageUrl(picker, folder) {
  const { file, remove, currentUrl } = picker.get();
  if (file) return db.uploadImage(file, folder);
  if (remove) return '';
  return currentUrl ?? '';
}

function renderProfilePage() {
  profileLinksEl.innerHTML = '';

  // ログアウト中：ログインの入口だけを見せる
  if (!isLoggedIn()) {
    profileFormMode = null;
    profileFormContainer.innerHTML = '';
    profileLoginPanel.hidden = false;
    profileAccountActions.hidden = true;
    profileTitleEl.textContent = 'マイページ';
    profileNoteEl.textContent = 'ログインすると、自分の選手プロフィールを編集したり大会にエントリーしたりできます。';
    return;
  }

  profileLoginPanel.hidden = true;
  profileLoginErrorEl.textContent = '';
  profileAccountActions.hidden = false;
  profileAccountEmail.textContent = auth.user.email
    ? `ログイン中: ${auth.user.email}`
    : 'ログイン中';

  const mode = needsOnboarding() ? 'onboarding' : `edit:${auth.player.id}`;
  const keepExistingForm = profileFormMode === mode && isProfileFormMounted(profileFormContainer);
  profileFormMode = mode;

  if (needsOnboarding()) {
    profileTitleEl.textContent = '選手登録';
    profileNoteEl.textContent = '表示名だけでも登録できます。あとからいつでも変更できます。';
    if (keepExistingForm) return;
    renderProfileForm(profileFormContainer, null, {
      submitLabel: '登録する',
      onSubmit: async (profile) => {
        const avatarUrl = await resolveAvatar(profile, '');
        await db.createOwnPlayer(auth.user.id, { ...profile, avatarUrl, pastNames: [] });
        await reloadOwnPlayer();
        await refreshFromDb();
        setStatus('選手登録が完了しました。', 'success');
        location.hash = `#player/${encodeURIComponent(auth.player.id)}`;
      },
    });
    return;
  }

  profileTitleEl.textContent = 'マイページ';
  profileNoteEl.textContent = 'ここで編集した内容は、あなたの選手ページに表示されます。';

  if (!keepExistingForm) {
    renderProfileForm(profileFormContainer, auth.player, {
      submitLabel: '保存',
      onSubmit: async (profile) => {
        // 表示名を変えたら旧名を過去名に残す（players.js の updatePlayer と同じ扱い）
        const pastNames = [...auth.player.pastNames];
        if (profile.currentName !== auth.player.currentName
          && !pastNames.includes(auth.player.currentName)) {
          pastNames.push(auth.player.currentName);
        }
        const avatarUrl = await resolveAvatar(profile, auth.player.avatarUrl);
        const previousAvatar = auth.player.avatarUrl;

        await db.savePlayer({ ...auth.player, ...profile, avatarUrl, pastNames });

        // 差し替え・削除で使われなくなった画像は消しておく（無料枠を無駄に食わないため）。
        // ここが失敗しても保存自体は済んでいるので、処理は止めない。
        if (previousAvatar && previousAvatar !== avatarUrl) {
          await db.removeAvatarByUrl(previousAvatar).catch(() => {});
        }

        await reloadOwnPlayer();
        await refreshFromDb();
        setStatus('プロフィールを保存しました。', 'success');
      },
    });
  }

  const link = document.createElement('a');
  link.className = 'back-link';
  link.href = `#player/${encodeURIComponent(auth.player.id)}`;
  link.textContent = '自分の選手ページを見る →';
  profileLinksEl.appendChild(link);
}

// ---- 大会履歴 ----

// 優勝者を名指しするのは、運営が結果を確定させた大会だけ。
// 表が埋まっただけの段階では「結果待ち」に留める。
function tournamentStatusLabel(t) {
  const bracket = state.brackets[t.id];
  if (!bracket) return STATUS_LABELS[t.status] ?? '—';

  if (t.status === 'finished') {
    const championId = getChampionId(bracket);
    if (championId) return `優勝: ${getPlayerName(championId)}`;
    return '終了';
  }
  return allMatchesDecided(bracket) ? '結果待ち' : '進行中';
}

function renderHistoryList() {
  historyListEl.innerHTML = '';

  // 準備中・募集中は募集ページの担当。履歴には実際に始まった大会だけを並べる。
  const visible = state.tournaments.filter((t) => t.status === 'running' || t.status === 'finished');

  if (visible.length === 0) {
    historyListEl.innerHTML = '<p class="empty-hint">まだ開催された大会がありません。</p>';
    return;
  }

  [...visible].reverse().forEach((t) => {
    const item = document.createElement('a');
    item.className = 'history-item';
    item.href = `#bracket/${encodeURIComponent(t.id)}`;

    const info = document.createElement('div');
    info.className = 'history-info';
    info.innerHTML = `
      <span class="history-name">${escapeHtml(t.name)}</span>
      <span class="history-meta">${escapeHtml(t.date || '日付未設定')} ・ ${t.participantIds.length}人参加 ・ ${tournamentTier(t.participantIds.length)}</span>
    `;

    const status = document.createElement('span');
    status.className = 'history-status';
    status.textContent = tournamentStatusLabel(t);

    item.append(info, status);
    historyListEl.appendChild(item);
  });
}

// ---- ブラケットページ ----

const FORMAT_LABELS = {
  single_elim: 'シングルエリミネーション',
  double_elim: 'ダブルエリミネーション',
  round_robin: '総当たり',
};

function renderTournamentInfo(tournament) {
  const formatLabel = FORMAT_LABELS[tournament.format] || tournament.format;
  const countLabel = tournament.capacity == null
    ? `${tournament.participantIds.length}人`
    : `${tournament.participantIds.length} / ${tournament.capacity}人`;

  const imageUrl = safeUrl(tournament.imageUrl);
  const imageHtml = imageUrl
    ? `<img class="tournament-image" src="${escapeHtml(imageUrl)}" alt="" loading="lazy">`
    : '';

  let html = `
    ${imageHtml}
    <h3>大会情報</h3>
    <dl class="tournament-info-grid">
      <div><dt>${tournament.status === 'recruiting' ? 'エントリー' : '参加人数'}</dt><dd>${escapeHtml(countLabel)}</dd></div>
      <div><dt>規模</dt><dd>${tournamentTier(tournament.participantIds.length)}</dd></div>
      <div><dt>形式</dt><dd>${escapeHtml(formatLabel)}</dd></div>
      <div><dt>開催日</dt><dd>${escapeHtml(tournament.date || '日付未設定')}</dd></div>
      <div><dt>進行状況</dt><dd>${escapeHtml(tournamentStatusLabel(tournament))}</dd></div>
    </dl>
  `;
  if (tournament.rules) {
    html += `
      <h4>ルール</h4>
      <p class="tournament-rules">${escapeHtml(tournament.rules)}</p>
    `;
  }

  // ブラケットが出来る前は対戦表が無いので、代わりに顔ぶれを見せる。
  // 募集中の大会の詳細を選手が確認できるようにするための表示。
  if (!state.brackets[tournament.id] && tournament.participantIds.length > 0) {
    const names = tournament.participantIds.map((id) => {
      const player = state.players.find((p) => p.id === id);
      return `<span class="entrant-chip">${escapeHtml(player ? player.currentName : id)}</span>`;
    }).join('');
    html += `<h4>エントリー中の選手</h4><div class="entrant-list">${names}</div>`;
  }

  tournamentInfoEl.innerHTML = html;
}

function renderBracketPage(tournamentId) {
  currentBracketTournamentId = tournamentId;
  tournamentEditForm.hidden = true;

  const tournament = state.tournaments.find((t) => t.id === tournamentId);
  if (!tournament) {
    bracketTitleEl.textContent = '大会が見つかりません';
    bracketMetaEl.textContent = '';
    bracketContainer.innerHTML = '<p class="empty-hint">この大会は存在しないか、削除されています。</p>';
    tournamentInfoEl.innerHTML = '';
    return;
  }

  bracketTitleEl.textContent = tournament.name;
  bracketMetaEl.textContent = `${tournament.date || '日付未設定'} ・ ${tournament.participantIds.length}人参加 ・ ${tournamentStatusLabel(tournament)}`;

  // 募集中・準備中の大会は履歴に並ばないので、戻り先を募集ページにする
  const fromRecruit = tournament.status === 'draft' || tournament.status === 'recruiting';
  bracketBackLink.href = fromRecruit ? '#recruit' : '#history';
  bracketBackLink.textContent = fromRecruit ? '← 募集中の大会へ' : '← 大会履歴へ';

  const confirmed = tournament.status === 'finished';

  // bracketView は state を書き換えてから onChanged を呼ぶ。ここでDBへ反映する。
  renderBracket(tournamentId, bracketContainer, async () => {
    renderBracketPage(tournamentId);
    await persist(async () => {
      await db.syncTournamentProgress(tournamentId);

      // 確定済みの大会で結果を編集し直したら、確定を解いて進行中に戻す。
      // 逆方向（進行中→終了）は運営が明示的に確定させる（自動では上げない）。
      if (tournament.status === 'finished' && !allMatchesDecided(state.brackets[tournamentId])) {
        await db.setTournamentStatus(tournamentId, 'running');
        tournament.status = 'running';
        renderBracketPage(tournamentId);
      }
    }, '試合結果の保存');
  }, { readOnly: !isAdmin(), showResult: confirmed });

  renderResultSection(tournament);
  renderTournamentInfo(tournament);
}

// 表が全部埋まったあとの「結果を確定する」操作と、確定後の最終順位。
// 全欄が埋まった瞬間に自動で優勝を掲げると、入力ミスを直す前に結果として広まってしまうため、
// 運営が内容を見てから確定させる一手間を挟む。
function renderResultSection(tournament) {
  resultSectionEl.innerHTML = '';

  const bracket = state.brackets[tournament.id];
  if (!bracket) return;

  const decided = allMatchesDecided(bracket);
  const confirmed = tournament.status === 'finished';

  if (!decided) {
    if (isAdmin()) {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = 'すべての対戦が終わると、ここで結果を確定できます。';
      resultSectionEl.appendChild(note);
    }
    return;
  }

  if (!confirmed) {
    const box = document.createElement('div');
    box.className = 'result-pending';

    const note = document.createElement('p');
    note.textContent = isAdmin()
      ? 'すべての対戦が終わりました。内容を確認して「結果を確定する」を押すと、優勝者と最終順位が公開されます。'
      : 'すべての対戦が終わりました。運営が結果を確定するまでお待ちください。';
    box.appendChild(note);

    if (isAdmin()) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '結果を確定する';
      btn.addEventListener('click', async () => {
        if (!confirm(`「${tournament.name}」の結果を確定します。優勝者と最終順位が公開されます。よろしいですか？`)) return;
        btn.disabled = true;
        const ok = await persist(async () => {
          await db.setTournamentStatus(tournament.id, 'finished');
          tournament.status = 'finished';
        }, '結果の確定');
        if (ok) renderBracketPage(tournament.id);
        else btn.disabled = false;
      });
      box.appendChild(btn);
    }

    resultSectionEl.appendChild(box);
    return;
  }

  // ---- 確定済み：最終順位を出す ----
  const standings = finalStandings(bracket, 16);
  if (standings.length === 0) return;

  const heading = document.createElement('h3');
  heading.textContent = '最終順位';
  resultSectionEl.appendChild(heading);

  const rows = standings.map((s) => {
    const player = state.players.find((p) => p.id === s.playerId);
    const name = player ? player.currentName : s.playerId;
    const isOwn = auth.player?.id === s.playerId;
    return `
      <tr class="${s.rank <= 3 ? `rank-${s.rank}` : ''}${isOwn ? ' own-row' : ''}">
        <td class="rank-cell">${s.rank}</td>
        <td>
          <div class="player-identity">
            ${avatarHtml(player ?? { currentName: name }, 'sm')}
            <a href="#player/${encodeURIComponent(s.playerId)}">${escapeHtml(name)}</a>
            ${isOwn ? '<span class="you-badge">あなた</span>' : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');

  const wrap = document.createElement('div');
  wrap.className = 'table-scroll';
  wrap.innerHTML = `
    <table class="standings-table">
      <thead><tr><th>順位</th><th>選手</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  resultSectionEl.appendChild(wrap);

  if (isAdmin()) {
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'btn-secondary';
    undo.textContent = '確定を取り消す';
    undo.addEventListener('click', async () => {
      if (!confirm('結果の確定を取り消します。優勝者と最終順位は非公開に戻ります。よろしいですか？')) return;
      undo.disabled = true;
      const ok = await persist(async () => {
        await db.setTournamentStatus(tournament.id, 'running');
        tournament.status = 'running';
      }, '確定の取り消し');
      if (ok) renderBracketPage(tournament.id);
      else undo.disabled = false;
    });
    resultSectionEl.appendChild(undo);
  }
}

// ---- ランキング ----

const PERIOD_LABELS = { 1: '直近1カ月', 3: '直近3カ月', 6: '直近6カ月', 12: '直近12カ月', all: '全期間' };

function formatDateTime(iso) {
  const d = new Date(iso);
  return `${d.toLocaleDateString('ja-JP')} ${d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;
}

function publishedStatusLine() {
  const published = state.publishedRanking;
  const periodLabel = published
    ? (PERIOD_LABELS[published.periodMonths ?? 'all'] || `直近${published.periodMonths}か月`)
    : '';

  if (isAdmin()) {
    if (!published) return '未公開';
    return `公開中: ${periodLabel}（${formatDateTime(published.publishedAt)} 公開）`;
  }
  return published ? `集計期間: ${periodLabel}` : '';
}

// 運営には選択中の期間のライブプレビューを、それ以外には公開済みスナップショットを見せる。
function renderRankingPage() {
  rankingPublishedStatusEl.textContent = publishedStatusLine();

  if (isAdmin()) {
    const { rankings: preview } = computeRankingsForPeriod(state, rankingPeriodSelect.value);
    const previewWithChange = withRankChange(preview, state.publishedRanking?.rankings);
    renderRankingTable(
      rankingContainer,
      previewWithChange,
      'この期間に確定した試合がまだないため、ランキングを計算できません。',
      auth.player?.id ?? null,
    );
  } else {
    renderRankingTable(
      rankingContainer,
      state.publishedRanking?.rankings ?? [],
      'まだランキングが公開されていません。',
      auth.player?.id ?? null,
    );
  }
}

// ---- 選手個人ページ ----

function renderPlayerDetail(playerId) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) {
    playerDetailEl.innerHTML = '<p class="empty-hint">選手が見つかりません。</p>';
    return;
  }

  const stats = getPlayerStats(playerId);
  const rankEntry = state.publishedRanking?.rankings.find((r) => r.id === playerId);
  const rankLabel = state.publishedRanking ? (rankEntry ? `${rankEntry.rank}位` : '対象外') : '未公開';
  const rankChangeHtml = rankEntry && rankEntry.previousRank !== undefined
    ? (() => {
        const { label, className } = rankChangeInfo(rankEntry.previousRank, rankEntry.rank);
        return ` <span class="rank-change ${className}">${label}</span>`;
      })()
    : '';
  const total = stats.wins + stats.losses;
  const winRate = total > 0 ? Math.round((stats.wins / total) * 100) : null;
  const isOwn = auth.player?.id === playerId;

  let html = `
    <div class="player-detail-header">
      <div class="player-identity">
        ${avatarHtml(player, 'lg')}
        <div>
          <h2>${escapeHtml(player.currentName)}</h2>
          ${player.pastNames.length ? `<p class="meta-line">過去名: ${escapeHtml(player.pastNames.join(', '))}</p>` : ''}
          ${isOwn ? '<p class="meta-line"><a href="#profile">プロフィールを編集する</a></p>' : ''}
          ${!isOwn && isAdmin() ? '<p class="meta-line"><button type="button" class="btn-secondary admin-rename-btn">表示名を変更</button></p>' : ''}
        </div>
      </div>
    </div>
    ${profileSectionHtml(player)}
    <div class="stat-cards">
      <div class="stat-card"><span class="stat-value">${rankLabel}${rankChangeHtml}</span><span class="stat-label">現在ランク${rankEntry ? `（スコア ${rankEntry.score.toFixed(1)}）` : ''}</span></div>
      <div class="stat-card"><span class="stat-value">${stats.tournaments.length}</span><span class="stat-label">出場大会数</span></div>
      <div class="stat-card"><span class="stat-value">${stats.wins}勝${stats.losses}敗</span><span class="stat-label">通算成績</span></div>
      <div class="stat-card"><span class="stat-value">${winRate === null ? '—' : `${winRate}%`}</span><span class="stat-label">勝率</span></div>
    </div>
  `;

  if (stats.tournaments.length > 0) {
    html += `
      <h3>大会別成績</h3>
      <div class="table-scroll">
        <table>
          <thead><tr><th>大会</th><th>日付</th><th>結果</th><th>勝敗</th></tr></thead>
          <tbody>
            ${[...stats.tournaments].reverse().map((entry) => `
              <tr>
                <td><a href="#bracket/${encodeURIComponent(entry.tournament.id)}">${escapeHtml(entry.tournament.name)}</a></td>
                <td>${escapeHtml(entry.tournament.date || '—')}</td>
                <td>${escapeHtml(entry.placement || '—')}</td>
                <td>${entry.wins}勝${entry.losses}敗</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  if (stats.matches.length > 0) {
    html += `
      <h3>対戦履歴</h3>
      <div class="table-scroll">
        <table>
          <thead><tr><th>大会</th><th>ラウンド</th><th>対戦相手</th><th>勝敗</th><th>スコア</th></tr></thead>
          <tbody>
            ${[...stats.matches].reverse().map((m) => {
              const won = m.winnerId === playerId;
              const opponentId = won ? m.loserId : m.winnerId;
              const tournament = state.tournaments.find((t) => t.id === m.tournamentId);
              return `
                <tr>
                  <td>${escapeHtml(tournament ? tournament.name : m.tournamentId)}</td>
                  <td>${escapeHtml(m.round)}</td>
                  <td><a href="#player/${encodeURIComponent(opponentId)}">${escapeHtml(getPlayerName(opponentId))}</a></td>
                  <td class="${won ? 'result-win' : 'result-loss'}">${won ? '勝ち' : '負け'}</td>
                  <td>${m.score ? escapeHtml(m.score) : '不戦勝'}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  } else {
    html += '<p class="empty-hint">まだ対戦記録がありません。</p>';
  }

  playerDetailEl.innerHTML = html;

  // 表示名の変更。選手一覧の表からは外したので、運営はここから直す。
  // 代理登録された選手（本人のアカウントが無い人）を直せる唯一の経路でもある。
  const renameBtn = playerDetailEl.querySelector('.admin-rename-btn');
  if (renameBtn) {
    renameBtn.addEventListener('click', async () => {
      const input = prompt(`「${player.currentName}」の新しい表示名を入力してください。`, player.currentName);
      if (input === null) return;

      const result = updatePlayer(player.id, { currentName: input });
      if (!result.ok) {
        alert(result.error);
        return;
      }
      renameBtn.disabled = true;
      const ok = await persist(() => db.savePlayer(result.player), '表示名の変更');
      if (ok) await refreshFromDb();
      else renameBtn.disabled = false;
    });
  }
}

// ---- データの読み込みと自動更新 ----

function formatTime(date) {
  return date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

let loadInFlight = false;
let refreshQueued = false;

async function refreshFromDb({ silent = false } = {}) {
  // 読み込み中に更新通知が来たら、取りこぼさないよう終わってからもう一度読む
  if (loadInFlight) {
    refreshQueued = true;
    return;
  }
  loadInFlight = true;
  try {
    await db.loadAll();
    routeFromHash();
    if (!silent) setStatus('');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    loadInFlight = false;
    if (refreshQueued) {
      refreshQueued = false;
      await refreshFromDb({ silent: true });
    }
  }
}

// フォーム入力中は再描画で入力内容が消えるため、更新の反映を見送る。
function isUserTyping() {
  const el = document.activeElement;
  if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return true;
  return [...document.querySelectorAll('.score-num-input')].some((i) => i.value !== '');
}

// ---- イベント配線 ----

// 運営による代理登録（アカウントを持たない選手を先に作っておく）
playerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = playerNameInput.value.trim();
  if (!name) {
    alert('表示名を入力してください。');
    return;
  }
  const ok = await persist(async () => {
    await db.createProxyPlayer({
      currentName: name,
      pastNames: [],
      gameAccountId: playerIdInput.value.trim(),
      mainCharacters: [],
    });
  }, '選手の登録');
  if (!ok) return;
  playerIdInput.value = '';
  playerNameInput.value = '';
  await refreshFromDb();
});

participantSearchInput.addEventListener('input', () => {
  participantSearchQuery = participantSearchInput.value;
  renderParticipantCheckboxes();
});

playerSearchInput.addEventListener('input', () => {
  playerSearchQuery = playerSearchInput.value;
  refreshPlayerUI();
});

shuffleBtn.addEventListener('click', shuffleSelected);
seedByRankingBtn.addEventListener('click', seedBySelectedRanking);

// 参加者の集め方の切り替え（エントリー募集 / 運営が直接選ぶ）
tournamentForm.addEventListener('change', (e) => {
  if (e.target.name !== 'entry-mode') return;
  const manual = e.target.value === 'manual';
  manualParticipantsEl.hidden = !manual;
  tournamentSubmitBtn.textContent = manual ? 'ブラケットを生成' : '大会を作成';
});

rankingPeriodSelect.addEventListener('change', () => {
  if (isAdmin()) renderRankingPage();
});

rankingExportBtn.addEventListener('click', async () => {
  const { rankings } = computeRankingsForPeriod(state, rankingPeriodSelect.value);
  if (rankings.length === 0) {
    alert('この期間に確定した試合がまだないため、画像を書き出せません。');
    return;
  }

  rankingExportBtn.disabled = true;
  const originalLabel = rankingExportBtn.textContent;
  try {
    await downloadRankingCards(rankings, (done, total) => {
      rankingExportBtn.textContent = `書き出し中... (${done}/${total})`;
    });
  } finally {
    rankingExportBtn.disabled = false;
    rankingExportBtn.textContent = originalLabel;
  }
});

rankingPublishBtn.addEventListener('click', async () => {
  const period = rankingPeriodSelect.value;
  const { periodMonths, rankings } = computeRankingsForPeriod(state, period);

  if (rankings.length === 0) {
    alert('この期間に確定した試合がまだないため、公開できません。');
    return;
  }
  if (!confirm(`${PERIOD_LABELS[period]}のランキングを公開します。閲覧者に反映されます。よろしいですか？`)) return;

  // 前回公開時点の順位を各エントリに焼き込み、公開後もずっと「前回との差」が分かるようにする
  const snapshot = {
    publishedAt: new Date().toISOString(),
    periodMonths,
    rankings: withRankChange(rankings, state.publishedRanking?.rankings),
  };

  rankingPublishBtn.disabled = true;
  const ok = await persist(() => db.publishRanking(snapshot), 'ランキングの公開');
  rankingPublishBtn.disabled = false;
  if (!ok) return;

  state.publishedRanking = snapshot;

  // renderRankingPage() は運営には常にライブプレビューを見せるが、それだと公開直後の
  // 「前回比」がプレビュー自身との比較になって全て「変動なし」に潰れる。公開した直後だけは
  // 閲覧者が実際に見るスナップショット（正しい前回比バッジ入り）をそのまま表示する。
  rankingPublishedStatusEl.textContent = publishedStatusLine();
  renderRankingTable(
    rankingContainer, snapshot.rankings, 'ランキングを計算できません。', auth.player?.id ?? null,
  );
});

tournamentForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const name = tournamentNameInput.value.trim();
  if (!name) {
    alert('大会名を入力してください。');
    return;
  }

  const manual = tournamentForm.elements['entry-mode'].value === 'manual';
  if (manual && selectedParticipantIds.length < 2) {
    alert('参加者を2人以上選択してください。');
    return;
  }

  const capacityRaw = tournamentCapacityInput.value.trim();
  const capacity = capacityRaw === '' ? null : Number(capacityRaw);
  if (capacity != null && (!Number.isInteger(capacity) || capacity < 2)) {
    alert('定員は2以上の整数で入力してください。');
    return;
  }

  const tournament = {
    id: newId(),
    name,
    date: tournamentDateInput.value || null,
    format: 'single_elim',
    rules: tournamentRulesInput.value.trim() || null,
    imageUrl: '',
    weight: null,
    // 定員はエントリー募集を制御するためのもの。運営が参加者を直接選ぶ場合は
    // 意味を持たないうえ、選んだ人数が定員を超えると自分で自分を弾いてしまう。
    capacity: manual ? null : capacity,
    status: manual ? 'running' : 'recruiting',
    createdBy: auth.player?.id ?? null,
    participantIds: manual ? [...selectedParticipantIds] : [],
  };

  tournamentSubmitBtn.disabled = true;
  const ok = await persist(async () => {
    // 先に画像を上げてURLを確定させてから大会を作る
    tournament.imageUrl = await resolveImageUrl(tournamentImagePicker, 'tournaments');
    await db.createTournament(tournament);
    if (!manual) return;

    // 参加者やブラケットの登録に失敗したら、作りかけの大会を残さない。
    // 大会を先に作らないと参加者を紐づけられない（外部キー）ので、
    // 失敗時に取り消す形で埋め合わせる。
    try {
      await db.replaceEntries(tournament.id, tournament.participantIds);
      const bracket = createBracket(tournament.id, tournament.participantIds);
      await db.saveBracket(tournament.id, bracket);
    } catch (err) {
      await db.deleteTournament(tournament.id).catch(() => {});
      throw err;
    }
  }, '大会の作成');
  tournamentSubmitBtn.disabled = false;
  if (!ok) return;

  tournamentNameInput.value = '';
  tournamentDateInput.value = '';
  tournamentCapacityInput.value = '';
  tournamentRulesInput.value = '';
  tournamentImagePicker.setCurrent('');
  selectedParticipantIds = [];

  await refreshFromDb();
  location.hash = manual ? `#bracket/${encodeURIComponent(tournament.id)}` : '#recruit';
});

tournamentEditBtn.addEventListener('click', () => {
  const tournament = state.tournaments.find((t) => t.id === currentBracketTournamentId);
  if (!tournament) return;
  tournamentEditNameInput.value = tournament.name;
  tournamentEditDateInput.value = tournament.date || '';
  tournamentEditCapacityInput.value = tournament.capacity ?? '';
  tournamentEditRulesInput.value = tournament.rules || '';
  tournamentEditImagePicker.setCurrent(tournament.imageUrl || '');
  tournamentEditForm.hidden = !tournamentEditForm.hidden;
});

tournamentEditCancelBtn.addEventListener('click', () => {
  tournamentEditForm.hidden = true;
});

tournamentEditForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const capacityRaw = tournamentEditCapacityInput.value.trim();
  const result = updateTournament(currentBracketTournamentId, {
    name: tournamentEditNameInput.value,
    date: tournamentEditDateInput.value,
    rules: tournamentEditRulesInput.value,
    capacity: capacityRaw === '' ? null : Number(capacityRaw),
  });
  if (!result.ok) {
    alert(result.error);
    return;
  }
  const tournament = state.tournaments.find((t) => t.id === currentBracketTournamentId);
  const previousImage = tournament.imageUrl || '';
  const ok = await persist(async () => {
    tournament.imageUrl = await resolveImageUrl(tournamentEditImagePicker, 'tournaments');
    await db.saveTournament(tournament);
    // 差し替え・削除で使われなくなった画像は消しておく。失敗しても保存は済んでいる。
    if (previousImage && previousImage !== tournament.imageUrl) {
      await db.removeImageByUrl(previousImage).catch(() => {});
    }
  }, '大会情報の保存');
  if (ok) tournamentEditForm.hidden = true;
  renderBracketPage(currentBracketTournamentId);
});

tournamentDeleteBtn.addEventListener('click', async () => {
  const tournament = state.tournaments.find((t) => t.id === currentBracketTournamentId);
  if (!tournament) return;
  if (!confirm(`大会「${tournament.name}」と、その試合結果をすべて削除します。よろしいですか？`)) return;

  // ブラケット・試合・エントリーは外部キーのカスケードで一緒に消える
  const imageUrl = tournament.imageUrl || '';
  const ok = await persist(() => db.deleteTournament(currentBracketTournamentId), '大会の削除');
  if (!ok) return;
  if (imageUrl) await db.removeImageByUrl(imageUrl).catch(() => {});
  await refreshFromDb();
  location.hash = '#history';
});

playerBackBtn.addEventListener('click', () => {
  history.back();
});

// ---- お知らせ（運営） ----

announcementNewBtn.addEventListener('click', () => openAnnouncementForm(null));
announcementCancelBtn.addEventListener('click', closeAnnouncementForm);

announcementForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = announcementTitleInput.value.trim();
  if (!title) {
    announcementFormErrorEl.textContent = 'タイトルを入力してください。';
    return;
  }

  const id = announcementIdInput.value;
  const previousImage = id
    ? (state.announcements.find((a) => a.id === id)?.imageUrl || '')
    : '';

  announcementSubmitBtn.disabled = true;
  const ok = await persist(async () => {
    const imageUrl = await resolveImageUrl(announcementImagePicker, 'announcements');
    const payload = {
      title,
      body: announcementBodyInput.value.trim(),
      imageUrl,
      pinned: announcementPinnedInput.checked,
    };
    if (id) {
      await db.updateAnnouncement(id, payload);
    } else {
      await db.createAnnouncement({ ...payload, createdBy: auth.player?.id ?? null });
    }
    // 差し替え・削除で使われなくなった画像は消しておく
    if (previousImage && previousImage !== imageUrl) {
      await db.removeImageByUrl(previousImage).catch(() => {});
    }
  }, id ? 'お知らせの更新' : 'お知らせの投稿');
  announcementSubmitBtn.disabled = false;

  if (ok) {
    closeAnnouncementForm();
    await refreshFromDb();
  } else {
    announcementFormErrorEl.textContent = '保存に失敗しました。もう一度お試しください。';
  }
});

// ---- ログイン ----

function openLoginDialog() {
  emailInput.value = '';
  passwordInput.value = '';
  loginErrorEl.textContent = '';
  loginDialog.showModal();
}

loginBtn.addEventListener('click', openLoginDialog);
loginCancelBtn.addEventListener('click', () => loginDialog.close());

// 募集ページの「ログインしてエントリー」など、他モジュールからの要求
document.addEventListener('request-login', openLoginDialog);

// マイページからのログイン。Google/Discordはその場で、メールはダイアログで。
profileGoogleBtn.addEventListener('click', async () => {
  try {
    await signInWithProvider('google');
  } catch (err) {
    profileLoginErrorEl.textContent = err.message;
  }
});

profileDiscordBtn.addEventListener('click', async () => {
  try {
    await signInWithProvider('discord');
  } catch (err) {
    profileLoginErrorEl.textContent = err.message;
  }
});

profileEmailBtn.addEventListener('click', openLoginDialog);

googleLoginBtn.addEventListener('click', async () => {
  try {
    await signInWithProvider('google');
  } catch (err) {
    loginErrorEl.textContent = err.message;
  }
});

discordLoginBtn.addEventListener('click', async () => {
  try {
    await signInWithProvider('discord');
  } catch (err) {
    loginErrorEl.textContent = err.message;
  }
});

emailForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  emailLoginBtn.disabled = true;
  loginErrorEl.textContent = '';
  try {
    await signInWithEmail(emailInput.value.trim(), passwordInput.value);
    loginDialog.close();
  } catch (err) {
    loginErrorEl.textContent = err.message;
  } finally {
    emailLoginBtn.disabled = false;
  }
});

signupBtn.addEventListener('click', async () => {
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  if (!email || !password) {
    loginErrorEl.textContent = 'メールアドレスとパスワードを入力してください。';
    return;
  }
  signupBtn.disabled = true;
  loginErrorEl.textContent = '';
  try {
    const { needsEmailConfirmation } = await signUpWithEmail(email, password);
    if (needsEmailConfirmation) {
      loginErrorEl.className = 'status-line success';
      loginErrorEl.textContent = '確認メールを送りました。メール内のリンクを開くとログインできます。';
    } else {
      loginDialog.close();
    }
  } catch (err) {
    loginErrorEl.className = 'status-line error';
    loginErrorEl.textContent = err.message;
  } finally {
    signupBtn.disabled = false;
  }
});

logoutBtn.addEventListener('click', async () => {
  try {
    await signOut();
    location.hash = '#home';
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

// ---- 狭い画面のメニュー ----
//
// 開閉状態は routeFromHash では触らない。背景の自動更新でも routeFromHash は
// 走るため、そこで閉じると開いた直後に勝手に畳まれてしまう。
// 実際に画面が変わるとき（hashchange）と、リンクを押したときだけ閉じる。

function setNavOpen(open) {
  mainNav.classList.toggle('open', open);
  navToggle.setAttribute('aria-expanded', String(open));
  navToggle.setAttribute('aria-label', open ? 'メニューを閉じる' : 'メニューを開く');
}

navToggle.addEventListener('click', () => {
  setNavOpen(!mainNav.classList.contains('open'));
});

// 今いるページと同じリンクを押した場合は hashchange が起きないので、ここでも閉じる
mainNav.addEventListener('click', (e) => {
  if (e.target.closest('a')) setNavOpen(false);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setNavOpen(false);
});

// メニューの外を触ったら閉じる
document.addEventListener('click', (e) => {
  if (!mainNav.classList.contains('open')) return;
  if (e.target.closest('#main-nav') || e.target.closest('#nav-toggle')) return;
  setNavOpen(false);
});

window.addEventListener('hashchange', () => {
  setNavOpen(false);
  routeFromHash();
});

// タブを開き直したときは最新を取り込む（Realtimeが届かない間に進んでいることがある）
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !isUserTyping()) refreshFromDb({ silent: true });
});

// ---- 起動 ----

async function start() {
  // 接続先が未設定のまま動かすと、原因の分かりにくいネットワークエラーが出続けるので
  // 先に止めて、何をすればよいかを画面に出す（supabase/SETUP.md の手順3）。
  if (!isConfigured()) {
    setStatus('Supabaseの接続先が未設定です。supabase/SETUP.md の手順3にしたがって js/supabaseClient.js を設定してください。', 'error');
    loginBtn.disabled = true;
    return;
  }

  // ログイン状態が変わるたびに、UIの出し分けと表示中ページの描画をやり直す
  await initAuth(() => {
    applyAuthUI();
    routeFromHash();

    // ログインしたのに選手行が無い＝新規登録がまだ。そのまま登録フォームへ案内する。
    if (needsOnboarding() && parseHash().page !== 'profile') {
      location.hash = '#profile';
    }
  });

  await refreshFromDb();

  // 10秒ポーリングの置き換え。誰かが勝敗を入力した瞬間に全員の画面へ届く。
  db.subscribeToChanges(() => {
    if (isUserTyping()) return;
    refreshFromDb({ silent: true });
  });

  // 保険。WebSocketが切れたまま再接続できていない間も、進行中の大会が
  // 古いまま放置されないようにする（通常はRealtimeが先に届くので空振りする）。
  setInterval(() => {
    if (document.hidden || isUserTyping()) return;
    refreshFromDb({ silent: true });
  }, 60 * 1000);
}

start();

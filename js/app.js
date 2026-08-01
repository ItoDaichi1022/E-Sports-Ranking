// 導入の演出を終わらせる係。exportを持たず、読み込むだけで働く。
// 一番上に置くのは、飛ばす操作（クリック・キー・スクロール）を受ける耳を
// できるだけ早く付けるため。演出そのものはCSSが動かしているので、
// これが遅れても絵は止まらない。
import './intro.js';
import {
  state, newId, getPlayerName, isTeamTournament, getEntrantName, getEntrantMemberIds,
  openChatReports,
} from './state.js';
import { renderPlayerTable, updatePlayer } from './players.js';
import { escapeHtml, avatarHtml, safeUrl, cardThumb, setupImagePicker } from './util.js';
import {
  createBracket, updateTournament, allMatchesDecided, finalStandings, finalPlacements,
  swapBracketEntrants,
} from './bracket.js';
import { renderBracket } from './bracketView.js';
import { reportChipHtml, syncOpenChat } from './matchChat.js';
import { computeRankings, computeRankingsForRange, withRankChange, rankChangeInfo } from './ranking.js';
import { renderRankingTable } from './rankingView.js';
import { getPlayerStats, championLabel, placementLabelOf } from './playerStats.js';
import { tournamentTier } from './tournamentTier.js';
import { matchTypeLabel, rankingEligibility, RANKED_MIN_PARTICIPANTS } from './rankingEligibility.js';
import { renderProfileForm, profileMetaHtml, profileBioHtml, isProfileFormMounted } from './profile.js';
import { characterImageUrl } from './characters.js';
import { keepFormDraft, clearFormDraft } from './formDraft.js';
import {
  renderRecruitPage, renderTournamentActions, STATUS_LABELS, entrantUnit,
} from './entries.js';
import {
  auth, initAuth, isAdmin, isLoggedIn, needsOnboarding, accountLabel,
  signInWithProvider, signOut, reloadOwnPlayer,
} from './auth.js';
import { isConfigured } from './supabaseClient.js';
import { initStage, renderFeatured, renderStats, prefersReducedMotion } from './stage.js';
import { iconSvg, makeIconButton, setButtonIcon } from './icons.js';
import * as db from './db.js';

// 大会作成画面でのシード順（index 0 = シード1位）。ブラケット生成前の一時的な状態。
let selectedParticipantIds = [];
let participantSearchQuery = '';
let playerSearchQuery = '';
let currentBracketTournamentId = null;

const $ = (id) => document.getElementById(id);

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
const tournamentStreamInput = $('tournament-stream-input');
const tournamentSubmitBtn = $('tournament-submit-btn');
const tournamentMatchTypeInput = $('tournament-match-type-input');
const tournamentMatchTypeNoteField = $('tournament-match-type-note-field');
const tournamentMatchTypeNoteInput = $('tournament-match-type-note-input');
const tournamentThirdPlaceInput = $('tournament-third-place-input');

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

const tournamentsListEl = $('tournaments-list');
const tournamentsNoteEl = $('tournaments-note');
// タブ名 → タブのリンク要素。renderTournamentsPage が is-active を付け替える
const tournamentsTabEls = {
  recruiting: $('tournaments-tab-recruiting'),
  running: $('tournaments-tab-running'),
  finished: $('tournaments-tab-finished'),
};

const entriesNoteEl = $('entries-note');
const entriesLoginPanel = $('entries-login-panel');
const entriesLoginBtn = $('entries-login-btn');
const entriesContentEl = $('entries-content');

const bracketTitleEl = $('bracket-title');
const bracketMetaEl = $('bracket-meta');
const bracketOwnHintEl = $('bracket-own-hint');
const bracketAdminToolsEl = $('bracket-admin-tools');
const bracketContainer = $('bracket-container');
const tournamentEditBtn = $('tournament-edit-btn');
const tournamentDeleteBtn = $('tournament-delete-btn');
const tournamentEditForm = $('tournament-edit-form');
const tournamentEditNameInput = $('tournament-edit-name-input');
const tournamentEditDateInput = $('tournament-edit-date-input');
const tournamentEditRulesInput = $('tournament-edit-rules-input');
const tournamentEditStreamInput = $('tournament-edit-stream-input');
const tournamentEditCancelBtn = $('tournament-edit-cancel-btn');
const tournamentEditMatchTypeInput = $('tournament-edit-match-type-input');
const tournamentEditMatchTypeNoteField = $('tournament-edit-match-type-note-field');
const tournamentEditMatchTypeNoteInput = $('tournament-edit-match-type-note-input');
const tournamentInfoEl = $('tournament-info');
const tournamentActionsEl = $('tournament-actions');
const tournamentHeroEl = $('tournament-hero');
const tournamentTitleEl = $('tournament-title');
const tournamentMetaEl = $('tournament-meta');
const tournamentBackLink = $('tournament-back-link');
const bracketLinkEl = $('bracket-link');
const bracketLinkNoteEl = $('bracket-link-note');
const resultSectionEl = $('result-section');
const bracketBackLink = $('bracket-back-link');
const tournamentEditCapacityInput = $('tournament-edit-capacity-input');

const playerDetailEl = $('player-detail');
const playerBackBtn = $('player-back-btn');

const profileTitleEl = $('profile-title');
const profileNoteEl = $('profile-note');
const profileViewEl = $('profile-view');
const profileFormContainer = $('profile-form-container');
const profileLinksEl = $('profile-links');
const profileLoginPanel = $('profile-login-panel');
const profileLoginErrorEl = $('profile-login-error');
const profileGoogleBtn = $('profile-google-btn');
const profileDiscordBtn = $('profile-discord-btn');
const profileAccountActions = $('profile-account-actions');
const profileAccountEmail = $('profile-account-email');

const rankingContainer = $('ranking-container');
const rankingCreateBtn = $('ranking-create-btn');
const rankingEditorEl = $('ranking-editor');
const rankingStartInput = $('ranking-start-input');
const rankingEndInput = $('ranking-end-input');
const rankingPublishBtn = $('ranking-publish-btn');
const rankingCancelBtn = $('ranking-cancel-btn');
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

// ホームの「見せる面」のブロック（js/stage.js が中身を作る）
const homeFeaturedEl = $('home-featured');
const homeFeaturedSlotEl = $('home-featured-slot');
const homeStatRowEl = $('home-stat-row');

const announcementListEl = $('announcement-list');
const announcementNewBtn = $('announcement-new-btn');
const announcementDialog = $('announcement-dialog');
const announcementDialogTitle = $('announcement-dialog-title');
const announcementForm = $('announcement-form');
const announcementIdInput = $('announcement-id-input');
const announcementTitleInput = $('announcement-title-input');
const announcementBodyInput = $('announcement-body-input');
const announcementPinnedInput = $('announcement-pinned-input');
const announcementFormErrorEl = $('announcement-form-error');
const announcementSubmitBtn = $('announcement-submit-btn');
const announcementCancelBtn = $('announcement-cancel-btn');

const newsListEl = $('news-list');
const newsHeroEl = $('news-hero');
const newsTitleEl = $('news-title');
const newsDateEl = $('news-date');
const newsBodyEl = $('news-body');
const newsActionsEl = $('news-actions');

const loginDialog = $('login-dialog');
const loginErrorEl = $('login-error');
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
  rankingCreateBtn.hidden = !admin;
  tournamentEditBtn.hidden = !admin;
  tournamentDeleteBtn.hidden = !admin;
  if (!admin) tournamentEditForm.hidden = true;
  // 運営でなくなったら投稿フォームも畳む
  if (!admin) closeAnnouncementForm();
  // 同じく、開いていたランキングの編集欄も畳む
  if (!admin) closeRankingEditor();

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
  guide: 'view-guide', // はじめに（静的ページ。描画関数は持たない）
  // #news はお知らせ一覧、#news/{id} は詳細。routeFromHash がパラメータの有無で分ける
  news: 'view-news',
  newslist: 'view-news-list',
  // 大会一覧。募集中・進行中・終了はページ内タブ（#tournaments/{タブ名}）
  tournaments: 'view-tournaments',
  // 自分がエントリー・出場した大会のまとめ
  entries: 'view-entries',
  // create=大会作成（運営）、tournament=大会詳細、bracket=対戦表。
  // 詳細と対戦表は別ページに分けてある。
  create: 'view-tournament',
  tournament: 'view-tournament-detail',
  bracket: 'view-bracket',
  player: 'view-player-detail',
  // 選手一覧はランキングと同じページに統合した。#players は以前のリンクや
  // ブックマークから来る人のために、そのまま同じ画面へ通す。
  players: 'view-ranking',
  ranking: 'view-ranking',
  profile: 'view-profile',
  // 規約類（静的ページ。フッターから開く。描画関数は持たない）
  terms: 'view-terms',
  privacy: 'view-privacy',
};

// ナビのハイライト用：詳細ページは親メニューに対応付ける
const NAV_PAGE_OF = {
  tournament: 'tournaments', bracket: 'tournaments', player: 'ranking',
  players: 'ranking', news: 'newslist',
};

function parseHash() {
  const h = location.hash.replace(/^#/, '');
  const [page, param] = h.split('/');
  return { page: page || 'home', param: param ? decodeURIComponent(param) : null };
}

// いま表示しているのがこのページか。データを取りに行っている間に別の画面へ
// 移ることがあるので、非同期の描画は結果を書き込む前にこれで確かめる
// （確かめないと、移った先の画面に前のページの内容が出てしまう）。
function isCurrentRoute(page, param = null) {
  const now = parseHash();
  if (now.page !== page) return false;
  return param == null || now.param === param;
}

// 直前に表示していた画面。ページが変わったときだけスクロールを先頭へ戻すために覚えておく
// （Realtimeの更新でも routeFromHash は呼ばれるので、毎回戻すと読んでいる途中で飛んでしまう）。
let lastRouteKey = null;

// ---- 読み物ページの読み込み ----
//
// 「はじめに」「利用規約」「プライバシーポリシー」は、中身が長いわりに
// JSからは一切触らない読み物なので、index.html には空の <section> だけを置き、
// 本文は pages/*.html に分けてある（index.html を読める長さに保つため）。
// 読み込むのは、そのページが最初に開かれたときの1回だけ。
//
// 読み込み先のURLは <section data-src="pages/guide.html?v=69"> に書いてある。
// ?v= を index.html の他の版数と同じ場所に置くことで、デプロイ時の一括置換と
// scripts/check-cache-version.mjs の確認から漏れないようにしている。

const pageLoads = new Map(); // viewId -> Promise（二重取得を防ぐ）

function loadStaticPage(viewId) {
  const el = $(viewId);
  const src = el?.dataset.src;
  if (!src) return; // 既に読み込み済み（下で data-src を消している）か、静的ページではない

  if (pageLoads.has(viewId)) return;

  // 取りに行っている間の白紙を避ける。すぐ返ってくれば見えないが、
  // 回線が遅いときに「開いたのに何も無い」と見えるのを防ぐ。
  el.innerHTML = '<p class="status-line loading">読み込んでいます...</p>';

  const task = fetch(src)
    .then((res) => {
      if (!res.ok) throw new Error(`${res.status}`);
      return res.text();
    })
    .then((html) => {
      el.innerHTML = html;
      // 二度と取りに行かない印。属性が残っていると、再訪のたびに読み直してしまう。
      delete el.dataset.src;
      // 中身が入ったいま初めて演出を仕掛けられる（routeFromHash が呼んだ時点では
      // この器はまだ空で、仕掛ける相手がいなかった）。
      initStage(el);
    })
    .catch((err) => {
      // 読めなかったときは、白紙のまま放置せず理由を出して読み直せるようにする
      // （通信が切れている、デプロイの途中で古い ?v= を見に行った、など）。
      pageLoads.delete(viewId);
      el.innerHTML = '<p class="status-line error">'
        + 'このページを読み込めませんでした。通信状況を確認して、再読み込みしてください。</p>';
      console.error(`${src} の読み込みに失敗しました`, err);
    });
  pageLoads.set(viewId, task);
}

function routeFromHash() {
  const { page, param } = parseHash();

  // #login はページではなくログインダイアログを開くための入口
  if (page === 'login') {
    location.replace('#home');
    if (!isLoggedIn()) openLoginDialog();
    return;
  }

  // ページ統合前の旧URL。古いリンク・ブックマークから来た人を対応するタブへ通す。
  if (page === 'recruit') {
    location.replace('#tournaments/recruiting');
    return;
  }
  if (page === 'history') {
    location.replace('#tournaments/finished');
    return;
  }

  let target = VIEW_IDS[page] ? page : 'home';

  // #news はパラメータの有無で一覧と詳細に分かれる（#news=一覧、#news/{id}=詳細）
  if (page === 'news' && !param) target = 'newslist';

  // 大会作成は運営限定。マイページはログアウト中でも開ける（そこからログインする）
  if (target === 'create' && !isAdmin()) {
    location.replace('#home');
    target = 'home';
  }

  // 「別の画面へ移ったのか、同じ画面を描き直しているだけなのか」。
  // この関数は Realtime の更新のたびにも呼ばれるので、この区別は要になる。
  //   * 先頭までスクロールを戻すのは、移ったときだけ
  //   * 画面の切り替えに一枚かぶせるのも、移ったときだけ
  // ここを見ずに演出を走らせると、チャットや対戦表が更新されるたびに
  // 画面全体がひらめいて、見ている人には不具合に見える。
  const routeKey = `${target}/${param ?? ''}`;
  // 最初の1回は「移った」とは数えない。まだ何も描かれていない画面から
  // かぶせても、白い面が一度ひらめくだけで意味がないため。
  const isFirstRoute = lastRouteKey === null;
  const routeChanged = routeKey !== lastRouteKey;
  lastRouteKey = routeKey;

  // 画面の入れ替え一式。View Transitions で包めるように、ひとまとまりにしてある。
  const applyRoute = () => {
    Object.entries(VIEW_IDS).forEach(([name, id]) => {
      $(id).hidden = name !== target;
    });

    // 中身を別ファイルに分けてある読み物ページ（はじめに・利用規約・プライバシーポリシー）。
    // data-src が付いていないページでは何もしない。
    loadStaticPage(VIEW_IDS[target]);

    const navPage = NAV_PAGE_OF[target] || target;
    mainNav.querySelectorAll('a').forEach((a) => {
      a.classList.toggle('active', a.dataset.page === navPage);
    });

    // ページによっては、その画面で初めて必要になるデータを取りに行ってから描く
    // （非同期の描画。中で失敗は拾っているので、ここでは最後の受け皿だけ用意する）。
    const draw = (result) => Promise.resolve(result).catch((err) => {
      console.error('画面の描画に失敗しました', err);
      setStatus(err.message, 'error');
    });

    if (target === 'home') renderHome();
    else if (target === 'news') draw(renderNewsPage(param));
    else if (target === 'newslist') draw(renderNewsListPage());
    else if (target === 'tournaments') renderTournamentsPage(param);
    else if (target === 'entries') draw(renderEntriesPage());
    else if (target === 'create') { renderParticipantCheckboxes(); renderSelectedList(); }
    else if (target === 'tournament') draw(renderTournamentDetail(param));
    else if (target === 'bracket') draw(renderBracketPage(param));
    else if (target === 'player') draw(renderPlayerDetail(param));
    // 選手検索とランキングは同じページ。どちらのハッシュで来ても両方を描く。
    else if (target === 'players' || target === 'ranking') {
      refreshPlayerUI();
      renderRankingPage();
    } else if (target === 'profile') renderProfilePage();

    // 別の画面へ移ったときは先頭から見せる。ハッシュだけを書き換える作りなので、
    // 何もしないとブラウザは前の画面のスクロール位置をそのまま引き継いでしまい、
    // 長いページから移ると途中や一番下から始まったように見える。
    // 中身を入れ替えたあとに戻す。先に戻しても、描画で高さが変わると位置がずれる。
    if (routeChanged) window.scrollTo(0, 0);

    // 先頭に戻ったので「上へ戻る」も引っ込める。scroll イベント待ちにすると、
    // 既に先頭にいた場合はイベントが起きず、ボタンが出たまま残る。
    syncScrollTopBtn();

    // 見せる面（ホーム・読み物ページ）の登場アニメを仕掛ける。スクロール位置を
    // 戻したあとに呼ぶこと（先に呼ぶと、前の画面の位置で「もう見えている」と
    // 判定され、上のほうの要素が出た状態から始まってしまう）。
    // 読み物ページは中身が後から入るので、そちらは loadStaticPage が改めて呼ぶ。
    initStage($(VIEW_IDS[target]));
  };

  // 画面が切り替わるときだけ、一枚かぶせて入れ替える（View Transitions）。
  // 非対応のブラウザと、動きを止めている人には、これまでどおり
  // .view の view-in（css/style.css）だけが働く。
  if (routeChanged && !isFirstRoute
      && typeof document.startViewTransition === 'function' && !prefersReducedMotion()) {
    document.startViewTransition(applyRoute);
  } else {
    applyRoute();
  }
}

// ---- ホーム（お知らせ） ----

// 投稿・編集フォームを開く。announcement を渡すと編集、null なら新規。
// ホーム（新規）と詳細ページ（編集）の両方から開くのでダイアログにしている。
// 下書きの控えは投稿ごとに分ける。新規と編集で同じ鍵にすると、
// 書きかけの新規投稿が、既存のお知らせを編集したときに流れ込んでしまう。
const announcementDraftKey = (id) => `announcement-${id || 'new'}`;

function openAnnouncementForm(announcement) {
  announcementIdInput.value = announcement?.id ?? '';
  announcementTitleInput.value = announcement?.title ?? '';
  announcementBodyInput.value = announcement?.body ?? '';
  announcementPinnedInput.checked = Boolean(announcement?.pinned);
  announcementImagePicker.setCurrent(announcement?.imageUrl || '');
  announcementFormErrorEl.textContent = '';
  announcementDialogTitle.textContent = announcement ? 'お知らせを編集' : '新しいお知らせ';
  announcementSubmitBtn.textContent = announcement ? '更新する' : '投稿する';
  // 保存済みの内容を入れ終えてから下書きを重ねる（書きかけがあればそちらが勝つ）
  keepFormDraft(announcementForm, announcementDraftKey(announcement?.id));
  announcementDialog.showModal();
  // ダイアログは閉じても要素が残るので、前に開いたときのスクロール位置を持っている
  announcementDialog.scrollTop = 0;
  announcementTitleInput.focus();
}

// 閉じるのは「やめる」か「投稿できた」かのどちらか。どちらも書きかけを持ち越さない。
function closeAnnouncementForm() {
  clearFormDraft(announcementDraftKey(announcementIdInput.value));
  announcementDialog.close();
  announcementForm.reset();
  announcementIdInput.value = '';
  announcementImagePicker.setCurrent('');
  announcementFormErrorEl.textContent = '';
}

// ホームに出すお知らせの件数。最新の動きが分かれば十分なので数件に絞り、
// 全件はお知らせ一覧ページ（#news）で見せる。
const HOME_ANNOUNCEMENT_COUNT = 3;

function renderHome() {
  // 見せる面のブロック（注目の大会・数字）。中身は js/stage.js が
  // state から作る。どちらも起動時に読み終えているデータだけを使うので、
  // ここで通信は増えない。
  renderFeatured(homeFeaturedEl, homeFeaturedSlotEl);
  renderStats(homeStatRowEl);

  renderAnnouncementCards(announcementListEl, state.announcements.slice(0, HOME_ANNOUNCEMENT_COUNT));
}

// お知らせ一覧ページ。全件を新しい順（固定を先頭）に並べる。
// 普段は最新の数件しか読んでいないので、ここで全件を取りに行く。
async function renderNewsListPage() {
  renderAnnouncementCards(newsListEl, state.announcements);
  try {
    await db.ensureAllAnnouncements();
  } catch (err) {
    setStatus(err.message, 'error');
    return;
  }
  if (!isCurrentRoute('news')) return;
  renderAnnouncementCards(newsListEl, state.announcements);
}

// お知らせのカード一覧。ホームとお知らせ一覧ページの両方から使う。
function renderAnnouncementCards(containerEl, announcements) {
  containerEl.innerHTML = '';

  if (announcements.length === 0) {
    containerEl.innerHTML = '<p class="empty-hint">まだお知らせはありません。</p>';
    return;
  }

  // 一覧は画像・題名・日付だけの入口。本文は詳細ページ（#news/{id}）で読ませる。
  // カードの形と並べ方は大会一覧と共通（css の .card 系）。
  const list = document.createElement('div');
  list.className = 'card-grid';

  announcements.forEach((a) => {
    const card = document.createElement('a');
    card.className = `card${a.pinned ? ' pinned' : ''}`;
    card.href = `#news/${encodeURIComponent(a.id)}`;

    const body = document.createElement('div');
    body.className = 'card-body';

    const title = document.createElement('h3');
    title.className = 'card-title';
    if (a.pinned) {
      const pin = document.createElement('span');
      pin.className = 'pin-badge';
      pin.textContent = '固定';
      title.appendChild(pin);
    }
    title.appendChild(document.createTextNode(a.title));
    body.appendChild(title);

    const date = document.createElement('p');
    date.className = 'card-date';
    date.textContent = formatDateTime(a.createdAt);
    body.appendChild(date);

    card.append(cardThumb(a.imageUrl, a.title), body);
    list.appendChild(card);
  });

  containerEl.appendChild(list);
}

// お知らせの詳細。画像 → 題名 → 日付 → 本文 → 運営操作 の順に出す。
async function renderNewsPage(id) {
  newsActionsEl.innerHTML = '';

  // 最新数件にしか入っていない状態で古いお知らせのURLを直接開かれることがある。
  // 「見つかりません」を出す前に、全件を取りに行って確かめる。
  if (!state.announcements.some((x) => x.id === id)) {
    try {
      await db.ensureAllAnnouncements();
    } catch (err) {
      setStatus(err.message, 'error');
    }
    if (!isCurrentRoute('news', id)) return;
  }

  const a = state.announcements.find((x) => x.id === id);
  if (!a) {
    renderHero(newsHeroEl, null);
    newsTitleEl.textContent = 'お知らせが見つかりません';
    newsDateEl.textContent = '';
    newsBodyEl.textContent = 'このお知らせは存在しないか、削除されています。';
    return;
  }

  renderHero(newsHeroEl, a.imageUrl);
  newsTitleEl.textContent = a.title;
  newsDateEl.textContent = formatDateTime(a.createdAt);
  // 本文はユーザー入力。textContentで入れ、改行はCSS(white-space:pre-wrap)で見せる
  newsBodyEl.textContent = a.body || '';

  if (!isAdmin()) return;

  const editBtn = makeIconButton('pencil', 'お知らせを編集', { className: 'btn-secondary' });
  editBtn.addEventListener('click', () => openAnnouncementForm(a));

  const delBtn = makeIconButton('trash', 'お知らせを削除', { className: 'btn-remove' });
  delBtn.addEventListener('click', async () => {
    if (!confirm(`お知らせ「${a.title}」を削除しますか？`)) return;
    const ok = await persist(() => db.deleteAnnouncement(a.id), 'お知らせの削除');
    if (!ok) return;
    if (a.imageUrl) await db.removeImageByUrl(a.imageUrl).catch(() => {});
    await refreshFromDb();
    // 消したお知らせのページに留まらないよう一覧へ戻す
    location.hash = '#news';
  });

  newsActionsEl.append(editBtn, delBtn);
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

    const upBtn = makeIconButton('arrowUp', 'シードを1つ上げる', { className: 'btn-secondary' });
    upBtn.disabled = index === 0;
    upBtn.addEventListener('click', () => {
      [selectedParticipantIds[index - 1], selectedParticipantIds[index]] =
        [selectedParticipantIds[index], selectedParticipantIds[index - 1]];
      renderSelectedList();
    });

    const downBtn = makeIconButton('arrowDown', 'シードを1つ下げる', { className: 'btn-secondary' });
    downBtn.disabled = index === selectedParticipantIds.length - 1;
    downBtn.addEventListener('click', () => {
      [selectedParticipantIds[index + 1], selectedParticipantIds[index]] =
        [selectedParticipantIds[index], selectedParticipantIds[index + 1]];
      renderSelectedList();
    });

    const removeBtn = makeIconButton('x', '参加者から外す', { className: 'btn-secondary' });
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
async function seedBySelectedRanking() {
  // 並び替えの根拠になるランキングには全期間の試合結果が要る（普段は持っていない）
  try {
    await db.ensureFullData();
  } catch (err) {
    alert(err.message);
    return;
  }

  const rankings = computeRankings(state);
  if (rankings.length === 0) {
    alert('ランキング反映対象の大会に確定した試合がまだないため、ランキング順には並び替えられません。');
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

// マイページで入力欄を開いているか。普段は他の人から見えるプロフィールを出し、
// 編集アイコンを押したときだけ入力欄に切り替える（自分の見え方を先に確かめられるように）。
//
// 開いていたかどうかもタブに控える。他のアプリへ移って戻るとページごと捨てられて
// いることがあり、そのとき閲覧の姿に戻ってしまうと、控えてある書きかけ
// （js/formDraft.js）があることに気づけない。開いた状態で戻せば、そのまま続けられる。
const PROFILE_EDITING_KEY = 'profile-editing';
let profileEditing = (() => {
  try {
    return sessionStorage.getItem(PROFILE_EDITING_KEY) === '1';
  } catch {
    return false;
  }
})();

function setProfileEditing(on) {
  profileEditing = on;
  try {
    if (on) sessionStorage.setItem(PROFILE_EDITING_KEY, '1');
    else sessionStorage.removeItem(PROFILE_EDITING_KEY);
  } catch {
    // 控えられなくても編集そのものは続けられる
  }
}

function renderProfilePage() {
  profileLinksEl.innerHTML = '';
  profileViewEl.innerHTML = '';
  profileViewEl.hidden = true;

  // ログアウト中：ログインの入口だけを見せる
  if (!isLoggedIn()) {
    profileFormMode = null;
    setProfileEditing(false);
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

  // 登録がまだの人には、いきなり入力欄を出す（見せるプロフィールがまだ無い）
  if (needsOnboarding()) {
    profileTitleEl.textContent = '選手登録';
    profileNoteEl.textContent = '表示名など必要事項を記入すると登録が完了します。あとからいつでも変更できます。';
    if (keepExistingForm) return;
    renderProfileForm(profileFormContainer, null, {
      submitLabel: '登録する',
      draftKey: 'profile-onboarding',
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

  // 普段は「他の人から見える姿」をそのまま出す。編集は鉛筆から。
  if (!profileEditing) {
    profileFormMode = null;
    profileFormContainer.innerHTML = '';
    profileNoteEl.textContent = 'これが他の人から見えるあなたのプロフィールです。';
    renderOwnProfileView();
    return;
  }

  profileNoteEl.textContent = 'ここで編集した内容は、あなたの選手ページに表示されます。';

  if (!keepExistingForm) {
    renderProfileForm(profileFormContainer, auth.player, {
      submitLabel: '保存',
      draftKey: `profile-${auth.player.id}`,
      onCancel: () => {
        // 「キャンセル」は書きかけを捨てる操作。控えも一緒に捨てないと、
        // 次に編集を開いたときに、捨てたはずの内容が戻ってくる。
        clearFormDraft(`profile-${auth.player.id}`);
        setProfileEditing(false);
        renderProfilePage();
      },
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
        // 保存できたら閲覧に戻す。直した結果が他の人にどう見えるかをその場で確かめられる。
        setProfileEditing(false);
        renderProfilePage();
      },
    });
  }
}

// 他の人から見えるプロフィールをそのまま出す。選手ページと同じ部品を使うので、
// ここでの見え方＝選手ページでの見え方になる。
function renderOwnProfileView() {
  const player = auth.player;
  profileViewEl.hidden = false;

  const meta = profileMetaHtml(player);
  const bio = profileBioHtml(player);

  // 選手ページとまったく同じ部品で組む（ここが「他の人からどう見えるか」の確認場所
  // なので、見た目が少しでも違うと確認にならない）。
  profileViewEl.innerHTML = playerHeroHtml(player, {
    nameTag: 'h3',
    action: `<button type="button" class="profile-edit-link profile-edit-btn"
              title="プロフィールを編集する" aria-label="プロフィールを編集する">${iconSvg('pencil')}</button>`,
    meta,
  }) + (meta || bio
    ? bio
    : '<p class="empty-hint">まだ表示名だけです。鉛筆アイコンからアイコン・使用キャラ・自己紹介などを追加できます。</p>');

  profileViewEl.querySelector('.profile-edit-btn').addEventListener('click', () => {
    setProfileEditing(true);
    renderProfilePage();
  });

  const link = document.createElement('a');
  link.className = 'back-link';
  link.href = `#player/${encodeURIComponent(player.id)}`;
  link.textContent = '自分の選手ページ（戦歴つき）を見る →';
  profileLinksEl.appendChild(link);
}

// ---- エントリー状況 ----
//
// 自分がエントリー・出場した大会だけを、募集中・進行中・終了に分けて並べる。
// マイページはプロフィールの場所なので、自分の大会への入口はこちらに集約する。

// グループの並びは大会の時間の流れ（これから出る → いま出ている → 出終わった）。
// 準備中は「募集中に入れたが運営が一時的に募集を止めた」状態なので、エントリー中に含める。
const ENTRY_GROUPS = [
  { title: 'エントリー中の大会', statuses: ['recruiting', 'draft'] },
  { title: '出場中の大会', statuses: ['running'] },
  { title: '過去に出場した大会', statuses: ['finished'] },
];

// 自分の出場記録は、この選手のぶんだけDBから取る（全大会のエントリー行は
// 手元に持っていない。js/db.js の loadPlayerEntries を参照）。
async function renderEntriesPage() {
  if (!isLoggedIn()) {
    entriesContentEl.innerHTML = '';
    entriesLoginPanel.hidden = false;
    entriesNoteEl.textContent = 'ログインすると、自分がエントリー・出場した大会がここにまとまります。';
    return;
  }
  entriesLoginPanel.hidden = true;

  // ログイン済みでも選手登録がまだならエントリーできないので、登録へ案内する
  if (!auth.player) {
    entriesNoteEl.textContent = '';
    entriesContentEl.innerHTML = '<p class="empty-hint">選手登録がまだです。'
      + '<a href="#profile">マイページ</a>で登録すると、大会にエントリーできます。</p>';
    return;
  }

  entriesNoteEl.textContent = '自分がエントリー・出場した大会の一覧です。大会を選ぶと詳細に移動します。';

  const playerId = auth.player.id;
  let entries;
  try {
    entries = await db.loadPlayerEntries(playerId);
  } catch (err) {
    entriesContentEl.innerHTML = `<p class="empty-hint">${escapeHtml(err.message)}</p>`;
    return;
  }
  if (!isCurrentRoute('entries')) return;

  entriesContentEl.innerHTML = '';

  const myTournamentIds = new Set(entries.map((e) => e.tournamentId));
  const placements = new Map(entries.map((e) => [e.tournamentId, e.placement]));
  const mine = state.tournaments.filter((t) => myTournamentIds.has(t.id));

  if (mine.length === 0) {
    entriesContentEl.innerHTML = '<p class="empty-hint">まだエントリーした大会がありません。'
      + '<a href="#tournaments">募集中の大会</a>からエントリーできます。</p>';
    return;
  }

  ENTRY_GROUPS.forEach(({ title, statuses }) => {
    const items = mine.filter((t) => statuses.includes(t.status));
    if (items.length === 0) return; // 空のグループは見出しごと出さない

    const heading = document.createElement('h3');
    heading.className = 'entries-group-title';
    heading.textContent = title;
    entriesContentEl.appendChild(heading);

    const listWrap = document.createElement('div');
    renderTournamentCards(listWrap, [...items].reverse(), '', { myPlacements: placements });
    entriesContentEl.appendChild(listWrap);
  });
}

// ---- 大会一覧（募集中・進行中・終了のタブ） ----

// 大会の規模の表示。ブラケットの枠になるのはチーム戦ではチームなので、
// 「16チーム」を主にしつつ、実際に出た人数も添える。
// 数えるのは行を読み込んでいない大会でも出せる entrantCount / participantCount
// （一覧では出場者の行そのものは持っていない。js/state.js の説明を参照）。
function entrantCountLabel(t) {
  const count = `${t.entrantCount}${entrantUnit(t)}`;
  return isTeamTournament(t) ? `${count}（${t.participantCount}人）` : count;
}

// 優勝者を名指しするのは、運営が結果を確定させた大会だけ。
// 表が埋まっただけの段階では「結果待ち」に留める。
//
// 状態と優勝者は別々に返す。履歴一覧では別の要素として並べたいので、
// 「優勝: ○○」という1本の文字列にまとめてしまうと分解できなくなる。
function tournamentStatusInfo(t) {
  if (!state.bracketIds.has(t.id)) {
    return { label: STATUS_LABELS[t.status] ?? '—', tone: t.status, champion: null };
  }

  if (t.status === 'finished') {
    // チーム戦ではチーム名が返る（優勝者は2人いるので選手名では出せない）
    return { label: '終了', tone: 'finished', champion: championLabel(t.id) };
  }

  // 「結果待ち（表は埋まったが運営が確定していない）」は対戦表を見ないと分からない。
  // 一覧では対戦表を読み込まないので、その場合は「進行中」までの表示に留める。
  const bracket = state.brackets[t.id];
  return bracket && allMatchesDecided(bracket)
    ? { label: '結果待ち', tone: 'pending', champion: null }
    : { label: '進行中', tone: 'running', champion: null };
}

// 大会情報の「進行状況」欄用。1行に収めたいので優勝者も含めて文字列にする。
function tournamentStatusLabel(t) {
  const { label, champion } = tournamentStatusInfo(t);
  return champion ? `優勝: ${champion}` : label;
}

const TOURNAMENT_TABS = ['recruiting', 'running', 'finished'];

// タブごとの説明。そのタブで何ができるかを1行で示す。
const TOURNAMENT_TAB_NOTES = {
  recruiting: '大会を選ぶと、ルールや参加者を確認してエントリーできます。募集中はいつでも取り消せます。',
  running: '大会を選ぶとブラケット（進行状況）を確認できます。',
  finished: '大会を選ぶとブラケット（最終結果）を確認できます。',
};

function renderTournamentsPage(param) {
  const tab = TOURNAMENT_TABS.includes(param) ? param : 'recruiting';

  Object.entries(tournamentsTabEls).forEach(([name, el]) => {
    el.classList.toggle('is-active', name === tab);
    if (name === tab) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
  tournamentsNoteEl.textContent = TOURNAMENT_TAB_NOTES[tab];

  // 募集中タブは、エントリー導線ごと entries.js に任せる（運営には準備中も見える）
  if (tab === 'recruiting') {
    renderRecruitPage(tournamentsListEl);
    return;
  }

  const visible = state.tournaments.filter((t) => t.status === tab);
  renderTournamentCards(tournamentsListEl, [...visible].reverse(), tab === 'running'
    ? '進行中の大会はありません。'
    : 'まだ終了した大会がありません。');
}

// 始まった大会（進行中・終了）のカード一覧。大会一覧とエントリー状況で使う。
// myPlacements（大会ID → 勝ち上がりの深さ）を渡すと、その成績をカードに添える。
function renderTournamentCards(containerEl, tournaments, emptyText, { myPlacements = null } = {}) {
  containerEl.innerHTML = '';

  if (tournaments.length === 0) {
    containerEl.innerHTML = `<p class="empty-hint">${escapeHtml(emptyText)}</p>`;
    return;
  }

  // カードの形は募集・お知らせと共通（css の .card 系）
  const list = document.createElement('div');
  list.className = 'card-grid';

  tournaments.forEach((t) => {
    const card = document.createElement('a');
    card.className = 'card';
    card.href = `#tournament/${encodeURIComponent(t.id)}`;

    const { label, tone, champion } = tournamentStatusInfo(t);
    const placement = myPlacements
      ? placementLabelOf(t.id, myPlacements.get(t.id) ?? null)
      : null;

    const body = document.createElement('div');
    body.className = 'card-body';
    body.innerHTML = `
      <h3 class="card-title">${escapeHtml(t.name)}</h3>
      <p class="card-date">${escapeHtml(t.date || '日付未設定')} ・ ${escapeHtml(entrantCountLabel(t))}参加</p>
      <span class="status-chip status-${tone}">${escapeHtml(label)}</span>
      ${reportChipHtml(t.id)}
      ${champion ? `<span class="card-champion">優勝 ${escapeHtml(champion)}</span>` : ''}
      ${placement ? `<span class="card-my-result">自分の成績: ${escapeHtml(placement)}</span>` : ''}
    `;

    card.append(cardThumb(t.imageUrl, t.name), body);
    list.appendChild(card);
  });

  containerEl.appendChild(list);
}

// ---- ブラケットページ ----

const FORMAT_LABELS = {
  single_elim: 'シングルエリミネーション',
  double_elim: 'ダブルエリミネーション',
  round_robin: '総当たり',
};

// 配信元の入力欄を読む。空欄はそのまま空、書式が違えば知らせて止める。
//
// javascript: のようなURLを弾くのは表示側（safeUrl）でもやっているが、
// 保存する前に気づけないと、運営は「書いたのにリンクが出ない」としか分からない。
const INVALID_URL = Symbol('invalid-url');

function readStreamUrl(input) {
  const raw = input.value.trim();
  if (!raw) return '';
  const url = safeUrl(raw);
  if (!url) {
    alert('配信元は http:// または https:// から始まるURLで入力してください。');
    input.focus();
    return INVALID_URL;
  }
  return url;
}

// 詳細ページ（大会・お知らせ）の画像ヘッダー。
// 画像が無いときは枠ごと隠し、余白だけが残らないようにする。
function renderHero(el, imageUrl) {
  const url = safeUrl(imageUrl);
  if (url) {
    el.innerHTML = `<img src="${escapeHtml(url)}" alt="" loading="lazy">`;
    el.hidden = false;
  } else {
    el.innerHTML = '';
    el.hidden = true;
  }
}

// ランキングに反映される大会かどうかの印。条件（24人以上・1v1／リレー）は
// 大会の内容で決まるので、満たしていない場合は何が足りないかもそのまま出す。
// 募集中の大会では人数が増えて条件を満たすことがあるため、見出しの文言を変える。
function rankingEligibilityHtml(tournament) {
  const { ranked, reasons } = rankingEligibility(tournament);
  const settled = tournament.status === 'finished';

  if (ranked) {
    const title = settled ? 'ランキング反映済み' : 'ランキング反映対象';
    return `
      <div class="ranking-mark ranking-mark-on">
        <span class="ranking-mark-title">${title}</span>
        <span class="ranking-mark-note">この大会の試合はランキングのスコアに反映されます。</span>
      </div>
    `;
  }

  const title = settled ? 'ランキング反映なし' : 'ランキング反映対象外';
  return `
    <div class="ranking-mark ranking-mark-off">
      <span class="ranking-mark-title">${title}</span>
      <span class="ranking-mark-note">
        条件（参加${RANKED_MIN_PARTICIPANTS}人以上・対戦方法が1v1かリレー）を満たしていません：
        ${escapeHtml(reasons.join(' / '))}
      </span>
    </div>
  `;
}

function renderTournamentInfo(tournament) {
  const formatLabel = FORMAT_LABELS[tournament.format] || tournament.format;
  const unit = entrantUnit(tournament);
  // 定員もチーム戦ではチーム数（DBの定員トリガーと同じ数え方）
  const countLabel = tournament.capacity == null
    ? entrantCountLabel(tournament)
    : `${tournament.entrantCount} / ${tournament.capacity}${unit}`;
  const countHeading = tournament.status === 'recruiting'
    ? 'エントリー'
    : `参加${unit === 'チーム' ? 'チーム数' : '人数'}`;

  // 未対応の報告は大会情報のいちばん上に出す。運営が対戦表まで下りなくても
  // 「この大会で何か起きている」と気づけるようにするため。
  const openReports = isAdmin() ? openChatReports(tournament.id) : [];

  let html = `
    <h3>大会情報</h3>
    ${openReports.length > 0 ? `
      <div class="report-notice">
        <span class="report-notice-title">⚠ 未対応の報告が${openReports.length}件あります</span>
        <span class="report-notice-note">
          対戦表を開き、印の付いた対戦のチャットから内容を確認して「対応済みにする」を押してください。
        </span>
      </div>
    ` : ''}
    ${rankingEligibilityHtml(tournament)}
    <dl class="tournament-info-grid">
      <div><dt>${countHeading}</dt><dd>${escapeHtml(countLabel)}</dd></div>
      <div><dt>規模</dt><dd>${tournamentTier(tournament.entrantCount)}</dd></div>
      <div><dt>対戦方法</dt><dd>${escapeHtml(matchTypeLabel(tournament))}</dd></div>
      <div><dt>形式</dt><dd>${escapeHtml(formatLabel)}</dd></div>
      <div><dt>三位決定戦</dt><dd>${tournament.thirdPlaceMatch ? '行う' : '行わない'}</dd></div>
      <div><dt>開催日</dt><dd>${escapeHtml(tournament.date || '日付未設定')}</dd></div>
      <div><dt>進行状況</dt><dd>${escapeHtml(tournamentStatusLabel(tournament))}</dd></div>
    </dl>
  `;
  // 配信元。試合を見に行く導線なので、ルールより先に、押せる形で出す。
  // URLはDBから来るので、表示のたびに safeUrl を通してから href に入れる。
  const streamUrl = safeUrl(tournament.streamUrl);
  if (streamUrl) {
    html += `
      <h4>配信元</h4>
      <a class="stream-link" href="${escapeHtml(streamUrl)}" target="_blank" rel="noopener noreferrer">
        <span class="stream-link-label">配信を見る</span>
        <span class="stream-link-host">${escapeHtml(new URL(streamUrl).hostname)}</span>
      </a>
    `;
  }

  if (tournament.rules) {
    html += `
      <h4>ルール</h4>
      <p class="tournament-rules">${escapeHtml(tournament.rules)}</p>
    `;
  }

  // ブラケットが出来る前は対戦表が無いので、代わりに顔ぶれを見せる。
  // 募集中の大会の詳細を選手が確認できるようにするための表示。
  if (!state.bracketIds.has(tournament.id) && tournament.entrantCount > 0) {
    if (isTeamTournament(tournament)) {
      // チーム戦はチーム名を主に、メンバーを添える。誰と誰が組んでいるかが
      // 分からないと、これから申し込む人が相手を選べない。
      const chips = tournament.teams.map((team) => {
        const members = team.memberIds.map((id) => getPlayerName(id)).join(' / ');
        return `<span class="entrant-chip entrant-chip-team">
            <span class="entrant-chip-name">${escapeHtml(team.name)}</span>
            <span class="entrant-chip-members">${escapeHtml(members)}</span>
          </span>`;
      }).join('');
      html += `<h4>エントリー中のチーム</h4><div class="entrant-list">${chips}</div>`;
    } else {
      const names = tournament.entrantIds.map((id) => {
        const player = state.players.find((p) => p.id === id);
        return `<span class="entrant-chip">${escapeHtml(player ? player.currentName : id)}</span>`;
      }).join('');
      html += `<h4>エントリー中の選手</h4><div class="entrant-list">${names}</div>`;
    }
  }

  tournamentInfoEl.innerHTML = html;
}

// 大会一覧へ戻るときの行き先。この大会がいま並んでいるタブへ戻す。
// 準備中は運営にだけ募集中タブに並ぶので、募集中タブ扱いにする。
function backToListLink(tournament) {
  const tab = tournament.status === 'draft' ? 'recruiting'
    : TOURNAMENT_TABS.includes(tournament.status) ? tournament.status : 'finished';
  return { href: `#tournaments/${tab}`, text: '← 大会一覧へ' };
}

// 大会詳細。対戦表そのものは別ページ（#bracket/{id}）に分けてあり、
// ここには「ブラケットを見る」という入口だけを置く。
//
// 「誰が出ているか」はこのページで初めて必要になるので、ここで取りに行く
// （一覧では人数しか持っていない。js/state.js の説明を参照）。
async function renderTournamentDetail(tournamentId) {
  currentBracketTournamentId = tournamentId;
  tournamentEditForm.hidden = true;

  const tournament = state.tournaments.find((t) => t.id === tournamentId);
  if (!tournament) {
    renderHero(tournamentHeroEl, null);
    tournamentTitleEl.textContent = '大会が見つかりません';
    tournamentMetaEl.textContent = '';
    tournamentInfoEl.innerHTML = '<p class="empty-hint">この大会は存在しないか、削除されています。</p>';
    tournamentActionsEl.innerHTML = '';
    bracketLinkEl.hidden = true;
    return;
  }

  try {
    await db.ensureTournamentDetail(tournamentId);
  } catch (err) {
    tournamentInfoEl.innerHTML = `<p class="empty-hint">${escapeHtml(err.message)}</p>`;
    return;
  }
  // 読み込んでいる間に別の画面へ移っていたら、そこへ古い内容を描かない
  if (!isCurrentRoute('tournament', tournamentId)) return;

  renderHero(tournamentHeroEl, tournament.imageUrl);
  tournamentTitleEl.textContent = tournament.name;
  tournamentMetaEl.textContent = `${tournament.date || '日付未設定'} ・ ${entrantCountLabel(tournament)}参加 ・ ${tournamentStatusLabel(tournament)}`;

  const back = backToListLink(tournament);
  tournamentBackLink.href = back.href;
  tournamentBackLink.textContent = back.text;

  // 対戦表がまだ組まれていない（募集中など）大会では、入口を出しても空のページに
  // 行き着くだけなので隠す。
  const hasBracket = state.bracketIds.has(tournamentId);
  bracketLinkEl.hidden = !hasBracket;
  if (hasBracket) {
    bracketLinkEl.href = `#bracket/${encodeURIComponent(tournamentId)}`;
    bracketLinkNoteEl.textContent = tournament.status === 'finished'
      ? '対戦表と最終結果'
      : '対戦表と進行状況';
  }

  // エントリーと運営の募集操作。募集一覧のカードは入口だけにしたので、ここが操作の場所。
  renderTournamentActions(tournamentActionsEl, tournament, async () => {
    await refreshFromDb();
  });

  renderTournamentInfo(tournament);
}

// ---- 組み合わせの手直し（運営） ----
//
// 自動生成されたブラケットは、シード順のとおりに機械的に並ぶ。同じ地域の選手が
// 1回戦で当たる、といった「表としては正しいが運営として避けたい」組み合わせを、
// 開始前に手で直せるようにする。
//
// { tournamentId, selected } | null。selected は1人目に選んだ出場枠のID。
let bracketSwap = null;

// 直せるのは回戦が始まる前だけ。選手に対戦相手が見えたあとで動かすと、
// 待ち合わせ済みの相手が変わってしまう。
function canAdjustBracket(tournamentId) {
  if (!state.brackets[tournamentId]) return false;
  const started = state.rounds.some((r) => r.tournamentId === tournamentId && r.startedAt);
  const hasResults = state.matches.some((m) => m.tournamentId === tournamentId);
  return !started && !hasResults;
}

function renderBracketAdminTools(tournamentId) {
  bracketAdminToolsEl.innerHTML = '';

  if (!isAdmin() || !canAdjustBracket(tournamentId)) {
    bracketAdminToolsEl.hidden = true;
    if (bracketSwap?.tournamentId === tournamentId) bracketSwap = null;
    return;
  }

  bracketAdminToolsEl.hidden = false;
  const swapping = bracketSwap?.tournamentId === tournamentId;

  if (!swapping) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-secondary';
    btn.textContent = '組み合わせを調整する';
    btn.addEventListener('click', () => {
      bracketSwap = { tournamentId, selected: null };
      renderBracketPage(tournamentId);
    });
    bracketAdminToolsEl.appendChild(btn);

    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = '回戦を開始する前なら、対戦カードの組み合わせを手で入れ替えられます。';
    bracketAdminToolsEl.appendChild(note);
    return;
  }

  bracketAdminToolsEl.classList.add('is-swapping');
  const note = document.createElement('p');
  note.className = 'bracket-swap-note';
  note.textContent = bracketSwap.selected
    ? '入れ替える相手を選んでください（選んだ2人の位置が入れ替わります）。'
    : '位置を入れ替えたい選手を2人、順に押してください。';
  bracketAdminToolsEl.appendChild(note);

  const doneBtn = document.createElement('button');
  doneBtn.type = 'button';
  doneBtn.textContent = '調整を終える';
  doneBtn.addEventListener('click', () => {
    bracketSwap = null;
    bracketAdminToolsEl.classList.remove('is-swapping');
    renderBracketPage(tournamentId);
  });
  bracketAdminToolsEl.appendChild(doneBtn);
}

// 対戦表で選手が押されたとき。1人目は覚えるだけ、2人目でその場で入れ替える。
async function onBracketSwapPick(tournamentId, entrantId) {
  if (bracketSwap?.tournamentId !== tournamentId) return;

  // 同じ人をもう一度押したら選択を解除する（押し間違いをその場で戻せる）
  if (bracketSwap.selected === entrantId) {
    bracketSwap.selected = null;
    await renderBracketPage(tournamentId);
    return;
  }
  if (!bracketSwap.selected) {
    bracketSwap.selected = entrantId;
    await renderBracketPage(tournamentId);
    return;
  }

  const result = swapBracketEntrants(tournamentId, bracketSwap.selected, entrantId);
  if (!result.ok) {
    alert(result.error);
    return;
  }
  bracketSwap.selected = null;
  await renderBracketPage(tournamentId);

  // 保存に失敗したら、DBから取り直して手元の入れ替えを捨てる（画面とDBを食い違わせない）
  const ok = await persist(
    () => db.saveBracket(tournamentId, state.brackets[tournamentId]), '対戦表の保存',
  );
  if (!ok) {
    await refreshFromDb();
    await renderBracketPage(tournamentId);
  }
}

// 対戦表のページ。大会詳細から分けて、対戦表だけに集中できるようにする。
//
// 対戦表の中身はこのページに来て初めて取りに行く（loadAll は持ってこない）。
// そのぶん最初の描画が一拍遅れるので、見出しだけは先に出しておく。
async function renderBracketPage(tournamentId) {
  const tournament = state.tournaments.find((t) => t.id === tournamentId);
  if (!tournament) {
    bracketTitleEl.textContent = '大会が見つかりません';
    bracketMetaEl.textContent = '';
    bracketOwnHintEl.hidden = true;
    bracketAdminToolsEl.hidden = true;
    bracketContainer.innerHTML = '<p class="empty-hint">この大会は存在しないか、削除されています。</p>';
    resultSectionEl.innerHTML = '';
    bracketBackLink.href = '#tournaments';
    bracketBackLink.textContent = '← 大会一覧へ';
    return;
  }

  bracketTitleEl.textContent = tournament.name;
  bracketMetaEl.textContent = `${tournament.date || '日付未設定'} ・ ${entrantCountLabel(tournament)}参加 ・ ${tournamentStatusLabel(tournament)}`;

  // 出場者の行とこの大会の試合結果を揃えてから描く。表の名前を引くのに出場者が、
  // 勝敗の保存（syncTournamentProgress の差分照合）に試合結果が要る。
  try {
    await Promise.all([
      db.ensureTournamentDetail(tournamentId),
      db.ensureTournamentMatches(tournamentId),
    ]);
  } catch (err) {
    bracketContainer.innerHTML = `<p class="empty-hint">${escapeHtml(err.message)}</p>`;
    return;
  }
  if (!isCurrentRoute('bracket', tournamentId)) return;

  // 出場している選手にだけ、対戦表の使い方を1行で示す。
  // 自分の対戦を開く入口は画面下端の「あなたの対戦」（js/bracketView.js）に集約した。
  // ここでは、対戦表の中の選手名がプロフィールへ行くことだけを伝えておく。
  const isParticipant = Boolean(auth.player)
    && tournament.participantIds.includes(auth.player.id)
    && tournament.status !== 'finished';
  bracketOwnHintEl.hidden = !isParticipant || isAdmin();
  if (!bracketOwnHintEl.hidden) {
    bracketOwnHintEl.textContent = '色の付いた行が自分の対戦です。画面下の「あなたの対戦」から、ルームコードの確認・対戦相手とのチャット・ゲームカウントの報告ができます。選手名を押すと、その選手のプロフィールが見られます。';
  }

  // 戻り先は大会詳細。ここへは詳細から来るため。
  bracketBackLink.href = `#tournament/${encodeURIComponent(tournamentId)}`;
  bracketBackLink.textContent = '← 大会の詳細へ';

  if (!state.brackets[tournamentId] && state.bracketIds.has(tournamentId)) {
    bracketContainer.innerHTML = '<p class="empty-hint">対戦表を読み込んでいます…</p>';
    resultSectionEl.innerHTML = '';
    try {
      await db.loadBracket(tournamentId);
    } catch (err) {
      bracketContainer.innerHTML = `<p class="empty-hint">${escapeHtml(err.message)}</p>`;
      return;
    }
    // 読み込んでいる間に別のページへ移っていたら、そこへ古い表を描かない
    if (!isCurrentRoute('bracket', tournamentId)) return;
  }

  renderBracketAdminTools(tournamentId);
  const swapping = bracketSwap?.tournamentId === tournamentId;

  // bracketView は state を書き換えてから onChanged を呼ぶ。ここでDBへ反映する。
  renderBracket(tournamentId, bracketContainer, async () => {
    renderBracketPage(tournamentId);
    await persist(async () => {
      await db.syncTournamentProgress(tournamentId);

      // 確定済みの大会で結果を編集し直したら、確定を解いて進行中に戻す。
      // 逆方向（進行中→終了）は運営が明示的に確定させる（自動では上げない）。
      if (tournament.status === 'finished' && !allMatchesDecided(state.brackets[tournamentId])) {
        await db.clearEntryPlacements(tournamentId);
        await db.setTournamentStatus(tournamentId, 'running');
        delete state.placements[tournamentId];
        delete state.teamChampions[tournamentId];
        tournament.status = 'running';
        await renderBracketPage(tournamentId);
      }
    }, '試合結果の保存');
  }, {
    readOnly: !isAdmin(),
    // 選手がゲームカウントを報告・承認したあと。DBの関数側で書き込みが済んでいるので、
    // ここは取り直して描き直すだけでよい（onChanged と違い、書き戻しはしない）。
    onRefresh: async () => { await refreshFromDb(); },
    // 組み合わせの調整中だけ、選手の行を「選ぶ」対象にする
    swap: swapping
      ? {
        selected: bracketSwap.selected,
        onPick: (entrantId) => onBracketSwapPick(tournamentId, entrantId),
      }
      : null,
  });

  renderResultSection(tournament);
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
          // 順位を先に書いてから確定する。順に失敗しても「終了と表示されているのに
          // 順位が無い」状態にはならない（逆順だとそうなる）。
          const placements = finalPlacements(state.brackets[tournament.id]);
          await db.saveEntryPlacements(tournament.id, placements);
          await db.setTournamentStatus(tournament.id, 'finished');

          // state.placements は選手ID単位。チーム戦ではチームの成績を
          // メンバー全員に配る（DBへ書き込む saveEntryPlacements と同じ扱い）。
          state.placements[tournament.id] = Object.fromEntries(
            placements.flatMap((p) => getEntrantMemberIds(tournament.id, p.entrantId)
              .map((playerId) => [playerId, p.depth])),
          );
          // 優勝チーム名の表示（championLabel）はチーム行の placement を見るので、
          // 再読み込みを待たずにここでも反映しておく。
          if (isTeamTournament(tournament)) {
            const depthByTeam = new Map(placements.map((p) => [p.entrantId, p.depth]));
            tournament.teams.forEach((tm) => { tm.placement = depthByTeam.get(tm.id) ?? null; });
          }
          tournament.status = 'finished';
        }, '結果の確定');
        if (ok) await renderBracketPage(tournament.id);
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

  // チーム戦はチーム名を主に、メンバー全員へのリンクを添える
  // （優勝者が2人いるので、1人を代表として出すわけにいかない）。
  const team = isTeamTournament(tournament);

  const rows = standings.map((s) => {
    const memberIds = getEntrantMemberIds(tournament.id, s.entrantId);
    const isOwn = Boolean(auth.player) && memberIds.includes(auth.player.id);
    const rowClass = `${s.rank <= 3 ? `rank-${s.rank}` : ''}${isOwn ? ' own-row' : ''}`;

    const memberLinks = memberIds.map((id) => {
      const player = state.players.find((p) => p.id === id);
      const name = player ? player.currentName : id;
      return `
        <div class="player-identity">
          ${avatarHtml(player ?? { currentName: name }, 'sm')}
          <a href="#player/${encodeURIComponent(id)}">${escapeHtml(name)}</a>
        </div>
      `;
    }).join('');

    const cell = team
      ? `<div class="standings-team">
           <span class="standings-team-name">${escapeHtml(getEntrantName(tournament.id, s.entrantId) ?? '')}</span>
           <div class="standings-team-members">${memberLinks}</div>
         </div>`
      : memberLinks;

    return `
      <tr class="${rowClass}">
        <td class="rank-cell">${s.rank}</td>
        <td>${cell}</td>
      </tr>
    `;
  }).join('');

  const wrap = document.createElement('div');
  wrap.className = 'table-scroll';
  wrap.innerHTML = `
    <table class="standings-table">
      <thead><tr><th>順位</th><th>${team ? 'チーム' : '選手'}</th></tr></thead>
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
        // 先に進行中へ戻す。順位だけ残っても表示には出ない（確定済みの大会しか見ない）ので、
        // 途中で失敗したときに結果が公開されたままになることはない。
        await db.setTournamentStatus(tournament.id, 'running');
        await db.clearEntryPlacements(tournament.id);
        delete state.placements[tournament.id];
        delete state.teamChampions[tournament.id];
        tournament.teams.forEach((tm) => { tm.placement = null; });
        tournament.status = 'running';
      }, '確定の取り消し');
      if (ok) await renderBracketPage(tournament.id);
      else undo.disabled = false;
    });
    resultSectionEl.appendChild(undo);
  }
}

// ---- ランキング ----

function formatDateTime(iso) {
  const d = new Date(iso);
  return `${d.toLocaleDateString('ja-JP')} ${d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;
}

function formatJaDate(date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

// 'YYYY-MM-DD' をそのまま「〇年〇月〇日」にする。new Date(文字列) を経由すると
// タイムゾーンの解釈次第で日付がずれかねないので、文字列を直接分解する。
function formatJaDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${y}年${m}月${d}日`;
}

// カレンダーで選んだ開始日・終了日（'YYYY-MM-DD' または null）を
// 「〇年〇月〇日〜〇年〇月〇日」の形にする。片方だけ省略した場合はその側を開けたまま表示し、
// 両方省略なら「全期間」と表示する。
function periodRangeLabel(start, end) {
  if (!start && !end) return '全期間';
  return `${start ? formatJaDateStr(start) : ''}〜${end ? formatJaDateStr(end) : ''}`;
}

// 移行前の「直近Nか月」形式で公開された古いデータだけに使う表示。
// periodMonths か月分をさかのぼった開始日と、基準日（endDate）を範囲表示にする。
function legacyMonthsRangeLabel(periodMonths, endDate) {
  if (periodMonths == null) return '全期間';
  const start = new Date(endDate);
  start.setMonth(start.getMonth() - Number(periodMonths));
  return `${formatJaDate(start)}〜${formatJaDate(endDate)}`;
}

function publishedStatusLine() {
  const published = state.publishedRanking;
  const periodLabel = published
    ? (published.periodStart || published.periodEnd
      ? periodRangeLabel(published.periodStart, published.periodEnd)
      : legacyMonthsRangeLabel(published.periodMonths ?? null, new Date(published.publishedAt)))
    : '';

  if (isAdmin()) {
    if (!published) return '未公開';
    return `公開中: ${periodLabel}（${formatDateTime(published.publishedAt)} 公開）`;
  }
  return published ? `集計期間: ${periodLabel}` : '';
}

// 日付入力欄から、現在選ばれている範囲を取り出す（空欄は無制限を表す null）。
function selectedRankingRange() {
  return { start: rankingStartInput.value || null, end: rankingEndInput.value || null };
}

// ランキングの集計欄を開いているか。開いている間だけ、運営には公開中のものではなく
// 集計中のプレビューを見せる。普段は運営も閲覧者と同じ「公開中のランキング」を見る。
let rankingEditorOpen = false;

// ランキングの集計には全期間の試合結果が要る。普段は持っていないので、
// 運営がこの欄を開いたときに初めて全データを読み込む。
async function openRankingEditor() {
  rankingCreateBtn.disabled = true;
  setStatus('集計データを読み込んでいます...', 'loading');
  try {
    await db.ensureFullData();
  } catch (err) {
    setStatus(err.message, 'error');
    rankingCreateBtn.disabled = false;
    return;
  }
  setStatus('');
  rankingCreateBtn.disabled = false;

  rankingEditorOpen = true;
  rankingEditorEl.hidden = false;
  rankingEditorNoteEl.hidden = false;
  rankingCreateBtn.hidden = true;
  renderRankingPage();
}

function closeRankingEditor() {
  rankingEditorOpen = false;
  rankingEditorEl.hidden = true;
  rankingEditorNoteEl.hidden = true;
  rankingCreateBtn.hidden = !isAdmin();
  renderRankingPage();
}

// 集計欄を開いている運営には選択中の期間のライブプレビューを、
// それ以外には公開済みスナップショットを見せる。
function renderRankingPage() {
  rankingPublishedStatusEl.textContent = publishedStatusLine();

  if (isAdmin() && rankingEditorOpen) {
    const { rankings: preview } = computeRankingsForRange(state, selectedRankingRange());
    const previewWithChange = withRankChange(preview, state.publishedRanking?.rankings);
    renderRankingTable(
      rankingContainer,
      previewWithChange,
      'この期間にランキング反映対象の大会の試合がないため、ランキングを計算できません。',
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

// 出場した大会は最初この件数だけ見せ、残りは「もっと見る」で開く。
// 出場数が多い選手でもページが縦に伸びきらないようにするため。
const VISIBLE_TOURNAMENTS = 3;

// 「もっと見る」で開いたかどうかを覚えておく（対象の選手ID）。
// 背景の自動更新でも renderPlayerDetail は走るので、覚えておかないと
// 読んでいる最中に勝手に畳まれてしまう。
let expandedTournamentsFor = null;

// 選手カード。選手ページとマイページの上部で、同じ形を使う
// （マイページは「他の人からどう見えるか」の確認場所なので、違う見た目では意味がない）。
//
//   ┌───────────────────────┬──────────────────┐
//   │ アイコン    キャラクター  │ 名前             │
//   │                        │ ID・SNS          │
//   │                        │ 戦歴（ランク等）   │
//   └───────────────────────┴──────────────────┘
//
// 【なぜ絵と文字を左右に分けるか】以前は名前も項目もキャラクターの絵の上に
// 重ねていた。スマートフォンでは絵と表示名がちょうど同じ場所に来てしまい、
// 名前が読み取れなくなる。面を分ければ、どの幅でも文字が絵に乗らない。
// 狭い画面では左右ではなく上下に積む（絵の面が上、文字が下）。
//
// キャラクターは先頭の1人だけ。順番には意味があり（js/characterPicker.js）、
// 先頭が本人の名乗りだからで、複数枚を並べると誰の場所か分からなくなる。
// 登録していない人には何も出さない ── 代わりの絵を置くと、選んでいない人まで
// 選んだように見えてしまう。絵は装飾なので読み上げから外す。
function playerHeroHtml(player, { nameTag = 'h2', action = '', meta = '', stats = '' } = {}) {
  const artUrl = characterImageUrl(player.mainCharacters?.[0], 'large');
  const art = artUrl
    ? `<span class="player-hero-char" aria-hidden="true">`
      + `<img src="${escapeHtml(artUrl)}" alt="" decoding="async"></span>`
    : '';

  return `
    <div class="player-hero${art ? '' : ' has-no-char'}">
      <div class="player-hero-visual">
        ${avatarHtml(player, 'hero')}
        ${art}
      </div>
      <div class="player-hero-body">
        <${nameTag} class="player-hero-name">${escapeHtml(player.currentName)}${action}</${nameTag}>
        ${player.pastNames.length
          ? `<p class="meta-line">過去名: ${escapeHtml(player.pastNames.slice(-2).join(', '))}</p>`
          : ''}
        ${meta}
        ${stats}
      </div>
    </div>`;
}

// 戦績はこの選手のぶんだけ取りに行く（全選手の試合は手元に持っていない。
// js/db.js の loadPlayerRecord を参照）。
async function renderPlayerDetail(playerId) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) {
    playerDetailEl.innerHTML = '<p class="empty-hint">選手が見つかりません。</p>';
    return;
  }

  let record;
  try {
    record = await db.loadPlayerRecord(playerId);
  } catch (err) {
    playerDetailEl.innerHTML = `<p class="empty-hint">${escapeHtml(err.message)}</p>`;
    return;
  }
  if (!isCurrentRoute('player', playerId)) return;

  const stats = getPlayerStats(playerId, record);
  const rankEntry = state.publishedRanking?.rankings.find((r) => r.id === playerId);
  const rankLabel = state.publishedRanking ? (rankEntry ? `${rankEntry.rank}位` : '対象外') : '未公開';
  const rankChangeHtml = rankEntry && rankEntry.previousRank !== undefined
    ? (() => {
        const { label, className } = rankChangeInfo(rankEntry.previousRank, rankEntry.rank);
        return ` <span class="rank-change ${className}">${label}</span>`;
      })()
    : '';
  const isOwn = auth.player?.id === playerId;

  let html = playerHeroHtml(player, {
    action: isOwn
      ? `<a href="#profile" class="profile-edit-link" title="プロフィールを編集する" aria-label="プロフィールを編集する">${iconSvg('pencil')}</a>`
      : '',
    meta: profileMetaHtml(player)
      + (!isOwn && isAdmin()
        ? '<p class="meta-line"><button type="button" class="btn-secondary admin-rename-btn">表示名を変更</button></p>'
        : ''),
    stats: `
      <div class="stat-cards">
        <div class="stat-card"><span class="stat-value">${rankLabel}${rankChangeHtml}</span><span class="stat-label">現在ランク${rankEntry ? `（スコア ${rankEntry.score.toFixed(1)}）` : ''}</span></div>
        <div class="stat-card"><span class="stat-value">${stats.tournaments.length}</span><span class="stat-label">出場大会数</span></div>
      </div>`,
  }) + profileBioHtml(player);

  // 出場した大会と、その大会での順位だけを並べる。
  // 勝敗数・勝率・対戦ごとの記録は出さない（プロフィールは戦績表ではなく
  // 「どの大会に出て、どこまで勝ち上がったか」を見る場所という位置づけ）。
  if (stats.tournaments.length > 0) {
    const entries = [...stats.tournaments].reverse();
    const expanded = expandedTournamentsFor === playerId;
    const hiddenCount = expanded ? 0 : Math.max(0, entries.length - VISIBLE_TOURNAMENTS);

    html += `
      <h3>出場した大会</h3>
      <div class="table-scroll">
        <table>
          <thead><tr><th>大会</th><th>日付</th><th>結果</th></tr></thead>
          <tbody>
            ${entries.map((entry, i) => `
              <tr${!expanded && i >= VISIBLE_TOURNAMENTS ? ' class="extra-row" hidden' : ''}>
                <td>
                  <a href="#tournament/${encodeURIComponent(entry.tournament.id)}">${escapeHtml(entry.tournament.name)}</a>
                  ${entry.teamName ? `<div class="meta-line">${escapeHtml(entry.teamName)}</div>` : ''}
                </td>
                <td>${escapeHtml(entry.tournament.date || '—')}</td>
                <td>${escapeHtml(entry.placement || '—')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      ${hiddenCount > 0
        ? `<button type="button" class="btn-secondary show-more-btn">もっと見る（残り${hiddenCount}件）</button>`
        : ''}
    `;
  } else {
    html += '<p class="empty-hint">まだ大会に出場していません。</p>';
  }

  playerDetailEl.innerHTML = html;

  // 「もっと見る」。開いたことを覚えてから残りの行を出す
  // （覚えないと、次の自動更新で描き直されたときに畳まれてしまう）。
  const showMoreBtn = playerDetailEl.querySelector('.show-more-btn');
  if (showMoreBtn) {
    showMoreBtn.addEventListener('click', () => {
      expandedTournamentsFor = playerId;
      playerDetailEl.querySelectorAll('.extra-row').forEach((row) => { row.hidden = false; });
      showMoreBtn.remove();
    });
  }

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
// 読み込み中に届いた更新の持ち越し。取り直す部位のSet（null = 持ち越し無し）。
// 「全部」も専用の印ではなく全部位を入れたSetで表すので、あとから部位を足すだけで済む。
let queuedParts = null;

// 持ち越しに部位を足す。parts が null（＝全部取り直す指示）なら全部位を入れる。
function mergeParts(held, parts) {
  const add = parts ?? db.ALL_PARTS;
  if (!held) return new Set(add);
  add.forEach((p) => held.add(p));
  return held;
}

// 保険の全件取得をどれくらいの間隔で行うか。
// 判定は「前回DBから読んでからの経過時間」で見るので、Realtimeでの更新や
// 保存操作で読み直した直後は、その分だけ次の照合が先送りされる。
const POLL_TICK_MS = 60 * 1000;              // 判定そのものは1分ごと
const POLL_CONNECTED_MS = 15 * 60 * 1000;    // 届いている間は15分に1回だけ照合
const POLL_DISCONNECTED_MS = 60 * 1000;      // 届いていないときは1分ごとに取りに行く
const REPORT_POLL_MS = 60 * 1000;            // 運営への報告だけは常に1分ごとに見る

let lastLoadedAt = 0;

// parts は取り直す state の部位（db.ALL_PARTS の要素）。省略すると全部位を取り直す。
// Realtimeからの呼び出しだけが部位を絞り、保存操作のあとの読み直しは全部位のまま
// （書き込みが何に波及したかを呼び出し側が知っている必要が無いようにする）。
async function refreshFromDb({ silent = false, parts = null } = {}) {
  // 読み込み中に更新通知が来たら、取りこぼさないよう終わってからもう一度読む
  if (loadInFlight) {
    queuedParts = mergeParts(queuedParts, parts);
    return;
  }
  loadInFlight = true;
  try {
    await db.loadAll(parts);
    // 保険の照合を先送りしてよいのは、全部位を取り直したときだけ。
    // 一部だけ取り直したのを「最新になった」と数えると、取り直していない部位が
    // 15分ぶん古いまま据え置かれてしまう。
    // 持ち越しが積み重なって結果的に全部位になった場合も、全件取得と同じに数える。
    if (!parts || db.ALL_PARTS.every((p) => parts.includes(p))) lastLoadedAt = Date.now();
    routeFromHash();
    // 開きっぱなしのチャットは画面の外にあるので、routeFromHash では更新されない。
    // 相手の報告や回戦の開始に追従させる。
    syncOpenChat();
    if (!silent) setStatus('');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    loadInFlight = false;
    if (queuedParts) {
      const next = [...queuedParts];
      queuedParts = null;
      await refreshFromDb({ silent: true, parts: next });
    }
  }
}

// フォーム入力中は再描画で入力内容が消えるため、更新の反映を見送る。
function isUserTyping() {
  const el = document.activeElement;
  if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
    // 対戦チャットのメッセージ入力・報告文・ルームコードは例外。ダイアログは
    // routeFromHash の再描画対象外で、syncOpenChat もこれらには触らない
    // （ルームコードは書きかけの間だけ描き直しを見送る）ので、入力が消えることはない。
    // ここで真を返すと、チャットで会話している間じゅう更新が届かなくなってしまう
    // （送信のたびにフォーカスが入力欄へ戻るため、開いている間はほぼ常に入力中になる）。
    const exempt = el.id === 'match-chat-input'
      || el.id === 'match-chat-report-input'
      || el.id === 'match-chat-room-input';
    if (!exempt) return true;
  }
  return [...document.querySelectorAll('.score-num-input')].some((i) => i.value !== '');
}

// 入力中に届いた更新通知の持ち越し。捨ててしまうと、次の保険の全件取得
// （Realtime接続中は15分に1回）まで画面が古いまま残る。相手のゲームカウント報告が
// 「リロードしないと出ない」ように見えていたのはこれが原因。
//
// 取り直す部位のSet（null = 持ち越し無し）。入力しているあいだに複数の通知が
// 届いたら部位を足していき、手が空いたところで1回にまとめて取りに行く。
let heldParts = null;

function holdRefresh(parts) {
  heldParts = mergeParts(heldParts, parts);
}

function flushHeldRefresh() {
  if (!heldParts || document.hidden || isUserTyping()) return;
  const parts = [...heldParts];
  heldParts = null;
  refreshFromDb({ silent: true, parts });
}

// 入力欄からフォーカスが外れた直後に反映する。focusout の時点では次のフォーカス先が
// まだ定まっていない（activeElement が body になっている）ので、一拍置いてから判定する。
document.addEventListener('focusout', () => setTimeout(flushHeldRefresh, 100));

// スコア入力欄は、空にするか送信するまで isUserTyping が真のままなので、
// focusout だけでは拾えない。保険として数秒ごとにも見る（フラグ確認だけなので軽い）。
setInterval(flushHeldRefresh, 5000);

// ---- イベント配線 ----

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

rankingCreateBtn.addEventListener('click', openRankingEditor);
rankingCancelBtn.addEventListener('click', closeRankingEditor);

rankingStartInput.addEventListener('change', () => {
  if (isAdmin()) renderRankingPage();
});
rankingEndInput.addEventListener('change', () => {
  if (isAdmin()) renderRankingPage();
});

rankingPublishBtn.addEventListener('click', async () => {
  const range = selectedRankingRange();
  if (range.start && range.end && range.start > range.end) {
    alert('開始日が終了日より後になっています。');
    return;
  }
  const { periodStart, periodEnd, rankings } = computeRankingsForRange(state, range);

  if (rankings.length === 0) {
    alert('この期間に確定した試合がまだないため、公開できません。');
    return;
  }
  if (!confirm(`${periodRangeLabel(periodStart, periodEnd)}のランキングを公開します。閲覧者に反映されます。よろしいですか？`)) return;

  // 前回公開時点の順位を各エントリに焼き込み、公開後もずっと「前回との差」が分かるようにする
  const snapshot = {
    publishedAt: new Date().toISOString(),
    periodStart,
    periodEnd,
    rankings: withRankChange(rankings, state.publishedRanking?.rankings),
  };

  rankingPublishBtn.disabled = true;
  const ok = await persist(() => db.publishRanking(snapshot), 'ランキングの公開');
  rankingPublishBtn.disabled = false;
  if (!ok) return;

  state.publishedRanking = snapshot;

  // 公開したら作業は終わりなので集計欄を畳む。閲覧者と同じ「公開中のランキング」
  // （＝いま公開したスナップショット。正しい前回比バッジ入り）の表示に戻る。
  // プレビューのまま残すと、前回比が自分自身との比較になって全て「変動なし」に潰れる。
  closeRankingEditor();
});

// 「その他」を選んだときだけ説明欄を出す。他の選択肢では書いても表示に使われない。
function bindMatchTypeNoteToggle(select, field) {
  const sync = () => { field.hidden = select.value !== 'other'; };
  select.addEventListener('change', sync);
  return sync;
}
const syncMatchTypeNote = bindMatchTypeNoteToggle(
  tournamentMatchTypeInput, tournamentMatchTypeNoteField,
);
const syncEditMatchTypeNote = bindMatchTypeNoteToggle(
  tournamentEditMatchTypeInput, tournamentEditMatchTypeNoteField,
);

// 2v2は「運営が参加者を直接選ぶ」経路を使えない。この画面には選手を並べる欄しかなく、
// チーム名と組み合わせを決められないため。選べたまま送信させてエラーを出すより、
// 選択肢そのものを閉じておく。
function syncEntryModeForMatchType() {
  const isTeam = tournamentMatchTypeInput.value === '2v2';
  const modes = [...tournamentForm.elements['entry-mode']];
  const manualRadio = modes.find((r) => r.value === 'manual');

  manualRadio.disabled = isTeam;
  if (isTeam && manualRadio.checked) {
    modes.find((r) => r.value === 'recruit').checked = true;
    manualParticipantsEl.hidden = true;
    tournamentSubmitBtn.textContent = '大会を作成';
  }
}
tournamentMatchTypeInput.addEventListener('change', syncEntryModeForMatchType);

// 大会作成は項目が多く、途中で他のアプリへ移ることもある。書きかけを控えておく。
// 選んだ参加者（selectedParticipantIds）は入力欄ではないので控えの対象外。
const TOURNAMENT_DRAFT_KEY = 'tournament-create';
keepFormDraft(tournamentForm, TOURNAMENT_DRAFT_KEY);

tournamentForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const name = tournamentNameInput.value.trim();
  if (!name) {
    alert('大会名を入力してください。');
    return;
  }

  const matchType = tournamentMatchTypeInput.value;
  if (!matchType) {
    alert('対戦方法を選んでください。');
    return;
  }

  const manual = tournamentForm.elements['entry-mode'].value === 'manual';
  if (manual && matchType === '2v2') {
    alert('2v2はチーム編成が必要なため、「エントリーを募集する」で作成してください。');
    return;
  }
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

  const streamUrl = readStreamUrl(tournamentStreamInput);
  if (streamUrl === INVALID_URL) return;

  const tournament = {
    id: newId(),
    name,
    date: tournamentDateInput.value || null,
    format: 'single_elim',
    matchType,
    matchTypeNote: matchType === 'other' ? tournamentMatchTypeNoteInput.value.trim() : '',
    rules: tournamentRulesInput.value.trim() || null,
    streamUrl,
    imageUrl: '',
    // 三位決定戦。実際に置くかどうかはブラケット生成時に出場枠の数で決まる
    // （4枠未満だと準決勝の敗者がそろわない。js/bracket.js の canHoldThirdPlaceMatch）。
    thirdPlaceMatch: tournamentThirdPlaceInput.checked,
    weight: null,
    // 定員はエントリー募集を制御するためのもの。運営が参加者を直接選ぶ場合は
    // 意味を持たないうえ、選んだ人数が定員を超えると自分で自分を弾いてしまう。
    capacity: manual ? null : capacity,
    status: manual ? 'running' : 'recruiting',
    createdBy: auth.player?.id ?? null,
    // この経路は個人戦専用（2v2は上で弾いている）なので、出場枠＝選手で同じ配列になる
    entrantIds: manual ? [...selectedParticipantIds] : [],
    participantIds: manual ? [...selectedParticipantIds] : [],
    teams: [],
    entrantCount: manual ? selectedParticipantIds.length : 0,
    participantCount: manual ? selectedParticipantIds.length : 0,
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
      await db.replaceEntries(tournament.id, tournament.entrantIds);
      const bracket = createBracket(tournament.id, tournament.entrantIds, {
        thirdPlace: tournament.thirdPlaceMatch,
      });
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
  tournamentMatchTypeInput.value = '';
  tournamentMatchTypeNoteInput.value = '';
  syncMatchTypeNote();
  syncEntryModeForMatchType();
  tournamentCapacityInput.value = '';
  tournamentRulesInput.value = '';
  tournamentStreamInput.value = '';
  tournamentThirdPlaceInput.checked = false;
  tournamentImagePicker.setCurrent('');
  selectedParticipantIds = [];
  // 作れたので下書きは用済み（残すと次に大会を作るとき前回の内容が入ってくる）
  clearFormDraft(TOURNAMENT_DRAFT_KEY);

  await refreshFromDb();
  location.hash = manual ? `#tournament/${encodeURIComponent(tournament.id)}` : '#tournaments/recruiting';
});

tournamentEditBtn.addEventListener('click', () => {
  const tournament = state.tournaments.find((t) => t.id === currentBracketTournamentId);
  if (!tournament) return;
  tournamentEditNameInput.value = tournament.name;
  tournamentEditDateInput.value = tournament.date || '';
  tournamentEditMatchTypeInput.value = tournament.matchType || '';
  tournamentEditMatchTypeNoteInput.value = tournament.matchTypeNote || '';
  syncEditMatchTypeNote();
  tournamentEditCapacityInput.value = tournament.capacity ?? '';
  tournamentEditRulesInput.value = tournament.rules || '';
  tournamentEditStreamInput.value = tournament.streamUrl || '';
  tournamentEditImagePicker.setCurrent(tournament.imageUrl || '');
  // 保存済みの内容を入れ終えてから下書きを重ねる（書きかけがあればそちらが勝つ）
  keepFormDraft(tournamentEditForm, `tournament-edit-${tournament.id}`);
  tournamentEditForm.hidden = !tournamentEditForm.hidden;
});

tournamentEditCancelBtn.addEventListener('click', () => {
  // 「キャンセル」は書きかけを捨てる操作なので、控えも一緒に捨てる
  clearFormDraft(`tournament-edit-${currentBracketTournamentId}`);
  tournamentEditForm.hidden = true;
});

tournamentEditForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (!tournamentEditMatchTypeInput.value) {
    alert('対戦方法を選んでください。');
    return;
  }

  const streamUrl = readStreamUrl(tournamentEditStreamInput);
  if (streamUrl === INVALID_URL) return;

  const capacityRaw = tournamentEditCapacityInput.value.trim();
  const result = updateTournament(currentBracketTournamentId, {
    name: tournamentEditNameInput.value,
    date: tournamentEditDateInput.value,
    matchType: tournamentEditMatchTypeInput.value,
    matchTypeNote: tournamentEditMatchTypeNoteInput.value,
    rules: tournamentEditRulesInput.value,
    streamUrl,
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
  if (ok) {
    clearFormDraft(`tournament-edit-${currentBracketTournamentId}`);
    tournamentEditForm.hidden = true;
  }
  renderTournamentDetail(currentBracketTournamentId);
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
  location.hash = '#tournaments';
});

// 「はじめに」の目次。ページ内の移動なので、ハッシュは変えずにスクロールで運ぶ。
// （ハッシュはページの切り替えに使っているため、#見出しID を入れると
//   routeFromHash が知らないページとして扱い、ホームへ戻してしまう）
//
// 目次そのものは pages/guide.html の中にあり、この時点ではまだ存在しない。
// そこで、常にある入れ物（view-guide）で受けて、中の目次リンクを拾う。
$('view-guide').addEventListener('click', (e) => {
  const link = e.target.closest('[data-guide-target]');
  if (!link) return;
  e.preventDefault();

  // 動きを減らす設定のときは滑らせない（CSSの prefers-reduced-motion は
  // JSのスクロールまでは止められないので、ここで見て切り替える）
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // 見出しには scroll-margin-top を入れてあるので、固定ヘッダーの下に隠れない
  $(link.dataset.guideTarget)?.scrollIntoView({
    behavior: reduce ? 'auto' : 'smooth',
    block: 'start',
  });
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
//
// ログイン手段はGoogleとDiscordのみ。どちらもアカウント側でメール確認や
// パスワード再設定が済んでいるので、こちらで登録フォームを持つ必要がない。

function openLoginDialog() {
  loginErrorEl.textContent = '';
  loginDialog.showModal();
  loginDialog.scrollTop = 0;
}

loginBtn.addEventListener('click', openLoginDialog);
loginCancelBtn.addEventListener('click', () => loginDialog.close());

// 募集ページの「ログインしてエントリー」など、他モジュールからの要求
document.addEventListener('request-login', openLoginDialog);

// エントリー状況ページのログイン導線。ページ遷移せずダイアログだけ開く
entriesLoginBtn.addEventListener('click', openLoginDialog);

// マイページからのログイン。ダイアログを介さず、その場で認可画面へ送る。
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

logoutBtn.addEventListener('click', async () => {
  // 押し間違いでログアウトすると入り直す手間がかかるので一度確認する
  if (!confirm('ログアウトしますか？')) return;

  logoutBtn.disabled = true;
  try {
    await signOut();
    location.hash = '#home';
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    logoutBtn.disabled = false;
  }
});

// ---- 上へ戻る ----
//
// 「はじめに」や規約、参加者の多い対戦表は画面何枚ぶんもある。下まで読んだあとに
// 指でスクロールして戻るのは骨が折れるので、下へ行ったときだけ右下に出す。

const scrollTopBtn = $('scroll-top-btn');
setButtonIcon(scrollTopBtn, 'arrowUp', 'ページの先頭へ戻る');

// この高さより下にいるときだけ出す。1画面ぶんに満たない移動で出てしまうと、
// 短いページでも現れたり消えたりして、かえって目障りになる。
const SCROLL_TOP_SHOW_AT = 600;

function syncScrollTopBtn() {
  scrollTopBtn.hidden = window.scrollY < SCROLL_TOP_SHOW_AT;
}

// スクロール中は毎フレーム飛んでくるので、描画1回ぶんにまとめてから見る。
// passive を付けて、この処理がスクロール自体を待たせないようにする。
let scrollTickQueued = false;
window.addEventListener('scroll', () => {
  if (scrollTickQueued) return;
  scrollTickQueued = true;
  requestAnimationFrame(() => {
    scrollTickQueued = false;
    syncScrollTopBtn();
  });
}, { passive: true });

scrollTopBtn.addEventListener('click', () => {
  // 動きを減らす設定のときは滑らせない（CSSの prefers-reduced-motion では
  // JSのスクロールまでは止められないので、ここで見て切り替える）
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
});

// ---- ホームのロゴ ----
//
// 画像は差し替える前提の1ファイル（img/game-logo.webp）なので、
// 「ファイルがまだ無い」「白背景の画像が来た」のどちらでも画面が崩れないようにする。

const heroGameEl = $('hero-game');
const heroGameLogoEl = $('hero-game-logo');

// 画像の四隅が明るいか。明るければ白背景の画像なので、黒い面から浮かないよう
// 白い台紙に載せる（透過画像ならそのまま黒地に置く）。
// 判定にはcanvasを使うが、失敗しても台紙を付けないだけで表示は続く。
function looksLightBackground(img) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);

    const w = canvas.width - 1;
    const h = canvas.height - 1;
    const corners = [[0, 0], [w, 0], [0, h], [w, h]];

    return corners.every(([x, y]) => {
      const [r, g, b, a] = ctx.getImageData(x, y, 1, 1).data;
      // 透明なら「白背景ではない」。不透明で明るければ白背景と見なす。
      if (a < 200) return false;
      return (r + g + b) / 3 > 200;
    });
  } catch (err) {
    // 別オリジンの画像などで画素を読めないことがある。台紙なしで続ける。
    return false;
  }
}

if (heroGameEl && heroGameLogoEl) {
  // 画像がまだ置かれていなければ、割れた画像を出さずにブロックごと引っ込める
  const hideBlock = () => { heroGameEl.hidden = true; };

  const applyPlate = () => {
    heroGameEl.classList.toggle('is-plated', looksLightBackground(heroGameLogoEl));
  };

  // このスクリプトはmodule（defer扱い）なので、走り出す頃には画像の読み込みが
  // 終わっていることがある。その場合イベントはもう飛んでこないので、
  // 先に complete を見て決める（naturalWidth が0なら読み込みに失敗している）。
  if (heroGameLogoEl.complete) {
    if (heroGameLogoEl.naturalWidth) applyPlate();
    else hideBlock();
  } else {
    heroGameLogoEl.addEventListener('load', applyPlate);
    heroGameLogoEl.addEventListener('error', hideBlock);
  }
}

// ---- 狭い画面のメニュー ----
//
// 開閉状態は routeFromHash では触らない。背景の自動更新でも routeFromHash は
// 走るため、そこで閉じると開いた直後に勝手に畳まれてしまう。
// 実際に画面が変わるとき（hashchange）と、リンクを押したときだけ閉じる。

// メニューは画面全体をふさぐ。開いているあいだは、その後ろにあるものを
// 「無いもの」として扱う必要がある。
//   * 後ろの本文がスクロールしてしまわないように、body のスクロールを止める
//   * 隠れているのに Tab で入れてしまわないように、main とフッターを inert にする
//     （ヘッダーはメニュー自身と閉じるボタンを持っているので対象外）
const mainEl = document.querySelector('main');
const siteFooterEl = document.querySelector('.site-footer');

function setNavOpen(open) {
  mainNav.classList.toggle('open', open);
  navToggle.setAttribute('aria-expanded', String(open));
  navToggle.setAttribute('aria-label', open ? 'メニューを閉じる' : 'メニューを開く');

  document.body.classList.toggle('nav-open', open);
  [mainEl, siteFooterEl].forEach((el) => { if (el) el.inert = open; });

  // 閉じるときにメニューの中にいたフォーカスは、開くのに使ったボタンへ戻す。
  // 戻さないと、キーボードだけで操作している人が画面の先頭に飛ばされる。
  if (!open && mainNav.contains(document.activeElement)) navToggle.focus();
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
  if (document.hidden) return;
  if (isUserTyping()) {
    holdRefresh(null);   // 何が進んでいるか分からないので全部位
    return;
  }
  refreshFromDb({ silent: true });
});

// チャットから報告が出された／対応済みになった。大会カードと対戦表の印を出し直す。
document.addEventListener('chat-reports-changed', () => routeFromHash());

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
  // 入力中は捨てずに持ち越し、手が空いた時点で flushHeldRefresh が反映する。
  //
  // parts には「変わったテーブルに対応する部位」だけが入る。進行中の大会では
  // 観戦者全員がこの通知を受けるので、ここで全テーブルを引くと人数分だけ通信が増える。
  db.subscribeToChanges((parts) => {
    if (isUserTyping()) {
      holdRefresh(parts);
      return;
    }
    refreshFromDb({ silent: true, parts });
  });

  // 保険の全件取得。WebSocketが切れたまま再接続できていない間も、進行中の大会が
  // 古いまま放置されないようにする。
  //
  // Realtimeが正常に届いている間は、これはほぼ毎回空振りする。それでも通信量は
  // 満額かかる（loadAllは常に全テーブルを全件取る）ので、届いているときは
  // 間隔を大きく空ける。完全に止めないのは、再接続の瞬間に起きた変更は
  // 通知が届かず取りこぼし得るため。長めでも照合が入れば必ず正しい状態に戻る。
  setInterval(() => {
    if (document.hidden || isUserTyping()) return;

    const needed = db.isRealtimeConnected() ? POLL_CONNECTED_MS : POLL_DISCONNECTED_MS;
    if (Date.now() - lastLoadedAt < needed) return;

    refreshFromDb({ silent: true });
  }, POLL_TICK_MS);

  // 報告だけは別に、短い間隔で見に行く。
  //
  // 上の保険は届いている間は15分に1回で、トラブルの報告が運営に伝わるには遅すぎる。
  // かといってチャットと同じ理由でRealtimeには載せられない。行数はごく少なく、
  // RLSで運営と本人以外には0件しか返らないので、この頻度でも軽い。
  let reportsRenderPending = false;
  setInterval(async () => {
    if (document.hidden || !auth.player) return;
    try {
      // 未対応の顔ぶれが変わったときだけ描き直す（毎分の再描画は入力を邪魔する）
      if (await db.refreshChatReports()) reportsRenderPending = true;
    } catch (err) {
      // 一時的な失敗は次の周期で取り直す。画面には出さない
      console.error('[app] 報告の取得に失敗', err);
    }

    // 入力中は描き直しを持ち越す。routeFromHash は編集中のフォームを閉じてしまうため。
    if (reportsRenderPending && !isUserTyping()) {
      reportsRenderPending = false;
      routeFromHash();
    }
  }, REPORT_POLL_MS);
}

start();

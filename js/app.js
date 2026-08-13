// 導入の演出を終わらせる係。exportを持たず、読み込むだけで働く。
// 一番上に置くのは、飛ばす操作（クリック・キー・スクロール）を受ける耳を
// できるだけ早く付けるため。演出そのものはCSSが動かしているので、
// これが遅れても絵は止まらない。
import './intro.js';
import {
  state, newId, getPlayerName, isTeamTournament, getEntrantName, getEntrantMemberIds,
  openChatReports, organizerIdsOf,
  isBannedPlayer, playerReportSummaries, hasOpenReportFrom, BAN_THRESHOLD,
  tournamentReportSummaries, hasOpenTournamentReportFrom,
  UNKNOWN_PLAYER_NAME,
} from './state.js';
import { renderPlayerTable, updatePlayer } from './players.js';
import {
  escapeHtml, avatarHtml, safeUrl, cardThumb, setupImagePicker, skeletonCards,
  createSearchRunner, tournamentWhenText, toDateTimeLocalValue, fromDateTimeLocalValue,
} from './util.js';
import {
  createBracket, updateTournament, allMatchesDecided, finalStandings, finalPlacements,
  swapBracketEntrants,
} from './bracket.js';
import { reportChipHtml, syncOpenChat } from './matchChat.js';
import { computeRankings, rankChangeInfo } from './ranking.js';
import { getPlayerStats, championLabel, placementLabelOf } from './playerStats.js';
import { tournamentTier } from './tournamentTier.js';
import { matchTypeLabel, rankingEligibility, RANKED_MIN_PARTICIPANTS } from './rankingEligibility.js';
import { renderProfileForm, profileMetaHtml, profileBioHtml, isProfileFormMounted } from './profile.js';
import { characterImageUrl } from './characters.js';
import { heroImageUrl } from './imageUrl.js';
import { keepFormDraft, clearFormDraft } from './formDraft.js';
import { mountOrganizerPicker } from './organizerPicker.js';
import {
  renderRecruitPage, renderTournamentActions, renderEntryCta, entryDeadlineText,
  draftNotice,
} from './entries.js';
import { STATUS_LABELS, entrantUnit, entryState } from './tournamentState.js';
import {
  auth, initAuth, isAdmin, isOwner, canManageTournament, isLoggedIn, needsOnboarding,
  accountLabel, signInWithProvider, signOut, reloadOwnPlayer,
} from './auth.js';
import { isConfigured } from './supabaseClient.js';
import { initStage, renderFeatured, renderStats, prefersReducedMotion } from './stage.js';
import { iconSvg, makeIconButton, setButtonIcon } from './icons.js';
import {
  TOURNAMENT_TABS, ROUTE_CHANGE_EVENT, VIEW_ID_OF, matchPath, pathFor, navigate,
  startRouter, migrateLegacyUrl,
} from './router.js';
import { applyPageMeta } from './seo.js';
import * as db from './db.js';

// ---- 開いた人だけが取りに行くモジュール ----
//
// 対戦表と順位発表は、どちらもサイトの中では大きい部類（生で 56KB と 48KB）で、
// しかも「その画面を開いた人」しか要らない。上の import に並べておくと、
// トップページを見にきただけの人の回線と、そのうえ解析にかかる時間まで
// 使ってしまう ── 開いたときに初めて取りに行けば、その分だけ最初の表示が早くなる。
//
// URLを '/js/…' と根から書いているのは、インポートマップの見出しと同じ形に
// するため（?v= の差し替えを効かせる。相対で書くと、深いURLで開いたときに
// /tournaments/{ID}/js/… を取りに行って404になる）。
//
// 一度読んだら覚えておく。2回目からは待ち時間なしで返る。
let bracketViewMod = null;
async function loadBracketView() {
  bracketViewMod ??= await import('/js/bracketView.js');
  return bracketViewMod;
}

let revealMod = null;
async function loadReveal() {
  revealMod ??= await import('/js/reveal.js');
  return revealMod;
}

// 大会作成画面でのシード順（index 0 = シード1位）。ブラケット生成前の一時的な状態。
let selectedParticipantIds = [];
let currentBracketTournamentId = null;

// 検索欄の状態。
//
// 【結果を覚えておく必要がある】以前は state.players を手元で絞っていたので、
// 描き直すたびに同じ結果を作り直せた。DBに問い合わせる形になったいまは、
// 描き直し（Realtimeの更新でも起きる）のたびに投げ直すわけにいかないので、
// 直前の結果をここに置いて、そこから描く。
//
// status: 'idle'（未入力） / 'loading' / 'done' / 'error'
const playerSearch = { query: '', players: [], status: 'idle', error: '', hasMore: false };
const participantSearch = { query: '', players: [], status: 'idle', error: '', hasMore: false };

// 「この大会の運営」欄の操作卓（js/organizerPicker.js）。作成用と編集用で別に持つ。
// 建て直すと選んだ顔ぶれが消えるので、画面を描き直すたびには作らない
// （この画面は Realtime の更新でも描き直される）。
let organizerPicker = null;
let editOrganizerPicker = null;

const $ = (id) => document.getElementById(id);

const playerListEl = $('player-list');
const playerSearchInput = $('player-search-input');

// 選手の通報（ダイアログ）と、届いた通報の一覧（運営専用）
const reportDialog = $('report-dialog');
const reportDialogTitleEl = $('report-dialog-title');
const reportTargetEl = $('report-target');
const reportForm = $('report-form');
const reportReasonInput = $('report-reason-input');
const reportBodyInput = $('report-body-input');
const reportFormErrorEl = $('report-form-error');
const reportSubmitBtn = $('report-submit-btn');
const reportCancelBtn = $('report-cancel-btn');
const reportReviewEl = $('report-review');

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
const tournamentDeadlineInput = $('tournament-deadline-input');
const tournamentRulesInput = $('tournament-rules-input');
const tournamentOrganizersEl = $('tournament-organizers');
const tournamentStreamInput = $('tournament-stream-input');
const tournamentSubmitBtn = $('tournament-submit-btn');
const tournamentMatchTypeInput = $('tournament-match-type-input');
const tournamentMatchTypeNoteField = $('tournament-match-type-note-field');
const tournamentMatchTypeNoteInput = $('tournament-match-type-note-input');
const tournamentRankingOptInInput = $('tournament-ranking-opt-in-input');
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
const tournamentReportBtn = $('tournament-report-btn');
// 編集・削除をしまってある歯車。3つで1組（外枠・押す場所・中身）
const tournamentManageEl = $('tournament-manage');
const tournamentManageBtn = $('tournament-manage-btn');
const tournamentManageList = $('tournament-manage-list');
const tournamentShareBtn = $('tournament-share-btn');
const tournamentEditForm = $('tournament-edit-form');
const tournamentDetailViewEl = $('view-tournament-detail');

// 大会情報の編集を開く・閉じる。
//
// フォームの hidden と、面ごと伏せる印（.is-editing）は必ず一緒に動かすこと。
// 片方だけ動かすと、編集フォームの下に保存前の古い表示が並ぶ ── どちらが本当の
// 値なのか読めなくなる。伏せ方は css/style.css のその節を参照。
function setTournamentEditing(on) {
  tournamentEditForm.hidden = !on;
  tournamentDetailViewEl.classList.toggle('is-editing', on);
}
const tournamentEditNameInput = $('tournament-edit-name-input');
const tournamentEditDateInput = $('tournament-edit-date-input');
const tournamentEditRulesInput = $('tournament-edit-rules-input');
const tournamentEditOrganizersEl = $('tournament-edit-organizers');
const tournamentEditStreamInput = $('tournament-edit-stream-input');
const tournamentEditCancelBtn = $('tournament-edit-cancel-btn');
const tournamentEditMatchTypeInput = $('tournament-edit-match-type-input');
const tournamentEditMatchTypeNoteField = $('tournament-edit-match-type-note-field');
const tournamentEditMatchTypeNoteInput = $('tournament-edit-match-type-note-input');
const tournamentEditRankingOptInInput = $('tournament-edit-ranking-opt-in-input');
const tournamentInfoEl = $('tournament-info');
const tournamentActionsEl = $('tournament-actions');
const tournamentDraftNoticeEl = $('tournament-draft-notice');
const tournamentEntryCtaEl = $('tournament-entry-cta');
const tournamentHeroEl = $('tournament-hero');
const tournamentTitleEl = $('tournament-title');
const tournamentStatusChipEl = $('tournament-status-chip');
const tournamentMetaEl = $('tournament-meta');
const tournamentBackLink = $('tournament-back-link');
const bracketLinkEl = $('bracket-link');
const bracketLinkNoteEl = $('bracket-link-note');
const entrantsLinkEl = $('entrants-link');
const entrantsLinkTitleEl = $('entrants-link-title');
const entrantsLinkNoteEl = $('entrants-link-note');
const entrantsTitleEl = $('entrants-title');
const entrantsMetaEl = $('entrants-meta');
const entrantsNoteEl = $('entrants-note');
const entrantsContainerEl = $('entrants-container');
const entrantsBackLink = $('entrants-back-link');
const resultSectionEl = $('result-section');
const bracketBackLink = $('bracket-back-link');
const tournamentEditCapacityInput = $('tournament-edit-capacity-input');
const tournamentEditDeadlineInput = $('tournament-edit-deadline-input');

const playerDetailEl = $('player-detail');
const playerBackBtn = $('player-back-btn');

const profileTitleEl = $('profile-title');
const profileNoteEl = $('profile-note');
const profileViewEl = $('profile-view');
const profileFormContainer = $('profile-form-container');
const profileLoginPanel = $('profile-login-panel');
const profileLoginErrorEl = $('profile-login-error');
const profileGoogleBtn = $('profile-google-btn');
const profileDiscordBtn = $('profile-discord-btn');
const profileAccountActions = $('profile-account-actions');
const profileAccountEmail = $('profile-account-email');

const rankingRevealBtn = $('ranking-reveal-btn');

const appStatusEl = $('app-status');
const syncBarEl = $('sync-bar');
const accountAvatarEl = $('account-avatar');
const loginBtn = $('login-btn');
const logoutBtn = $('logout-btn');
const navTournamentLink = $('nav-tournament-link');
const mainNav = $('main-nav');
const navToggle = $('nav-toggle');
const navCloseBtn = $('nav-close');

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
  const owner = isOwner();
  const loggedIn = isLoggedIn();
  // 大会は誰でも開ける。必要なのは選手登録だけ（作った人がその大会の運営になる）。
  // 利用停止中の人だけは作れない（DB側の tournaments_insert も同じ判定を持つ）。
  const canCreateTournament = Boolean(auth.player) && !isBannedPlayer(auth.player);
  // いま開いている大会を管理できるか。詳細ページを開いたままログイン状態が
  // 変わることがあるので、ここでも見ておく（描き直しは routeFromLocation 側）。
  const canManageCurrent = canManageTournament(currentBracketTournamentId);

  navTournamentLink.hidden = !canCreateTournament;
  announcementNewBtn.hidden = !admin;
  // ランキングの集計と順位発表は持ち主だけ。大会を開ける人が増えても、
  // 全大会を横断して順位を決める操作は1人に閉じておく。
  rankingRevealBtn.hidden = !owner;
  // 歯車の中身はログインの状態で変わる（運営なら編集・削除、それ以外は通報）。
  // 大会詳細を開いたままログイン・ログアウトされることがあるので、ここでも見る。
  syncTournamentManageMenu(currentBracketTournamentId, canManageCurrent);
  if (!canManageCurrent) setTournamentEditing(false);
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

// ページ名 → 画面の <section> のID は js/router.js が持っている。
// Worker（worker/index.js）も同じ表を見て、返すHTMLの時点で出す画面を決める。
const VIEW_IDS = VIEW_ID_OF;

// ナビのハイライト用：詳細ページは親メニューに対応付ける
const NAV_PAGE_OF = {
  tournament: 'tournaments', bracket: 'tournaments', entrants: 'tournaments',
  player: 'players', players: 'players', reveal: 'players', news: 'newslist',
};

// いま開いているURLが指すページ。
//
// 知らないURLはホームに倒す。ここへ来るのは、サーバー側で受け付けている形
// （worker/index.js が index.html を返す形）だけなので、実際に起きるのは
// 手でURLをいじった場合くらいになる。
function currentRoute() {
  const matched = matchPath(location.pathname);
  return {
    page: matched?.page ?? 'home',
    param: matched?.param ?? null,
    query: new URLSearchParams(location.search),
  };
}

// そのページの title・説明文・canonical・構造化データを出し直す（js/seo.js）。
//
// 文言の組み立ては seo.js が持っているので、ここでやるのは「どのデータを見せるか」
// を選ぶことだけ。描画と同じ経路で呼ぶため、背景の更新で大会名が変われば
// 検索結果に出る題も一緒に追いつく。
function applyRouteMeta(page, param) {
  // 一覧がまだ1件も届いていないあいだは「見つからない」と決めない。
  // 決めてしまうと、読み込み中のページに noindex が付いた瞬間ができる。
  const loaded = lastLoadedAt > 0;

  if (page === 'tournament' || page === 'bracket' || page === 'entrants') {
    const t = state.tournaments.find((x) => x.id === param) ?? null;
    applyPageMeta(page, {
      param,
      tournament: t,
      // 参加規模の数え方は対戦方法で変わる（2v2はチーム数）ので、
      // 数え方を知っているこちらで文字にしてから渡す。
      entrantsText: t ? entrantCountLabel(t) : '',
      notFound: loaded && !t,
    });
    return;
  }

  if (page === 'player') {
    const p = state.players.find((x) => x.id === param) ?? null;
    const entry = p ? state.publishedRanking?.rankings.find((r) => r.id === p.id) : null;
    applyPageMeta(page, {
      param,
      player: p,
      rankText: entry ? `公開ランキング${entry.rank}位` : '',
      notFound: loaded && !p,
    });
    return;
  }

  if (page === 'news') {
    // お知らせは最新数件しか手元に無いことがある。全件を取りに行くのは
    // renderNewsPage の仕事で、取り終えたらあちらがここを呼び直す。
    const a = state.announcements.find((x) => x.id === param) ?? null;
    applyPageMeta(page, { param, announcement: a, notFound: loaded && !a && db.hasAllAnnouncements() });
    return;
  }

  applyPageMeta(page, { param });
}

// いま表示しているのがこのページか。データを取りに行っている間に別の画面へ
// 移ることがあるので、非同期の描画は結果を書き込む前にこれで確かめる
// （確かめないと、移った先の画面に前のページの内容が出てしまう）。
function isCurrentRoute(page, param = null) {
  const now = currentRoute();
  if (now.page !== page) return false;
  return param == null || now.param === param;
}

// 直前に表示していた画面。ページが変わったときだけスクロールを先頭へ戻すために覚えておく
// （Realtimeの更新でも routeFromLocation は呼ばれるので、毎回戻すと読んでいる途中で飛んでしまう）。
let lastRouteKey = null;

// ---- 読み物ページの読み込み ----
//
// 「はじめに」「利用規約」「プライバシーポリシー」は、中身が長いわりに
// JSからは一切触らない読み物なので、index.html には空の <section> だけを置き、
// 本文は pages/*.html に分けてある（index.html を読める長さに保つため）。
// 読み込むのは、そのページが最初に開かれたときの1回だけ。
//
// 読み込み先のURLは <section data-src="/pages/guide.html?v=69"> に書いてある。
// 先頭の / は落とさないこと。相対パスのままだと、/tournaments/{id}/ のような
// 深いURLから開いたときに /tournaments/{id}/pages/guide.html を取りに行って404になる。
// ?v= を index.html の他の版数と同じ場所に置くことで、デプロイ時の一括置換と
// scripts/check-cache-version.mjs の確認から漏れないようにしている。

// その画面でしか使わないCSSを、初めて開いたときに1回だけ読む。
//
// 順位発表（/reveal/）の45KBがこれにあたる。持ち主しか開かない画面のCSSを
// <head> に置くと、ブラウザはそれを読み終えるまで最初の描画を始めないため、
// 一度も開かない人まで待たされる。読み込み先は <section data-css="..."> にある。
//
// 【一瞬だけ素の見た目が出る】CSSが届く前に画面を描くので、ごく短いあいだ
// 装飾の無い状態が見える。開くのは操作のあと（持ち主がボタンを押す）で、
// その先の全画面演出まではさらに一手あるので、ここでは待たせないほうを採る。
//
// 【1画面に複数書ける】data-css は空白区切りで並べられる。使い方ガイドが
// その例で、ガイド自身のCSSに加えて、本文に埋め込んだ対戦カードやチャットの
// 見本のために css/bracket.css も要る。1つしか書けなかったころ、ガイドの
// 見本が素の見た目のまま配られた（v172）。
const viewCssLoaded = new Set();

function loadViewCss(viewId) {
  const list = $(viewId)?.dataset.css;
  if (!list) return;

  for (const href of list.trim().split(/\s+/)) {
    if (viewCssLoaded.has(href)) continue;   // 別の画面が先に読んでいれば取り直さない
    viewCssLoaded.add(href);

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }
}

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
      // 中身が入ったいま初めて演出を仕掛けられる（routeFromLocation が呼んだ時点では
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

// いまのURLに合わせて画面を描く。
//
// 呼ばれる経路は3つある。どれも同じここへ集まるので、描く処理は1か所で済む。
//   * リンクを押した／navigate() した  … router.js の go() から
//   * 戻る・進む                       … router.js の popstate から
//   * 背景の更新（Realtime・再取得）    … refreshFromDb などから直接
// pushState は popstate を起こさないので、この「移動」と「描画」を分けておかないと
// 自分で移動したときだけ画面が変わらない、という壊れ方をする。
function routeFromLocation() {
  const { page, param, query } = currentRoute();

  // ?login=1 はページではなくログインダイアログを開くための入口
  // （旧 #login から読み替えられて来る。router.js の pathFromLegacyHash）。
  // クエリはすぐ消す ── 残すと、戻ってきたときや共有されたときに再び開いてしまう。
  if (query.has('login')) {
    query.delete('login');
    const search = String(query);
    history.replaceState(null, '', location.pathname + (search ? `?${search}` : ''));
    if (!isLoggedIn()) openLoginDialog();
  }

  let target = VIEW_IDS[page] ? page : 'home';

  // 大会作成は選手登録さえ済んでいれば誰でも。順位発表はサイトの持ち主だけ。
  // マイページはログアウト中でも開ける（そこからログインする）。
  //
  // 追い返すのは replaceState で。push すると、戻るボタンで入れないページへ
  // 帰されて、また追い返されて、と往復から抜けられなくなる。
  if (target === 'create' && !auth.player) {
    history.replaceState(null, '', pathFor('home'));
    target = 'home';
  }
  if (target === 'reveal' && !isOwner()) {
    history.replaceState(null, '', pathFor('home'));
    target = 'home';
  }

  // 「別の画面へ移ったのか、同じ画面を描き直しているだけなのか」。
  // この関数は Realtime の更新のたびにも呼ばれるので、この区別は要になる。
  //   * 先頭までスクロールを戻すのは、移ったときだけ
  //   * 画面の切り替えに一枚かぶせるのも、移ったときだけ
  // ここを見ずに演出を走らせると、チャットや対戦表が更新されるたびに
  // 画面全体がひらめいて、見ている人には不具合に見える。
  // 大会一覧のタブはクエリ（?tab=）に入っていて param には出てこない。ここに混ぜないと
  // タブを切り替えても「同じ画面のまま」と判断され、先頭へのスクロールが起きない。
  // location.search をそのまま使わないのは、画面の中身に関わらないクエリ
  // （ログインから戻った直後の ?code= など）で「移った」と数えないため。
  const routeKey = `${target}/${param ?? ''}/${query.get('tab') ?? ''}`;
  // 最初の1回は「移った」とは数えない。まだ何も描かれていない画面から
  // かぶせても、白い面が一度ひらめくだけで意味がないため。
  const isFirstRoute = lastRouteKey === null;
  const routeChanged = routeKey !== lastRouteKey;
  lastRouteKey = routeKey;

  // 画面の入れ替え一式。View Transitions で包めるように、ひとまとまりにしてある。
  const applyRoute = () => {
    // 発表中に別のページへ移ったら、全画面を先に畳む。畳まないと body に
    // .reveal-playing が残り、移った先でヘッダーもナビも消えたままになる。
    // まだ順位発表を開いていなければ（revealMod が null）畳むものも無いので、
    // ここで取りに行かせない ── そうしないと、どのページへ移っても48KBを読むことになる。
    if (target !== 'reveal') revealMod?.closeRevealStage();

    // 比べるのはページ名ではなく要素のID。2つのページ名が同じ画面を指すことがあり
    // （かつて #players と #ranking がそうだった）、名前で比べると、後から回ってきた
    // 別名のほうが「対象ではない」と判断して、出したばかりの画面を隠してしまう。
    const targetViewId = VIEW_IDS[target];
    Object.values(VIEW_IDS).forEach((id) => {
      $(id).hidden = id !== targetViewId;
    });

    // 中身を別ファイルに分けてある読み物ページ（はじめに・利用規約・プライバシーポリシー）。
    // data-src が付いていないページでは何もしない。
    loadStaticPage(VIEW_IDS[target]);
    // その画面だけで使うCSS（順位発表）。data-css が付いていないページでは何もしない。
    loadViewCss(VIEW_IDS[target]);

    // 検索結果とSNSに出る情報（title・説明文・canonical・構造化データ）。
    // 画面と同じ材料から作るので、ここで一緒に出し直す。
    applyRouteMeta(target, param);

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
    else if (target === 'tournaments') renderTournamentsPage(query.get('tab'));
    else if (target === 'entries') draw(renderEntriesPage());
    else if (target === 'create') {
      renderParticipantCheckboxes();
      renderSelectedList();
      ensureCreateOrganizerPicker();
    }
    else if (target === 'tournament') draw(renderTournamentDetail(param));
    else if (target === 'bracket') draw(renderBracketPage(param));
    else if (target === 'entrants') draw(renderEntrantsPage(param));
    else if (target === 'player') draw(renderPlayerDetail(param));
    else if (target === 'players') refreshPlayerUI();
    else if (target === 'reveal') draw(loadReveal().then((m) => m.renderRevealPage()));
    else if (target === 'profile') renderProfilePage();

    // 別の画面へ移ったときは先頭から見せる。ページを読み直さずURLだけを書き換える
    // 作りなので、何もしないとブラウザは前の画面のスクロール位置をそのまま引き継ぎ、
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
  renderAnnouncementCards(newsListEl, state.announcements, { titleTag: 'h2' });
  try {
    await db.ensureAllAnnouncements();
  } catch (err) {
    setStatus(err.message, 'error');
    return;
  }
  if (!isCurrentRoute('newslist')) return;
  renderAnnouncementCards(newsListEl, state.announcements, { titleTag: 'h2' });
}

// お知らせのカード一覧。ホームとお知らせ一覧ページの両方から使う。
//
// titleTag は、その一覧が置かれる場所によって変わる。お知らせ一覧ページでは
// ページの題（h1「お知らせ」）のすぐ下なので h2、ホームでは「お知らせ」という
// ブロックの題（h2）の下なので h3 になる。同じ部品でも、見出しの深さは
// 置かれた場所で決まる ── 決め打ちにすると、どちらかで段が飛ぶ。
function renderAnnouncementCards(containerEl, announcements, { titleTag = 'h3' } = {}) {
  containerEl.innerHTML = '';

  if (announcements.length === 0) {
    // まだDBから何も届いていないだけかもしれない。そこで「ありません」と
    // 言い切ると、初めて来た人には空のサイトに見える。
    if (!db.hasLoadedOnce()) {
      containerEl.appendChild(skeletonCards(2));
      return;
    }
    containerEl.innerHTML = '<p class="empty-hint">まだお知らせはありません。</p>';
    return;
  }

  // 一覧は画像・題名・日付だけの入口。本文は詳細ページ（/news/{id}/）で読ませる。
  // カードの形と並べ方は大会一覧と共通（css の .card 系）。
  const list = document.createElement('div');
  list.className = 'card-grid';

  announcements.forEach((a) => {
    const card = document.createElement('a');
    card.className = `card${a.pinned ? ' pinned' : ''}`;
    card.href = pathFor('news', a.id);

    const body = document.createElement('div');
    body.className = 'card-body';

    const title = document.createElement(titleTag);
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
    // 全件が揃ったので、題と説明文を確かめ直す。routeFromLocation が呼んだ時点では
    // まだ手元に無く、「お知らせ」という入れ物の名前しか出せていない。
    applyRouteMeta('news', id);
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
    navigate('newslist');
  });

  newsActionsEl.append(editBtn, delBtn);
}

// ---- 通報と利用停止（BAN）----
//
// 通報の入口は選手ページの「通報する」だけ。届いた通報は運営の画面（選手ページの
// 上）にまとまり、通報した人数が BAN_THRESHOLD に届くと「BAN対象」の札が付く。
//
// 【自動では止めない】札が付いても起きるのは表示だけで、止めるかどうかは運営が
// 押して決める。自動で消す作りにすると、結託した数アカウントで無実の選手を
// 消せてしまう（DB側も同じ考えで、数えるだけの作りにしてある）。

// DBの player_reports.reason と1対1で対応する。増やすときは
// supabase/schema.sql の player_reports_reason_check と index.html の選択肢も直すこと。
const REPORT_REASONS = {
  harassment: '誹謗中傷・ハラスメント',
  cheating: '不正行為・八百長',
  impersonation: 'なりすまし',
  inappropriate: '不適切なプロフィール',
  spam: '宣伝・勧誘・スパム',
  other: 'その他',
};

const reasonLabel = (reason) => REPORT_REASONS[reason] ?? 'その他';

// 通報ダイアログを開く。対象は選手（選手ページ）か、大会（大会詳細の歯車）。
//
// 【1つのダイアログを使い回している】理由の選択肢も、状況を書いてもらう欄も、
// 「運営だけが見る」という約束も同じ。2つ建てると、片方だけ文言が古くなる。
// 何に対する通報かは reportTarget が持つ。
let reportTarget = null;   // { kind: 'player' | 'tournament', id, name }

function openReportDialog(target) {
  reportTarget = target;
  const isTournament = target.kind === 'tournament';
  reportDialogTitleEl.textContent = isTournament ? '大会を通報する' : '選手を通報する';
  reportTargetEl.textContent = isTournament
    ? `通報する大会: ${target.name}`
    : `通報する相手: ${target.name}`;
  reportBodyInput.placeholder = isTournament
    ? '例: 開催日を過ぎても対戦表が作られず、運営に連絡しても返答がありません。'
    : '例: 〇月〇日の第5回大会の対戦チャットで、繰り返し暴言を受けました。';
  reportReasonInput.value = 'harassment';
  reportBodyInput.value = '';
  reportFormErrorEl.textContent = '';
  reportSubmitBtn.disabled = false;
  reportDialog.showModal();
}

function closeReportDialog() {
  reportTarget = null;
  reportDialog.close();
}

// 届いている通報の一覧（運営専用）。
//
// 通報された人ごとにまとめて、通報した人数の多い順に並べる。数えるのは件数ではなく
// 人数 ── 1人が何度押しても1件にしかならない（DB側の部分ユニーク索引で潰してある）。
function renderBanReview() {
  // 一般の利用者には存在ごと見せない。RLSでも運営以外には0件しか返らないので、
  // ここは「運営が自分の画面で見るためのもの」という位置づけを保つための出し分け。
  if (!isAdmin()) {
    reportReviewEl.hidden = true;
    reportReviewEl.innerHTML = '';
    return;
  }

  const summaries = playerReportSummaries();
  const banned = state.players.filter(isBannedPlayer);
  const tournamentSummaries = tournamentReportSummaries();

  if (summaries.length === 0 && banned.length === 0 && tournamentSummaries.length === 0) {
    reportReviewEl.hidden = true;
    reportReviewEl.innerHTML = '';
    return;
  }

  const cards = summaries.map((s) => {
    const player = state.players.find((p) => p.id === s.targetId);
    const name = player ? player.currentName : '削除された選手';
    const items = s.reports.map((r) => {
      const reporter = state.players.find((p) => p.id === r.reporterId);
      return `
        <li class="report-item">
          <span class="report-item-head">
            <span class="report-reason">${escapeHtml(reasonLabel(r.reason))}</span>
            <span class="meta-line">${escapeHtml(reporter ? reporter.currentName : '退会した選手')}・${escapeHtml(formatDateTime(r.createdAt))}</span>
          </span>
          ${r.body ? `<p class="report-item-body">${escapeHtml(r.body)}</p>` : ''}
        </li>`;
    }).join('');

    return `
      <article class="report-card${s.isCandidate ? ' is-candidate' : ''}">
        <header class="report-card-head">
          <a class="report-card-name" href="${pathFor('player', s.targetId)}">${escapeHtml(name)}</a>
          <span class="report-count">通報 ${s.reporterCount}人</span>
          ${s.isCandidate ? '<span class="ban-badge is-candidate">BAN対象</span>' : ''}
        </header>
        ${isBannedPlayer(player) ? '<p class="meta-line">この選手は既に利用停止中です。</p>' : ''}
        <details class="report-details">
          <summary>通報の内容（${s.reports.length}件）</summary>
          <ul class="report-list">${items}</ul>
        </details>
        <div class="row-actions">
          ${isBannedPlayer(player)
            ? ''
            : `<button type="button" class="btn-report ban-btn" data-id="${escapeHtml(s.targetId)}">この選手を利用停止にする</button>`}
          <button type="button" class="btn-secondary dismiss-btn" data-id="${escapeHtml(s.targetId)}">通報を却下する</button>
        </div>
      </article>`;
  }).join('');

  // 停止中の選手は検索から消えるので、解除する相手を探せる場所をここに残す
  const bannedList = banned.length === 0 ? '' : `
    <details class="report-details banned-block">
      <summary>利用停止中の選手（${banned.length}人）</summary>
      <ul class="banned-list">
        ${banned.map((p) => `
          <li>
            <a href="${pathFor('player', p.id)}">${escapeHtml(p.currentName)}</a>
            <span class="meta-line">${escapeHtml(formatDateTime(p.bannedAt))}に停止</span>
            <button type="button" class="btn-secondary unban-btn" data-id="${escapeHtml(p.id)}">停止を解除</button>
          </li>`).join('')}
      </ul>
    </details>`;

  // 大会への通報。選手への通報と同じ形で並べるが、押せる手は「消す」か「却下」だけ
  // （大会には利用停止にあたるものが無い）。消すのは大会詳細の歯車から。
  const tournamentCards = tournamentSummaries.map((s) => {
    const tournament = state.tournaments.find((t) => t.id === s.tournamentId);
    const name = tournament ? tournament.name : '削除された大会';
    const items = s.reports.map((r) => {
      const reporter = state.players.find((p) => p.id === r.reporterId);
      return `
        <li class="report-item">
          <span class="report-item-head">
            <span class="report-reason">${escapeHtml(reasonLabel(r.reason))}</span>
            <span class="meta-line">${escapeHtml(reporter ? reporter.currentName : '退会した選手')}・${escapeHtml(formatDateTime(r.createdAt))}</span>
          </span>
          ${r.body ? `<p class="report-item-body">${escapeHtml(r.body)}</p>` : ''}
        </li>`;
    }).join('');

    return `
      <article class="report-card">
        <header class="report-card-head">
          <a class="report-card-name" href="${pathFor('tournament', s.tournamentId)}">${escapeHtml(name)}</a>
          <span class="report-count">通報 ${s.reporterCount}人</span>
        </header>
        <details class="report-details">
          <summary>通報の内容（${s.reports.length}件）</summary>
          <ul class="report-list">${items}</ul>
        </details>
        <div class="row-actions">
          <button type="button" class="btn-secondary dismiss-tournament-btn" data-id="${escapeHtml(s.tournamentId)}">通報を却下する</button>
        </div>
      </article>`;
  }).join('');

  const tournamentBlock = tournamentSummaries.length === 0 ? '' : `
    <h3 class="report-review-title">大会への通報</h3>
    <p class="note">
      大会そのものへの通報です。消すかどうかは内容を読んで決めてください
      ── 消すのはその大会のページの歯車から行います（通報も一緒に消えます）。
      問題が無ければ却下すると、同じ人がまた通報できるようになります。
    </p>
    ${tournamentCards}`;

  reportReviewEl.hidden = false;
  reportReviewEl.innerHTML = `
    <h2 class="report-review-title">届いている通報</h2>
    <p class="note">
      通報が<strong>${BAN_THRESHOLD}人</strong>ぶん集まると「BAN対象」の札が付きます。
      札が付いても自動では何も起きません ── 内容を読んで、止めるか却下するかを決めてください。
      停止すると、その選手はエントリー・大会作成・チャット・プロフィールの編集ができなくなり、
      選手の検索からも消えます（過去の対戦表と戦績はそのまま残ります）。
    </p>
    ${cards}
    ${bannedList}
    ${tournamentBlock}`;

  reportReviewEl.querySelectorAll('.dismiss-tournament-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tournament = state.tournaments.find((t) => t.id === btn.dataset.id);
      if (!confirm(`「${tournament?.name ?? 'この大会'}」への通報をすべて却下します。よろしいですか？`)) return;
      btn.disabled = true;
      const ok = await persist(() => db.dismissTournamentReports(btn.dataset.id), '通報の却下');
      if (ok) await refreshFromDb();
      else btn.disabled = false;
    });
  });

  reportReviewEl.querySelectorAll('.ban-btn').forEach((btn) => {
    btn.addEventListener('click', () => setBan(btn, btn.dataset.id, true));
  });
  reportReviewEl.querySelectorAll('.unban-btn').forEach((btn) => {
    btn.addEventListener('click', () => setBan(btn, btn.dataset.id, false));
  });
  reportReviewEl.querySelectorAll('.dismiss-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const player = state.players.find((p) => p.id === btn.dataset.id);
      if (!confirm(`「${player?.currentName ?? 'この選手'}」への通報をすべて却下します。よろしいですか？`)) return;
      btn.disabled = true;
      const ok = await persist(() => db.dismissPlayerReports(btn.dataset.id), '通報の却下');
      if (ok) await refreshFromDb();
      else btn.disabled = false;
    });
  });
}

// 利用停止のオン・オフ。選手ページと通報の一覧の両方から呼ぶ。
async function setBan(btn, playerId, banned) {
  const player = state.players.find((p) => p.id === playerId);
  const name = player?.currentName ?? 'この選手';
  const message = banned
    ? `「${name}」を利用停止にします。\n\nエントリー・大会作成・チャット・プロフィールの編集ができなくなり、`
      + '選手の検索からも消えます（過去の対戦表と戦績は残ります）。\n未対応の通報はまとめて対応済みになります。'
      + '\n\nよろしいですか？'
    : `「${name}」の利用停止を解除します。よろしいですか？`;
  if (!confirm(message)) return;

  btn.disabled = true;
  const ok = await persist(() => db.setPlayerBan(playerId, banned), banned ? '利用停止' : '利用停止の解除');
  if (ok) await refreshFromDb();
  else btn.disabled = false;
}

// ---- 選手 ----

function refreshPlayerUI() {
  renderBanReview();
  renderPlayerTable(playerListEl, {
    ownPlayerId: auth.player?.id ?? null,
    isAdmin: isAdmin(),
    players: playerSearch.players,
    status: playerSearch.status,
    errorMessage: playerSearch.error,
    hasMore: playerSearch.hasMore,
    onDelete: async (player) => {
      await db.deletePlayer(player.id);
      selectedParticipantIds = selectedParticipantIds.filter((id) => id !== player.id);
      await refreshFromDb();
      // 消した人が結果に残ったままにしない（結果は手元の控えなので、
      // 取り直さない限り消えない）。
      runPlayerSearch(playerSearch.query);
    },
    onMerge: async (sourceId, targetId) => {
      await db.mergePlayers(sourceId, targetId);
      await reloadOwnPlayer();
      await refreshFromDb();
      runPlayerSearch(playerSearch.query);
    },
  });
  renderParticipantCheckboxes();
}

// 検索欄2つの動かし方。どちらも js/util.js の createSearchRunner に任せる
// （打鍵ごとに投げない・古い応答に上書きさせない、の2点を1か所で持つため）。
//
// 【利用停止中の扱いが2つで違う】選手検索は運営にだけ停止中の人を出す ──
// 解除する相手を探せる場所がここしかないため。参加者選びには出さない
// （停止中の人を大会に入れられてしまう）。
function bindSearch(box, render, optionsOf = () => ({})) {
  return createSearchRunner({
    // 問い合わせる直前に組み立てる。運営かどうかはログインの状態で変わるので、
    // ここを作った時点の値で固めてしまうと、ログインしても切り替わらない。
    search: (q) => db.searchPlayers(q, optionsOf()),
    onStart: (q) => { box.query = q; box.status = 'loading'; box.error = ''; render(); },
    onEmpty: () => {
      box.query = '';
      box.players = [];
      box.status = 'idle';
      box.error = '';
      box.hasMore = false;
      render();
    },
    onResult: ({ players, hasMore }) => {
      box.players = players;
      box.hasMore = hasMore;
      box.status = 'done';
      render();
    },
    onError: (err) => { box.status = 'error'; box.error = err.message; render(); },
  });
}

const runPlayerSearch = bindSearch(
  playerSearch, () => refreshPlayerUI(), () => ({ includeBanned: isAdmin() }),
);
const runParticipantSearch = bindSearch(
  participantSearch, () => renderParticipantCheckboxes(),
);

// 大会作成の「この大会の運営」欄。
//
// 建てるのは1回だけ。この画面は Realtime の更新でも描き直されるので、
// そのたびに建て直すと、指名しかけた顔ぶれが消えてしまう。
// 作成が終わったあとだけ reset で建て直す（前の大会の顔ぶれを持ち越さないため）。
function ensureCreateOrganizerPicker({ reset = false } = {}) {
  if (!auth.player) return;
  if (organizerPicker && !reset) {
    // 建て直さずに、札の名前だけ描き直す。この画面は読み込みが終わるたびに
    // ここを通るので、建てた時点で選手が届いていなくても、届いた時点で名前になる。
    organizerPicker.refresh();
    return;
  }
  organizerPicker = mountOrganizerPicker(tournamentOrganizersEl, {
    selectedIds: [auth.player.id],
    lockedId: auth.player.id,
  });
}

// 運営が参加者を直接選ぶ欄。
//
// 【空欄のときに全員を並べないこと】以前はそうしていたが、それには全選手を
// 手元に持つ必要があった。いまは打った文字でDBに問い合わせる（db.searchPlayers）。
// 選手が増えるほど、全員を並べても目当ての人は結局探せない ── 他の3つの検索欄
// （選手検索・相方選び・運営の指名）と同じ「打つと出る」形にそろえた。
//
// 利用停止中の選手は候補に出さない（db.searchPlayers の既定。停止中の人を
// 大会に入れられてしまうため）。
function renderParticipantCheckboxes() {
  participantCheckboxesEl.innerHTML = '';

  if (participantSearch.status === 'idle') {
    participantCheckboxesEl.innerHTML = '<p class="empty-hint">名前かゲームIDを入力すると候補が出ます。</p>';
    return;
  }

  if (participantSearch.status === 'error') {
    participantCheckboxesEl.innerHTML = `<p class="empty-hint">${escapeHtml(participantSearch.error)}</p>`;
    return;
  }

  // 通信の途中に「一致する選手がいません」を挟まない（打つたびに一瞬出る）
  if (participantSearch.status === 'loading') {
    participantCheckboxesEl.innerHTML = '<p class="status-line loading">選手を検索しています...</p>';
    return;
  }

  const visiblePlayers = participantSearch.players;

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

    // 名前は <span> に入れる。裸の文字のままだと flex の中で折り返しの扱いが
    // 効かず、長い名前が島からはみ出して隣の行と境目が混ざる。
    const name = document.createElement('span');
    name.textContent = p.gameAccountId
      ? `${p.currentName}（${p.gameAccountId}）`
      : p.currentName;

    label.append(checkbox, name);
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
    // 引けないときにIDを出さない（js/state.js の UNKNOWN_PLAYER_NAME を参照）
    nameLabel.textContent = player ? player.currentName : UNKNOWN_PLAYER_NAME;

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
    profileNoteEl.textContent = 'プレイヤー名など必要事項を記入すると登録が完了します。あとからいつでも変更できます。';
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
        navigate('player', auth.player.id);
      },
    });
    return;
  }

  profileTitleEl.textContent = 'マイページ';

  // 利用停止中は、まずそのことを本人に伝える。編集も保存もDB側で弾かれるので、
  // 黙って失敗させると「保存できない不具合」に見える。
  if (isBannedPlayer(auth.player)) {
    profileFormMode = null;
    setProfileEditing(false);
    profileFormContainer.innerHTML = '';
    profileNoteEl.textContent = 'このアカウントは現在、利用を停止されています。'
      + 'エントリー・大会作成・対戦チャットへの書き込み・プロフィールの編集はできません。'
      + '心当たりがない場合や、解除を求める場合は、フッターのお問い合わせから運営にご連絡ください。';
    renderOwnProfileView();
    return;
  }

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
        // プレイヤー名を変えたら旧名を過去名に残す（players.js の updatePlayer と同じ扱い）
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

  const bio = profileBioHtml(player);
  const chips = profileFooterHtml(player);
  // 停止中は編集の入口を出さない。押してもDB側で弾かれるだけで、
  // 「保存できない不具合」に見えてしまう（理由は上の renderProfilePage が出している）。
  const banned = isBannedPlayer(player);

  // 選手ページとまったく同じ部品で組む（ここが「他の人からどう見えるか」の確認場所
  // なので、見た目が少しでも違うと確認にならない）。戦歴だけは通信が要るので、
  // 先に枠を出しておいて後から差し込む（下の fillOwnRecord）。
  // 直近の戦績は島の中（.player-record）、全件の表は島の外（.player-history）。
  profileViewEl.innerHTML = playerHeroHtml(player, {
    // ページの題は「マイページ」（h1）なので、自分の名前はその下の段
    nameTag: 'h2',
    action: banned
      ? ''
      : `<button type="button" class="profile-edit-link profile-edit-btn"
              title="プロフィールを編集する" aria-label="プロフィールを編集する">${iconSvg('pencil')}</button>`,
    extra: banned ? '<p class="ban-notice">利用停止中のアカウントです。</p>' : '',
    foot: bio + '<div class="player-record"></div>',
  })
    + '<div class="player-history"></div>'
    + (chips || (bio ? '' : '<p class="empty-hint">まだプレイヤー名だけです。鉛筆アイコンからアイコン・使用キャラ・自己紹介などを追加できます。</p>'));

  profileViewEl.querySelector('.profile-edit-btn')?.addEventListener('click', () => {
    setProfileEditing(true);
    renderProfilePage();
  });

  // 戦歴だけはサーバーへ取りに行く（全選手の試合は手元に無い。js/db.js の
  // loadPlayerRecord）。待たずに先へ進む ── ヒーローも自己紹介も手元のデータだけで
  // 描けるので、通信のあいだ空白のマイページを見せる理由がない。
  fillOwnRecord(player.id);
}

// 読み終えた戦歴を、先に描いておいた枠へ差し込む。
async function fillOwnRecord(playerId) {
  let record;
  try {
    record = await db.loadPlayerRecord(playerId);
  } catch (err) {
    const failed = profileViewEl.querySelector('.player-record');
    if (failed) failed.innerHTML = `<p class="empty-hint">${escapeHtml(err.message)}</p>`;
    return;
  }

  // 読んでいるあいだに編集へ切り替わった・別のアカウントになったなら捨てる。
  // 枠は renderProfilePage が毎回消すので、見つからなければ描き直された後。
  const box = profileViewEl.querySelector('.player-record');
  if (!box || auth.player?.id !== playerId) return;

  const stats = getPlayerStats(playerId, record);
  // マイページは「マイページ(h1) → 自分の名前(h2)」の下なので1段深い
  box.innerHTML = recentResultsHtml(stats, { titleTag: 'h3' });

  // 全件の表は島の外。枠が無いのは描き直された後なので、その時は何もしない。
  const history = profileViewEl.querySelector('.player-history');
  if (history) history.innerHTML = historyTableHtml(stats);
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
      + `<a href="${pathFor('profile')}">マイページ</a>で登録すると、大会にエントリーできます。</p>`;
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
      + `<a href="${pathFor('tournaments')}">募集中の大会</a>からエントリーできます。</p>`;
    return;
  }

  ENTRY_GROUPS.forEach(({ title, statuses }) => {
    const items = mine.filter((t) => statuses.includes(t.status));
    if (items.length === 0) return; // 空のグループは見出しごと出さない

    const heading = document.createElement('h2');
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

// 大会の進行状況。優勝者はここに含めない（下の championOf が別に受け持つ）。
//
// 【公開前は空を返す】状態の言葉が付くのは公開してから（js/tournamentState.js の
// STATUS_LABELS）。呼ぶ側は label が空ならタグごと・その一節ごと出さないこと。
// 公開されていないことは、ページ先頭の帯（js/entries.js の draftNotice）が言う。
function tournamentStatusInfo(t) {
  if (t.status === 'draft') return { label: '', tone: 'draft' };

  if (!state.bracketIds.has(t.id)) {
    return { label: STATUS_LABELS[t.status] ?? '—', tone: t.status };
  }

  if (t.status === 'finished') return { label: '終了', tone: 'finished' };

  // 「結果待ち（表は埋まったが運営が確定していない）」は対戦表を見ないと分からない。
  // 一覧では対戦表を読み込まないので、その場合は「進行中」までの表示に留める。
  const bracket = state.brackets[t.id];
  return bracket && allMatchesDecided(bracket)
    ? { label: '結果待ち', tone: 'pending' }
    : { label: '進行中', tone: 'running' };
}

// 優勝者を名指しするのは、運営が結果を確定させた大会だけ。
// 表が埋まっただけの段階では「結果待ち」に留める。
// チーム戦ではチーム名が返る（優勝者は2人いるので選手名では出せない）。
//
// 【大会の一覧では呼ばないこと】個人戦の優勝者名は js/state.js の getPlayerName で
// 引く ── つまり、その選手を手元に持っている必要がある。一覧は大会を何十件も並べる
// 画面なので、ここで呼ぶと「一覧に出た全大会の優勝者」が要る＝結局こちらは
// 全選手を抱えることになる。だから一覧のカードからは「優勝 ○○」を外した。
//
// 大会詳細・対戦表・出場選手一覧では呼んでよい。それらの画面は、もともと
// その大会の出場者を取っていて、優勝者はその中の1人だから追加の取得が起きない。
function championOf(t) {
  if (!state.bracketIds.has(t.id) || t.status !== 'finished') return null;
  return championLabel(t.id);
}

// 大会詳細の歯車の中身を、見ている人に合わせて出し分ける。
//
// 【歯車ごと隠さないこと】以前は運営でなければ歯車そのものを出さなかった。
// いまは通報の入口を兼ねるので、ログインしていれば誰にでも出す。
// 出さないのは、押しても何もできない人だけ ── ログインしていない人と、
// 選手登録がまだの人（通報には名乗りが要る。DB側のポリシーでも弾かれる）。
function syncTournamentManageMenu(tournamentId, canManage) {
  const canReport = Boolean(auth.player) && !canManage && !isBannedPlayer(auth.player);

  tournamentManageEl.hidden = !canManage && !canReport;
  tournamentEditBtn.hidden = !canManage;
  tournamentDeleteBtn.hidden = !canManage;
  tournamentReportBtn.hidden = !canReport;

  if (canReport) {
    // 2回目は出せない（DB側の部分ユニーク索引でも弾かれる）。押せる見た目のまま
    // 弾かれるより、済んでいることを先に見せる。
    const done = hasOpenTournamentReportFrom(auth.player.id, tournamentId);
    tournamentReportBtn.disabled = done;
    tournamentReportBtn.textContent = done ? '通報済みです' : 'この大会を通報する';
  }

  if (tournamentManageEl.hidden) setManageMenuOpen(false);
}

// 大会情報の「進行状況」欄用。1行に収めたいので優勝者も含めて文字列にする。
function tournamentStatusLabel(t) {
  const champion = championOf(t);
  return champion ? `優勝: ${champion}` : tournamentStatusInfo(t).label;
}

// 大会名の隣に出すバッジ。「この大会はいま何を受け付けているか」を一言で示す。
//
// 募集中のあいだは、受付の状況（募集中・定員に達しました・締切時刻を過ぎています）が
// そのまま大会の状態になるので js/tournamentState.js の判定を使う。エントリー
// ボタンの出方も検索結果の eventStatus も同じ関数から出るので、three者がずれない。
//
// 始まったあとは、対戦表まで見ないと分からない「結果待ち」があるので
// tournamentStatusInfo のほうが詳しい。どちらも見ているのは同じ t.status で、
// 深さが違うだけ。
function tournamentBadge(t) {
  if (t.status === 'recruiting') {
    const st = entryState(t);
    return { label: st.label, tone: st.tone };
  }
  const info = tournamentStatusInfo(t);
  return { label: info.label, tone: info.tone };
}

// タブの一覧は js/router.js が持っている（URLの ?tab= を読み替えるのに要るため）。

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
  // ページの題（h1「大会」）のすぐ下に並ぶ一覧なので、カードの題は h2。
  renderTournamentCards(tournamentsListEl, [...visible].reverse(), tab === 'running'
    ? '進行中の大会はありません。'
    : 'まだ終了した大会がありません。', { titleTag: 'h2' });
}

// 始まった大会（進行中・終了）のカード一覧。大会一覧とエントリー状況で使う。
// myPlacements（大会ID → 勝ち上がりの深さ）を渡すと、その成績をカードに添える。
function renderTournamentCards(containerEl, tournaments, emptyText, { myPlacements = null, titleTag = 'h3' } = {}) {
  containerEl.innerHTML = '';

  if (tournaments.length === 0) {
    if (!db.hasLoadedOnce()) {
      containerEl.appendChild(skeletonCards(3));
      return;
    }
    containerEl.innerHTML = `<p class="empty-hint">${escapeHtml(emptyText)}</p>`;
    return;
  }

  // カードの形は募集・お知らせと共通（css の .card 系）
  const list = document.createElement('div');
  list.className = 'card-grid';

  tournaments.forEach((t) => {
    const card = document.createElement('a');
    card.className = 'card';
    card.href = pathFor('tournament', t.id);

    // 【優勝者はここに出さない】上の championOf の注記を参照。
    const { label, tone } = tournamentStatusInfo(t);
    const placement = myPlacements
      ? placementLabelOf(t.id, myPlacements.get(t.id) ?? null)
      : null;

    const body = document.createElement('div');
    body.className = 'card-body';
    body.innerHTML = `
      <${titleTag} class="card-title">${escapeHtml(t.name)}</${titleTag}>
      <p class="card-date">${escapeHtml(tournamentWhenText(t.date) || '日付未設定')} ・ ${escapeHtml(entrantCountLabel(t))}参加</p>
      <span class="status-chip status-${tone}">${escapeHtml(label)}</span>
      ${reportChipHtml(t.id)}
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

// エントリー締切の入力欄（input[type=datetime-local]）とDBの値の橋渡し。
//
// 入力欄が返すのは「2026-08-15T21:00」という、地域の情報を持たない壁時計の文字列。
// 打った人の時計での時刻なので、そのまま Date に渡すとローカル時刻として読まれ、
// 保存はISO（UTC）になる。逆に戻すときは同じ経路を通す必要があり、
// toISOString() をそのまま入れると9時間ずれた時刻が欄に出る。
const INVALID_DEADLINE = Symbol('invalid-deadline');

function readDeadline(input) {
  const raw = input.value.trim();
  if (!raw) return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    alert('エントリー締切の日時が正しくありません。');
    input.focus();
    return INVALID_DEADLINE;
  }
  return at.toISOString();
}

// ISO → 入力欄の値。分までしか扱わないので秒以下は落とす。
function deadlineInputValue(iso) {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
    + `T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

// 詳細ページ（大会・お知らせ）の画像ヘッダー。
// 画像が無いときは枠ごと隠し、余白だけが残らないようにする。
//
// 【loading="lazy" を付けないこと】この絵はページの一番上にあり、多くの場合
// そのページで一番大きい要素になる ── つまり「表示できた」と測られる当の相手
// （LCP）。lazy を付けると、ブラウザはレイアウトが決まるまで取りに行かないので、
// 一番見せたい絵が一番遅く出ることになる。fetchpriority で先に取らせる。
// 逆に一覧のカードや対戦表の中の絵は lazy のままでよい（画面の外にあるため）。
function renderHero(el, imageUrl) {
  // 【必ず heroImageUrl を通すこと】サーバーが返したHTMLの中の <img> も、
  // 同じ関数を通したURLで書かれている（js/seo.js の heroImage → worker/index.js）。
  // ここで通し忘れると、下の「同じ絵なら何もしない」の比較が必ず外れ、
  // せっかく届いた絵を捨てて、別のURLとして同じ絵をもう一度取りに行くことになる。
  const url = safeUrl(heroImageUrl(imageUrl));

  // 「先頭に絵が出るページ」の印。最初に付けるのは worker/index.js（HTMLを返すとき）で、
  // その時点の1ページぶんしか知らない。ここで付け直すのは、画面を移っても
  // ページを読み直さないため ── 絵のある大会から無い大会へ移ったときに印が残ると、
  // 空の帯だけが居座る。描くたびに実際の絵の有無に合わせ直す。
  document.documentElement.classList.toggle('has-hero', Boolean(url));

  // 同じ絵が既に入っているなら何もしない。
  // サーバーが返したHTMLに実物が入っていることがあり（worker/index.js）、
  // ここで作り直すと、せっかく描き終えた絵を捨ててもう一度描くことになる。
  if (url && el.firstElementChild?.getAttribute('src') === url) {
    el.hidden = false;
    return;
  }

  if (url) {
    el.innerHTML = `<img src="${escapeHtml(url)}" alt="" fetchpriority="high" decoding="async">`;
    el.hidden = false;
  } else {
    el.innerHTML = '';
    el.hidden = true;
  }
}

// ランキングに反映される大会かどうかの印。条件（16人以上・1v1／リレー・YouTube配信・
// 運営の設定）は
// 大会の内容で決まるので、満たしていない場合は何が足りないかもそのまま出す。
// 募集中の大会では人数が増えて条件を満たすことがあるため、見出しの文言を変える。
//
// 対象外の理由は2通りあり、言い方を分ける。条件を満たしていないのは「まだ足りない」で、
// 募集中なら人数が増えて満たされることもある。運営が外しているのは決定事項なので、
// 足りないものを並べても読む人の役に立たない（増えても対象にはならない）。
function rankingEligibilityHtml(tournament) {
  const { ranked, reasons, optedOut } = rankingEligibility(tournament);
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
  const note = optedOut
    ? 'この大会はランキングに反映しない設定です。試合の結果はスコアに影響しません（戦歴には残ります）。'
    : `条件（参加${RANKED_MIN_PARTICIPANTS}人以上・対戦方法が1v1かリレー・配信元がYouTube）を
       満たしていません：${escapeHtml(reasons.join(' / '))}`;

  return `
    <div class="ranking-mark ranking-mark-off">
      <span class="ranking-mark-title">${title}</span>
      <span class="ranking-mark-note">${note}</span>
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
  const openReports = canManageTournament(tournament.id) ? openChatReports(tournament.id) : [];

  // この大会の運営。誰に連絡すればよいかが分からないと、もめたときに詰まる。
  const organizerNames = organizerIdsOf(tournament.id)
    .map((id) => getPlayerName(id))
    .filter(Boolean);

  // エントリー締切。募集を終えれば役目の済む値なので、進行中・終了した大会では出さない
  // （残り時間つきの掲示は、エントリーボタンの隣にある。js/entries.js）。
  const deadlineText = tournament.status === 'draft' || tournament.status === 'recruiting'
    ? entryDeadlineText(tournament)
    : '';

  let html = `
    <h2>大会情報</h2>
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
      <div><dt>開催日時</dt><dd>${escapeHtml(tournamentWhenText(tournament.date) || '日付未設定')}</dd></div>
      ${deadlineText ? `<div><dt>エントリー締切</dt><dd>${escapeHtml(deadlineText)}</dd></div>` : ''}
      ${tournamentStatusLabel(tournament)
    ? `<div><dt>進行状況</dt><dd>${escapeHtml(tournamentStatusLabel(tournament))}</dd></div>`
    : ''}
      ${organizerNames.length > 0
    ? `<div><dt>運営</dt><dd>${escapeHtml(organizerNames.join('、'))}</dd></div>`
    : ''}
    </dl>
  `;
  // 配信元。試合を見に行く導線なので、ルールより先に、押せる形で出す。
  // URLはDBから来るので、表示のたびに safeUrl を通してから href に入れる。
  const streamUrl = safeUrl(tournament.streamUrl);
  if (streamUrl) {
    html += `
      <h3>配信元</h3>
      <a class="stream-link" href="${escapeHtml(streamUrl)}" target="_blank" rel="noopener noreferrer">
        <span class="stream-link-label">配信を見る</span>
        <span class="stream-link-host">${escapeHtml(new URL(streamUrl).hostname)}</span>
      </a>
    `;
  }

  if (tournament.rules) {
    html += `
      <h3>ルール</h3>
      <p class="tournament-rules">${escapeHtml(tournament.rules)}</p>
    `;
  }

  tournamentInfoEl.innerHTML = html;
}

// 出場選手一覧のページ（/tournaments/{大会ID}/entrants/）。名前の五十音順に上から並べ、
// 1枠ずつ対戦表の対戦カードと同じ見た目で出す。
//
// 大会詳細に直に並べず1ページ取っているのは、顔ぶれが数十枠になるため。
// 詳細の中に置くと、その下の大会情報とエントリーの操作が画面から押し出される。
//
// 並びが名前順なのは、このページの用途が「あの人は出ているか」を探すことだから。
// シード順に並べると、探す人は先頭から順に目で追うしかない。シード番号は行の
// バッジに残してあるので、順位付けの情報が消えるわけではない。
//
// 見た目を対戦カードと揃えているのは、ここで見た枠を対戦表の中で見つけられるように
// するため（シード番号・チーム名とメンバー・キャラクターの地模様まで同じ形になる）。
async function renderEntrantsPage(tournamentId) {
  entrantsBackLink.href = pathFor('tournament', tournamentId);

  const tournament = state.tournaments.find((t) => t.id === tournamentId);
  if (!tournament) {
    // 届く前に「無い」と言い切らない（renderTournamentDetailLoading と同じ理由）
    if (!db.hasLoadedOnce()) {
      // サーバーが題を先に入れていることがある（worker/index.js）。あれば残す。
      if (!entrantsTitleEl.textContent.trim()) {
        entrantsTitleEl.innerHTML = '<span class="skeleton-line skeleton-text"></span>';
      }
      entrantsMetaEl.textContent = '';
      entrantsNoteEl.textContent = '';
      entrantsContainerEl.innerHTML = '';
      return;
    }
    entrantsBackLink.href = pathFor('tournaments');
    entrantsBackLink.textContent = '← 大会一覧へ';
    entrantsTitleEl.textContent = '大会が見つかりません';
    entrantsMetaEl.textContent = '';
    entrantsNoteEl.textContent = '';
    entrantsContainerEl.innerHTML = '<p class="empty-hint">この大会は存在しないか、削除されています。</p>';
    return;
  }

  entrantsBackLink.textContent = '← 大会の詳細へ';
  entrantsTitleEl.textContent = `${tournament.name} の出場${isTeamTournament(tournament) ? 'チーム' : '選手'}`;
  // 公開前は進行状況が空になる。区切りだけが残らないよう、空は落としてから繋ぐ。
  entrantsMetaEl.textContent = [
    tournamentWhenText(tournament.date) || '日付未設定',
    `${entrantCountLabel(tournament)}参加`,
    tournamentStatusLabel(tournament),
  ].filter(Boolean).join(' ・ ');

  // 「誰が出ているか」はこのページで初めて必要になるので、ここで取りに行く
  // （大会一覧では人数しか持っていない。js/state.js の説明を参照）。
  try {
    await db.ensureTournamentDetail(tournamentId);
  } catch (err) {
    entrantsNoteEl.textContent = '';
    entrantsContainerEl.innerHTML = `<p class="empty-hint">${escapeHtml(err.message)}</p>`;
    return;
  }
  // 読み込んでいる間に別の画面へ移っていたら、そこへ古い内容を描かない
  if (!isCurrentRoute('entrants', tournamentId)) return;

  entrantsContainerEl.innerHTML = '';

  if (tournament.entrantIds.length === 0) {
    entrantsNoteEl.textContent = '';
    entrantsContainerEl.innerHTML = '<p class="empty-hint">まだ誰もエントリーしていません。</p>';
    return;
  }

  // シードは募集の締切時に決まる。それまでは番号が無いので、バッジは空欄になり、
  // 説明でも触れない（無い番号の話をしても読む人の役に立たない）。
  const seeds = tournament.entrantSeeds ?? [];
  const seeded = seeds.some((s) => s != null);
  const unit = isTeamTournament(tournament) ? 'チーム名' : '選手名';
  entrantsNoteEl.textContent = seeded
    ? `${unit}の五十音順に並んでいます。左の番号はシード順です。名前を押すと、その選手のプロフィールが見られます。`
    : `${unit}の五十音順に並んでいます。シードは募集を締め切った時点で決まります。名前を押すと、その選手のプロフィールが見られます。`;

  // 1枠ずつの見た目は対戦表と同じものを使う（js/bracketView.js）。
  // 取りに行っている間に別の画面へ移っていることがあるので、DBの読み込みと同じく
  // ここでも行き先を確かめ直す。
  const { buildEntrantRow } = await loadBracketView();
  if (!isCurrentRoute('entrants', tournamentId)) return;

  const list = document.createElement('div');
  list.className = 'entrant-roster';
  sortEntrantsByName(tournamentId, tournament.entrantIds, seeds)
    .forEach(({ id, seed }) => list.appendChild(buildEntrantRow(tournamentId, id, seed)));
  entrantsContainerEl.appendChild(list);
}

// 名前を並べ替えるときの比較。日本語の辞書順（かなの五十音順）で見る。
//
// 名前の読みは持っていないので、漢字の名前は読みではなく文字そのものの順に並ぶ
// （「一ノ瀬」を「いちのせ」として、かなの中に混ぜることはできない）。同じ理由で
// 英字の名前も別のかたまりになる。それでも登録順よりは目当ての名前に辿り着ける。
const nameCollator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

// 出場枠を名前の五十音順に並べる。戻り値の seed は元のシード番号（未確定なら null）で、
// 並びが変わってもバッジの数字は動かない。
function sortEntrantsByName(tournamentId, entrantIds, seeds = []) {
  return entrantIds
    .map((id, i) => ({
      id,
      seed: seeds[i] ?? null,
      name: getEntrantName(tournamentId, id) ?? '',
    }))
    .sort((a, b) => {
      const byName = nameCollator.compare(a.name, b.name);
      if (byName !== 0) return byName;
      // 同名（別人でも起こりうる）はシード順に。番号が無い枠は後ろへ。
      return (a.seed ?? Infinity) - (b.seed ?? Infinity);
    });
}

// 大会一覧へ戻るときの行き先。この大会がいま並んでいるタブへ戻す。
// 準備中は運営にだけ募集中タブに並ぶので、募集中タブ扱いにする。
function backToListLink(tournament) {
  const tab = tournament.status === 'draft' ? 'recruiting'
    : TOURNAMENT_TABS.includes(tournament.status) ? tournament.status : 'finished';
  return { href: pathFor('tournaments', null, { tab }), text: '← 大会一覧へ' };
}

// データが届く前の大会詳細。実物と同じ形・同じ高さの箱を先に置く。
//
// 【画像の枠には触らない】サーバーが「このページには先頭に絵が出る」と印を付けて
// 場所を空けてある（worker/index.js の has-hero）。ここで消すと、いったん潰れてから
// 絵が届いてまた開く ── 二度動くことになり、直したかった揺れがかえって増える。
function renderTournamentDetailLoading() {
  // サーバーが大会名を先に入れていることがある（worker/index.js）。
  // 入っているならそのまま残す ── ここで仮置きに差し替えると、
  // 「名前 → 灰色の棒 → 名前」と二度動くことになる。
  if (!tournamentTitleEl.textContent.trim()) {
    tournamentTitleEl.innerHTML = '<span class="skeleton-line skeleton-text"></span>';
  }
  tournamentStatusChipEl.hidden = true;
  tournamentMetaEl.innerHTML = '<span class="skeleton-line skeleton-text is-short"></span>';
  tournamentActionsEl.innerHTML = '';
  // 別の大会を開いたときに、前の大会の「まだ公開されていません」を残さない
  tournamentDraftNoticeEl.innerHTML = '';
  // 行き先が決まっていないリンクは出さない（押せてしまう空のリンクを作らない）
  bracketLinkEl.hidden = true;
  entrantsLinkEl.hidden = true;
  tournamentShareBtn.hidden = true;

  // 【仮置きは一番上の枠に、1つだけ】
  // 待っているあいだの仮置きは、JSが後から埋める枠のうち「一番上のもの」に置く。
  // ここを間違えると、待たせた時間ぶんそのまま画面が飛ぶ ── 以前は大会情報
  // （#tournament-info・ページの下のほう）に置いていたので、中身が届いた瞬間に
  // エントリーの導線と対戦表・出場選手への入口がその上に割り込み、仮置きが
  // 300px ほど下へ突き落とされていた（Lighthouse の CLS 0.19 はほぼこれ）。
  //
  // 一番上に置けば、届いた中身はその場で入れ替わり、続きは「まだ何も無い」
  // 下の空きに足されるだけになる。動くものが無いので、ずれようがない。
  // 逆に、下の枠は読み込み中は空のままにしておくこと。
  renderEntryCta(tournamentEntryCtaEl, null);
  tournamentEntryCtaEl.innerHTML = [
    '<div class="skeleton-line skeleton-panel skeleton-panel-cta"></div>',
    '<div class="skeleton-line skeleton-panel skeleton-panel-link"></div>',
    '<div class="skeleton-line skeleton-panel skeleton-panel-link"></div>',
  ].join('');
  tournamentEntryCtaEl.hidden = false;
  tournamentInfoEl.innerHTML = '';
}

// 大会詳細。対戦表（/tournaments/{id}/bracket/）と出場選手一覧（同 entrants/）は別ページに
// 分けてあり、ここにはそこへの入口だけを置く。
//
// 「誰が出ているか」はこのページで初めて必要になるので、ここで取りに行く
// （一覧では人数しか持っていない。js/state.js の説明を参照）。
async function renderTournamentDetail(tournamentId) {
  currentBracketTournamentId = tournamentId;
  setTournamentEditing(false);

  // 歯車の中身を、この大会の運営かどうかで入れ替える。大会は誰でも開けるので、
  // 出し分けは「サイトの運営か」ではなく「この大会の運営か」で決まる。
  //
  //   運営     … 大会情報を編集／大会を削除
  //   それ以外 … この大会を通報する（宛先はサイト全体の運営）
  const canManage = canManageTournament(tournamentId);
  syncTournamentManageMenu(tournamentId, canManage);
  // 別の大会を開いたときに開きっぱなしにしない
  setManageMenuOpen(false);
  // 共有は運営でなくても押せる。無い大会のときだけ、下で隠す。
  tournamentShareBtn.hidden = false;

  // 別の大会を開いたときに「コピーしました」の印が残らないよう、毎回戻す
  clearTimeout(shareBtnResetTimer);
  resetShareBtn();

  const tournament = state.tournaments.find((t) => t.id === tournamentId);
  if (!tournament) {
    // まだDBから何も届いていないなら「無い」とは言えない。ここで言い切ると、
    // 実在する大会を開いた人に「大会が見つかりません」が一瞬見える ── そのあと
    // 中身が出ても、最初に読んだ一言のほうが残る。
    if (!db.hasLoadedOnce()) {
      renderTournamentDetailLoading();
      return;
    }
    // 無い大会のリンクを配っても仕方がないので、ここだけは隠す
    tournamentShareBtn.hidden = true;
    renderHero(tournamentHeroEl, null);
    tournamentTitleEl.textContent = '大会が見つかりません';
    tournamentMetaEl.textContent = '';
    tournamentStatusChipEl.hidden = true;
    tournamentInfoEl.innerHTML = '<p class="empty-hint">この大会は存在しないか、削除されています。</p>';
    tournamentActionsEl.innerHTML = '';
    tournamentDraftNoticeEl.innerHTML = '';
    renderEntryCta(tournamentEntryCtaEl, null);
    bracketLinkEl.hidden = true;
    entrantsLinkEl.hidden = true;
    return;
  }

  try {
    await db.ensureTournamentDetail(tournamentId);
  } catch (err) {
    // 待たせるのをやめるので、仮置きも一緒に片付ける。残すと、灰色の帯が
    // 流れ続けたまま下に失敗の知らせが出て、まだ読み込み中に見える。
    renderEntryCta(tournamentEntryCtaEl, null);
    tournamentInfoEl.innerHTML = `<p class="empty-hint">${escapeHtml(err.message)}</p>`;
    return;
  }
  // 読み込んでいる間に別の画面へ移っていたら、そこへ古い内容を描かない
  if (!isCurrentRoute('tournament', tournamentId)) return;

  renderHero(tournamentHeroEl, tournament.imageUrl);
  tournamentTitleEl.textContent = tournament.name;

  // 状態はバッジが受け持つので、この行からは外す（同じことを2回言わない）。
  // 優勝者だけは状態ではなく結果なので、ここに残す。
  const champion = championOf(tournament);
  tournamentMetaEl.textContent = [
    tournamentWhenText(tournament.date) || '日付未設定',
    `${entrantCountLabel(tournament)}参加`,
    champion ? `優勝: ${champion}` : '',
  ].filter(Boolean).join(' ・ ');

  // 公開前は状態の言葉が無い（label が空）ので、タグごと出さない。
  // 空のタグを置くと、丸い印だけが意味もなく残る。
  const badge = tournamentBadge(tournament);
  tournamentStatusChipEl.hidden = !badge.label;
  tournamentStatusChipEl.className = `status-chip status-${badge.tone}`;
  tournamentStatusChipEl.textContent = badge.label;

  const back = backToListLink(tournament);
  tournamentBackLink.href = back.href;
  tournamentBackLink.textContent = back.text;

  // 対戦表がまだ組まれていない（募集中など）大会では、入口を出しても空のページに
  // 行き着くだけなので隠す。
  const hasBracket = state.bracketIds.has(tournamentId);
  bracketLinkEl.hidden = !hasBracket;
  if (hasBracket) {
    bracketLinkEl.href = pathFor('bracket', tournamentId);
    bracketLinkNoteEl.textContent = tournament.status === 'finished'
      ? '対戦表と最終結果'
      : '対戦表と進行状況';
  }

  // 出場選手一覧への入口。エントリーが1つも無いうちは、開いても空のページなので隠す。
  // シードが決まる前でも出す ── これから申し込む人が顔ぶれを見る場所でもあるため。
  const unit = isTeamTournament(tournament) ? 'チーム' : '選手';
  entrantsLinkEl.hidden = tournament.entrantIds.length === 0;
  if (!entrantsLinkEl.hidden) {
    entrantsLinkEl.href = pathFor('entrants', tournamentId);
    entrantsLinkTitleEl.textContent = `出場${unit}一覧を見る`;
    entrantsLinkNoteEl.textContent = tournament.status === 'recruiting' || tournament.status === 'draft'
      ? `エントリー中の${unit}を五十音順で（${entrantCountLabel(tournament)}）`
      : `出場${unit}を五十音順で（${entrantCountLabel(tournament)}）`;
  }

  const onChanged = async () => { await refreshFromDb(); };

  // 公開前の帯はページのいちばん上。ここに立てるのは運営だけ（DBが draft の行を
  // 運営以外に返さない。supabase/migration-022.sql）だが、念のため画面でも見る。
  tournamentDraftNoticeEl.innerHTML = '';
  if (tournament.status === 'draft' && canManageTournament(tournament.id)) {
    tournamentDraftNoticeEl.appendChild(draftNotice(tournament));
  }

  // エントリーの導線はページの上（見出しのすぐ下）。運営の募集操作は下のまま。
  renderEntryCta(tournamentEntryCtaEl, tournament, onChanged);
  renderTournamentActions(tournamentActionsEl, tournament, onChanged);

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

  if (!canManageTournament(tournamentId) || !canAdjustBracket(tournamentId)) {
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
    // 届く前に「無い」と言い切らない（renderTournamentDetailLoading と同じ理由）
    if (!db.hasLoadedOnce()) {
      // サーバーが題を先に入れていることがある（worker/index.js）。あれば残す。
      if (!bracketTitleEl.textContent.trim()) {
        bracketTitleEl.innerHTML = '<span class="skeleton-line skeleton-text"></span>';
      }
      bracketMetaEl.textContent = '';
      bracketOwnHintEl.hidden = true;
      bracketAdminToolsEl.hidden = true;
      bracketContainer.innerHTML = '';
      resultSectionEl.innerHTML = '';
      return;
    }
    bracketTitleEl.textContent = '大会が見つかりません';
    bracketMetaEl.textContent = '';
    bracketOwnHintEl.hidden = true;
    bracketAdminToolsEl.hidden = true;
    bracketContainer.innerHTML = '<p class="empty-hint">この大会は存在しないか、削除されています。</p>';
    resultSectionEl.innerHTML = '';
    bracketBackLink.href = pathFor('tournaments');
    bracketBackLink.textContent = '← 大会一覧へ';
    return;
  }

  bracketTitleEl.textContent = tournament.name;
  bracketMetaEl.textContent = [
    tournamentWhenText(tournament.date) || '日付未設定',
    `${entrantCountLabel(tournament)}参加`,
    tournamentStatusLabel(tournament),
  ].filter(Boolean).join(' ・ ');

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
  bracketOwnHintEl.hidden = !isParticipant || canManageTournament(tournamentId);
  if (!bracketOwnHintEl.hidden) {
    bracketOwnHintEl.textContent = '色の付いた行が自分の対戦です。画面下の「あなたの対戦」から、ルームコードの確認・対戦相手とのチャット・ゲームカウントの報告ができます。選手名を押すと、その選手のプロフィールが見られます。';
  }

  // 戻り先は大会詳細。ここへは詳細から来るため。
  bracketBackLink.href = pathFor('tournament', tournamentId);
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

  // 対戦表を描く部品は、このページを開いた人だけが取りに行く（生 56KB）。
  // DBの読み込みと同じく、待っている間に別の画面へ移っていないかを確かめ直す。
  const { renderBracket } = await loadBracketView();
  if (!isCurrentRoute('bracket', tournamentId)) return;

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
    readOnly: !canManageTournament(tournamentId),
    // 選手がゲームカウントを入力したあと。DBの関数側で書き込みが済んでいるので、
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
    if (canManageTournament(tournament.id)) {
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
    note.textContent = canManageTournament(tournament.id)
      ? 'すべての対戦が終わりました。内容を確認して「結果を確定する」を押すと、優勝者と最終順位が公開されます。'
      : 'すべての対戦が終わりました。運営が結果を確定するまでお待ちください。';
    box.appendChild(note);

    if (canManageTournament(tournament.id)) {
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

  const heading = document.createElement('h2');
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
      // 引けないときにIDを出さない（js/state.js の UNKNOWN_PLAYER_NAME を参照）
      const name = player ? player.currentName : UNKNOWN_PLAYER_NAME;
      return `
        <div class="player-identity">
          ${avatarHtml(player ?? { currentName: name }, 'sm')}
          <a href="${pathFor('player', id)}">${escapeHtml(name)}</a>
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

  if (canManageTournament(tournament.id)) {
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

function formatDateTime(iso) {
  const d = new Date(iso);
  return `${d.toLocaleDateString('ja-JP')} ${d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;
}

// ---------------------------------------------------------------------------
// プロフィール（選手ページ・マイページ）
// ---------------------------------------------------------------------------
//
// 【面を取り合わせない】以前はキャラクターの絵を「背景」として敷き、その上に
// 戦歴・ランク・登録情報を重ねていた。同じ面積を「絵を見せる」役と「数字を読ませる」役で
// 取り合う形になり、どちらも果たせていなかった ── 顔と上半身は戦歴カードの裏に隠れ、
// 透けた絵のせいで表の数字も読みにくかった。
// いまは面そのものを分けている。絵には絵だけの領域を渡し、文字はその外側にしか置かない。
// 重なりが無いので絵は透かす必要がなく、文字は無地の上に乗る。
//
// 【読む順を4段に決める】上から順に格が下がるよう並べ、格ごとに面を変える。
//
//   1. ヒーロー   選手名・ランク・メインキャラクター … 一番大きく、一番上
//   2. 直近の戦績 最新3件を札で                     … 数字より「何をした人か」
//   3. すべての戦歴 全件の表（畳んである）             … 調べたい人だけ開く
//   4. 設定・連絡先 編集ボタン・ID・SNS               … 小さく、色を落として
//
// マイページと選手ページは同じ部品で組む。マイページは「他の人からどう見えるか」の
// 確認場所なので、見た目が少しでも違うと確認にならない。

// 上の2段目「直近の戦績」に札で出す件数。全件は3段目の表が受け持つ。
const RECENT_RESULTS = 3;

// ヒーロー。絵の領域と文字の領域を隣り合わせに置き、決して重ねない。
//
// 【顔の安全領域】切り抜きは頭が必ず上端にある。絵を専用の升（.player-hero-art）に
// 入れて上詰めで置き、その升には他の要素を一切入れないことで、顔に何も重ならないことを
// 位置の計算ではなく構造として保証する。升の上には余白（--art-safe）を取って、
// カードの縁が頭に触れることも防ぐ。狭い画面でも升は隣に残す（下に積むと
// 一番格上の選手名が画面の外へ押し出されるため）。
//
// キャラクターは先頭の1人だけ。順番には意味があり（js/characterPicker.js）、
// 先頭が本人の名乗りだからで、複数枚を並べると誰の場所か分からなくなる。
// 登録していない人には何も出さない ── 代わりの絵を置くと、選んでいない人まで
// 選んだように見えてしまう。絵は装飾なので読み上げから外す。
// nameTag は置かれる場所で変わる。選手ページでは選手名がそのページの題なので h1、
// マイページでは題が「マイページ」なので h2 になる。
function playerHeroHtml(player, { nameTag = 'h1', action = '', extra = '', foot = '' } = {}) {
  const artUrl = characterImageUrl(player.mainCharacters?.[0], 'large');
  const rankEntry = state.publishedRanking?.rankings.find((r) => r.id === player.id);

  // ランクは公開済みランキングから引くので、戦歴の通信を待たずに出せる。
  let rankValue = 'ランキング対象外';
  let rankNote = '対象の大会に参加していません';
  if (state.publishedRanking) {
    if (rankEntry) {
      rankValue = `${rankEntry.rank}<span class="rank-unit">位</span>`;
      rankNote = `スコア ${rankEntry.score.toFixed(1)}`;
      if (rankEntry.previousRank !== undefined) {
        const { label, className } = rankChangeInfo(rankEntry.previousRank, rankEntry.rank);
        rankNote += ` <span class="rank-change ${className}">${label}</span>`;
      }
    } else {
      rankValue = '—';
      rankNote = '対象の大会に参加していません';
    }
  }

  // 名前・ランク・キャラクターは .player-hero-core にまとめる。この升が
  // 「選手名と順位の島」で、中身の並びと大きさの釣り合いは升の幅だけで決まる
  // （CSSの container-type と cqw。画面が広くなると釣り合いを保ったまま拡大する）。
  // 升の中は、名前が上段で横いっぱい、中段を左右に割って 左＝ランク・右＝キャラクター。
  // 絵を中段に置くのは「名前にかぶらない位置」を段で決めるため ── 座標で避けると、
  // 過去名の有無で名前の高さが変わったときにずれる。
  //
  // foot は自己紹介と直近の戦績。名前・ランクと同じ人の話なので同じ島に収める。
  // 置き場所は画面の広さで変わる（狭ければ升の下、広ければ升の横）。どちらでも
  // 区切り線は引く ── 升の中の左右の境目は線を引くと絵が板に見えるが、
  // こちらは文字と文字の境目なので、線があるほうが切れ目が分かる。
  return `
    <section class="player-hero${artUrl ? '' : ' has-no-art'}">
      <div class="player-hero-core">
        <div class="player-hero-id">
          ${avatarHtml(player, 'hero')}
          <div class="player-hero-names">
            <!-- title は、長い名前が「…」で切られたときに全体を読むための保険。
                 切らずに折り返すと2行になり、下の段の位置とカードの高さが
                 名前の長さで動いてしまう（CSSの .player-hero-name を参照）。 -->
            <${nameTag} class="player-hero-name" title="${escapeHtml(player.currentName)}">${escapeHtml(player.currentName)}</${nameTag}>
            ${player.pastNames.length
              ? `<p class="meta-line">過去名: ${escapeHtml(player.pastNames.slice(-2).join(', '))}</p>`
              : ''}
          </div>
          ${action}
        </div>
        <div class="player-hero-main">
          <div class="player-rank">
            <span class="player-rank-value">${rankValue}</span>
            <span class="player-rank-note">${rankNote}</span>
          </div>
          ${extra}
        </div>
        ${artUrl
          ? `<div class="player-hero-art" aria-hidden="true">
               <img src="${escapeHtml(artUrl)}" alt="" decoding="async">
             </div>`
          : ''}
      </div>
      ${foot ? `<div class="player-hero-foot">${foot}</div>` : ''}
    </section>`;
}

// 2段目。直近の大会3件を、順位を主役にした札で並べる。
//
// 表より先にこれを置くのは、プロフィールを開いた人がまず知りたいのが
// 「いま何位か」の次に「最近どこまで勝ったか」だから。表は全件を等しく並べるので、
// 一番新しい1件を探すのに目が要る。
// titleTag は置かれる場所で変わる。選手ページでは選手名（h1）のすぐ下なので h2、
// マイページではページの題（h1「マイページ」）→ 自分の名前（h2）の下なので h3。
function recentResultsHtml(stats, { titleTag = 'h2' } = {}) {
  if (!stats || stats.tournaments.length === 0) return '';

  const recent = [...stats.tournaments].reverse().slice(0, RECENT_RESULTS);
  const cards = recent.map((entry) => {
    // 優勝・準優勝・3位は金銀銅にする（ランキング表と同じ配色の考え方）。
    const rankClass = { 優勝: ' is-1st', 準優勝: ' is-2nd', '3位': ' is-3rd' }[entry.placement] ?? '';
    return `
      <a class="result-card${rankClass}" href="${pathFor('tournament', entry.tournament.id)}">
        <span class="result-place">${escapeHtml(entry.placement || '—')}</span>
        <span class="result-body">
          <span class="result-name">${escapeHtml(entry.tournament.name)}</span>
          <span class="result-meta">${escapeHtml(tournamentWhenText(entry.tournament.date) || '日付未定')}${
            entry.teamName ? `・${escapeHtml(entry.teamName)}` : ''}</span>
        </span>
      </a>`;
  }).join('');

  return `
    <section class="profile-block">
      <${titleTag} class="profile-block-title">直近の戦績</${titleTag}>
      <div class="result-cards">${cards}</div>
    </section>`;
}

// 3段目。全件の表。既定で畳んである ── ここまで見に来る人は少数で、
// 開いたままだと下の「設定」までが遠くなる。
// <details> を使うのは、開閉の状態も見た目も素のHTMLで足りるため。
function historyTableHtml(stats) {
  if (!stats) return '<p class="empty-hint">戦歴を読み込んでいます…</p>';
  if (stats.tournaments.length === 0) return '<p class="empty-hint">まだ大会に出場していません。</p>';

  const entries = [...stats.tournaments].reverse();
  return `
    <details class="profile-block history-block">
      <summary class="profile-block-title">すべての戦歴（${entries.length}件）</summary>
      <div class="table-scroll">
        <table>
          <thead><tr><th>大会</th><th>日付</th><th>結果</th></tr></thead>
          <tbody>
            ${entries.map((entry) => `
              <tr>
                <td>
                  <a href="${pathFor('tournament', entry.tournament.id)}">${escapeHtml(entry.tournament.name)}</a>
                  ${entry.teamName ? `<div class="meta-line">${escapeHtml(entry.teamName)}</div>` : ''}
                </td>
                <td>${escapeHtml(tournamentWhenText(entry.tournament.date) || '—')}</td>
                <td>${escapeHtml(entry.placement || '—')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </details>`;
}

// 4段目。連絡先と、自分のページなら編集への入口。
// 一番格が低いので、区切り線を引いて本文から離す。
function profileFooterHtml(player) {
  const meta = profileMetaHtml(player);
  return meta ? `<section class="profile-foot">${meta}</section>` : '';
}

// 戦績はこの選手のぶんだけ取りに行く（全選手の試合は手元に持っていない。
// js/db.js の loadPlayerRecord を参照）。
async function renderPlayerDetail(playerId) {
  // 【まず本人を取りに行くこと】この選手が手元にあるとは限らない。起動時に
  // 全選手を配るのをやめたので（js/db.js の loadAll）、URLから直接ここへ
  // 着地した場合、state.players はまだ空のこともある。
  // 「居ない」と言い切れるのは、取りに行って見つからなかったときだけ。
  playerDetailEl.innerHTML = '<div class="skeleton-line skeleton-panel"></div>';

  let record;
  try {
    // 3本まとめて投げる。直列にすると往復がそのぶん増え、表示が遅れる。
    //   本人の行     … 名前・アイコン・キャラクター（一覧用の列）
    //   自己紹介とSNS … 一覧の問い合わせには乗っていない（PLAYER_LIST_COLUMNS）
    //   戦績         … この選手の試合と出場記録
    // 運営の「プレイヤー名を変更」も、ここで詳細が揃っていることに頼っている
    // （揃っていないまま保存すると自己紹介が消えるので、db.savePlayer が弾く）。
    [record] = await Promise.all([
      db.loadPlayerRecord(playerId),
      db.ensurePlayers([playerId]),
      db.ensurePlayerDetail(playerId),
    ]);
  } catch (err) {
    playerDetailEl.innerHTML = `<p class="empty-hint">${escapeHtml(err.message)}</p>`;
    return;
  }
  if (!isCurrentRoute('player', playerId)) return;

  const player = state.players.find((p) => p.id === playerId);
  if (!player) {
    playerDetailEl.innerHTML = '<p class="empty-hint">選手が見つかりません。</p>';
    return;
  }

  const stats = getPlayerStats(playerId, record);
  const isOwn = auth.player?.id === playerId;
  const banned = isBannedPlayer(player);

  // 運営の操作。プレイヤー名の変更と、利用停止の切り替え。
  const adminActions = !isOwn && isAdmin()
    ? `<p class="meta-line row-actions">
         <button type="button" class="btn-secondary admin-rename-btn">プレイヤー名を変更</button>
         ${banned
           ? '<button type="button" class="btn-secondary admin-unban-btn">利用停止を解除</button>'
           : '<button type="button" class="btn-report admin-ban-btn">利用停止にする</button>'}
       </p>`
    : '';

  // 通報の入口。自分自身は通報できず、ログインして選手登録を済ませた人だけが押せる。
  // 既に通報していれば押せない札に変える（DB側も同じ相手への未対応の通報を1件に絞る）。
  let reportAction = '';
  if (!isOwn && !banned && auth.player && !isAdmin()) {
    reportAction = hasOpenReportFrom(auth.player.id, playerId)
      ? '<p class="meta-line report-done">通報済みです。運営が確認します。</p>'
      : '<p class="meta-line"><button type="button" class="btn-report player-report-btn">この選手を通報する</button></p>';
  }

  // 停止中であることは誰にでも出す（対戦表から辿り着いた人が、連絡がつかない理由を
  // 探して回らずに済む）。自己紹介とSNSのリンクは伏せる ── 停止の理由がそこに
  // 書かれていることが多く、残しておくと止めた意味が薄れる。
  const bannedNotice = banned
    ? '<p class="ban-notice">このアカウントは現在、利用を停止されています。過去の大会の記録はそのまま残しています。</p>'
    : '';

  playerDetailEl.innerHTML = playerHeroHtml(player, {
    action: isOwn
      ? `<a href="${pathFor('profile')}" class="profile-edit-link" title="プロフィールを編集する" aria-label="プロフィールを編集する">${iconSvg('pencil')}</a>`
      : '',
    extra: adminActions + reportAction,
    // 自己紹介と直近の戦績はヒーローの下段に入れる（同じ島）。
    // 全件の表だけは外に出す ── 開くと何十行にもなるので、島の中で伸ばすと
    // 名前とランクが画面の外へ流れていく。
    foot: bannedNotice + (banned ? '' : profileBioHtml(player)) + recentResultsHtml(stats),
  })
    + historyTableHtml(stats)
    + (banned ? '' : profileFooterHtml(player));

  // 通報する。押すとダイアログが開く（送信は下の reportForm の submit）。
  playerDetailEl.querySelector('.player-report-btn')?.addEventListener('click', () => {
    openReportDialog({ kind: 'player', id: player.id, name: player.currentName });
  });

  playerDetailEl.querySelector('.admin-ban-btn')?.addEventListener('click', (e) => {
    setBan(e.currentTarget, player.id, true);
  });
  playerDetailEl.querySelector('.admin-unban-btn')?.addEventListener('click', (e) => {
    setBan(e.currentTarget, player.id, false);
  });

  // プレイヤー名の変更。選手一覧の表からは外したので、運営はここから直す。
  // 代理登録された選手（本人のアカウントが無い人）を直せる唯一の経路でもある。
  const renameBtn = playerDetailEl.querySelector('.admin-rename-btn');
  if (renameBtn) {
    renameBtn.addEventListener('click', async () => {
      const input = prompt(`「${player.currentName}」の新しいプレイヤー名を入力してください。`, player.currentName);
      if (input === null) return;

      const result = updatePlayer(player.id, { currentName: input });
      if (!result.ok) {
        alert(result.error);
        return;
      }
      renameBtn.disabled = true;
      const ok = await persist(() => db.savePlayer(result.player), 'プレイヤー名の変更');
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
    routeFromLocation();
    // 開きっぱなしのチャットは画面の外にあるので、routeFromLocation では更新されない。
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
    // routeFromLocation の再描画対象外で、syncOpenChat もこれらには触らない
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

// 検索欄は打鍵ごとにDBへ投げるわけにいかない。予約だけして、入力が止まってから
// 1回投げる（js/util.js の createSearchRunner）。描き直しは応答が返ってから。
participantSearchInput.addEventListener('input', () => {
  runParticipantSearch(participantSearchInput.value);
});

playerSearchInput.addEventListener('input', () => {
  runPlayerSearch(playerSearchInput.value);
});

// 選手の通報。
//
// 状況の記入を必須にしているのは、理由の分類だけでは運営が判断できないため
// （DBの列は任意にしてあるが、画面では書いてもらう）。押し間違いで通報が
// 飛ばないようにする役目も兼ねている。
reportCancelBtn.addEventListener('click', closeReportDialog);
reportDialog.addEventListener('close', () => { reportTargetId = null; });

reportForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!reportTarget || !auth.player) return;

  const body = reportBodyInput.value.trim();
  if (!body) {
    reportFormErrorEl.textContent = '何があったかを書いてください。運営はこの内容だけを見て判断します。';
    reportBodyInput.focus();
    return;
  }

  reportFormErrorEl.textContent = '';
  reportSubmitBtn.disabled = true;

  const { kind, id } = reportTarget;
  const reason = reportReasonInput.value;
  const ok = await persist(
    () => (kind === 'tournament'
      ? db.reportTournament(id, auth.player.id, reason, body)
      : db.reportPlayer(id, auth.player.id, reason, body)),
    '通報の送信',
  );

  if (!ok) {
    reportSubmitBtn.disabled = false;
    return;
  }

  closeReportDialog();
  alert('通報を送信しました。運営が内容を確認します。');
  await refreshFromDb();
});

shuffleBtn.addEventListener('click', shuffleSelected);
seedByRankingBtn.addEventListener('click', seedBySelectedRanking);

// 参加者の集め方の切り替え（エントリー募集 / 運営が直接選ぶ）。
// ボタンの文言は変えない（index.html のその行の注記を参照）。
//
// 【状態を持たず、そのつどラジオを見ること】以前は変更のたびに直接 hidden を
// 書き換えていた。そのため、ラジオが別の道から変わったとき（書きかけの復元、
// 作成後のフォーム初期化）に選手を選ぶ欄だけが取り残され、「エントリーを募集する」
// なのに選手検索とシード順が出たままになっていた。
function syncEntryMode() {
  const mode = tournamentForm.elements['entry-mode']?.value;
  manualParticipantsEl.hidden = mode !== 'manual';
}

tournamentForm.addEventListener('change', (e) => {
  if (e.target.name !== 'entry-mode') return;
  syncEntryMode();
});

rankingRevealBtn.addEventListener('click', () => { navigate('reveal'); });

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
  }
  // 閉じた結果ラジオが変わることがあるので、欄の出し入れは必ず通す
  syncEntryMode();
}
tournamentMatchTypeInput.addEventListener('change', syncEntryModeForMatchType);

// 大会作成は項目が多く、途中で他のアプリへ移ることもある。書きかけを控えておく。
// 選んだ参加者（selectedParticipantIds）は入力欄ではないので控えの対象外。
const TOURNAMENT_DRAFT_KEY = 'tournament-create';
keepFormDraft(tournamentForm, TOURNAMENT_DRAFT_KEY);
// 控えを戻すとラジオも戻る。欄の出し入れはラジオを見て決めているので、
// 戻し終えたこの時点で一度そろえておく（でないと、前回「運営が直接選ぶ」で
// 離れた人の画面が、募集の設定なのに選手検索を出したままになる）。
syncEntryMode();

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

  const entryDeadline = readDeadline(tournamentDeadlineInput);
  if (entryDeadline === INVALID_DEADLINE) return;

  const tournament = {
    id: newId(),
    name,
    // datetime-local が返すのは地域時刻の文字列。DBは timestamptz なので、
    // 時差を持ったISOに直してから渡す（そのまま渡すと、サーバー側の時間帯で
    // 読まれて9時間ずれる）。
    date: fromDateTimeLocalValue(tournamentDateInput.value),
    format: 'single_elim',
    matchType,
    matchTypeNote: matchType === 'other' ? tournamentMatchTypeNoteInput.value.trim() : '',
    // ランキングに反映させるか。外した場合は条件を満たしていてもスコアに入らない
    // （js/rankingEligibility.js）。あとから大会情報の編集で変えられる。
    rankingOptIn: tournamentRankingOptInInput.checked,
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
    // 締切も募集のための値。運営が参加者を直接選ぶ大会には募集そのものが無い
    entryDeadline: manual ? null : entryDeadline,
    // 作った大会は必ず準備中（＝非公開）から始まる。募集の開始も、参加者を直に
    // 選んだ大会の開始も、運営が大会ページで「公開」を押したときに起きる
    // （js/entries.js の adminControls）。作った瞬間に世に出ると、打ち間違いも
    // 決めかねている日付もそのまま広まってしまい、取り消しがきかない。
    // DB側も draft の行を運営以外に返さない（supabase/migration-022.sql）。
    status: 'draft',
    createdBy: auth.player?.id ?? null,
    // この経路は個人戦専用（2v2は上で弾いている）なので、出場枠＝選手で同じ配列になる
    entrantIds: manual ? [...selectedParticipantIds] : [],
    // 選んだ並びがそのままシード順（replaceEntries が index+1 で書き込む）
    entrantSeeds: manual ? selectedParticipantIds.map((_, i) => i + 1) : [],
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
    // 作った本人はDB側のトリガで必ず運営に入る。ここで足すのは、その上で
    // 指名した人だけ（自分を含めて渡しても on conflict で二重にはならない）。
    if (organizerPicker) {
      await db.setTournamentOrganizers(tournament.id, organizerPicker.selectedIds());
    }
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
  tournamentRankingOptInInput.checked = true;
  // 集め方も既定（エントリーを募集する）に戻す。戻さないと、次に大会を作る人の
  // 画面が「運営が直接選ぶ」のまま開き、選手検索とシード順が出たままになる。
  tournamentForm.elements['entry-mode'].value = 'recruit';
  syncMatchTypeNote();
  syncEntryModeForMatchType();
  tournamentCapacityInput.value = '';
  tournamentDeadlineInput.value = '';
  tournamentRulesInput.value = '';
  tournamentStreamInput.value = '';
  tournamentThirdPlaceInput.checked = false;
  tournamentImagePicker.setCurrent('');
  ensureCreateOrganizerPicker({ reset: true });
  selectedParticipantIds = [];
  // 作れたので下書きは用済み（残すと次に大会を作るとき前回の内容が入ってくる）
  clearFormDraft(TOURNAMENT_DRAFT_KEY);

  await refreshFromDb();
  // 作り終えたら、作り方に関わらずその大会のページへ。公開の操作はそこにあり、
  // 一覧へ戻しても（まだ非公開なので）運営以外には何も無いページに見える。
  navigate('tournament', tournament.id);
});

// 大会の共有リンク。大会ページのURLそのものを配る。
//
// 以前は専用の /t/{id} を配っていた。ハッシュ（#tournament/xxx）ではサーバーに
// どの大会かが届かず、og: を返す口を別に用意するしかなかったため。いまは
// /tournaments/{id}/ に Worker が直接 og: を埋めて返すので、その必要がない
// （worker/index.js）。古い /t/{id} は301でここへ送られる。
//
// origin から組み立てるのは、配信先（独自ドメイン・*.workers.dev・wrangler dev）に
// 依存しないため。
function tournamentShareUrl(tournamentId) {
  return `${location.origin}${pathFor('tournament', tournamentId)}`;
}

let shareBtnResetTimer = null;

// 共有ボタンは矢印のアイコンだけで出す。編集・削除と違って押しても何も壊れず、
// 箱から出ていく矢印は共有シートと同じ絵なので、文字が無くても伝わる。
function resetShareBtn() {
  setButtonIcon(tournamentShareBtn, 'share', '共有');
}

// 押した結果をアイコンの差し替えで返す。共有シートが開く端末では何も言わなくても
// 分かるが、コピーは黙って終わると「押せたのか」が分からない。
// 読み上げ用のラベルも一緒に変えて、絵の変化を見られない人にも同じことを伝える。
function flashShareBtn(name, label) {
  setButtonIcon(tournamentShareBtn, name, label);
  clearTimeout(shareBtnResetTimer);
  shareBtnResetTimer = setTimeout(resetShareBtn, 1800);
}

tournamentShareBtn.addEventListener('click', async () => {
  const tournament = state.tournaments.find((t) => t.id === currentBracketTournamentId);
  if (!tournament) return;
  const url = tournamentShareUrl(tournament.id);

  // スマートフォンでは端末の共有シートを出す（そこからXやDiscordへ直接送れる）。
  // 途中でやめたときは AbortError で戻ってくるので、失敗として扱わない。
  if (navigator.share) {
    try {
      await navigator.share({ title: tournament.name, url });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
      // 共有シートが使えなかっただけなので、下のコピーに落とす
    }
  }

  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(url);
    flashShareBtn('check', 'リンクをコピーしました');
  } catch {
    // クリップボードは http 接続や許可の無い環境では使えない。
    // その場合は選んでコピーできる形で見せるところまでやる。
    window.prompt('このURLをコピーしてください', url);
  }
});

// ---- 大会の管理（歯車） ----
//
// 編集と削除は、大会に一度あるかどうかの操作で、しかも削除は取り返しがつかない。
// 出しっぱなしにすると「共有」や「エントリー」と同じ大きさで常に並ぶことになるので、
// 歯車の中にしまい、開けた人にだけ見せる。
//
// ダイアログ（<dialog>）にしないのは、押す場所のすぐ下に出したいため。画面の中央に
// 出てくると、どのボタンから開いたものかが一度視線を切らないと分からない。

setButtonIcon(tournamentManageBtn, 'gear', '大会の管理');

function setManageMenuOpen(open) {
  tournamentManageList.hidden = !open;
  tournamentManageBtn.setAttribute('aria-expanded', String(open));
  // 閉じるときに中にフォーカスが残っていると、キーボードだけの人が
  // 見えないボタンの上に取り残される。開くのに使った歯車へ戻す。
  if (!open && tournamentManageList.contains(document.activeElement)) tournamentManageBtn.focus();
}

tournamentManageBtn.addEventListener('click', () => {
  setManageMenuOpen(tournamentManageList.hidden);
});

// 外を触ったら閉じる。中の項目を押したときは、それぞれの処理のあとで閉じる
// （ここで先に閉じると、確認ダイアログが出る前に一覧が消えて落ち着かない）。
document.addEventListener('click', (e) => {
  if (tournamentManageList.hidden) return;
  if (e.target.closest('#tournament-manage')) return;
  setManageMenuOpen(false);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setManageMenuOpen(false);
});

// 大会を離れたら閉じておく（削除したときは行き先が大会一覧になる）
window.addEventListener(ROUTE_CHANGE_EVENT, () => setManageMenuOpen(false));

tournamentEditBtn.addEventListener('click', () => {
  const tournament = state.tournaments.find((t) => t.id === currentBracketTournamentId);
  if (!tournament) return;
  setManageMenuOpen(false);
  tournamentEditNameInput.value = tournament.name;
  // datetime-local は地域時刻の 'YYYY-MM-DDTHH:MM' しか受け付けない。
  // DBが持っているISO文字列をそのまま入れると、欄が空のままになる。
  tournamentEditDateInput.value = toDateTimeLocalValue(tournament.date);
  tournamentEditMatchTypeInput.value = tournament.matchType || '';
  tournamentEditMatchTypeNoteInput.value = tournament.matchTypeNote || '';
  tournamentEditRankingOptInInput.checked = tournament.rankingOptIn !== false;
  syncEditMatchTypeNote();
  tournamentEditCapacityInput.value = tournament.capacity ?? '';
  tournamentEditDeadlineInput.value = deadlineInputValue(tournament.entryDeadline);
  tournamentEditRulesInput.value = tournament.rules || '';
  tournamentEditStreamInput.value = tournament.streamUrl || '';
  tournamentEditImagePicker.setCurrent(tournament.imageUrl || '');
  // 運営の欄は開くたびに建て直す。いま入っている顔ぶれを見せる必要があり、
  // 別の大会を開いたときに前の大会の顔ぶれが残っていては困るため。
  //
  // 外せないのは「自分がいま運営に入っているとき」だけ。サイト全体の運営が
  // 他人の大会を直しているときは自分が名簿に居ないので、その場合は何も固定しない。
  const currentOrganizers = organizerIdsOf(tournament.id);
  editOrganizerPicker = mountOrganizerPicker(tournamentEditOrganizersEl, {
    selectedIds: currentOrganizers,
    lockedId: currentOrganizers.includes(auth.player?.id) ? auth.player.id : null,
  });
  // 保存済みの内容を入れ終えてから下書きを重ねる（書きかけがあればそちらが勝つ）
  keepFormDraft(tournamentEditForm, `tournament-edit-${tournament.id}`);
  setTournamentEditing(tournamentEditForm.hidden);
});

tournamentEditCancelBtn.addEventListener('click', () => {
  // 「キャンセル」は書きかけを捨てる操作なので、控えも一緒に捨てる
  clearFormDraft(`tournament-edit-${currentBracketTournamentId}`);
  setTournamentEditing(false);
});

tournamentEditForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (!tournamentEditMatchTypeInput.value) {
    alert('対戦方法を選んでください。');
    return;
  }

  const streamUrl = readStreamUrl(tournamentEditStreamInput);
  if (streamUrl === INVALID_URL) return;

  const entryDeadline = readDeadline(tournamentEditDeadlineInput);
  if (entryDeadline === INVALID_DEADLINE) return;

  const capacityRaw = tournamentEditCapacityInput.value.trim();
  const result = updateTournament(currentBracketTournamentId, {
    name: tournamentEditNameInput.value,
    date: fromDateTimeLocalValue(tournamentEditDateInput.value),
    matchType: tournamentEditMatchTypeInput.value,
    matchTypeNote: tournamentEditMatchTypeNoteInput.value,
    rankingOptIn: tournamentEditRankingOptInInput.checked,
    rules: tournamentEditRulesInput.value,
    streamUrl,
    capacity: capacityRaw === '' ? null : Number(capacityRaw),
    entryDeadline,
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
    if (editOrganizerPicker) {
      await db.setTournamentOrganizers(tournament.id, editOrganizerPicker.selectedIds());
    }
    // 差し替え・削除で使われなくなった画像は消しておく。失敗しても保存は済んでいる。
    if (previousImage && previousImage !== tournament.imageUrl) {
      await db.removeImageByUrl(previousImage).catch(() => {});
    }
  }, '大会情報の保存');
  if (ok) {
    clearFormDraft(`tournament-edit-${currentBracketTournamentId}`);
    setTournamentEditing(false);
    // 運営を入れ替えたことを、自分の画面にも反映させる（自分を外した場合は
    // 編集ボタンごと消える）。
    await refreshFromDb();
  }
  renderTournamentDetail(currentBracketTournamentId);
});

// この大会を通報する（その大会の運営でない人にだけ、歯車の中に出る）。
// 宛先はサイト全体の運営で、その大会の運営には届いたことも見えない。
tournamentReportBtn.addEventListener('click', () => {
  const tournament = state.tournaments.find((t) => t.id === currentBracketTournamentId);
  if (!tournament || !auth.player) return;
  setManageMenuOpen(false);
  openReportDialog({ kind: 'tournament', id: tournament.id, name: tournament.name });
});

tournamentDeleteBtn.addEventListener('click', async () => {
  const tournament = state.tournaments.find((t) => t.id === currentBracketTournamentId);
  if (!tournament) return;
  const ready = confirm(`大会「${tournament.name}」と、その試合結果をすべて削除します。よろしいですか？`);
  // やめたときも閉じる。開いたままでは、いま何を押したのかが残って見える
  setManageMenuOpen(false);
  if (!ready) return;

  // ブラケット・試合・エントリーは外部キーのカスケードで一緒に消える
  const imageUrl = tournament.imageUrl || '';
  const ok = await persist(() => db.deleteTournament(currentBracketTournamentId), '大会の削除');
  if (!ok) return;
  if (imageUrl) await db.removeImageByUrl(imageUrl).catch(() => {});
  await refreshFromDb();
  navigate('tournaments');
});

// 「はじめに」の目次。ページ内の移動なので、URLは変えずにスクロールで運ぶ。
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
    navigate('home');
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
// 開閉状態は routeFromLocation では触らない。背景の自動更新でも routeFromLocation は
// 走るため、そこで閉じると開いた直後に勝手に畳まれてしまう。
// 実際にURLが変わったとき（route-change）と、リンクを押したときだけ閉じる。

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

// メニューの中の×。押した後のフォーカスは setNavOpen が開くボタンへ戻す
navCloseBtn.addEventListener('click', () => setNavOpen(false));

// 今いるページと同じリンクを押した場合は route-change が起きないので、ここでも閉じる
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

// 画面が変わったらメニューは畳む。描き直しそのものは router.js が
// routeFromLocation を呼んで行うので、ここでは呼ばない。
window.addEventListener(ROUTE_CHANGE_EVENT, () => setNavOpen(false));

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
document.addEventListener('chat-reports-changed', () => routeFromLocation());

// ---- 起動 ----

async function start() {
  // SNSやDMに残っている旧形式のURL（#tournament/xxx）で着地した人を、先に
  // 新しいパスへ書き換える。ハッシュはサーバーに送られないので、この読み替えは
  // ブラウザの中でしかできない ── サーバー側の301では拾えない。
  //
  // ルーティングを動かすより前に済ませること。後にすると、ハッシュ付きのURLは
  // パスとしては「/」なので、一瞬ホームが描かれてから目的のページへ飛ぶ。
  migrateLegacyUrl();

  // リンクの横取りと、戻る・進むの受け取りを始める。描くのは routeFromLocation。
  startRouter(routeFromLocation);

  // 接続先が未設定のまま動かすと、原因の分かりにくいネットワークエラーが出続けるので
  // 先に止めて、何をすればよいかを画面に出す（supabase/SETUP.md の手順3）。
  if (!isConfigured()) {
    setStatus('Supabaseの接続先が未設定です。supabase/SETUP.md の手順3にしたがって js/supabaseClient.js を設定してください。', 'error');
    loginBtn.disabled = true;
    return;
  }

  // 【この画面が要るデータの問い合わせを、ここで先に始める】
  //
  // 大会詳細・出場者一覧・対戦表は、どれも loadAll では中身が届かない
  // （増え続けるデータなので、開いた大会のぶんだけ取りに行く作りになっている）。
  // これまではページを描く段になって初めて投げていたので、回線の往復が
  //     HTML → app.js → loadAll → この2〜3本
  // と3回、順番待ちで並んでいた。実測（Slow 4G・大会詳細）では loadAll の最後が
  // 届くのが 5.47秒、そこから投げ直して 6.11秒 ── 中身は2KBも無いのに、
  // 往復1回ぶん（約640ms）がまるまる待ち時間だった。
  //
  // 必要な大会IDはURLに入っているので、起動した瞬間から分かる。ここで投げておけば
  // loadAll と同時に流れ、往復が1回減る。実際に中身を使うのはこれまでどおり
  // ページを描くところ（db.js の ensure〜 が、ここで始めた問い合わせを待つ）。
  //
  // 【認証より前に置くこと】initAuth はログイン状態が確定するまで戻らないので、
  // 後ろに置くとその待ち時間ぶんだけ出遅れる。
  //
  // 認証より先に投げても、ログイン中の人がログアウト扱いになることはない。
  // supabase-js は問い合わせを送る直前に auth.getSession() を呼んで
  // Authorization ヘッダーを組み立てる（vendor/supabase.js の fetchWithAuth と
  // _getAccessToken）ので、トークンは initAuth の完了ではなく localStorage から
  // 決まる。準備中（draft）の大会も、その運営が開けばこれまでどおり中身が返る
  // ── ここを「どうせ誰でも読めるから」で済ませてはいけない。draft の
  // エントリーは RLS（is_tournament_visible）で運営にしか返らない。
  //
  // OAuth から戻ってきた直後（?code= 付き）と競合しないのは、戻り先が常に
  // トップだから（supabaseClient.js の redirectUrl）。下の3ページには着地しない。
  {
    const { page, param } = currentRoute();
    if (param && (page === 'tournament' || page === 'entrants' || page === 'bracket')) {
      db.prefetchTournamentDetail(param);
      // 試合結果を使うのは対戦表だけ。大会詳細でも取りに行くと、開かない人にも
      // 配ることになる（開いた分だけ読む、という方針がここで崩れる）。
      if (page === 'bracket') db.prefetchTournamentMatches(param);
    }
  }

  // ログイン状態が変わるたびに、UIの出し分けと表示中ページの描画をやり直す
  //
  // ここで例外を外へ逃がさないこと。逃がすと start() ごと止まり、この下の
  // refreshFromDb も Realtime の購読も走らないまま、ヘッダーだけが出た画面で
  // 固まる ── ログアウトボタンも効かないので、利用者には手の打ちようがなくなる。
  // 認証が確かめられなくても、閲覧だけならログイン無しで成立する作りなので、
  // 未ログインとして先へ進めたほうがましになる。
  try {
    await initAuth(() => {
      applyAuthUI();
      routeFromLocation();

      // ログインしたのに選手行が無い＝新規登録がまだ。そのまま登録フォームへ案内する。
      if (needsOnboarding() && currentRoute().page !== 'profile') {
        navigate('profile');
      }
    });
  } catch (err) {
    console.error('[start] 認証の初期化に失敗', err);
    setStatus(`ログイン状態を確認できませんでした（${err.message}）。未ログインとして表示します。`, 'error');
    applyAuthUI();
    routeFromLocation();
  }

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

    // 入力中は描き直しを持ち越す。routeFromLocation は編集中のフォームを閉じてしまうため。
    if (reportsRenderPending && !isUserTyping()) {
      reportsRenderPending = false;
      routeFromLocation();
    }
  }, REPORT_POLL_MS);
}

start();

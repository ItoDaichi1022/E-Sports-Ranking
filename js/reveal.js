// 順位発表の画面（運営専用・#reveal）。順位発表動画の収録と、配信での生発表に使う。
//
// ランキングの表（js/rankingView.js）は「調べる」ための見せ方で、
// 上から順に全員が一度に目に入る。発表はその逆で、1人ぶんだけを大きく出し、
// 次を見せない ── 順位を伏せたまま下から積み上げるのが発表の作り方だからだ。
// 表に演出を足すのではなく画面ごと分けてあるのはこのため。
//
// 【担当範囲】この画面が作るのは「カードの見た目と動き」まで。
// BGM・実況・試合クリップは録ったあとの編集作業で重ねる。
//
// 【好成績3件をどう出しているか】公開済みスナップショット（published_rankings.data）は
// 好成績を1件しか持っていない。増やすためにデータ形式を変えると過去の公開ぶんが
// 古い形のまま取り残されるので、ここでは保存済みの値を使わず、集計期間から
// その場で3件を選び直している（playerStats.js の topAchievements）。
// おかげで、いつ公開したスナップショットに対しても同じ3件が出る。

import { state } from './state.js';
import { escapeHtml, safeUrl, initialOf } from './util.js';
import {
  computeRankingsForRange, withRankChange, rankChangeInfo, tournamentIdsInRange,
} from './ranking.js';
import { topAchievements } from './playerStats.js';
import { CHARACTERS, characterImageUrl, representativeRef } from './characters.js';
import { CHARACTER_FOCUS, DEFAULT_FOCUS } from './characterFocus.js';
import * as db from './db.js';

const $ = (id) => document.getElementById(id);

// 収録する画の寸法。この寸法で組んでから、画面に合わせてまるごと縮める
// （文字の大きさをpxで直に書けるので、収録解像度が変わってもレイアウトがずれない）。
const STAGE_WIDTH = 1920;
const STAGE_HEIGHT = 1080;

// 1人あたりに並べる好成績の件数。
const ACHIEVEMENT_COUNT = 3;

const setupEl = $('reveal-setup');
const statusEl = $('reveal-status');
const sampleToggle = $('reveal-sample-toggle');
const sourceControlsEl = $('reveal-source-controls');
const startInput = $('reveal-start-input');
const endInput = $('reveal-end-input');
const playerListEl = $('reveal-player-list');
const countEl = $('reveal-count');
const startBtn = $('reveal-start-btn');
const stageEl = $('reveal-stage');
const canvasEl = $('reveal-canvas');

// 準備画面で選ばれている選手のID。ランキングを引き直しても選択を保つために
// 一覧の描き直しとは別に持っておく（期間を少し動かしただけで選び直しになると使えない）。
const selectedIds = new Set();

// いま発表中の並び（発表順に並べ替え済み）と、その何人目を出しているか。
let playing = null;

// ランキング反映対象の大会がまだ無い時期でも、発表画面の見た目とアニメーションだけを
// 確認できるようにする架空データの表示モード。DBには一切書き込まない。
// 発表画面には「SAMPLE DATA」の札を出し、収録に紛れ込んでも気付けるようにしてある。
let sampleMode = false;

function radioValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value;
}

function setRevealStatus(text, type) {
  statusEl.textContent = text ?? '';
  statusEl.className = `status-line${type ? ` ${type}` : ''}`;
}

// ---------------------------------------------------------------------------
// サンプルデータ（架空のランキング）
// ---------------------------------------------------------------------------
//
// 名前・大会名・順位・スコア・好成績はすべて架空で、実在の選手や大会とは無関係。
// 立ち絵だけは実在のキャラクター素材を順番に割り当てて使う（架空の絵を用意できないため）。
// わざと崩れやすい条件を混ぜてある ── とても長い選手名・大会名（1行に収まるか）、
// 好成績が0件の選手（欄が空でも崩れないか）、順位変動の4パターン全部（▲▼―NEW）。
const SAMPLE_PLAYERS = [
  { name: 'サンプル選手A', score: 100.0, previousRank: 2, achievements: [
    { label: '優勝', tournamentName: 'サンプルカップ #12 サマーシリーズ', participantCount: 32, tier: 'Tier 4' },
    { label: 'ベスト4', tournamentName: '架空杯 2026', participantCount: 64, tier: 'Tier 5' },
    { label: '準優勝', tournamentName: '月例サンプル大会 #8', participantCount: 24, tier: 'Tier 3' },
  ] },
  { name: 'サンプル選手B', score: 96.8, previousRank: 1, achievements: [
    { label: '準優勝', tournamentName: 'サンプルカップ #12 サマーシリーズ', participantCount: 32, tier: 'Tier 4' },
    { label: 'ベスト8', tournamentName: '月例サンプル大会 #6', participantCount: 30, tier: 'Tier 3' },
  ] },
  { name: 'サンプル選手C', score: 91.2, previousRank: 3, achievements: [
    { label: 'ベスト4', tournamentName: '架空杯 2026', participantCount: 64, tier: 'Tier 5' },
  ] },
  { name: 'サンプル選手D', score: 85.0, previousRank: null, achievements: [] },
  { name: 'とても長い名前の架空プレイヤーです2026', score: 79.4, previousRank: 8, achievements: [
    { label: 'ベスト8', tournamentName: 'これもとても長い名前の架空トーナメント2026チャンピオンシップ', participantCount: 48, tier: 'Tier 4' },
  ] },
  { name: 'サンプル選手F', score: 73.1, previousRank: 4, achievements: [
    { label: 'ベスト16', tournamentName: '月例サンプル大会 #7', participantCount: 30, tier: 'Tier 3' },
    { label: 'ベスト8', tournamentName: '架空杯 2026', participantCount: 64, tier: 'Tier 5' },
  ] },
  { name: 'サンプル選手G', score: 68.5, previousRank: 7, achievements: [
    { label: 'ベスト16', tournamentName: 'サンプルカップ #11', participantCount: 28, tier: 'Tier 3' },
  ] },
  { name: 'サンプル選手H', score: 62.0, previousRank: null, achievements: [] },
  { name: 'サンプル選手I', score: 57.3, previousRank: 6, achievements: [
    { label: 'ベスト16', tournamentName: '月例サンプル大会 #5', participantCount: 24, tier: 'Tier 3' },
  ] },
  { name: 'サンプル選手J', score: 51.9, previousRank: 11, achievements: [
    { label: 'ベスト8', tournamentName: 'サンプルカップ #10', participantCount: 26, tier: 'Tier 3' },
    { label: 'ベスト16', tournamentName: '架空杯 2025', participantCount: 56, tier: 'Tier 5' },
  ] },
  { name: 'サンプル選手K', score: 47.2, previousRank: 9, achievements: [
    { label: 'ベスト16', tournamentName: '月例サンプル大会 #4', participantCount: 20, tier: 'Tier 2' },
  ] },
  { name: 'サンプル選手L', score: 42.0, previousRank: 12, achievements: [] },
];

function sampleEntries() {
  const refs = CHARACTERS.map((c) => representativeRef(c));
  return SAMPLE_PLAYERS.map((p, i) => {
    // 何人かはメイン+サブ複数キャラを持たせて、サブキャラクター表示（列の崩れ・
    // 3人目以降を切り詰める挙動）もサンプルモードで確認できるようにする。
    // subCount: 0=メインのみ 〜 3=メイン+サブ3人（characterColumnHtml側で2人に切り詰められる）。
    const subCount = i % 4;
    const mainCharacters = Array.from({ length: subCount + 1 }, (_, k) => refs[(i + k) % refs.length]);
    return {
      id: `sample-${i}`,
      name: p.name,
      score: p.score,
      rank: i + 1,
      previousRank: p.previousRank,
      tournamentsPlayed: Math.max(p.achievements.length, 1),
      achievements: p.achievements,
      // cardElement はこれを見つけると、実在の選手を探しに行かずこちらを使う。
      samplePlayer: { currentName: p.name, avatarUrl: null, mainCharacters },
    };
  });
}

// ---------------------------------------------------------------------------
// 準備画面
// ---------------------------------------------------------------------------

// いま選ばれている集計期間。公開中のランキングを発表するときは、その公開時の期間を使う
// （好成績を選ぶ対象を、順位の根拠になった期間とそろえるため）。
function currentRange() {
  if (radioValue('reveal-source') === 'published') {
    const published = state.publishedRanking;
    return { start: published?.periodStart ?? null, end: published?.periodEnd ?? null };
  }
  return { start: startInput.value || null, end: endInput.value || null };
}

// 発表の対象になるランキング（順位の昇順）。
// 公開中のものはスナップショットをそのまま使う ── 発表するのは「公開した順位」であって、
// いま計算し直した順位ではない。
function currentRankings() {
  if (sampleMode) return sampleEntries();
  if (radioValue('reveal-source') === 'published') {
    return state.publishedRanking?.rankings ?? [];
  }
  const { rankings } = computeRankingsForRange(state, currentRange());
  return withRankChange(rankings, state.publishedRanking?.rankings);
}

// 順位変動を出せるか。古い形式で公開したスナップショットは previousRank を持っておらず、
// そのまま渡すと全員が NEW になってしまう（rankingView.js の showChange と同じ判定）。
function hasRankChange(rankings) {
  return rankings.some((r) => r.previousRank !== undefined);
}

function changeBadgeHtml(entry, showChange) {
  if (!showChange) return '';
  const { label, className } = rankChangeInfo(entry.previousRank, entry.rank);
  return `<span class="rank-change ${className}">${label}</span>`;
}

function renderPlayerPicker() {
  const rankings = currentRankings();
  const showChange = hasRankChange(rankings);

  if (rankings.length === 0) {
    playerListEl.innerHTML = '<p class="empty-hint">'
      + 'この条件では発表できるランキングがありません。期間を変えるか、先にランキングを公開してください。</p>';
    updateStartButton();
    return;
  }

  // 一覧に無くなった選手（期間を変えて圏外になった等）の選択は落とす。
  // 残しておくと「3人選択中」と出ているのに2人しか出ない、という食い違いになる。
  const availableIds = new Set(rankings.map((r) => r.id));
  [...selectedIds].forEach((id) => { if (!availableIds.has(id)) selectedIds.delete(id); });

  playerListEl.innerHTML = rankings.map((r) => `
    <label class="reveal-player-row">
      <input type="checkbox" value="${escapeHtml(r.id)}"${selectedIds.has(r.id) ? ' checked' : ''}>
      <span class="reveal-player-rank">${r.rank}</span>
      <span class="reveal-player-name">${escapeHtml(r.name)}</span>
      <span class="reveal-player-score">${r.score.toFixed(1)}</span>
      ${changeBadgeHtml(r, showChange)}
    </label>
  `).join('');

  updateStartButton();
}

function updateStartButton() {
  countEl.textContent = String(selectedIds.size);
  startBtn.disabled = selectedIds.size === 0;
}

// 上位n人に絞る。'all' は全員、'none' は全解除。
function applyPreset(preset) {
  const rankings = currentRankings();
  selectedIds.clear();
  if (preset !== 'none') {
    const limit = preset === 'all' ? rankings.length : Number(preset);
    rankings.slice(0, limit).forEach((r) => selectedIds.add(r.id));
  }
  renderPlayerPicker();
}

// 画面を開いたときの入口。集計にも好成績の選び直しにも全期間の試合結果が要るので、
// ここで初めて全データを読み込む（js/app.js の openRankingEditor と同じ理由）。
export async function renderRevealPage() {
  closeStage();
  setupEl.hidden = false;

  setRevealStatus('集計データを読み込んでいます...', 'loading');
  startBtn.disabled = true;
  try {
    await db.ensureFullData();
  } catch (err) {
    setRevealStatus(err.message, 'error');
    return;
  }
  setRevealStatus('');

  // 期間を指定する側の初期値は、公開中のランキングの期間に合わせておく
  // （そこから少し動かして試す、という使い方が多いため）。
  const published = state.publishedRanking;
  if (!startInput.value && published?.periodStart) startInput.value = published.periodStart;
  if (!endInput.value && published?.periodEnd) endInput.value = published.periodEnd;

  // 初めて開いたときだけ、既定として上位10人を選んでおく。
  if (selectedIds.size === 0) applyPreset('10');
  else renderPlayerPicker();
}

// ---------------------------------------------------------------------------
// 発表画面
// ---------------------------------------------------------------------------

// キャラクター立ち絵の「顔（目のあたり）」の位置。
//
// js/characters.js の focusStyle と同じ表を引くが、あちらの上下左右のクランプは
// 「行の高さしか無い細長い窓」のためのもので、ここでは要らない。この画面の絵は
// 画面の高さいっぱいに出すので、顔が絵の端に寄っている素材でも切れない。
function focusPosition(ref) {
  const [x, y] = CHARACTER_FOCUS[ref] ?? DEFAULT_FOCUS;
  return `${x}% ${y}%`;
}

function achievementRowHtml(achievement) {
  return `
    <li class="reveal-achievement">
      <span class="reveal-achievement-label">${escapeHtml(achievement.label)}</span>
      <span class="reveal-achievement-name">${escapeHtml(achievement.tournamentName)}</span>
      <span class="reveal-achievement-meta">${escapeHtml(achievement.tier)}</span>
    </li>
  `;
}

// 集計期間の出場大会が少ない選手は、好成績が1〜2件しか無いことも0件のこともある。
// 0件のときに見出しだけ残して欄を空にすると崩れて見えるので、代わりの1行を出す。
function achievementsListHtml(achievements) {
  if (achievements.length === 0) {
    return '<p class="reveal-achievements-empty">この期間の記録はまだありません</p>';
  }
  return `<ul>${achievements.map(achievementRowHtml).join('')}</ul>`;
}

// 使用キャラクターの列に出す絵。先頭（メイン）は大きく、2人目以降はサブとして
// 小さい札に並べる。3人目以降まで並べると1枚が小さくなりすぎるので、
// サブは最大2人ぶんまでに絞る（メイン1 + サブ2 = 最大3人ぶん表示）。
function characterColumnHtml(mainCharacters) {
  const refs = (mainCharacters ?? []).filter(Boolean);
  if (refs.length === 0) return '';

  const [mainRef, ...subRefs] = refs;
  const mainUrl = characterImageUrl(mainRef, 'large');
  if (!mainUrl) return '';

  const subsHtml = subRefs.slice(0, 2).map((ref) => {
    const url = characterImageUrl(ref, 'thumb');
    if (!url) return '';
    return `<div class="reveal-chara-sub"><img src="${escapeHtml(url)}" alt="" style="object-position:${focusPosition(ref)}"></div>`;
  }).join('');

  return `
    <div class="reveal-chara">
      <div class="reveal-chara-main">
        <img src="${escapeHtml(mainUrl)}" alt="" style="object-position:${focusPosition(mainRef)}">
      </div>
      ${subsHtml ? `<div class="reveal-chara-subs">${subsHtml}</div>` : ''}
    </div>
  `;
}

function cardElement(entry) {
  // サンプルデータ（架空の選手）は実在の選手を探しに行かず、架空の中身をそのまま使う。
  const player = entry.samplePlayer ?? state.players.find((p) => p.id === entry.id);
  // 公開済みランキングは公開時点の名前しか持っていないので、アイコンとキャラクターは
  // いまの選手の情報から引き、名前はランキングに記録された値を使う
  // （rankingView.js の rankingAvatar と同じ考え方）。
  const photoUrl = safeUrl(player?.avatarUrl);

  const card = document.createElement('div');
  card.className = `reveal-card${entry.rank <= 3 ? ` rank-${entry.rank}` : ''}`;
  card.innerHTML = `
    <div class="reveal-header">
      <p class="reveal-rank"><span class="reveal-rank-num">${entry.rank}</span><span class="reveal-rank-unit">位</span></p>
      <p class="reveal-name"><span>${escapeHtml(entry.name)}</span></p>
      <p class="reveal-score">
        <span class="reveal-score-label">SCORE</span>
        <span class="reveal-score-value">${entry.score.toFixed(1)}</span>
        ${changeBadgeHtml(entry, entry.previousRank !== undefined)}
      </p>
    </div>
    <div class="reveal-row">
      <div class="reveal-photo">
        ${photoUrl
    ? `<img src="${escapeHtml(photoUrl)}" alt="">`
    : `<span class="reveal-photo-fallback">${escapeHtml(initialOf(entry.name))}</span>`}
      </div>
      ${characterColumnHtml(player?.mainCharacters)}
      <div class="reveal-achievements">
        <p class="reveal-achievements-head">好成績</p>
        ${achievementsListHtml(entry.achievements)}
      </div>
    </div>
  `;
  return card;
}

// 画面の大きさに合わせて、1920×1080の画をまるごと縮める。
function fitStage() {
  const scale = Math.min(window.innerWidth / STAGE_WIDTH, window.innerHeight / STAGE_HEIGHT);
  canvasEl.style.setProperty('--reveal-scale', String(scale));
}

// いま出すべき1人を描く。
//
// クラスの付け外しではなく要素ごと作り直す。CSSアニメーションは同じ要素に同じ
// クラスを付け直しても再生されず（reflowを挟む小細工が要る）、「Rでやり直す」が
// 効かないことがあるため。1枚ぶんの組み立てなので作り直しても軽い。
function drawCurrent() {
  canvasEl.replaceChildren(cardElement(playing.entries[playing.index]));
}

function closeStage() {
  if (!playing) return;
  playing = null;
  stageEl.hidden = true;
  stageEl.classList.remove('is-sample');
  setupEl.hidden = false;
  canvasEl.replaceChildren();
  document.body.classList.remove('reveal-playing');
  document.removeEventListener('keydown', onStageKey);
  window.removeEventListener('resize', fitStage);
}

// 発表画面を閉じる（js/app.js が、別のページへ移るときにも呼ぶ）。
export function closeRevealStage() {
  closeStage();
}

function onStageKey(e) {
  if (!playing) return;
  const key = e.key;

  if (key === 'Escape') { closeStage(); return; }

  // 画面をめくる操作。Space はそのままだとページを送ってしまうので止める。
  if (key === ' ' || key === 'Spacebar' || key === 'ArrowRight' || key === 'Enter') {
    e.preventDefault();
    // 最後の1人でさらに進めても閉じない。発表しきったあとも画を出したまま
    // 締めの言葉を入れられるようにしておく（終わるのは Esc）。
    if (playing.index < playing.entries.length - 1) {
      playing.index += 1;
      drawCurrent();
    }
    return;
  }

  if (key === 'ArrowLeft') {
    e.preventDefault();
    if (playing.index > 0) {
      playing.index -= 1;
      drawCurrent();
    }
    return;
  }

  // 撮り直し。いまの1人を頭から流し直す。
  if (key === 'r' || key === 'R') {
    e.preventDefault();
    drawCurrent();
  }
}

function startPresentation() {
  // 選んだ選手だけを、発表順に並べる。好成績はここで初めて選ぶ
  // （全員ぶんを先に計算しても、出さない人のぶんは捨てるだけ）。
  // サンプルデータは好成績も作り物を最初から持っているので、選び直さない
  // （topAchievements は実在の大会・出場記録を見に行くので、架空のIDでは何も引けない）。
  const order = radioValue('reveal-order');
  let entries = currentRankings().filter((r) => selectedIds.has(r.id));
  if (!sampleMode) {
    const tournamentIds = tournamentIdsInRange(state, currentRange());
    entries = entries.map((r) => ({ ...r, achievements: topAchievements(r.id, tournamentIds, ACHIEVEMENT_COUNT) }));
  }
  entries = entries.sort((a, b) => (order === 'countdown' ? b.rank - a.rank : a.rank - b.rank));

  if (entries.length === 0) return;

  playing = { entries, index: 0 };
  setupEl.hidden = true;
  stageEl.hidden = false;
  stageEl.classList.toggle('is-sample', sampleMode);
  document.body.classList.add('reveal-playing');
  document.addEventListener('keydown', onStageKey);
  window.addEventListener('resize', fitStage);
  fitStage();
  drawCurrent();
}

// ---------------------------------------------------------------------------
// 配線
// ---------------------------------------------------------------------------

setupEl.addEventListener('change', (e) => {
  const target = e.target;

  if (target.name === 'reveal-source') {
    // 日付欄は「期間を指定」のときだけ触れるようにする。公開中のランキングを
    // 発表するときに日付をいじれると、動かしても何も変わらず戸惑わせるため。
    const useRange = target.value === 'range';
    startInput.disabled = !useRange;
    endInput.disabled = !useRange;
    renderPlayerPicker();
    return;
  }

  if (target === startInput || target === endInput) {
    renderPlayerPicker();
    return;
  }

  if (target.type === 'checkbox') {
    if (target.checked) selectedIds.add(target.value);
    else selectedIds.delete(target.value);
    updateStartButton();
  }
});

setupEl.addEventListener('click', (e) => {
  const preset = e.target.closest('[data-reveal-preset]')?.dataset.revealPreset;
  if (preset) applyPreset(preset);
});

// サンプルデータのON/OFF。「発表するランキング」欄（公開中／期間指定）はサンプル中は
// 意味を持たないので隠す。選択中の選手はどちらの世界でもID体系が違う（sample-0 等）ので、
// 切り替えるたびに選び直しにして、実在しない選手が選ばれたままになるのを防ぐ。
sampleToggle.addEventListener('change', () => {
  sampleMode = sampleToggle.checked;
  sourceControlsEl.hidden = sampleMode;
  applyPreset('10');
});

startBtn.addEventListener('click', startPresentation);

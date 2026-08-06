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
import { escapeHtml, avatarHtml } from './util.js';
import {
  computeRankingsForRange, withRankChange, rankChangeInfo, tournamentIdsInRange,
} from './ranking.js';
import { topAchievements } from './playerStats.js';
import { characterImageUrl } from './characters.js';
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

function radioValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value;
}

function setRevealStatus(text, type) {
  statusEl.textContent = text ?? '';
  statusEl.className = `status-line${type ? ` ${type}` : ''}`;
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
      <span class="reveal-achievement-meta">${achievement.participantCount}名参加・${escapeHtml(achievement.tier)}</span>
    </li>
  `;
}

function cardElement(entry) {
  const player = state.players.find((p) => p.id === entry.id);
  // 公開済みランキングは公開時点の名前しか持っていないので、アイコンとキャラクターは
  // いまの選手の情報から引き、名前はランキングに記録された値を使う
  // （rankingView.js の rankingAvatar と同じ考え方）。
  const ref = player?.mainCharacters?.[0];
  const artUrl = characterImageUrl(ref, 'large');

  const card = document.createElement('div');
  card.className = `reveal-card${entry.rank <= 3 ? ` rank-${entry.rank}` : ''}`;
  card.innerHTML = `
    <div class="reveal-art">
      ${artUrl
    ? `<img src="${escapeHtml(artUrl)}" alt="" style="object-position:${focusPosition(ref)}">`
    : ''}
    </div>
    <div class="reveal-body">
      <p class="reveal-rank"><span class="reveal-rank-num">${entry.rank}</span><span class="reveal-rank-unit">位</span></p>
      <p class="reveal-name">
        ${avatarHtml({ ...player, currentName: entry.name }, 'reveal')}
        <span>${escapeHtml(entry.name)}</span>
      </p>
      <p class="reveal-score">
        <span class="reveal-score-label">SCORE</span>
        <span class="reveal-score-value">${entry.score.toFixed(1)}</span>
        ${changeBadgeHtml(entry, entry.previousRank !== undefined)}
      </p>
      <div class="reveal-achievements">
        <p class="reveal-achievements-head">好成績</p>
        <ul>${entry.achievements.map(achievementRowHtml).join('')}</ul>
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
  const range = currentRange();
  const tournamentIds = tournamentIdsInRange(state, range);

  // 選んだ選手だけを、発表順に並べる。好成績はここで初めて選ぶ
  // （全員ぶんを先に計算しても、出さない人のぶんは捨てるだけ）。
  const order = radioValue('reveal-order');
  const entries = currentRankings()
    .filter((r) => selectedIds.has(r.id))
    .sort((a, b) => (order === 'countdown' ? b.rank - a.rank : a.rank - b.rank))
    .map((r) => ({ ...r, achievements: topAchievements(r.id, tournamentIds, ACHIEVEMENT_COUNT) }));

  if (entries.length === 0) return;

  playing = { entries, index: 0 };
  setupEl.hidden = true;
  stageEl.hidden = false;
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

startBtn.addEventListener('click', startPresentation);

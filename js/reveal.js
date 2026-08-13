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
// その場で3件を選び直している。おかげで、いつ公開したスナップショットに対しても
// 同じ3件が出る。
//
// 選ぶ基準は順位（優勝・ベスト4）ではなく「スコアをどれだけ押し上げたか」で、
// 計算はランキング本体と同じ式を使う（js/ranking.js の scoreContributionsByPlayer）。
// 発表しているのはスコア順のランキングなので、その根拠になった大会を並べないと
// 「なぜこの順位なのか」の説明にならない ── 少人数の大会での優勝より、
// 強豪ぞろいの大会で上位に食い込んだほうがスコアには効いている。

import { state, findTournament, UNKNOWN_PLAYER_NAME } from './state.js';
import { escapeHtml, safeUrl, initialOf } from './util.js';
import {
  computeRankingsForRange, withRankChange, rankChangeInfo,
  scoreContributionsByPlayer, filterMatchesByRange,
} from './ranking.js';
import { placementLabelOf } from './playerStats.js';
import { tournamentTier } from './tournamentTier.js';
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

// 「発表する選手」の一覧に出す上限。選手が増えるほど一覧は長くなるが、
// 発表は1人ずつ順に見せるもので、100人ぶんを流す収録はまず無い。
// 目で探せる長さに区切っておく（発表できるのもここに出ている人まで）。
const PICKER_LIMIT = 100;

const setupEl = $('reveal-setup');
const statusEl = $('reveal-status');
const sampleToggle = $('reveal-sample-toggle');
const sourceControlsEl = $('reveal-source-controls');
const startInput = $('reveal-start-input');
const endInput = $('reveal-end-input');
const publishBtn = $('reveal-publish-btn');
const publishedStatusEl = $('reveal-published-status');
const playerListEl = $('reveal-player-list');
const countEl = $('reveal-count');
const startBtn = $('reveal-start-btn');
const stageEl = $('reveal-stage');
const canvasEl = $('reveal-canvas');
const slotEl = $('reveal-slot');
const bgEl = $('reveal-bg');
const bgBackEl = $('reveal-bg-b');

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
// 名前・大会名・順位・スコアはすべて架空で、実在の選手や大会とは無関係。
// 立ち絵だけは実在のキャラクター素材を順番に割り当てて使う（架空の絵を用意できないため）。
// わざと崩れやすい条件を混ぜてある ── とても長い選手名・大会名（1行に収まるか）、
// 順位変動の4パターン全部（▲▼―NEW）、大会画像が未登録の大会（頭がそろうか）。
//
// 【全員ぶん3件そろえてある理由】発表画面は「スコアを押し上げた大会」を3件出す画で、
// 3件並んだときの見え方こそ確かめたいもの。実データ側も、スコアに効いた大会を
// 試合から拾うので3件そろうのが普通になっている。件数が足りない選手の見え方
// （.reveal-achievements-empty の1行）は実データ側にだけ残る道で、ここでは作らない。
//
// 大会画像は実在の大会を持てないので、サイトに同梱した画像を借りて充てている。
// ?v= は index.html と同じ版数に合わせること（/img/* は _headers で1年 immutable。
// 付け忘れると、絵を差し替えても古いものが配られ続ける）。
const SAMPLE_ART_A = '/img/game-logo.webp?v=180';
const SAMPLE_ART_B = '/img/icon.webp?v=180';

const SAMPLE_PLAYERS = [
  { name: 'サンプル選手A', score: 100.0, previousRank: 2, achievements: [
    { label: '優勝', tournamentName: 'サンプルカップ #12 サマーシリーズ', participantCount: 32, tier: 'Tier 4', imageUrl: SAMPLE_ART_A },
    { label: 'ベスト4', tournamentName: '架空杯 2026', participantCount: 64, tier: 'Tier 5', imageUrl: SAMPLE_ART_B },
    { label: '準優勝', tournamentName: '月例サンプル大会 #8', participantCount: 24, tier: 'Tier 3' },
  ] },
  { name: 'サンプル選手B', score: 96.8, previousRank: 1, achievements: [
    { label: '準優勝', tournamentName: 'サンプルカップ #12 サマーシリーズ', participantCount: 32, tier: 'Tier 4', imageUrl: SAMPLE_ART_A },
    { label: 'ベスト8', tournamentName: '月例サンプル大会 #6', participantCount: 30, tier: 'Tier 3', imageUrl: SAMPLE_ART_B },
    { label: 'ベスト4', tournamentName: '架空杯 2025', participantCount: 56, tier: 'Tier 5', imageUrl: SAMPLE_ART_A },
  ] },
  { name: 'サンプル選手C', score: 91.2, previousRank: 3, achievements: [
    { label: 'ベスト4', tournamentName: '架空杯 2026', participantCount: 64, tier: 'Tier 5', imageUrl: SAMPLE_ART_B },
    { label: '準優勝', tournamentName: '月例サンプル大会 #9', participantCount: 28, tier: 'Tier 3', imageUrl: SAMPLE_ART_A },
    { label: 'ベスト8', tournamentName: 'サンプルカップ #11', participantCount: 28, tier: 'Tier 3' },
  ] },
  { name: 'サンプル選手D', score: 85.0, previousRank: null, achievements: [
    { label: 'ベスト8', tournamentName: 'サンプルカップ #12 サマーシリーズ', participantCount: 32, tier: 'Tier 4', imageUrl: SAMPLE_ART_A },
    { label: 'ベスト16', tournamentName: '架空杯 2026', participantCount: 64, tier: 'Tier 5', imageUrl: SAMPLE_ART_B },
    { label: 'ベスト4', tournamentName: '月例サンプル大会 #7', participantCount: 30, tier: 'Tier 3', imageUrl: SAMPLE_ART_A },
  ] },
  { name: 'とても長い名前の架空プレイヤーです2026', score: 79.4, previousRank: 8, achievements: [
    { label: 'ベスト8', tournamentName: 'これもとても長い名前の架空トーナメント2026チャンピオンシップ', participantCount: 48, tier: 'Tier 4', imageUrl: SAMPLE_ART_A },
    { label: '準優勝', tournamentName: '月例サンプル大会 #6', participantCount: 30, tier: 'Tier 3', imageUrl: SAMPLE_ART_B },
    { label: 'ベスト16', tournamentName: '架空杯 2026', participantCount: 64, tier: 'Tier 5' },
  ] },
  { name: 'サンプル選手F', score: 73.1, previousRank: 4, achievements: [
    { label: 'ベスト16', tournamentName: '月例サンプル大会 #7', participantCount: 30, tier: 'Tier 3', imageUrl: SAMPLE_ART_B },
    { label: 'ベスト8', tournamentName: '架空杯 2026', participantCount: 64, tier: 'Tier 5', imageUrl: SAMPLE_ART_A },
    { label: '3位', tournamentName: 'サンプルカップ #10', participantCount: 26, tier: 'Tier 3', imageUrl: SAMPLE_ART_B },
  ] },
  { name: 'サンプル選手G', score: 68.5, previousRank: 7, achievements: [
    { label: 'ベスト16', tournamentName: 'サンプルカップ #11', participantCount: 28, tier: 'Tier 3', imageUrl: SAMPLE_ART_A },
    { label: 'ベスト8', tournamentName: '月例サンプル大会 #5', participantCount: 24, tier: 'Tier 3', imageUrl: SAMPLE_ART_B },
    { label: 'ベスト32', tournamentName: '架空杯 2026', participantCount: 64, tier: 'Tier 5', imageUrl: SAMPLE_ART_A },
  ] },
  { name: 'サンプル選手H', score: 62.0, previousRank: null, achievements: [
    { label: 'ベスト16', tournamentName: '架空杯 2025', participantCount: 56, tier: 'Tier 5', imageUrl: SAMPLE_ART_B },
    { label: 'ベスト8', tournamentName: '月例サンプル大会 #4', participantCount: 20, tier: 'Tier 2', imageUrl: SAMPLE_ART_A },
    { label: 'ベスト32', tournamentName: 'サンプルカップ #12 サマーシリーズ', participantCount: 32, tier: 'Tier 4' },
  ] },
  { name: 'サンプル選手I', score: 57.3, previousRank: 6, achievements: [
    { label: 'ベスト16', tournamentName: '月例サンプル大会 #5', participantCount: 24, tier: 'Tier 3', imageUrl: SAMPLE_ART_B },
    { label: 'ベスト32', tournamentName: '架空杯 2026', participantCount: 64, tier: 'Tier 5', imageUrl: SAMPLE_ART_A },
    { label: 'ベスト8', tournamentName: 'サンプルカップ #11', participantCount: 28, tier: 'Tier 3', imageUrl: SAMPLE_ART_B },
  ] },
  { name: 'サンプル選手J', score: 51.9, previousRank: 11, achievements: [
    { label: 'ベスト8', tournamentName: 'サンプルカップ #10', participantCount: 26, tier: 'Tier 3', imageUrl: SAMPLE_ART_A },
    { label: 'ベスト16', tournamentName: '架空杯 2025', participantCount: 56, tier: 'Tier 5' },
    { label: 'ベスト16', tournamentName: '月例サンプル大会 #6', participantCount: 30, tier: 'Tier 3', imageUrl: SAMPLE_ART_B },
  ] },
  { name: 'サンプル選手K', score: 47.2, previousRank: 9, achievements: [
    { label: 'ベスト16', tournamentName: '月例サンプル大会 #4', participantCount: 20, tier: 'Tier 2', imageUrl: SAMPLE_ART_B },
    { label: 'ベスト32', tournamentName: '架空杯 2026', participantCount: 64, tier: 'Tier 5', imageUrl: SAMPLE_ART_A },
    { label: 'ベスト16', tournamentName: 'サンプルカップ #12 サマーシリーズ', participantCount: 32, tier: 'Tier 4', imageUrl: SAMPLE_ART_B },
  ] },
  { name: 'サンプル選手L', score: 42.0, previousRank: 12, achievements: [
    { label: 'ベスト32', tournamentName: '架空杯 2025', participantCount: 56, tier: 'Tier 5', imageUrl: SAMPLE_ART_A },
    { label: 'ベスト16', tournamentName: 'サンプルカップ #10', participantCount: 26, tier: 'Tier 3', imageUrl: SAMPLE_ART_B },
    { label: 'ベスト8', tournamentName: '月例サンプル大会 #4', participantCount: 20, tier: 'Tier 2' },
  ] },
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

// 選べる（＝発表できる）選手。上位 PICKER_LIMIT 人まで。
// 一覧・プリセット・発表の開始がすべてこれを見るので、画面に出ていない選手が
// 発表に混ざることはない。
function pickerRankings() {
  return currentRankings().slice(0, PICKER_LIMIT);
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

// 候補に出す選手の名前を、必要になった時点で取りに行く。
//
// 【集計に全選手は要らない】ランキングの計算に使うのは選手IDとスコアだけで、
// 名前が要るのはここに並べる人と、実際に発表する人だけ ── 発表は10〜50人。
// 全選手を配ってしまうと、登録者が増えるほどこの画面を開くだけで重くなる。
//
// 一度頼んだIDは覚えておく。覚えないと、取ったあとの描き直しでもう一度頼み、
// 終わらない繰り返しになる（消された選手はいつまでも手元に来ないため）。
const pickerNamesRequested = new Set();

// 名前がまだ届いていない行の見せ方。
//
// 【(不明) を一瞬でも出さないこと】まだ取りに行っている最中というだけなのに、
// あの文字は「その選手は消えた」と読める。順位とスコアは先に出せるので、
// 名前の欄だけを待ちの姿にしておく。
function pickerName(entry) {
  return entry.name === UNKNOWN_PLAYER_NAME ? '…' : entry.name;
}

function fillPickerNames(rankings) {
  const ids = rankings
    .map((r) => r.id)
    .filter((id) => id && !pickerNamesRequested.has(id));
  if (ids.length === 0) return;

  ids.forEach((id) => pickerNamesRequested.add(id));
  db.ensurePlayers(ids)
    .then(() => renderPlayerPicker())
    .catch((err) => setRevealStatus(err.message, 'error'));
}

function renderPlayerPicker() {
  // 集計はここで一度だけ。切り詰めた件数を知るために全体の長さも要る
  // （pickerRankings を呼ぶと同じ集計をもう一度回すことになる）。
  const all = currentRankings();
  const rankings = all.slice(0, PICKER_LIMIT);
  const showChange = hasRankChange(rankings);

  // 名前が揃っていなければ取りに行く（届いたらここへ戻ってくる）。
  // 先に描いてから頼むので、順位とスコアは待たずに出る。
  fillPickerNames(rankings);

  if (rankings.length === 0) {
    playerListEl.innerHTML = '<p class="empty-hint">'
      + 'この条件では発表できるランキングがありません。期間を変えるか、先にランキングを公開してください。</p>';
    updateStartButton();
    return;
  }

  // 一覧に無くなった選手（期間を変えて圏外になった等）の選択は落とす。
  // 残しておくと「3人選択中」と出ているのに2人しか出ない、という食い違いになる。
  // 上限からあふれた選手もここで落ちる（画面に出ていない人は発表もしない）。
  const availableIds = new Set(rankings.map((r) => r.id));
  [...selectedIds].forEach((id) => { if (!availableIds.has(id)) selectedIds.delete(id); });

  const limitNote = all.length > PICKER_LIMIT
    ? `<p class="reveal-player-note">上位${PICKER_LIMIT}人まで表示しています`
      + `（該当${all.length}人）。発表できるのはこの中からです。</p>`
    : '';

  playerListEl.innerHTML = limitNote + rankings.map((r) => `
    <label class="reveal-player-row">
      <input type="checkbox" value="${escapeHtml(r.id)}"${selectedIds.has(r.id) ? ' checked' : ''}>
      <span class="reveal-player-rank">${r.rank}</span>
      <span class="reveal-player-name">${escapeHtml(pickerName(r))}</span>
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

// 上位n人に絞る。'none' は全解除。
function applyPreset(preset) {
  selectedIds.clear();
  if (preset !== 'none') {
    pickerRankings().slice(0, Number(preset)).forEach((r) => selectedIds.add(r.id));
  }
  renderPlayerPicker();
}

// 画面を開いたときの入口。集計にも好成績の選び直しにも全期間の試合結果が要るので、
// ここで初めて全データを読み込む（js/app.js の openRankingEditor と同じ理由）。
export async function renderRevealPage() {
  closeStage();
  setupEl.hidden = false;

  // 背景動画をここで読み込み始める。index.html では data-src に伏せてあるので、
  // この画面（運営専用）を開くまで15MBを取りに行かない。
  // 発表を始めてから読むと最初の「第〇位」が背景なしで出てしまうので、
  // 選手を選んでいるあいだに裏で読ませておく。
  //
  // 2本目は1本目に続けて読ませる。同時に始めると同じ15MBを2回取りに行きかねないが、
  // 1本目が流せる状態になってからなら実体はブラウザのキャッシュにある
  // （/video/* は _headers で1年 immutable）。継ぎ目で初めて読み始めるのでは
  // 間に合わないので、ここで先に用意しておく。
  if (bgEl.dataset.src && !bgEl.src) {
    bgEl.src = bgEl.dataset.src;
    bgEl.addEventListener('canplay', () => {
      if (!bgBackEl.src) bgBackEl.src = bgEl.dataset.src;
    }, { once: true });
  }

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

  renderPublishedStatus();

  // 初めて開いたときだけ、既定として上位10人を選んでおく。
  if (selectedIds.size === 0) applyPreset('10');
  else renderPlayerPicker();
}

// ---------------------------------------------------------------------------
// 「前回の順位」の保存
//
// サイトにランキングの表は無い（順位はお知らせで発表する）。それでも保存の仕組みが
// 要るのは、順位変動（▲▼―NEW）と選手ページのランクが「前回の順位」を必要とするため。
// 集計してから発表するまでの間に上書きすると発表の数字と食い違うので、
// 押すのは発表を終えたあと、という向きを画面の注記でも書いてある。
// 書けるのはサイトの持ち主だけ（DBの rankings_write が is_owner() を要求する）。
// ---------------------------------------------------------------------------

// 'YYYY-MM-DD' をそのまま「〇年〇月〇日」にする。new Date(文字列) を経由すると
// タイムゾーンの解釈次第で日付がずれかねないので、文字列を直接分解する。
function jaDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${y}年${m}月${d}日`;
}

function periodRangeLabel(start, end) {
  if (!start && !end) return '全期間';
  return `${start ? jaDate(start) : ''}〜${end ? jaDate(end) : ''}`;
}

function renderPublishedStatus() {
  const published = state.publishedRanking;
  if (!published) {
    publishedStatusEl.textContent = '「前回の順位」はまだ保存されていません。';
    return;
  }
  const label = published.periodStart || published.periodEnd
    ? periodRangeLabel(published.periodStart, published.periodEnd)
    : '全期間';
  const at = new Date(published.publishedAt);
  publishedStatusEl.textContent = `前回の順位: ${label}`
    + `（${at.getFullYear()}年${at.getMonth() + 1}月${at.getDate()}日 保存）`;
}

async function publishCurrentRanking() {
  if (sampleMode) {
    setRevealStatus('サンプルデータは保存できません。', 'error');
    return;
  }
  const range = currentRange();
  if (range.start && range.end && range.start > range.end) {
    setRevealStatus('開始日が終了日より後になっています。', 'error');
    return;
  }

  const { periodStart, periodEnd, rankings } = computeRankingsForRange(state, range);
  if (rankings.length === 0) {
    setRevealStatus('この期間に確定した試合がまだないため、保存できません。', 'error');
    return;
  }
  if (!confirm(
    `${periodRangeLabel(periodStart, periodEnd)}の集計を「前回の順位」として保存します。`
    + '\n\n次に集計したときの順位変動は、この順位が基準になります。よろしいですか？',
  )) return;

  // 保存時点の「前回」を各エントリに焼き込んでおく。あとから見ても
  // 「そのとき何位から動いたのか」が分かるようにするため。
  const snapshot = {
    publishedAt: new Date().toISOString(),
    periodStart,
    periodEnd,
    rankings: withRankChange(rankings, state.publishedRanking?.rankings),
  };

  publishBtn.disabled = true;
  try {
    await db.publishRanking(snapshot);
  } catch (err) {
    setRevealStatus(err.message, 'error');
    publishBtn.disabled = false;
    return;
  }
  publishBtn.disabled = false;

  state.publishedRanking = snapshot;
  setRevealStatus('「前回の順位」を保存しました。', 'success');
  renderPublishedStatus();
  renderPlayerPicker();
}

// ---------------------------------------------------------------------------
// 発表画面
// ---------------------------------------------------------------------------

// キャラクター立ち絵の「顔（目のあたり）」の位置を、CSSに渡せる形で返す。
//
// キャラクターの枠は、メインもサブも絵を枠より大きく引き伸ばして満たす（cover）。
// はみ出す分をどこで切るかで出来がまるで変わるので（素材のポーズはバラバラで、
// 顔が真ん中にある保証がない）、この (--fx, --fy) の点が枠の同じ位置に来るように
// 置いて、顔を必ず枠の中に残す。組み方は css/characters.css の .row-art img と同じ。
//
// js/characters.js の focusStyle と同じ表を引くが、あちらの上下左右のクランプは
// 掛けない。あれは「行の高さしか無い細長い窓」のためのもので、こちらの窓は
// ほぼ正方形なので、顔が絵の端に寄っている素材でもそのまま中心へ持ってこられる。
function focusVars(ref) {
  const [x, y] = CHARACTER_FOCUS[ref] ?? DEFAULT_FOCUS;
  return `--fx:${x}%;--fy:${y}%`;
}

// 大会の画像。運営が登録した画像は Supabase の絶対URLなので safeUrl がそのまま通す。
// サンプルデータだけは、実在の大会を持てないのでサイトに同梱した画像を指す
// （safeUrl は絶対URLしか通さないため、こちらだけ別に許す）。
function achievementImageUrl(value) {
  if (!value) return null;
  if (value.startsWith('/img/')) return value;
  return safeUrl(value);
}

// 好成績の1行。並びは 大会画像 → 大会名 → 順位 → Tier。
// 画像が未登録の大会でも枠だけは残す ── 詰めると行ごとに大会名の頭がずれて、
// 3行が表に見えなくなる。
function achievementRowHtml(achievement) {
  const artUrl = achievementImageUrl(achievement.imageUrl);
  return `
    <li class="reveal-achievement">
      <span class="reveal-achievement-art">
        ${artUrl ? `<img src="${escapeHtml(artUrl)}" alt="">` : ''}
      </span>
      <span class="reveal-achievement-name">${escapeHtml(achievement.tournamentName)}</span>
      <span class="reveal-achievement-place">${escapeHtml(achievement.label)}</span>
      <span class="reveal-achievement-meta">${escapeHtml(achievement.tier)}</span>
    </li>
  `;
}

// 集計期間の出場大会が少ない選手は、好成績が1〜2件しか無いことも0件のこともある。
// 0件のときに欄ごと消すと下の段がずれるので、代わりの1行を出す。
function achievementsListHtml(achievements) {
  if (achievements.length === 0) {
    return '<p class="reveal-achievements-empty">この期間の記録はまだありません</p>';
  }
  return `<ul>${achievements.map(achievementRowHtml).join('')}</ul>`;
}

// 発表に出す好成績。スコアを押し上げた大会の順（js/ranking.js の
// scoreContributionsByPlayer）に選び、表示に要る名前・画像・順位・規模を大会から引き直す。
//
// 順位は「表が組まれていて結果が確定した大会」でしか出せない（placementLabelOf）。
// 出せないときは勝敗で代える ── スコアに効いた大会である以上、試合は必ずしているので、
// 欄が空のまま残ることはない。
function achievementsOf(playerId, contributions) {
  const rows = contributions.get(playerId) ?? [];
  return rows.slice(0, ACHIEVEMENT_COUNT).map((row) => {
    const tournament = findTournament(row.tournamentId);
    const depth = state.placements[row.tournamentId]?.[playerId] ?? null;
    return {
      label: placementLabelOf(row.tournamentId, depth) ?? `${row.wins}勝${row.losses}敗`,
      tournamentName: tournament?.name ?? '',
      imageUrl: tournament?.imageUrl ?? '',
      tier: tournamentTier(tournament?.entrantCount ?? 0),
    };
  });
}

// 使用キャラクターの列。縦に積んで、メインが上から2/3、サブがのこり1/3を
// 分け合う（サブ1体なら1/3をひとりで、2体なら1/6ずつ。割り振りはCSSの flex）。
// 3人目以降まで並べると1枚が薄い帯になってしまうので、サブは最大2人ぶんまで。
//
// メインもサブも、絵は枠を端まで満たす（CSSの object-fit: cover）。はみ出した分は
// 切るが、切る位置は顔の位置の表（js/characterFocus.js）を object-position に
// 入れて決めるので、武器を振りかぶった絵でも寝そべった絵でも顔が枠の外へは出ない。
function characterColumnHtml(mainCharacters) {
  const refs = (mainCharacters ?? []).filter(Boolean);
  if (refs.length === 0) return '';

  const [mainRef, ...subRefs] = refs;
  const mainUrl = characterImageUrl(mainRef, 'large');
  if (!mainUrl) return '';

  // 【サブだけ thumb を使う理由】サブの枠は 227×359 と小さいので、@lg（長辺480px）を
  // 持ってきても解像度は使い切れず、重さだけが増える。メインの枠は 458×718 あるので
  // そちらは @lg を使う。
  //
  // なお顔の位置の表（js/characterFocus.js）は、240px角のサムネイルを方眼に載せて
  // 読み取った百分率で、そのサムネイルは正方形に「収めた」もの＝縦長の絵なら左右に、
  // 横長の絵なら上下に透明の余白が入っている（scripts/build-characters.mjs の
  // fit: 'contain'）。余白の入った側の百分率は、余白の無い @lg では別の場所を指す。
  // それでもメインに当てて構わない理由は css/reveal.css の .reveal-chara-main img
  // にある ── cover が切る向きと、余白でずれる向きが必ず逆になるため。
  const subsHtml = subRefs.slice(0, 2).map((ref) => {
    const url = characterImageUrl(ref, 'thumb');
    if (!url) return '';
    return `<div class="reveal-chara-sub"><img src="${escapeHtml(url)}" alt="" style="${focusVars(ref)}"></div>`;
  }).join('');

  return `
    <div class="reveal-chara">
      <div class="reveal-chara-main">
        <img src="${escapeHtml(mainUrl)}" alt="" style="${focusVars(mainRef)}">
      </div>
      ${subsHtml ? `<div class="reveal-chara-subs">${subsHtml}</div>` : ''}
    </div>
  `;
}

// 選手を出す前にはさむ中扉（「第〇位」）。
//
// 数字以外は何も置かない。ここで名前や絵を少しでも見せてしまうと、次のカードで
// めくる意味が無くなる ── 順位だけを先に言い、正体は伏せておくのが発表の作り方で、
// この画はその「伏せている時間」そのものを受け持つ。
// 背景も持たない（カードと同じで、下のプレー動画がそのまま透ける）。
function titleElement(entry) {
  const title = document.createElement('div');
  title.className = `reveal-title${entry.rank <= 3 ? ` rank-${entry.rank}` : ''}`;
  // 六角形の板の入れ子（外＝縁、内＝色の面）。組み方の理由は css/reveal.css の
  // 「六角形の板」を参照。中身の幅で板が伸びるので、桁数が変わっても枠が付いてくる。
  title.innerHTML = `
    <p class="reveal-title-rank">
      <span class="reveal-hex"><span class="reveal-hex-in"><span class="reveal-title-prefix">第</span><span class="reveal-title-num">${entry.rank}</span><span class="reveal-title-unit">位</span></span></span>
    </p>
  `;
  return title;
}

// 名前に使う文字の大きさ（px）を、その名前ごとに決める。
//
// 名前はこの画の主役なので、できるだけ大きく出したい。ただし一律に大きくすると、
// 長い名前が3点リーダで切れて誰なのか読めなくなる ── 目立たせるつもりが逆效果になる。
// 折り返して2行にする道は取れない（2行になると下のスコア以下が押し出されて、
// カードごとに位置が変わり、めくるたびに画面が跳ねる。css/reveal.css に既述）。
// そこで「その名前が1行で収まる大きさのうち、いちばん大きいもの」を選ぶ。
//
// 幅は字の種類で見積もりを変える。全角（日本語）は1文字が字の大きさとほぼ同じ幅を
// 取るのに対し、半角の英数字はその6割ほどしかない。同じ5文字でも "ゴウシオン" と
// "Gwynn" では要る幅が倍近く違うので、文字数ではなくこの重みの合計で測る。
const NAME_MAX_SIZE = 108;
const NAME_MIN_SIZE = 56;
// 半角1文字を全角の何文字ぶんとして数えるか。太字（800）なので気持ち広めに見る。
// 0.6 だったのは本文の字（system-ui）で出していたころの値。いまは名前も Oxanium で
// 出す（css/reveal.css の .reveal-name）ぶん、同じ大きさでも横に広い。
const HALF_WIDTH_UNIT = 0.66;

// 3列目（.reveal-body）の内寸。カード幅から他の列と余白を引いた値で、
// 割り振りは css/reveal.css の flex と padding に合わせてある。
// キャラクターを登録していない選手はあの列ごと出ないので、そのぶん名前を大きくできる。
const BODY_PADDING_X = 56 * 2;
const PHOTO_COLUMN = STAGE_WIDTH * 0.30 + 3; // 3px は列の区切り線
const CHARA_COLUMN = STAGE_WIDTH * 0.24 + 3;

// 名前を乗せる六角形の板が、文字の左右に食う量。css/reveal.css の
// .reveal-name .reveal-hex（斜辺 --hex-cut）と .reveal-hex-in（左右の余白）の
// 値と必ずそろえること ── 板の余白は名前の大きさに比例して決めてあるので、
// ここも「名前1文字ぶんの何倍か」で持つ。片方だけ変えると、名前が枠に入るか
// どうかの見積もりがずれる。
const HEX_SIDE_UNITS = (0.42 + 0.14) * 2;
// 縁（--hex-rim）の左右ぶん。こちらは字の大きさに連れないので実寸で引く。
const HEX_RIM_X = 8 * 0.55 * 2;
// 名前は斜体で出すので、最後の字の上が右へ倒れて、その手前の字より少しはみ出す
// （逆に先頭の字は下が左へ出る）。傾きは字の大きさに連れるため、文字数と同じ単位で持つ。
const ITALIC_LEAN_UNITS = 0.14;

function nameFontSize(name, hasCharaColumn) {
  let units = 0;
  for (const ch of name) units += ch.charCodeAt(0) < 0x0100 ? HALF_WIDTH_UNIT : 1;
  if (units <= 0) return NAME_MAX_SIZE;

  const room = STAGE_WIDTH - PHOTO_COLUMN - (hasCharaColumn ? CHARA_COLUMN : 0) - BODY_PADDING_X;
  // 板の左右も名前の大きさで伸びるので、要る幅は size×(文字ぶん + 板ぶん) になる。
  // これが列の内寸に収まる最大の size を解いた形が下の式。
  // 見積もりなので、収まりきらなかったときの保険は CSS の text-overflow に残してある。
  // 下限を切ってまで小さくしないのは、読めない大きさで全部入れても意味がないため。
  const fit = (room - HEX_RIM_X) / (units + HEX_SIDE_UNITS + ITALIC_LEAN_UNITS);
  return Math.round(Math.min(NAME_MAX_SIZE, Math.max(NAME_MIN_SIZE, fit)));
}

function cardElement(entry) {
  // サンプルデータ（架空の選手）は実在の選手を探しに行かず、架空の中身をそのまま使う。
  const player = entry.samplePlayer ?? state.players.find((p) => p.id === entry.id);
  // 公開済みランキングは公開時点の名前しか持っていないので、アイコンとキャラクターは
  // いまの選手の情報から引き、名前はランキングに記録された値を使う
  // （rankingView.js の rankingAvatar と同じ考え方）。
  const photoUrl = safeUrl(player?.avatarUrl);

  const charaHtml = characterColumnHtml(player?.mainCharacters);
  const nameSize = nameFontSize(entry.name, charaHtml !== '');

  const card = document.createElement('div');
  card.className = `reveal-card${entry.rank <= 3 ? ` rank-${entry.rank}` : ''}`;
  card.innerHTML = `
    <div class="reveal-photo">
      ${photoUrl
    ? `<img src="${escapeHtml(photoUrl)}" alt="">`
    : `<span class="reveal-photo-fallback">${escapeHtml(initialOf(entry.name))}</span>`}
      <p class="reveal-rank"><span class="reveal-hex"><span class="reveal-hex-in"><span class="reveal-rank-num">${entry.rank}</span><span class="reveal-rank-unit">位</span></span></span></p>
    </div>
    ${charaHtml}
    <div class="reveal-body">
      <p class="reveal-name" style="--name-size:${nameSize}px"><span class="reveal-hex"><span class="reveal-hex-in">${escapeHtml(entry.name)}</span></span></p>
      <p class="reveal-score">
        <span class="reveal-score-label">SCORE</span>
        <span class="reveal-score-value">${entry.score.toFixed(1)}</span>
        ${changeBadgeHtml(entry, entry.previousRank !== undefined)}
      </p>
      <div class="reveal-achievements">
        ${achievementsListHtml(entry.achievements)}
      </div>
    </div>
  `;
  return card;
}

// ---------------------------------------------------------------------------
// 背景動画のつなぎ目を消す
//
// loop 属性は、終わりのフレームから頭のフレームへ一瞬で飛ぶ。素材の頭と終わりの
// 絵が違うので、一周ごとに画が切り替わったように見えてしまう。
//
// そこで同じ動画を2本（bgEl / bgBackEl）重ね、一方が終わりに近づいたら
// もう一方を頭から流し始めて、重なっている BG_FADE 秒のあいだに入れ替える。
// 見ている側には、終わりの絵から頭の絵へ溶けていくようにしか見えない。
//
// 透過を動かすのは上に重なる bgBackEl だけ（理由は css/reveal.css の #reveal-bg-b。
// 2本を薄くし合うと、重なりの中ほどで下地が透けて暗い谷ができる）。
// ここは「どちらの絵を見せているか（front）」と「いつ入れ替えるか」だけを持つ。
// ---------------------------------------------------------------------------

// 重ねる秒数。css/reveal.css の #reveal-bg-b の transition と必ずそろえること。
const BG_FADE = 1.2;

// いま絵が見えているほう。もう一方は、出番が来るまで止めてある。
let bgFront = bgEl;
let bgTimer = null;

// 次の一周を始める。front は最後の BG_FADE 秒を流しきってから自然に終わる
// （loop 属性を外してあるので、終端で止まったままになる）。
function swapBgLayer() {
  const next = bgFront === bgEl ? bgBackEl : bgEl;
  next.currentTime = 0;
  next.play().catch(() => {});
  // 上の1本の出入りだけで入れ替える。次が上の1本なら現す、下の1本なら隠す
  // （隠せば、その下でずっと待っている bgEl の絵が出てくる）。
  bgBackEl.classList.toggle('is-front', next === bgBackEl);
  bgFront = next;
}

function watchBgLoop() {
  bgTimer = requestAnimationFrame(watchBgLoop);

  const { duration, currentTime } = bgFront;
  // メタデータが届くまで duration は NaN。届いていない＝まだ流れていないので何もしない。
  // 素材が BG_FADE より短いことは想定しないが、そのときは重ねずに切り替える。
  if (!Number.isFinite(duration) || duration <= 0) return;
  if (currentTime < Math.max(0, duration - BG_FADE)) return;

  swapBgLayer();
}

function startBgLoop() {
  stopBgLoop();
  bgFront = bgEl;
  // 上の1本を、透過の動きを挟まずに引っ込める。撮り直しのとき、前回が
  // 「上の1本が見えている」ところで終わっていると、ただ class を外すだけでは
  // 止まったままの最後のフレームが1.2秒かけて消えていく ── 頭出しのはずが
  // 前回の残りが重なって出てしまう。transition をいったん切って値を確定させ、
  // それから戻すことで、その1.2秒を飛ばす（間の reflow は値を確定させるため。
  // 同じフレームのうちに戻すと、変化が無かったことにされて効かない）。
  bgBackEl.style.transition = 'none';
  bgBackEl.classList.remove('is-front');
  void bgBackEl.offsetWidth;
  bgBackEl.style.transition = '';
  bgBackEl.pause();
  bgBackEl.currentTime = 0;
  // currentTime を戻すのは、撮り直したときに前回の続きから流れないようにするため
  // （何度撮っても同じ画から始まる）。
  // muted なので自動再生は止められないが、拒否されても発表そのものは続けられるよう
  // 握りつぶす。
  bgEl.currentTime = 0;
  bgEl.play().catch(() => {});
  bgTimer = requestAnimationFrame(watchBgLoop);
}

function stopBgLoop() {
  if (bgTimer !== null) cancelAnimationFrame(bgTimer);
  bgTimer = null;
  bgEl.pause();
  bgBackEl.pause();
}

// 画面の大きさに合わせて、1920×1080の画をまるごと縮める。
function fitStage() {
  const scale = Math.min(window.innerWidth / STAGE_WIDTH, window.innerHeight / STAGE_HEIGHT);
  canvasEl.style.setProperty('--reveal-scale', String(scale));
}

// いま出すべき画を描く。
//
// クラスの付け外しではなく要素ごと作り直す。CSSアニメーションは同じ要素に同じ
// クラスを付け直しても再生されず（reflowを挟む小細工が要る）、「Rでやり直す」が
// 効かないことがあるため。1枚ぶんの組み立てなので作り直しても軽い。
function drawCurrent() {
  // 何も出さない画が2か所ある。どちらも「この画面は映すものを持たない」ことが
  // 役目なので、canvas を空にするだけでよい。
  //
  //   blank  発表を始める前。開始した瞬間から画が出ていると、収録の頭が必ず
  //          「1枚目の途中」になる（録画ボタンを押すのが人の手である以上、
  //          間に合わない）。空の画で待てれば、録画を回してから落ち着いてめくれる。
  //   gap    「第〇位」を出したあと、その選手のカードを出すまでのあいだ。
  //          ここに、その選手の大会でのプレー動画を重ねる。編集で足すのではなく
  //          発表の側に間を用意しておくことで、プレー動画の尺に合わせて
  //          好きなだけ待ってからカードをめくれる。
  //
  // なお背景の動画はここでは触らない。開始から終わりまで出しっぱなしで流し続ける
  // （css/reveal.css の #reveal-bg）。何も出さない画でだけ消すと、めくるたびに
  // 背景が現れたり消えたりして継ぎ目が目立つ。プレー動画はOBS側でこの面より前に
  // 重ねるので、背景が流れたままでも塞がらない。
  const showing = playing.phase === 'title' || playing.phase === 'card';

  if (!showing) {
    slotEl.replaceChildren();
    return;
  }
  const entry = playing.entries[playing.index];
  slotEl.replaceChildren(
    playing.phase === 'title' ? titleElement(entry) : cardElement(entry),
  );
}

function closeStage() {
  if (!playing) return;
  playing = null;
  stageEl.hidden = true;
  stageEl.classList.remove('is-sample');
  setupEl.hidden = false;
  slotEl.replaceChildren();
  // 背景動画は2本とも止める。準備画面に戻ってからも裏で流れ続けると、見えないところで
  // フレームを描き続けることになる（読み込み済みのまま止めるので、次に発表を
  // 始めるときの待ちは増えない）。継ぎ目を見張る rAF もここで降ろす。
  stopBgLoop();
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
  //
  // めくる順は　空 →（1人につき）第〇位 → 空 → カード　の繰り返し。
  // 1人あたり3回めくることになるが、どの間も自動送りにしていない ── 溜めの長さは
  // 実況の間合いとプレー動画の尺で毎回変わるので、機械に決めさせるところではない。
  if (key === ' ' || key === 'Spacebar' || key === 'ArrowRight' || key === 'Enter') {
    e.preventDefault();
    if (playing.phase === 'blank') {
      playing.phase = 'title';
      drawCurrent();
    } else if (playing.phase === 'title') {
      playing.phase = 'gap';
      drawCurrent();
    } else if (playing.phase === 'gap') {
      playing.phase = 'card';
      drawCurrent();
    } else if (playing.index < playing.entries.length - 1) {
      // 最後の1人でさらに進めても閉じない。発表しきったあとも画を出したまま
      // 締めの言葉を入れられるようにしておく（終わるのは Esc）。
      playing.index += 1;
      playing.phase = 'title';
      drawCurrent();
    }
    return;
  }

  if (key === 'ArrowLeft') {
    e.preventDefault();
    if (playing.phase === 'card') {
      playing.phase = 'gap';
      drawCurrent();
    } else if (playing.phase === 'gap') {
      playing.phase = 'title';
      drawCurrent();
    } else if (playing.phase === 'title' && playing.index > 0) {
      playing.index -= 1;
      playing.phase = 'card';
      drawCurrent();
    } else if (playing.phase === 'title') {
      // 1人目の中扉から戻ると、始まる前の何も無い画に戻る（撮り直しの入口）。
      playing.phase = 'blank';
      drawCurrent();
    }
    return;
  }

  // 撮り直し。いま出ている画を頭から流し直す（中扉なら中扉、カードならカード）。
  if (key === 'r' || key === 'R') {
    e.preventDefault();
    drawCurrent();
  }
}

function startPresentation() {
  // 選んだ選手だけを、発表順に並べる。戦績はここで初めて選ぶ
  // （全員ぶんを先に計算しても、出さない人のぶんは捨てるだけ）。
  // サンプルデータは戦績も作り物を最初から持っているので、選び直さない
  // （寄与の計算は実在の試合を見に行くので、架空のIDでは何も引けない）。
  const order = radioValue('reveal-order');
  let entries = pickerRankings().filter((r) => selectedIds.has(r.id));
  if (!sampleMode) {
    // 寄与の計算は全選手ぶんが一度に返るので、選手ごとに呼び直さない
    // （中でランキングと同じ反復計算を回している）。
    const contributions = scoreContributionsByPlayer({
      ...state,
      matches: filterMatchesByRange(state, currentRange()),
    });
    entries = entries.map((r) => ({ ...r, achievements: achievementsOf(r.id, contributions) }));
  }
  entries = entries.sort((a, b) => (order === 'countdown' ? b.rank - a.rank : a.rank - b.rank));

  if (entries.length === 0) return;

  // 何も無い画から始める（理由は drawCurrent のコメント）。
  playing = { entries, index: 0, phase: 'blank' };
  setupEl.hidden = true;
  stageEl.hidden = false;
  stageEl.classList.toggle('is-sample', sampleMode);
  // 背景動画は、何も出さない画のうちから流し始めて最後まで止めない。
  // currentTime を戻すのは、撮り直したときに前回の続きから流れないようにするため
  // （何度撮っても同じ画から始まる）。
  // muted なので自動再生は止められないが、拒否されても発表そのものは続けられるよう
  // 握りつぶす。
  startBgLoop();
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

publishBtn.addEventListener('click', publishCurrentRanking);

// サンプルデータのON/OFF。「発表するランキング」欄（公開中／期間指定）はサンプル中は
// 意味を持たないので隠す。選択中の選手はどちらの世界でもID体系が違う（sample-0 等）ので、
// 切り替えるたびに選び直しにして、実在しない選手が選ばれたままになるのを防ぐ。
sampleToggle.addEventListener('change', () => {
  sampleMode = sampleToggle.checked;
  sourceControlsEl.hidden = sampleMode;
  applyPreset('10');
});

startBtn.addEventListener('click', startPresentation);

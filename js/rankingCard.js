// ランキング発表カード画像（順位発表動画用のPNG書き出し）。
// ranking.js（計算）/ rankingView.js（HTML表示）に対する、canvas描画+ダウンロード担当のモジュール。

export const CARD_WIDTH = 1920;
export const CARD_HEIGHT = 1080;

const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const COLOR_BORDER = '#888';
const COLOR_ACCENT = '#2b6cb0';
const COLOR_MUTED = '#666';
const COLOR_TEXT = '#1a1a1a';

// 既存のランキング表（rankingView.js）の金銀銅配色を踏襲する。
const RANK_COLORS = { 1: '#b8860b', 2: '#708090', 3: '#a0522d' };

function rankColor(rank) {
  return RANK_COLORS[rank] ?? COLOR_ACCENT;
}

// 指定した最大幅に収まるまでフォントサイズを縮小する。長い選手名がカードからはみ出すのを防ぐ。
export function fitFontSize(ctx, text, maxWidth, { startPx, minPx, weight = 'bold', family = FONT_FAMILY }) {
  let size = startPx;
  while (size > minPx) {
    ctx.font = `${weight} ${size}px ${family}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 4;
  }
  return size;
}

export function drawRankingCard(ctx, entry) {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  ctx.strokeStyle = COLOR_BORDER;
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, CARD_WIDTH - 4, CARD_HEIGHT - 4);

  ctx.fillStyle = COLOR_ACCENT;
  ctx.fillRect(0, 0, 24, CARD_HEIGHT);

  // 順位（左1/3）
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = rankColor(entry.rank);
  ctx.textAlign = 'center';
  ctx.font = `bold 420px ${FONT_FAMILY}`;
  ctx.fillText(String(entry.rank), 320, 620);
  ctx.font = `bold 140px ${FONT_FAMILY}`;
  ctx.fillText('位', 320, 760);

  // 区切り線
  ctx.strokeStyle = COLOR_BORDER;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(640, 80);
  ctx.lineTo(640, 1000);
  ctx.stroke();

  // 選手名・スコア・実績（右側）
  ctx.textAlign = 'left';
  ctx.fillStyle = COLOR_TEXT;
  const nameSize = fitFontSize(ctx, entry.name, 1080, { startPx: 120, minPx: 48 });
  ctx.font = `bold ${nameSize}px ${FONT_FAMILY}`;
  ctx.fillText(entry.name, 760, 420);

  ctx.fillStyle = COLOR_MUTED;
  ctx.font = `40px ${FONT_FAMILY}`;
  ctx.fillText('スコア', 760, 540);
  ctx.fillStyle = COLOR_ACCENT;
  ctx.font = `bold 72px ${FONT_FAMILY}`;
  ctx.fillText(entry.score.toFixed(1), 760, 620);

  ctx.fillStyle = COLOR_MUTED;
  ctx.font = `40px ${FONT_FAMILY}`;
  ctx.fillText('出場大会数', 760, 700);
  ctx.fillStyle = COLOR_TEXT;
  ctx.font = `bold 72px ${FONT_FAMILY}`;
  ctx.fillText(`${entry.tournamentsPlayed}大会`, 760, 780);
}

export function renderRankingCardCanvas(entry) {
  const canvas = document.createElement('canvas');
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  drawRankingCard(canvas.getContext('2d'), entry);
  return canvas;
}

function sanitizeFileNamePart(text) {
  const cleaned = text
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[.\s]+$/, '')
    .slice(0, 60);
  return cleaned || '';
}

// sequenceIndex はカウントダウン発表順（下位→上位）の連番。ファイル名でソートすれば発表順と一致する。
export function rankingCardFileName(entry, sequenceIndex) {
  const namePart = sanitizeFileNamePart(entry.name) || entry.id;
  return `${String(sequenceIndex).padStart(3, '0')}-${entry.rank}位-${namePart}.png`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

// rankings は順位昇順（1位が先頭）を想定。カウントダウン発表順（下位→上位）に並べ替えてから書き出す。
export async function downloadRankingCards(rankings, onProgress) {
  const ordered = [...rankings].sort((a, b) => b.rank - a.rank);

  for (let i = 0; i < ordered.length; i += 1) {
    const entry = ordered[i];
    const canvas = renderRankingCardCanvas(entry);
    const blob = await canvasToBlob(canvas);
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = rankingCardFileName(entry, i + 1);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    onProgress?.(i + 1, ordered.length);

    if (i < ordered.length - 1) await delay(350);
  }
}

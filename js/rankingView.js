import { escapeHtml } from './util.js';
import { rankChangeInfo } from './ranking.js';

function rankChangeCell(r) {
  const { label, className } = rankChangeInfo(r.previousRank, r.rank);
  return `<span class="rank-change ${className}">${label}</span>`;
}

// rankings: computeRankings() や公開済みスナップショットが返す
// [{ id, name, score, tournamentsPlayed, rank, previousRank? }] 形式の配列。
// previousRank が付与されていれば、前回公開時からの順位変動バッジを表示する。
export function renderRankingTable(containerEl, rankings, emptyMessage) {
  containerEl.innerHTML = '';

  if (!rankings || rankings.length === 0) {
    containerEl.innerHTML = `<p class="empty-hint">${escapeHtml(emptyMessage)}</p>`;
    return;
  }

  const showChange = rankings.some((r) => r.previousRank !== undefined);

  const table = document.createElement('table');
  table.className = 'ranking-table';
  table.innerHTML = `
    <thead>
      <tr><th>順位</th><th>選手</th><th>スコア</th>${showChange ? '<th>変動</th>' : ''}</tr>
    </thead>
  `;
  const tbody = document.createElement('tbody');

  rankings.forEach((r) => {
    const tr = document.createElement('tr');
    tr.className = 'clickable-row' + (r.rank <= 3 ? ` rank-${r.rank}` : '');
    tr.innerHTML = `
      <td class="rank-cell">${r.rank}</td>
      <td><a href="#player/${encodeURIComponent(r.id)}">${escapeHtml(r.name)}</a></td>
      <td>${r.score.toFixed(1)}</td>
      ${showChange ? `<td class="rank-change-cell">${rankChangeCell(r)}</td>` : ''}
    `;
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      location.hash = `#player/${encodeURIComponent(r.id)}`;
    });
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  const scrollWrap = document.createElement('div');
  scrollWrap.className = 'table-scroll';
  scrollWrap.appendChild(table);
  containerEl.appendChild(scrollWrap);
}

import { escapeHtml } from './players.js';

// rankings: computeRankings() や公開済みスナップショットが返す [{ id, name, score, tournamentsPlayed, rank }] 形式の配列。
export function renderRankingTable(containerEl, rankings, emptyMessage) {
  containerEl.innerHTML = '';

  if (!rankings || rankings.length === 0) {
    containerEl.innerHTML = `<p class="empty-hint">${escapeHtml(emptyMessage)}</p>`;
    return;
  }

  const table = document.createElement('table');
  table.className = 'ranking-table';
  table.innerHTML = `
    <thead>
      <tr><th>順位</th><th>選手</th><th>スコア</th><th>出場大会数</th></tr>
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
      <td>${r.tournamentsPlayed}</td>
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

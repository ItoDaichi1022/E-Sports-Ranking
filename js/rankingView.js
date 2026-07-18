import { state } from './state.js';
import { computeRankings } from './ranking.js';
import { escapeHtml } from './players.js';

export function renderRanking(containerEl) {
  containerEl.innerHTML = '';

  const rankings = computeRankings(state);
  if (rankings.length === 0) {
    containerEl.innerHTML = '<p class="empty-hint">確定した試合がまだないため、ランキングを計算できません。</p>';
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
  containerEl.appendChild(table);

  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = '行をクリックすると選手の個人戦績ページが開きます。';
  containerEl.appendChild(note);
}

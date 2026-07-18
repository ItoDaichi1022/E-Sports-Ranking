import { state, getPlayerName } from './state.js';
import { escapeHtml } from './players.js';

export function renderMatchesLog(containerEl) {
  containerEl.innerHTML = '';

  if (state.matches.length === 0) {
    containerEl.innerHTML = '<p class="empty-hint">まだ確定した試合はありません。</p>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'matches-table';
  table.innerHTML = `
    <thead>
      <tr><th>大会</th><th>ラウンド</th><th>勝者</th><th>敗者</th><th>スコア</th></tr>
    </thead>
  `;
  const tbody = document.createElement('tbody');

  state.matches.forEach((m) => {
    const tournament = state.tournaments.find((t) => t.id === m.tournamentId);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(tournament ? tournament.name : m.tournamentId)}</td>
      <td>${escapeHtml(m.round)}</td>
      <td>${escapeHtml(getPlayerName(m.winnerId))}</td>
      <td>${escapeHtml(getPlayerName(m.loserId))}</td>
      <td>${escapeHtml(m.score || '')}</td>
    `;
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  containerEl.appendChild(table);

  const details = document.createElement('details');
  details.className = 'raw-json';
  const summary = document.createElement('summary');
  summary.textContent = 'matches 配列の生データ（JSON）';
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(state.matches, null, 2);
  details.appendChild(summary);
  details.appendChild(pre);
  containerEl.appendChild(details);
}

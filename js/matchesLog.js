import { state, getPlayerName } from './state.js';
import { escapeHtml } from './players.js';

// 確定済み試合の一覧表。tournamentId を渡すとその大会分だけに絞る。
export function renderMatchesTable(containerEl, tournamentId = null) {
  containerEl.innerHTML = '';

  const matches = tournamentId
    ? state.matches.filter((m) => m.tournamentId === tournamentId)
    : state.matches;

  if (matches.length === 0) {
    containerEl.innerHTML = '<p class="empty-hint">確定した試合はまだありません。</p>';
    return;
  }

  const showTournamentCol = !tournamentId;
  const table = document.createElement('table');
  table.className = 'matches-table';
  table.innerHTML = `
    <thead>
      <tr>${showTournamentCol ? '<th>大会</th>' : ''}<th>ラウンド</th><th>勝者</th><th>敗者</th><th>スコア</th></tr>
    </thead>
  `;
  const tbody = document.createElement('tbody');

  matches.forEach((m) => {
    const tournament = state.tournaments.find((t) => t.id === m.tournamentId);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      ${showTournamentCol ? `<td>${escapeHtml(tournament ? tournament.name : m.tournamentId)}</td>` : ''}
      <td>${escapeHtml(m.round)}</td>
      <td>${escapeHtml(getPlayerName(m.winnerId))}</td>
      <td>${escapeHtml(getPlayerName(m.loserId))}</td>
      <td>${m.score ? escapeHtml(m.score) : '不戦勝'}</td>
    `;
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  containerEl.appendChild(table);
}

import { state, generateId } from './state.js';

// 選手を登録する。ゲームアカウントIDは不変の一意キーとして扱う。
export function addPlayer(gameAccountId, displayName) {
  const id = gameAccountId.trim();
  const name = displayName.trim();

  if (!id || !name) {
    return { ok: false, error: 'ゲームアカウントIDと表示名を入力してください。' };
  }
  if (state.players.some((p) => p.id === id)) {
    return { ok: false, error: `ID「${id}」は既に登録されています。` };
  }

  state.players.push({
    id,
    currentName: name,
    pastNames: [],
    mainCharacters: [],
  });

  return { ok: true };
}

export function removePlayer(id) {
  const idx = state.players.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  state.players.splice(idx, 1);
  return true;
}

export function renderPlayerTable(containerEl) {
  containerEl.innerHTML = '';

  if (state.players.length === 0) {
    containerEl.innerHTML = '<p class="empty-hint">まだ選手が登録されていません。</p>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'player-table';
  table.innerHTML = `
    <thead>
      <tr><th>ゲームアカウントID</th><th>表示名</th><th></th></tr>
    </thead>
  `;
  const tbody = document.createElement('tbody');

  state.players.forEach((p) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(p.id)}</td>
      <td>${escapeHtml(p.currentName)}</td>
      <td><button type="button" class="btn-remove" data-id="${escapeHtml(p.id)}">削除</button></td>
    `;
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  containerEl.appendChild(table);
}

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

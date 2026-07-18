import { state } from './state.js';

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

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

// 選手情報を更新する。表示名を変えた場合、旧名は pastNames に自動で残す（設計5章）。
export function updatePlayer(id, { currentName, mainCharactersText }) {
  const player = state.players.find((p) => p.id === id);
  if (!player) return { ok: false, error: '選手が見つかりません。' };

  const newName = currentName.trim();
  if (!newName) return { ok: false, error: '表示名を入力してください。' };

  if (newName !== player.currentName) {
    if (!player.pastNames.includes(player.currentName)) {
      player.pastNames.push(player.currentName);
    }
    player.currentName = newName;
  }
  player.mainCharacters = mainCharactersText
    .split(/[,、]/)
    .map((s) => s.trim())
    .filter(Boolean);

  return { ok: true };
}

// 試合結果や大会参加者に記録が残っている選手は削除できない（戦績の分断を防ぐ）。
export function canRemovePlayer(id) {
  if (state.matches.some((m) => m.winnerId === id || m.loserId === id)) {
    return { ok: false, reason: 'この選手は試合結果に記録されているため削除できません。' };
  }
  if (state.tournaments.some((t) => t.participantIds.includes(id))) {
    return { ok: false, reason: 'この選手は大会の参加者に含まれているため削除できません。' };
  }
  return { ok: true };
}

export function removePlayer(id) {
  const idx = state.players.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  state.players.splice(idx, 1);
  return true;
}

let editingPlayerId = null;

export function renderPlayerTable(containerEl, onChanged, options = {}) {
  const readOnly = !!options.readOnly;
  containerEl.innerHTML = '';

  if (state.players.length === 0) {
    containerEl.innerHTML = '<p class="empty-hint">まだ選手が登録されていません。</p>';
    return;
  }

  const table = document.createElement('table');
  table.className = 'player-table';
  table.innerHTML = `
    <thead>
      <tr><th>表示名</th><th>ゲームアカウントID</th><th>過去名</th><th>使用キャラ</th>${readOnly ? '' : '<th></th>'}</tr>
    </thead>
  `;
  const tbody = document.createElement('tbody');

  state.players.forEach((p) => {
    const tr = document.createElement('tr');

    if (!readOnly && editingPlayerId === p.id) {
      const nameTd = document.createElement('td');
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = p.currentName;
      nameTd.appendChild(nameInput);

      const idTd = document.createElement('td');
      idTd.innerHTML = `<code>${escapeHtml(p.id)}</code>`;

      const pastTd = document.createElement('td');
      pastTd.textContent = p.pastNames.join(', ');

      const charsTd = document.createElement('td');
      const charsInput = document.createElement('input');
      charsInput.type = 'text';
      charsInput.value = p.mainCharacters.join(', ');
      charsInput.placeholder = 'カンマ区切り';
      charsTd.appendChild(charsInput);

      const actionTd = document.createElement('td');
      actionTd.className = 'row-actions';

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.textContent = '保存';
      saveBtn.addEventListener('click', () => {
        const result = updatePlayer(p.id, {
          currentName: nameInput.value,
          mainCharactersText: charsInput.value,
        });
        if (!result.ok) {
          alert(result.error);
          return;
        }
        editingPlayerId = null;
        onChanged();
      });

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn-secondary';
      cancelBtn.textContent = 'キャンセル';
      cancelBtn.addEventListener('click', () => {
        editingPlayerId = null;
        renderPlayerTable(containerEl, onChanged, options);
      });

      actionTd.appendChild(saveBtn);
      actionTd.appendChild(cancelBtn);

      tr.appendChild(nameTd);
      tr.appendChild(idTd);
      tr.appendChild(pastTd);
      tr.appendChild(charsTd);
      tr.appendChild(actionTd);
    } else {
      const nameTd = document.createElement('td');
      const link = document.createElement('a');
      link.href = `#player/${encodeURIComponent(p.id)}`;
      link.textContent = p.currentName;
      nameTd.appendChild(link);

      const idTd = document.createElement('td');
      idTd.innerHTML = `<code>${escapeHtml(p.id)}</code>`;

      const pastTd = document.createElement('td');
      pastTd.textContent = p.pastNames.join(', ');

      const charsTd = document.createElement('td');
      charsTd.textContent = p.mainCharacters.join(', ');

      tr.appendChild(nameTd);
      tr.appendChild(idTd);
      tr.appendChild(pastTd);
      tr.appendChild(charsTd);

      if (!readOnly) {
        const actionTd = document.createElement('td');
        actionTd.className = 'row-actions';

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'btn-secondary';
        editBtn.textContent = '編集';
        editBtn.addEventListener('click', () => {
          editingPlayerId = p.id;
          renderPlayerTable(containerEl, onChanged, options);
        });

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn-remove';
        removeBtn.textContent = '削除';
        removeBtn.addEventListener('click', () => {
          const guard = canRemovePlayer(p.id);
          if (!guard.ok) {
            alert(guard.reason);
            return;
          }
          if (!confirm(`選手「${p.currentName}」を削除しますか？`)) return;
          removePlayer(p.id);
          onChanged();
        });

        actionTd.appendChild(editBtn);
        actionTd.appendChild(removeBtn);
        tr.appendChild(actionTd);
      }
    }

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  containerEl.appendChild(table);
}

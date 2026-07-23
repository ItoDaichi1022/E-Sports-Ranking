import { state } from './state.js';
import { escapeHtml, avatarHtml } from './util.js';

// 表示名を更新する。名前を変えた場合、旧名は pastNames に自動で残す。
// 戦績は不変のid（uuid）に紐づくので、名前が変わっても分断されない。
export function updatePlayer(id, { currentName }) {
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

  return { ok: true, player };
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

let editingPlayerId = null;

export function resetPlayerEditing() {
  editingPlayerId = null;
}

// 選手一覧を描画する。
// options:
//   canEdit(player)  -> その行の表示名を編集できるか（本人 or 運営）
//   isAdmin          -> 削除・アカウント統合などの運営操作を出すか
//   filterQuery      -> ID・表示名・過去名の部分一致で絞り込む
//   onSave(player)   -> 編集を保存するとき（DBへの書き込みは呼び出し側）
//   onDelete(player) -> 削除するとき
//   onMerge(source, target) -> 代理登録された行に本人のアカウントを統合するとき
export function renderPlayerTable(containerEl, options = {}) {
  const {
    canEdit = () => false,
    isAdmin = false,
    filterQuery = '',
    onSave = async () => {},
    onDelete = async () => {},
    onMerge = async () => {},
  } = options;

  containerEl.innerHTML = '';

  if (state.players.length === 0) {
    containerEl.innerHTML = '<p class="empty-hint">まだ選手が登録されていません。</p>';
    return;
  }

  const query = filterQuery.trim().toLowerCase();
  const visiblePlayers = query
    ? state.players.filter((p) =>
        (p.gameAccountId ?? '').toLowerCase().includes(query)
        || p.currentName.toLowerCase().includes(query)
        || p.pastNames.some((n) => n.toLowerCase().includes(query)))
    : state.players;

  if (visiblePlayers.length === 0) {
    containerEl.innerHTML = '<p class="empty-hint">検索条件に一致する選手がいません。</p>';
    return;
  }

  const anyActions = visiblePlayers.some((p) => canEdit(p)) || isAdmin;

  const table = document.createElement('table');
  table.className = 'player-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>表示名</th><th>ゲームアカウントID</th><th>過去名</th><th>アカウント</th>${anyActions ? '<th></th>' : ''}
      </tr>
    </thead>
  `;
  const tbody = document.createElement('tbody');

  const rerender = () => renderPlayerTable(containerEl, options);

  visiblePlayers.forEach((p) => {
    const tr = document.createElement('tr');

    const idTd = document.createElement('td');
    idTd.innerHTML = p.gameAccountId
      ? `<code>${escapeHtml(p.gameAccountId)}</code>`
      : '<span class="muted">—</span>';

    const pastTd = document.createElement('td');
    pastTd.textContent = p.pastNames.join(', ');

    // 本人のアカウントが紐づいているか。紐づいていない行＝運営が代理登録した選手。
    const accountTd = document.createElement('td');
    accountTd.innerHTML = p.userId
      ? '<span class="account-badge linked">本人</span>'
      : '<span class="account-badge">代理登録</span>';

    if (editingPlayerId === p.id && canEdit(p)) {
      const nameTd = document.createElement('td');
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = p.currentName;
      nameTd.appendChild(nameInput);

      const actionTd = document.createElement('td');
      actionTd.className = 'row-actions';

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.textContent = '保存';
      saveBtn.addEventListener('click', async () => {
        const result = updatePlayer(p.id, { currentName: nameInput.value });
        if (!result.ok) {
          alert(result.error);
          return;
        }
        saveBtn.disabled = true;
        try {
          await onSave(result.player);
          editingPlayerId = null;
          rerender();
        } catch (err) {
          alert(err.message);
          saveBtn.disabled = false;
        }
      });

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn-secondary';
      cancelBtn.textContent = 'キャンセル';
      cancelBtn.addEventListener('click', () => {
        editingPlayerId = null;
        rerender();
      });

      actionTd.append(saveBtn, cancelBtn);
      tr.append(nameTd, idTd, pastTd, accountTd, actionTd);
      tbody.appendChild(tr);
      return;
    }

    const nameTd = document.createElement('td');
    const nameCell = document.createElement('div');
    nameCell.className = 'player-identity';
    nameCell.innerHTML = avatarHtml(p, 'sm');
    const link = document.createElement('a');
    link.href = `#player/${encodeURIComponent(p.id)}`;
    link.textContent = p.currentName;
    nameCell.appendChild(link);
    nameTd.appendChild(nameCell);

    tr.append(nameTd, idTd, pastTd, accountTd);

    if (anyActions) {
      const actionTd = document.createElement('td');
      actionTd.className = 'row-actions';

      if (canEdit(p)) {
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'btn-secondary';
        editBtn.textContent = '編集';
        editBtn.addEventListener('click', () => {
          editingPlayerId = p.id;
          rerender();
        });
        actionTd.appendChild(editBtn);
      }

      // 代理登録された行に、本人が自分で作ったアカウントを統合する（移行してきた選手の初回だけ）。
      if (isAdmin && !p.userId) {
        const candidates = state.players.filter((c) => c.userId && c.id !== p.id);
        if (candidates.length > 0) {
          const select = document.createElement('select');
          select.append(new Option('本人のアカウントを統合...', ''));
          candidates.forEach((c) => select.append(new Option(c.currentName, c.id)));
          select.addEventListener('change', async () => {
            const sourceId = select.value;
            if (!sourceId) return;
            const source = state.players.find((c) => c.id === sourceId);
            if (!confirm(`「${source.currentName}」のアカウントを「${p.currentName}」に統合します。`
              + `\n統合後、「${source.currentName}」の行は削除され、その人は「${p.currentName}」の戦績を引き継ぎます。よろしいですか？`)) {
              select.value = '';
              return;
            }
            select.disabled = true;
            try {
              await onMerge(sourceId, p.id);
            } catch (err) {
              alert(err.message);
              select.disabled = false;
              select.value = '';
            }
          });
          actionTd.appendChild(select);
        }
      }

      if (isAdmin) {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn-remove';
        removeBtn.textContent = '削除';
        removeBtn.addEventListener('click', async () => {
          const guard = canRemovePlayer(p.id);
          if (!guard.ok) {
            alert(guard.reason);
            return;
          }
          if (!confirm(`選手「${p.currentName}」を削除しますか？`)) return;
          removeBtn.disabled = true;
          try {
            await onDelete(p);
          } catch (err) {
            alert(err.message);
            removeBtn.disabled = false;
          }
        });
        actionTd.appendChild(removeBtn);
      }

      tr.appendChild(actionTd);
    }

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  const scrollWrap = document.createElement('div');
  scrollWrap.className = 'table-scroll';
  scrollWrap.appendChild(table);
  containerEl.appendChild(scrollWrap);
}

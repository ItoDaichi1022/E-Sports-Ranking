import { state, isBannedPlayer } from './state.js';
import { avatarHtml } from './util.js';
import { characterRowArtHtml } from './characters.js';
import { makeIconButton } from './icons.js';
import { pathFor } from './router.js';
import * as db from './db.js';

// プレイヤー名を更新する。名前を変えた場合、旧名は pastNames に自動で残す。
// 戦績は不変のid（uuid）に紐づくので、名前が変わっても分断されない。
export function updatePlayer(id, { currentName }) {
  const player = state.players.find((p) => p.id === id);
  if (!player) return { ok: false, error: '選手が見つかりません。' };

  const newName = currentName.trim();
  if (!newName) return { ok: false, error: 'プレイヤー名を入力してください。' };

  if (newName !== player.currentName) {
    if (!player.pastNames.includes(player.currentName)) {
      player.pastNames.push(player.currentName);
    }
    player.currentName = newName;
  }

  return { ok: true, player };
}

// 試合結果や大会参加者に記録が残っている選手は削除できない（戦績の分断を防ぐ）。
//
// 判定はDBに数えてもらう。試合とエントリーは手元に全件あるとは限らない
// （増え続けるので必要なぶんだけ読む方針。js/state.js の説明を参照）ため、
// state を見て判定すると「記録がある選手を消せてしまう」ことが起きる。
export async function canRemovePlayer(id) {
  const { inMatches, inTournaments } = await db.playerHasRecords(id);
  if (inMatches) {
    return { ok: false, reason: 'この選手は試合結果に記録されているため削除できません。' };
  }
  if (inTournaments) {
    return { ok: false, reason: 'この選手は大会の参加者に含まれているため削除できません。' };
  }
  return { ok: true };
}

// 選手一覧を描画する。
//
// 一覧に出すのは名前とアイコンだけ。ゲームアカウントIDや過去名、アカウント種別は
// 詳細（選手ページ）で見られれば十分で、一覧では並べない（見やすさを優先）。
// プレイヤー名の編集もこの表には置かない。自分の行は名前をクリックして選手ページ経由で、
// 他人の行は運営が選手ページから編集する。一覧は「見る」ことに専念させる。
//
// options:
//   ownPlayerId      -> ログイン中の本人の選手ID。その行を目立たせる
//   isAdmin          -> 削除・アカウント統合などの運営操作を出すか
//   filterQuery      -> プレイヤー名・過去名（直近2件）の部分一致で絞り込む（改名しても見つかるように過去名も対象）。
//                        空のときは一覧を出さず、検索を促す案内だけ表示する
//   onDelete(player) -> 削除するとき
//   onMerge(source, target) -> 代理登録された行に本人のアカウントを統合するとき
export function renderPlayerTable(containerEl, options = {}) {
  const {
    ownPlayerId = null,
    isAdmin = false,
    filterQuery = '',
    onDelete = async () => {},
    onMerge = async () => {},
  } = options;

  containerEl.innerHTML = '';

  // 検索していないときは一覧を出さない。全員を並べても探している人は見つからず、
  // 選手が増えるほど重くなるだけだから（名前で絞ってから見せる）。
  const query = filterQuery.trim().toLowerCase();
  if (!query) {
    containerEl.innerHTML = '<p class="empty-hint">上の欄に名前を入力すると、選手を検索できます。</p>';
    return;
  }

  if (state.players.length === 0) {
    // まだ届いていないだけかもしれない。読み込み中に「登録されていません」と
    // 出すと、初めて来た人には誰も居ないサイトに見える。
    if (!db.hasLoadedOnce()) {
      containerEl.innerHTML = '<p class="status-line loading">選手を読み込んでいます...</p>';
      return;
    }
    containerEl.innerHTML = '<p class="empty-hint">まだ選手が登録されていません。</p>';
    return;
  }

  const visiblePlayers = state.players
    // 利用停止中の選手は検索に出さない。運営には「停止中」の札を付けて残す ──
    // 解除する相手を探せる場所がここしかないため。
    // 過去の大会の対戦表と戦績には今までどおり名前が出る（記録は消さない）。
    .filter((p) => isAdmin || !isBannedPlayer(p))
    .filter((p) => p.currentName.toLowerCase().includes(query)
      // 選手ページに出す過去名（直近2件）と検索対象をそろえる。全履歴を対象にすると、
      // 画面には出ていない古い名前で見つかってしまい、利用者から見て不可解になる。
      || p.pastNames.slice(-2).some((n) => n.toLowerCase().includes(query)));

  if (visiblePlayers.length === 0) {
    containerEl.innerHTML = '<p class="empty-hint">検索条件に一致する選手がいません。</p>';
    return;
  }

  const anyActions = isAdmin;

  const table = document.createElement('table');
  table.className = 'player-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>選手</th>${anyActions ? '<th></th>' : ''}
      </tr>
    </thead>
  `;
  const tbody = document.createElement('tbody');

  visiblePlayers.forEach((p) => {
    const tr = document.createElement('tr');

    // 自分の行はひと目で分かるようにする
    if (ownPlayerId && p.id === ownPlayerId) tr.className = 'own-row';

    const nameTd = document.createElement('td');
    nameTd.className = 'has-row-art';
    nameTd.innerHTML = characterRowArtHtml(p.mainCharacters);
    const nameCell = document.createElement('div');
    nameCell.className = 'player-identity';
    nameCell.innerHTML = avatarHtml(p, 'sm');
    const link = document.createElement('a');
    link.href = pathFor('player', p.id);
    link.textContent = p.currentName;
    nameCell.appendChild(link);

    // 運営の画面にだけ出る札（一般の利用者にはそもそも行が出ていない）
    if (isBannedPlayer(p)) {
      const badge = document.createElement('span');
      badge.className = 'ban-badge';
      badge.textContent = '停止中';
      nameCell.appendChild(badge);
    }

    nameTd.appendChild(nameCell);

    tr.append(nameTd);

    if (anyActions) {
      const actionTd = document.createElement('td');
      actionTd.className = 'row-actions';

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
        const removeBtn = makeIconButton('trash', '選手を削除', { className: 'btn-remove' });
        removeBtn.addEventListener('click', async () => {
          removeBtn.disabled = true;
          try {
            const guard = await canRemovePlayer(p.id);
            if (!guard.ok) {
              alert(guard.reason);
              removeBtn.disabled = false;
              return;
            }
            if (!confirm(`選手「${p.currentName}」を削除しますか？`)) {
              removeBtn.disabled = false;
              return;
            }
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

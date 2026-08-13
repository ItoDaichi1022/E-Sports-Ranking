import { state, isBannedPlayer } from './state.js';
import { avatarHtml, escapeHtml } from './util.js';
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
// 【絞り込みはこの関数の仕事ではない】以前はここで state.players を手元で
// フィルタしていたが、そのためには全選手を配る必要があった。いまは呼ぶ側が
// db.searchPlayers（DB側で当たった人だけを返す）を通し、その結果を渡す。
// 検索対象（名前・ゲームID・過去名の直近2件）は players.search_text が持っている。
//
// options:
//   ownPlayerId      -> ログイン中の本人の選手ID。その行を目立たせる
//   isAdmin          -> 削除・アカウント統合などの運営操作を出すか
//   players          -> 表に出す選手（検索結果）。呼ぶ側が用意する
//   status           -> 'idle'（未入力） / 'loading' / 'done' / 'error'
//   errorMessage     -> status が 'error' のときに出す文言
//   hasMore          -> 上限に収まりきらなかったか（「絞り込んでください」を出す）
//   onDelete(player) -> 削除するとき
//   onMerge(source, target) -> 代理登録された行に本人のアカウントを統合するとき
export function renderPlayerTable(containerEl, options = {}) {
  const {
    ownPlayerId = null,
    isAdmin = false,
    players = [],
    status = 'idle',
    errorMessage = '',
    hasMore = false,
    onDelete = async () => {},
    onMerge = async () => {},
  } = options;

  containerEl.innerHTML = '';

  // 検索していないときは一覧を出さない。全員を並べても探している人は見つからず、
  // 選手が増えるほど重くなるだけだから（名前で絞ってから見せる）。
  if (status === 'idle') {
    containerEl.innerHTML = '<p class="empty-hint">上の欄に名前を入力すると、選手を検索できます。</p>';
    return;
  }

  if (status === 'error') {
    containerEl.innerHTML = `<p class="empty-hint">${escapeHtml(errorMessage || '検索に失敗しました。')}</p>`;
    return;
  }

  // 【「見つかりません」を先に言わないこと】通信の途中はまだ何も分かっていない。
  // ここで「一致する選手がいません」と出すと、打つたびに一瞬その文言が挟まり、
  // 探している人には「居ない」と読めてしまう。
  if (status === 'loading') {
    containerEl.innerHTML = '<p class="status-line loading">選手を検索しています...</p>';
    return;
  }

  const visiblePlayers = players;

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
      //
      // 【候補は、欄に触れたときに初めて取る】候補になるのは「一度でもログインした
      // 選手」全員で、登録者が増えれば全選手とほぼ同じ数になる。この欄のために
      // 起動時から全員を配るわけにいかない。使うのは移行してきた選手の初回だけなので、
      // 開いた人だけが1回取る形にしてある（db.loadMergeCandidates）。
      if (isAdmin && !p.userId) {
        const select = document.createElement('select');
        select.append(new Option('本人のアカウントを統合...', ''));

        let loaded = false;
        const fillCandidates = async () => {
          if (loaded) return;
          loaded = true;   // 二重に取りに行かない（focus は何度でも来る）
          try {
            const { players: candidates, hasMore } = await db.loadMergeCandidates();
            const usable = candidates.filter((c) => c.id !== p.id);
            if (usable.length === 0) {
              select.options[0].textContent = '統合できるアカウントがありません';
              return;
            }
            usable.forEach((c) => select.append(new Option(c.currentName, c.id)));
            // 溢れたことは伝える。黙って切ると、目当ての人が居ないのを
            // 「そのアカウントは無い」と読まれる。
            if (hasMore) select.append(new Option('（候補が多く、以降は表示していません）', ''));
          } catch (err) {
            loaded = false;   // 失敗したら次に触れたときやり直す
            select.options[0].textContent = err.message;
          }
        };
        // focus だけだと、キーボードで開いたときにしか来ない環境がある
        select.addEventListener('focus', fillCandidates);
        select.addEventListener('pointerdown', fillCandidates);

        select.addEventListener('change', async () => {
          const sourceId = select.value;
          if (!sourceId) return;
          const source = state.players.find((c) => c.id === sourceId);
          if (!source) { select.value = ''; return; }
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

  // 上限に収まりきらなかったことを伝える。黙って切ると、探している人が
  // 一覧に出ていないだけなのに「登録されていない」と読まれる。
  if (hasMore) {
    const more = document.createElement('p');
    more.className = 'empty-hint';
    more.textContent = '一致する選手が多いため、先頭だけを出しています。'
      + 'もう少し詳しく入力すると絞り込めます。';
    containerEl.appendChild(more);
  }
}

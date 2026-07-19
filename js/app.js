import { state, generateId, getPlayerName } from './state.js';
import { addPlayer, renderPlayerTable, escapeHtml } from './players.js';
import { createBracket, updateTournament, deleteTournamentData, getChampionId } from './bracket.js';
import { renderBracket } from './bracketView.js';
import { renderMatchesTable } from './matchesLog.js';
import { computeRankings } from './ranking.js';
import { renderRanking } from './rankingView.js';
import { getPlayerStats } from './playerStats.js';
import { githubConfig, loadConfigFromStorage, saveConfigToStorage, verifyWriteAccess } from './github.js';
import { loadAllFromGitHub, saveAllToGitHub, markBracketDeleted } from './githubSync.js';

// 大会作成画面でのシード順（index 0 = シード1位）。ブラケット生成前の一時的な状態。
let selectedParticipantIds = [];
let participantSearchQuery = '';
let playerSearchQuery = '';
let currentBracketTournamentId = null;
let dirty = false;

const playerForm = document.getElementById('player-form');
const playerIdInput = document.getElementById('player-id-input');
const playerNameInput = document.getElementById('player-name-input');
const playerListEl = document.getElementById('player-list');

const participantSearchInput = document.getElementById('participant-search-input');
const participantCheckboxesEl = document.getElementById('participant-checkboxes');
const selectedListEl = document.getElementById('selected-participant-list');
const selectedCountEl = document.getElementById('selected-count');
const shuffleBtn = document.getElementById('shuffle-btn');
const seedByRankingBtn = document.getElementById('seed-by-ranking-btn');

const tournamentForm = document.getElementById('tournament-form');
const tournamentNameInput = document.getElementById('tournament-name-input');
const tournamentDateInput = document.getElementById('tournament-date-input');
const tournamentRulesInput = document.getElementById('tournament-rules-input');

const historyListEl = document.getElementById('history-list');

const bracketTitleEl = document.getElementById('bracket-title');
const bracketMetaEl = document.getElementById('bracket-meta');
const bracketContainer = document.getElementById('bracket-container');
const bracketMatchesContainer = document.getElementById('bracket-matches-container');
const tournamentEditBtn = document.getElementById('tournament-edit-btn');
const tournamentDeleteBtn = document.getElementById('tournament-delete-btn');
const tournamentEditForm = document.getElementById('tournament-edit-form');
const tournamentEditNameInput = document.getElementById('tournament-edit-name-input');
const tournamentEditDateInput = document.getElementById('tournament-edit-date-input');
const tournamentEditRulesInput = document.getElementById('tournament-edit-rules-input');
const tournamentEditCancelBtn = document.getElementById('tournament-edit-cancel-btn');
const tournamentInfoEl = document.getElementById('tournament-info');

const playerDetailEl = document.getElementById('player-detail');
const playerBackBtn = document.getElementById('player-back-btn');

const rankingContainer = document.getElementById('ranking-container');

const githubStatusEl = document.getElementById('github-status');
const dirtyBadgeEl = document.getElementById('dirty-badge');
const modeToggleBtn = document.getElementById('mode-toggle-btn');

const tokenDialog = document.getElementById('token-dialog');
const tokenForm = document.getElementById('token-form');
const tokenInput = document.getElementById('token-input');
const tokenRememberInput = document.getElementById('token-remember-input');
const tokenErrorEl = document.getElementById('token-error');
const tokenSubmitBtn = document.getElementById('token-submit-btn');
const tokenCancelBtn = document.getElementById('token-cancel-btn');

const navTournamentLink = document.getElementById('nav-tournament-link');
const homeCardTournament = document.getElementById('home-card-tournament');
const navRankingLink = document.getElementById('nav-ranking-link');
const homeCardRanking = document.getElementById('home-card-ranking');
const playerSearchInput = document.getElementById('player-search-input');

const mainNav = document.getElementById('main-nav');

// ---- 編集/閲覧モード ----

function isEditMode() {
  return Boolean(githubConfig.token);
}

// モードに応じて編集系UIの表示/非表示をまとめて切り替える
function applyModeUI() {
  const editing = isEditMode();
  navTournamentLink.hidden = !editing;
  homeCardTournament.hidden = !editing;
  navRankingLink.hidden = !editing;
  homeCardRanking.hidden = !editing;
  playerForm.hidden = !editing;
  tournamentEditBtn.hidden = !editing;
  tournamentDeleteBtn.hidden = !editing;
  if (!editing) tournamentEditForm.hidden = true;
  modeToggleBtn.textContent = editing ? '閲覧モードへ' : '編集モード';

  // 閲覧モードでは進行中の大会を追えるよう自動更新する。
  // 編集モードでは未保存の編集を上書きしないため停止する。
  if (editing) {
    stopAutoRefresh();
  } else {
    startAutoRefresh();
  }
}

// ---- 未保存変更の管理 ----

function updateSyncBar() {
  dirtyBadgeEl.hidden = !dirty;
}

function markDirty() {
  dirty = true;
  updateSyncBar();
  // 編集モードでは変更のたびに自動保存を予約する（連続操作はまとめて1回）
  scheduleAutoSave();
}

function clearDirty() {
  dirty = false;
  updateSyncBar();
}

window.addEventListener('beforeunload', (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---- ルーティング ----

const VIEW_IDS = {
  home: 'view-home',
  tournament: 'view-tournament',
  history: 'view-history',
  bracket: 'view-bracket',
  players: 'view-players',
  player: 'view-player-detail',
  ranking: 'view-ranking',
};

// ナビのハイライト用：詳細ページは親メニューに対応付ける
const NAV_PAGE_OF = { bracket: 'history', player: 'players' };

function parseHash() {
  const h = location.hash.replace(/^#/, '');
  const [page, param] = h.split('/');
  return { page: page || 'home', param: param ? decodeURIComponent(param) : null };
}

function routeFromHash() {
  const { page, param } = parseHash();
  let target = VIEW_IDS[page] ? page : 'home';

  // 大会作成とランキングは編集モード限定。閲覧者が直接URLで来た場合はホームに戻す。
  if ((target === 'tournament' || target === 'ranking') && !isEditMode()) {
    location.replace('#home');
    target = 'home';
  }

  Object.entries(VIEW_IDS).forEach(([name, id]) => {
    document.getElementById(id).hidden = name !== target;
  });

  const navPage = NAV_PAGE_OF[target] || target;
  mainNav.querySelectorAll('a').forEach((a) => {
    a.classList.toggle('active', a.dataset.page === navPage);
  });

  if (target === 'tournament') {
    renderParticipantCheckboxes();
    renderSelectedList();
  } else if (target === 'history') {
    renderHistoryList();
  } else if (target === 'bracket') {
    renderBracketPage(param);
  } else if (target === 'players') {
    refreshPlayerUI();
  } else if (target === 'player') {
    renderPlayerDetail(param);
  } else if (target === 'ranking') {
    renderRanking(rankingContainer);
  }
}

// ---- 選手まわり ----

function refreshPlayerUI() {
  renderPlayerTable(playerListEl, () => {
    markDirty();
    // 削除された選手が選択中リストに残らないようにする
    selectedParticipantIds = selectedParticipantIds.filter((id) =>
      state.players.some((p) => p.id === id),
    );
    refreshPlayerUI();
  }, { readOnly: !isEditMode(), filterQuery: playerSearchQuery });
  renderParticipantCheckboxes();
}

function renderParticipantCheckboxes() {
  participantCheckboxesEl.innerHTML = '';

  if (state.players.length === 0) {
    participantCheckboxesEl.innerHTML = '<p class="empty-hint">先に選手を登録してください。</p>';
    return;
  }

  const query = participantSearchQuery.trim().toLowerCase();
  const visiblePlayers = query
    ? state.players.filter((p) => p.id.toLowerCase().includes(query) || p.currentName.toLowerCase().includes(query))
    : state.players;

  if (visiblePlayers.length === 0) {
    participantCheckboxesEl.innerHTML = '<p class="empty-hint">検索条件に一致する選手がいません。</p>';
    return;
  }

  visiblePlayers.forEach((p) => {
    const label = document.createElement('label');
    label.className = 'checkbox-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = p.id;
    checkbox.checked = selectedParticipantIds.includes(p.id);

    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        if (!selectedParticipantIds.includes(p.id)) selectedParticipantIds.push(p.id);
      } else {
        selectedParticipantIds = selectedParticipantIds.filter((id) => id !== p.id);
      }
      renderSelectedList();
    });

    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(` ${p.currentName} (${p.id})`));
    participantCheckboxesEl.appendChild(label);
  });
}

function renderSelectedList() {
  selectedListEl.innerHTML = '';
  selectedCountEl.textContent = selectedParticipantIds.length
    ? `（選択中: ${selectedParticipantIds.length}人）`
    : '';

  if (selectedParticipantIds.length === 0) {
    selectedListEl.innerHTML = '<p class="empty-hint">参加者が選択されていません。</p>';
    return;
  }

  selectedParticipantIds.forEach((id, index) => {
    const player = state.players.find((p) => p.id === id);
    const li = document.createElement('li');
    li.className = 'selected-item';

    const seedLabel = document.createElement('span');
    seedLabel.className = 'seed-label';
    seedLabel.textContent = `シード${index + 1}`;

    const nameLabel = document.createElement('span');
    nameLabel.className = 'seed-name';
    nameLabel.textContent = player ? player.currentName : id;

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'btn-secondary';
    upBtn.textContent = '↑';
    upBtn.disabled = index === 0;
    upBtn.addEventListener('click', () => {
      [selectedParticipantIds[index - 1], selectedParticipantIds[index]] =
        [selectedParticipantIds[index], selectedParticipantIds[index - 1]];
      renderSelectedList();
    });

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'btn-secondary';
    downBtn.textContent = '↓';
    downBtn.disabled = index === selectedParticipantIds.length - 1;
    downBtn.addEventListener('click', () => {
      [selectedParticipantIds[index + 1], selectedParticipantIds[index]] =
        [selectedParticipantIds[index], selectedParticipantIds[index + 1]];
      renderSelectedList();
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-secondary';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => {
      selectedParticipantIds = selectedParticipantIds.filter((pid) => pid !== id);
      renderParticipantCheckboxes();
      renderSelectedList();
    });

    li.appendChild(seedLabel);
    li.appendChild(nameLabel);
    li.appendChild(upBtn);
    li.appendChild(downBtn);
    li.appendChild(removeBtn);
    selectedListEl.appendChild(li);
  });
}

function shuffleSelected() {
  for (let i = selectedParticipantIds.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [selectedParticipantIds[i], selectedParticipantIds[j]] = [selectedParticipantIds[j], selectedParticipantIds[i]];
  }
  renderSelectedList();
}

// 現在のランキング順（上位ほどシード上位）に並び替える。ランキング未算出の選手は末尾にまとめる。
function seedBySelectedRanking() {
  const rankings = computeRankings(state);
  if (rankings.length === 0) {
    alert('確定した試合がまだないため、ランキング順には並び替えられません。');
    return;
  }
  const rankIndex = new Map(rankings.map((r) => [r.id, r.rank]));
  selectedParticipantIds = [...selectedParticipantIds].sort((a, b) => {
    const ra = rankIndex.has(a) ? rankIndex.get(a) : Infinity;
    const rb = rankIndex.has(b) ? rankIndex.get(b) : Infinity;
    return ra - rb;
  });
  renderSelectedList();
}

// ---- 大会履歴 ----

function tournamentStatusLabel(t) {
  const bracket = state.brackets[t.id];
  if (!bracket) return '—';
  const championId = getChampionId(bracket);
  return championId ? `優勝: ${getPlayerName(championId)}` : '進行中';
}

function renderHistoryList() {
  historyListEl.innerHTML = '';

  if (state.tournaments.length === 0) {
    historyListEl.innerHTML = '<p class="empty-hint">まだ大会がありません。「大会作成」から始めてください。</p>';
    return;
  }

  [...state.tournaments].reverse().forEach((t) => {
    const item = document.createElement('a');
    item.className = 'history-item';
    item.href = `#bracket/${encodeURIComponent(t.id)}`;

    const info = document.createElement('div');
    info.className = 'history-info';
    info.innerHTML = `
      <span class="history-name">${escapeHtml(t.name)}</span>
      <span class="history-meta">${escapeHtml(t.date || '日付未設定')} ・ ${t.participantIds.length}人参加</span>
    `;

    const status = document.createElement('span');
    status.className = 'history-status';
    status.textContent = tournamentStatusLabel(t);

    item.appendChild(info);
    item.appendChild(status);
    historyListEl.appendChild(item);
  });
}

// ---- ブラケットページ ----

const FORMAT_LABELS = {
  single_elim: 'シングルエリミネーション',
  double_elim: 'ダブルエリミネーション',
  round_robin: '総当たり',
};

// ブラケットの下に、参加人数・形式・ルールなど大会の基本情報をまとめて表示する。
function renderTournamentInfo(tournament) {
  const formatLabel = FORMAT_LABELS[tournament.format] || tournament.format;
  let html = `
    <h3>大会情報</h3>
    <dl class="tournament-info-grid">
      <div><dt>参加人数</dt><dd>${tournament.participantIds.length}人</dd></div>
      <div><dt>形式</dt><dd>${escapeHtml(formatLabel)}</dd></div>
      <div><dt>開催日</dt><dd>${escapeHtml(tournament.date || '日付未設定')}</dd></div>
      <div><dt>進行状況</dt><dd>${escapeHtml(tournamentStatusLabel(tournament))}</dd></div>
    </dl>
  `;
  if (tournament.rules) {
    html += `
      <h4>ルール</h4>
      <p class="tournament-rules">${escapeHtml(tournament.rules)}</p>
    `;
  }
  tournamentInfoEl.innerHTML = html;
}

function renderBracketPage(tournamentId) {
  currentBracketTournamentId = tournamentId;
  tournamentEditForm.hidden = true;

  const tournament = state.tournaments.find((t) => t.id === tournamentId);
  if (!tournament) {
    bracketTitleEl.textContent = '大会が見つかりません';
    bracketMetaEl.textContent = '';
    bracketContainer.innerHTML = '<p class="empty-hint">この大会は存在しないか、削除されています。</p>';
    bracketMatchesContainer.innerHTML = '';
    tournamentInfoEl.innerHTML = '';
    return;
  }

  bracketTitleEl.textContent = tournament.name;
  bracketMetaEl.textContent = `${tournament.date || '日付未設定'} ・ ${tournament.participantIds.length}人参加 ・ ${tournamentStatusLabel(tournament)}`;

  renderBracket(tournamentId, bracketContainer, () => {
    markDirty();
    renderBracketPage(tournamentId);
  }, { readOnly: !isEditMode() });
  renderTournamentInfo(tournament);
  renderMatchesTable(bracketMatchesContainer, tournamentId);
}

// ---- 選手個人ページ ----

function renderPlayerDetail(playerId) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) {
    playerDetailEl.innerHTML = '<p class="empty-hint">選手が見つかりません。</p>';
    return;
  }

  const stats = getPlayerStats(playerId);
  const rankings = computeRankings(state);
  const rankEntry = rankings.find((r) => r.id === playerId);
  const total = stats.wins + stats.losses;
  const winRate = total > 0 ? Math.round((stats.wins / total) * 100) : null;

  let html = `
    <div class="player-detail-header">
      <h2>${escapeHtml(player.currentName)}</h2>
      <p class="meta-line"><code>${escapeHtml(player.id)}</code></p>
      ${player.pastNames.length ? `<p class="meta-line">過去名: ${escapeHtml(player.pastNames.join(', '))}</p>` : ''}
    </div>
    <div class="stat-cards">
      ${isEditMode() ? `<div class="stat-card"><span class="stat-value">${rankEntry ? `${rankEntry.rank}位` : '対象外'}</span><span class="stat-label">現在ランク${rankEntry ? `（スコア ${rankEntry.score.toFixed(1)}）` : ''}</span></div>` : ''}
      <div class="stat-card"><span class="stat-value">${stats.tournaments.length}</span><span class="stat-label">出場大会数</span></div>
      <div class="stat-card"><span class="stat-value">${stats.wins}勝${stats.losses}敗</span><span class="stat-label">通算成績</span></div>
      <div class="stat-card"><span class="stat-value">${winRate === null ? '—' : `${winRate}%`}</span><span class="stat-label">勝率</span></div>
    </div>
  `;

  if (stats.tournaments.length > 0) {
    html += `
      <h3>大会別成績</h3>
      <table>
        <thead><tr><th>大会</th><th>日付</th><th>結果</th><th>勝敗</th></tr></thead>
        <tbody>
          ${[...stats.tournaments].reverse().map((entry) => `
            <tr>
              <td><a href="#bracket/${encodeURIComponent(entry.tournament.id)}">${escapeHtml(entry.tournament.name)}</a></td>
              <td>${escapeHtml(entry.tournament.date || '—')}</td>
              <td>${escapeHtml(entry.placement || '—')}</td>
              <td>${entry.wins}勝${entry.losses}敗</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  if (stats.matches.length > 0) {
    html += `
      <h3>対戦履歴</h3>
      <table>
        <thead><tr><th>大会</th><th>ラウンド</th><th>対戦相手</th><th>勝敗</th><th>スコア</th></tr></thead>
        <tbody>
          ${[...stats.matches].reverse().map((m) => {
            const won = m.winnerId === playerId;
            const opponentId = won ? m.loserId : m.winnerId;
            const tournament = state.tournaments.find((t) => t.id === m.tournamentId);
            return `
              <tr>
                <td>${escapeHtml(tournament ? tournament.name : m.tournamentId)}</td>
                <td>${escapeHtml(m.round)}</td>
                <td><a href="#player/${encodeURIComponent(opponentId)}">${escapeHtml(getPlayerName(opponentId))}</a></td>
                <td class="${won ? 'result-win' : 'result-loss'}">${won ? '勝ち' : '負け'}</td>
                <td>${m.score ? escapeHtml(m.score) : '不戦勝'}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  } else {
    html += '<p class="empty-hint">まだ対戦記録がありません。</p>';
  }

  playerDetailEl.innerHTML = html;
}

// ---- GitHub連携 ----

function setGithubStatus(text, type) {
  githubStatusEl.textContent = text;
  githubStatusEl.className = `status-line${type ? ` ${type}` : ''}`;
}

let loadInFlight = false;

async function handleGithubLoad() {
  if (dirty && !confirm('未保存の変更があります。読み込むと破棄されますが、続けますか？')) return;
  cancelPendingAutoSave();
  loadInFlight = true;
  setGithubStatus('GitHubから読み込み中...', 'loading');
  try {
    await loadAllFromGitHub();
    selectedParticipantIds = [];
    clearDirty();
    routeFromHash();
    setGithubStatus(
      githubConfig.token ? 'GitHubから読み込みました。' : '最新データを読み込みました（10秒ごとに自動更新）。',
      'success',
    );
  } catch (err) {
    setGithubStatus(err.message, 'error');
  } finally {
    loadInFlight = false;
  }
}

// ---- 自動保存 ----

// 編集モードでは変更のたびに自動保存する。連続した操作（スコア入力→次の試合の確定など）を
// 1回の保存にまとめるため、最後の変更から少し待ってから実行する。
// 手動の「保存」ボタンは無いため、失敗時も次の変更を待たず自身で再試行する。
const AUTO_SAVE_DEBOUNCE_MS = 2500;
const AUTO_SAVE_RETRY_MS = 15 * 1000;
let autoSaveTimer = null;
let saveInFlight = false;
let saveQueuedAgain = false;

function scheduleAutoSave(delayMs = AUTO_SAVE_DEBOUNCE_MS) {
  if (!isEditMode()) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(performSave, delayMs);
}

function cancelPendingAutoSave() {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
}

async function performSave() {
  if (!githubConfig.token) return;
  // 保存中に次の変更が来たら、終わってからもう一度保存する
  if (saveInFlight) {
    saveQueuedAgain = true;
    return;
  }
  saveInFlight = true;
  cancelPendingAutoSave();
  setGithubStatus('自動保存中...', 'loading');
  try {
    await saveAllToGitHub();
    clearDirty();
    setGithubStatus(`自動保存しました（${formatTime(new Date())}）`, 'success');
    saveInFlight = false;
    if (saveQueuedAgain) {
      saveQueuedAgain = false;
      scheduleAutoSave();
    }
  } catch (err) {
    setGithubStatus(`${err.message}（自動的に再試行します）`, 'error');
    saveInFlight = false;
    saveQueuedAgain = false;
    scheduleAutoSave(AUTO_SAVE_RETRY_MS);
  }
}

// ---- 閲覧モードの自動更新 ----

// 観戦者が何もしなくても進行中の大会の最新結果が出るよう、閲覧モードでは
// 定期的に静的データを再取得し、内容が変わったときだけ再描画する。
const AUTO_REFRESH_MS = 10 * 1000;
let autoRefreshTimer = null;
let autoRefreshInFlight = false;

function formatTime(date) {
  return date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

async function autoRefresh() {
  // 編集モード・読み込み中・タブ非表示のときは何もしない
  if (isEditMode() || autoRefreshInFlight || loadInFlight || dirty || document.hidden) return;
  autoRefreshInFlight = true;
  try {
    const before = JSON.stringify(state);
    await loadAllFromGitHub();
    if (JSON.stringify(state) !== before) {
      routeFromHash();
      setGithubStatus(`新しいデータを反映しました（${formatTime(new Date())}）`, 'success');
    }
  } catch {
    // 一時的な通信エラーは無視し、次回の自動更新に任せる
  } finally {
    autoRefreshInFlight = false;
  }
}

function startAutoRefresh() {
  if (autoRefreshTimer) return;
  autoRefreshTimer = setInterval(autoRefresh, AUTO_REFRESH_MS);
}

function stopAutoRefresh() {
  clearInterval(autoRefreshTimer);
  autoRefreshTimer = null;
}

// タブを開き直したときは次の周期を待たずにすぐ最新化する
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) autoRefresh();
});

// ---- イベント配線 ----

playerForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const result = addPlayer(playerIdInput.value, playerNameInput.value);
  if (!result.ok) {
    alert(result.error);
    return;
  }
  playerIdInput.value = '';
  playerNameInput.value = '';
  markDirty();
  refreshPlayerUI();
});

participantSearchInput.addEventListener('input', () => {
  participantSearchQuery = participantSearchInput.value;
  renderParticipantCheckboxes();
});

playerSearchInput.addEventListener('input', () => {
  playerSearchQuery = playerSearchInput.value;
  refreshPlayerUI();
});

shuffleBtn.addEventListener('click', shuffleSelected);
seedByRankingBtn.addEventListener('click', seedBySelectedRanking);

tournamentForm.addEventListener('submit', (e) => {
  e.preventDefault();

  const name = tournamentNameInput.value.trim();
  if (!name) {
    alert('大会名を入力してください。');
    return;
  }
  if (selectedParticipantIds.length < 2) {
    alert('参加者を2人以上選択してください。');
    return;
  }

  const tournament = {
    id: generateId('t'),
    name,
    date: tournamentDateInput.value || null,
    format: 'single_elim',
    participantIds: [...selectedParticipantIds],
    weight: null,
    rules: tournamentRulesInput.value.trim() || null,
  };
  state.tournaments.push(tournament);
  state.brackets[tournament.id] = createBracket(tournament.id, selectedParticipantIds);

  tournamentNameInput.value = '';
  tournamentDateInput.value = '';
  tournamentRulesInput.value = '';
  selectedParticipantIds = [];
  markDirty();
  location.hash = `#bracket/${encodeURIComponent(tournament.id)}`;
});

tournamentEditBtn.addEventListener('click', () => {
  const tournament = state.tournaments.find((t) => t.id === currentBracketTournamentId);
  if (!tournament) return;
  tournamentEditNameInput.value = tournament.name;
  tournamentEditDateInput.value = tournament.date || '';
  tournamentEditRulesInput.value = tournament.rules || '';
  tournamentEditForm.hidden = !tournamentEditForm.hidden;
});

tournamentEditCancelBtn.addEventListener('click', () => {
  tournamentEditForm.hidden = true;
});

tournamentEditForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const result = updateTournament(currentBracketTournamentId, {
    name: tournamentEditNameInput.value,
    date: tournamentEditDateInput.value,
    rules: tournamentEditRulesInput.value,
  });
  if (!result.ok) {
    alert(result.error);
    return;
  }
  markDirty();
  renderBracketPage(currentBracketTournamentId);
});

tournamentDeleteBtn.addEventListener('click', () => {
  const tournament = state.tournaments.find((t) => t.id === currentBracketTournamentId);
  if (!tournament) return;
  if (!confirm(`大会「${tournament.name}」と、その試合結果をすべて削除します。よろしいですか？`)) return;
  const result = deleteTournamentData(currentBracketTournamentId);
  if (!result.ok) {
    alert(result.error);
    return;
  }
  markBracketDeleted(currentBracketTournamentId);
  markDirty();
  location.hash = '#history';
});

playerBackBtn.addEventListener('click', () => {
  history.back();
});

// 編集モードへの切り替え（トークン入力ダイアログ）と閲覧モードへの復帰
modeToggleBtn.addEventListener('click', () => {
  if (isEditMode()) {
    if (dirty && !confirm('未保存の変更があります。破棄して閲覧モードに戻りますか？')) return;
    cancelPendingAutoSave();
    githubConfig.token = '';
    githubConfig.rememberToken = false;
    saveConfigToStorage();
    clearDirty();
    applyModeUI();
    routeFromHash();
    handleGithubLoad();
    setGithubStatus('閲覧モードに戻りました。', 'success');
    return;
  }
  tokenInput.value = '';
  tokenRememberInput.checked = false;
  tokenErrorEl.textContent = '';
  tokenDialog.showModal();
});

tokenCancelBtn.addEventListener('click', () => {
  tokenDialog.close();
});

tokenForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  tokenSubmitBtn.disabled = true;
  tokenErrorEl.textContent = 'トークンを確認しています...';

  githubConfig.token = tokenInput.value.trim();
  const check = await verifyWriteAccess();
  tokenSubmitBtn.disabled = false;

  if (!check.ok) {
    githubConfig.token = '';
    tokenErrorEl.textContent = check.error;
    return;
  }

  githubConfig.rememberToken = tokenRememberInput.checked;
  saveConfigToStorage();
  tokenDialog.close();
  applyModeUI();
  routeFromHash();
  await handleGithubLoad();
  setGithubStatus('編集モードに切り替えました（変更は自動で保存されます）。', 'success');
});

window.addEventListener('hashchange', routeFromHash);

// ---- 起動 ----

loadConfigFromStorage();
applyModeUI();
routeFromHash();
handleGithubLoad();

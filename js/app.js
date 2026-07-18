import { state, generateId } from './state.js';
import { addPlayer, renderPlayerTable } from './players.js';
import { createBracket } from './bracket.js';
import { renderBracket } from './bracketView.js';
import { renderMatchesLog } from './matchesLog.js';
import { computeRankings } from './ranking.js';
import { renderRanking } from './rankingView.js';
import { githubConfig, loadConfigFromStorage, saveConfigToStorage, isConfigured } from './github.js';
import { loadAllFromGitHub, saveAllToGitHub } from './githubSync.js';

// 選手選択画面でのシード順（index 0 = シード1位）。ブラケット生成前の一時的な状態。
let selectedParticipantIds = [];
let currentTournamentId = null;
let participantSearchQuery = '';

const playerForm = document.getElementById('player-form');
const playerIdInput = document.getElementById('player-id-input');
const playerNameInput = document.getElementById('player-name-input');
const playerListEl = document.getElementById('player-list');

const participantSearchInput = document.getElementById('participant-search-input');
const participantCheckboxesEl = document.getElementById('participant-checkboxes');
const selectedListEl = document.getElementById('selected-participant-list');
const shuffleBtn = document.getElementById('shuffle-btn');
const seedByRankingBtn = document.getElementById('seed-by-ranking-btn');

const tournamentForm = document.getElementById('tournament-form');
const tournamentNameInput = document.getElementById('tournament-name-input');
const tournamentDateInput = document.getElementById('tournament-date-input');

const tournamentSelect = document.getElementById('tournament-select');
const bracketContainer = document.getElementById('bracket-container');
const matchesLogContainer = document.getElementById('matches-log-container');
const rankingContainer = document.getElementById('ranking-container');

const githubConfigForm = document.getElementById('github-config-form');
const githubOwnerInput = document.getElementById('github-owner-input');
const githubRepoInput = document.getElementById('github-repo-input');
const githubBranchInput = document.getElementById('github-branch-input');
const githubPathInput = document.getElementById('github-path-input');
const githubTokenInput = document.getElementById('github-token-input');
const githubLoadBtn = document.getElementById('github-load-btn');
const githubSaveBtn = document.getElementById('github-save-btn');
const githubStatusEl = document.getElementById('github-status');

function refreshPlayerUI() {
  renderPlayerTable(playerListEl);
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
    upBtn.textContent = '↑';
    upBtn.disabled = index === 0;
    upBtn.addEventListener('click', () => {
      [selectedParticipantIds[index - 1], selectedParticipantIds[index]] =
        [selectedParticipantIds[index], selectedParticipantIds[index - 1]];
      renderSelectedList();
    });

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.textContent = '↓';
    downBtn.disabled = index === selectedParticipantIds.length - 1;
    downBtn.addEventListener('click', () => {
      [selectedParticipantIds[index + 1], selectedParticipantIds[index]] =
        [selectedParticipantIds[index], selectedParticipantIds[index + 1]];
      renderSelectedList();
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
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

function refreshTournamentSelect() {
  tournamentSelect.innerHTML = '';

  if (state.tournaments.length === 0) {
    tournamentSelect.innerHTML = '<option value="">(大会未作成)</option>';
    return;
  }

  state.tournaments.forEach((t) => {
    const option = document.createElement('option');
    option.value = t.id;
    option.textContent = `${t.name} (${t.date || '日付未設定'})`;
    tournamentSelect.appendChild(option);
  });

  tournamentSelect.value = currentTournamentId;
}

function renderBracketAndLog() {
  if (currentTournamentId) {
    renderBracket(currentTournamentId, bracketContainer, renderBracketAndLog);
  } else {
    bracketContainer.innerHTML = '<p class="empty-hint">まだブラケットが生成されていません。</p>';
  }
  renderMatchesLog(matchesLogContainer);
  renderRanking(rankingContainer);
}

function setGithubStatus(text, type) {
  githubStatusEl.textContent = text;
  githubStatusEl.className = `status-line${type ? ` ${type}` : ''}`;
}

function populateGithubConfigForm() {
  githubOwnerInput.value = githubConfig.owner;
  githubRepoInput.value = githubConfig.repo;
  githubBranchInput.value = githubConfig.branch;
  githubPathInput.value = githubConfig.pathPrefix;
  githubTokenInput.value = githubConfig.token;
}

function applyGithubConfigFromForm() {
  githubConfig.owner = githubOwnerInput.value.trim();
  githubConfig.repo = githubRepoInput.value.trim();
  githubConfig.branch = githubBranchInput.value.trim() || 'main';
  githubConfig.pathPrefix = githubPathInput.value.trim() || 'data';
  githubConfig.token = githubTokenInput.value;
  saveConfigToStorage();
}

async function handleGithubLoad() {
  if (!isConfigured()) {
    setGithubStatus('リポジトリ所有者とリポジトリ名を入力してください。', 'error');
    return;
  }
  githubLoadBtn.disabled = true;
  setGithubStatus('GitHubから読み込み中...', 'loading');
  try {
    await loadAllFromGitHub();
    selectedParticipantIds = [];
    currentTournamentId = state.tournaments.length
      ? state.tournaments[state.tournaments.length - 1].id
      : null;
    refreshPlayerUI();
    renderSelectedList();
    refreshTournamentSelect();
    renderBracketAndLog();
    setGithubStatus('GitHubから読み込みました。', 'success');
  } catch (err) {
    setGithubStatus(err.message, 'error');
  } finally {
    githubLoadBtn.disabled = false;
  }
}

async function handleGithubSave() {
  if (!isConfigured()) {
    setGithubStatus('リポジトリ所有者とリポジトリ名を入力してください。', 'error');
    return;
  }
  githubSaveBtn.disabled = true;
  setGithubStatus('GitHubに保存中...', 'loading');
  try {
    await saveAllToGitHub();
    setGithubStatus('GitHubに保存しました。', 'success');
  } catch (err) {
    setGithubStatus(err.message, 'error');
  } finally {
    githubSaveBtn.disabled = false;
  }
}

playerForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const result = addPlayer(playerIdInput.value, playerNameInput.value);
  if (!result.ok) {
    alert(result.error);
    return;
  }
  playerIdInput.value = '';
  playerNameInput.value = '';
  refreshPlayerUI();
});

participantSearchInput.addEventListener('input', () => {
  participantSearchQuery = participantSearchInput.value;
  renderParticipantCheckboxes();
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
  };
  state.tournaments.push(tournament);
  state.brackets[tournament.id] = createBracket(tournament.id, selectedParticipantIds);
  currentTournamentId = tournament.id;

  refreshTournamentSelect();
  renderBracketAndLog();
});

tournamentSelect.addEventListener('change', () => {
  currentTournamentId = tournamentSelect.value || null;
  renderBracketAndLog();
});

githubConfigForm.addEventListener('submit', (e) => {
  e.preventDefault();
  applyGithubConfigFromForm();
  setGithubStatus('設定を反映しました。', 'success');
});

githubLoadBtn.addEventListener('click', handleGithubLoad);
githubSaveBtn.addEventListener('click', handleGithubSave);

refreshPlayerUI();
renderSelectedList();
refreshTournamentSelect();
renderBracketAndLog();

loadConfigFromStorage();
populateGithubConfigForm();
if (isConfigured()) {
  handleGithubLoad();
}

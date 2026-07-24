import { state, getPlayerName } from './state.js';
import { confirmMatch, editMatch } from './bracket.js';

// 1回戦（葉ノード）1枠あたりの高さ。深いラウンドほど 2^round 倍のスロット高さになり、
// 実際のトーナメント表のように中央揃えで配置される。
const LEAF_ROW_HEIGHT_PX = 100;

let lastRenderArgs = null;
let resizeRedrawTimer = null;

window.addEventListener('resize', () => {
  clearTimeout(resizeRedrawTimer);
  resizeRedrawTimer = setTimeout(() => {
    if (lastRenderArgs) {
      renderBracket(lastRenderArgs.tournamentId, lastRenderArgs.containerEl, lastRenderArgs.onChanged, lastRenderArgs.options);
    }
  }, 150);
});

function slotPlacement(roundIndex, matchIndex) {
  const rowSpan = 2 ** (roundIndex + 1);
  const rowStart = matchIndex * rowSpan + 1;
  return { rowStart, rowSpan };
}

// 確定済みスコア文字列 "3-1" を [player1のスコア, player2のスコア] に分解する。
function playerScores(match) {
  if (!match.score || typeof match.score !== 'string') return [null, null];
  const parts = match.score.split('-');
  if (parts.length !== 2) return [null, null];
  return [parts[0].trim(), parts[1].trim()];
}

// Challonge風の1選手行（シード番号・名前・スコア枠）を作る。
function buildPlayerRow({ seed, name, isWinner }) {
  const row = document.createElement('div');
  row.className = 'match-player' + (isWinner ? ' winner' : '');

  const seedBadge = document.createElement('span');
  seedBadge.className = 'seed-badge';
  if (seed != null) seedBadge.textContent = seed;
  else seedBadge.classList.add('seed-badge-empty');

  const nameSpan = document.createElement('span');
  nameSpan.className = 'player-name';
  nameSpan.textContent = name;

  const scoreSpan = document.createElement('span');
  scoreSpan.className = 'player-score';

  row.append(seedBadge, nameSpan, scoreSpan);
  return { row, scoreSpan };
}

function makeScoreInput(label) {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.className = 'score-num-input';
  input.setAttribute('aria-label', `${label}のスコア`);
  return input;
}

function drawConnectorLines(bracket, wrapper, matchElements) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.classList.add('bracket-lines');
  svg.setAttribute('width', wrapper.scrollWidth);
  svg.setAttribute('height', wrapper.scrollHeight);

  const wrapperRect = wrapper.getBoundingClientRect();

  bracket.rounds.forEach((round) => {
    round.matches.forEach((match) => {
      if (!match.nextMatchId) return;
      const fromEl = matchElements.get(match.id);
      const toEl = matchElements.get(match.nextMatchId);
      if (!fromEl || !toEl) return;

      const fromRect = fromEl.getBoundingClientRect();
      const toRect = toEl.getBoundingClientRect();
      const startX = fromRect.right - wrapperRect.left;
      const startY = fromRect.top + fromRect.height / 2 - wrapperRect.top;
      const endX = toRect.left - wrapperRect.left;
      const endY = toRect.top + toRect.height / 2 - wrapperRect.top;
      const midX = (startX + endX) / 2;

      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('class', 'connector-line');
      path.setAttribute('d', `M ${startX} ${startY} H ${midX} V ${endY} H ${endX}`);
      svg.appendChild(path);
    });
  });

  wrapper.appendChild(svg);
}

function renderMatchBox(tournamentId, match, onChanged, readOnly, seedOf) {
  const box = document.createElement('div');
  box.className = 'match-box';
  if (match.confirmed) box.classList.add('confirmed');
  if (match.isBye) box.classList.add('bye');
  if (match.isWalkover) box.classList.add('walkover');

  // BYE（不戦勝）はラベルを出さず、進出した選手名だけをそのまま表示する。
  if (match.isBye) {
    const { row } = buildPlayerRow({
      seed: seedOf(match.winnerId),
      name: getPlayerName(match.winnerId),
      isWinner: true,
    });
    box.appendChild(row);
    return box;
  }

  const p1 = match.player1Id;
  const p2 = match.player2Id;
  const name1 = p1 ? getPlayerName(p1) : 'TBD';
  const name2 = p2 ? getPlayerName(p2) : 'TBD';

  const r1 = buildPlayerRow({
    seed: p1 ? seedOf(p1) : null,
    name: name1,
    isWinner: match.winnerId && match.winnerId === p1,
  });
  const r2 = buildPlayerRow({
    seed: p2 ? seedOf(p2) : null,
    name: name2,
    isWinner: match.winnerId && match.winnerId === p2,
  });

  const editable = !readOnly && !match.confirmed && p1 && p2;

  // 勝敗入力中はフォームで行をまとめ、Enterでも確定できるようにする。
  const rowsHost = editable ? document.createElement('form') : box;
  if (editable) rowsHost.className = 'match-edit';
  rowsHost.appendChild(r1.row);
  rowsHost.appendChild(r2.row);

  if (match.confirmed) {
    if (match.isWalkover) {
      const winnerRow = match.winnerId === p1 ? r1 : r2;
      const loserRow = match.winnerId === p1 ? r2 : r1;
      winnerRow.scoreSpan.textContent = 'W';
      loserRow.scoreSpan.textContent = 'L';
      box.title = '不戦勝';
    } else {
      const [s1, s2] = playerScores(match);
      r1.scoreSpan.textContent = s1 ?? '';
      r2.scoreSpan.textContent = s2 ?? '';
    }

    if (!readOnly) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'edit-match-btn';
      editBtn.textContent = '編集';
      editBtn.addEventListener('click', () => {
        const ok = confirm('この試合の結果を編集しますか？以降のラウンドに既に反映・確定している結果があれば、それらも未確定に戻ります。');
        if (!ok) return;
        const result = editMatch(tournamentId, match.id);
        if (!result.ok) {
          alert(result.error);
          return;
        }
        onChanged();
      });
      box.appendChild(editBtn);
    }
    return box;
  }

  if (!editable) {
    const status = document.createElement('div');
    status.className = 'match-status';
    status.textContent = p1 && p2 ? '未実施' : '対戦カード未確定';
    box.appendChild(status);
    return box;
  }

  // --- ここから勝敗入力フォーム ---
  const score1Input = makeScoreInput(name1);
  const score2Input = makeScoreInput(name2);
  r1.scoreSpan.appendChild(score1Input);
  r2.scoreSpan.appendChild(score2Input);

  const controls = document.createElement('div');
  controls.className = 'match-controls';

  const walkoverLabel = document.createElement('label');
  walkoverLabel.className = 'walkover-toggle';
  const walkoverCheckbox = document.createElement('input');
  walkoverCheckbox.type = 'checkbox';
  walkoverLabel.appendChild(walkoverCheckbox);
  walkoverLabel.appendChild(document.createTextNode(' 不戦勝で確定（スコアなし）'));

  const walkoverWinnerWrap = document.createElement('div');
  walkoverWinnerWrap.className = 'walkover-winner';
  walkoverWinnerWrap.hidden = true;
  const walkoverSelect = document.createElement('select');
  const optDefault = new Option('勝者を選択', '');
  const opt1 = new Option(name1, p1);
  const opt2 = new Option(name2, p2);
  walkoverSelect.append(optDefault, opt1, opt2);
  walkoverWinnerWrap.appendChild(walkoverSelect);

  walkoverCheckbox.addEventListener('change', () => {
    const isWalkover = walkoverCheckbox.checked;
    score1Input.disabled = isWalkover;
    score2Input.disabled = isWalkover;
    walkoverWinnerWrap.hidden = !isWalkover;
  });

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.textContent = '確定';

  controls.append(walkoverLabel, walkoverWinnerWrap, submitBtn);
  rowsHost.appendChild(controls);

  rowsHost.addEventListener('submit', (e) => {
    e.preventDefault();

    if (walkoverCheckbox.checked) {
      if (!walkoverSelect.value) {
        alert('不戦勝の勝者を選択してください。');
        return;
      }
      const result = confirmMatch(tournamentId, match.id, walkoverSelect.value, null, { isWalkover: true });
      if (!result.ok) {
        alert(result.error);
        return;
      }
      onChanged();
      return;
    }

    const raw1 = score1Input.value.trim();
    const raw2 = score2Input.value.trim();
    if (raw1 === '' || raw2 === '') {
      alert('両者のスコアを入力してください。');
      return;
    }
    const s1 = Number(raw1);
    const s2 = Number(raw2);
    if (!Number.isFinite(s1) || !Number.isFinite(s2) || s1 < 0 || s2 < 0) {
      alert('スコアは0以上の数値で入力してください。');
      return;
    }
    if (s1 === s2) {
      alert('スコアが同点のため勝者を判定できません。');
      return;
    }
    const winnerId = s1 > s2 ? p1 : p2;
    const result = confirmMatch(tournamentId, match.id, winnerId, `${s1}-${s2}`);
    if (!result.ok) {
      alert(result.error);
      return;
    }
    onChanged();
  });

  box.appendChild(rowsHost);
  return box;
}

export function renderBracket(tournamentId, containerEl, onChanged, options = {}) {
  const readOnly = !!options.readOnly;
  lastRenderArgs = { tournamentId, containerEl, onChanged, options };

  const bracket = state.brackets[tournamentId];
  containerEl.innerHTML = '';

  if (!bracket) {
    containerEl.innerHTML = '<p class="empty-hint">まだブラケットが生成されていません。</p>';
    return;
  }

  // 参加者IDはシード順（index 0 = シード1位）で保存されているので、そこから番号を引く。
  const tournament = state.tournaments.find((t) => t.id === tournamentId);
  const seedByPlayer = new Map();
  if (tournament) tournament.participantIds.forEach((id, i) => seedByPlayer.set(id, i + 1));
  const seedOf = (id) => (id != null && seedByPlayer.has(id) ? seedByPlayer.get(id) : null);

  const wrapper = document.createElement('div');
  wrapper.className = 'bracket';

  const matchElements = new Map();
  const bodyHeight = bracket.bracketSize * LEAF_ROW_HEIGHT_PX;

  bracket.rounds.forEach((round, roundIndex) => {
    const col = document.createElement('div');
    col.className = 'round-column';

    const header = document.createElement('div');
    header.className = 'round-header';
    header.textContent = round.name;
    col.appendChild(header);

    const body = document.createElement('div');
    body.className = 'round-body';
    body.style.height = `${bodyHeight}px`;
    body.style.gridTemplateRows = `repeat(${bracket.bracketSize}, 1fr)`;

    round.matches.forEach((match, matchIndex) => {
      const { rowStart, rowSpan } = slotPlacement(roundIndex, matchIndex);
      const slot = document.createElement('div');
      slot.className = 'match-slot';
      slot.style.gridRow = `${rowStart} / span ${rowSpan}`;

      const box = renderMatchBox(tournamentId, match, onChanged, readOnly, seedOf);
      matchElements.set(match.id, box);
      slot.appendChild(box);
      body.appendChild(slot);
    });

    col.appendChild(body);
    wrapper.appendChild(col);
  });

  containerEl.appendChild(wrapper);
  drawConnectorLines(bracket, wrapper, matchElements);
}

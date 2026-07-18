import { state, getPlayerName } from './state.js';
import { confirmMatch, editMatch, getChampionId } from './bracket.js';
import { escapeHtml } from './players.js';

// 1回戦（葉ノード）1枠あたりの高さ。深いラウンドほど 2^round 倍のスロット高さになり、
// 実際のトーナメント表のように中央揃えで配置される。
const LEAF_ROW_HEIGHT_PX = 100;

let lastRenderArgs = null;
let resizeRedrawTimer = null;

window.addEventListener('resize', () => {
  clearTimeout(resizeRedrawTimer);
  resizeRedrawTimer = setTimeout(() => {
    if (lastRenderArgs) renderBracket(lastRenderArgs.tournamentId, lastRenderArgs.containerEl, lastRenderArgs.onChanged);
  }, 150);
});

function slotPlacement(roundIndex, matchIndex) {
  const rowSpan = 2 ** (roundIndex + 1);
  const rowStart = matchIndex * rowSpan + 1;
  return { rowStart, rowSpan };
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

function renderMatchBox(tournamentId, match, onChanged) {
  const box = document.createElement('div');
  box.className = 'match-box';
  if (match.confirmed) box.classList.add('confirmed');
  if (match.isBye) box.classList.add('bye');
  if (match.isWalkover) box.classList.add('walkover');

  if (match.isBye) {
    // BYE（不戦勝）はラベルを出さず、進出した選手名だけをそのまま表示する。
    const row = document.createElement('div');
    row.className = 'match-player winner';
    row.textContent = escapeHtml(getPlayerName(match.winnerId));
    box.appendChild(row);
    return box;
  }

  const p1Name = match.player1Id ? escapeHtml(getPlayerName(match.player1Id)) : 'TBD';
  const p2Name = match.player2Id ? escapeHtml(getPlayerName(match.player2Id)) : 'TBD';

  const row1 = document.createElement('div');
  row1.className = 'match-player' + (match.winnerId && match.winnerId === match.player1Id ? ' winner' : '');
  row1.textContent = p1Name;

  const row2 = document.createElement('div');
  row2.className = 'match-player' + (match.winnerId && match.winnerId === match.player2Id ? ' winner' : '');
  row2.textContent = p2Name;

  box.appendChild(row1);
  box.appendChild(row2);

  if (match.confirmed) {
    const status = document.createElement('div');
    status.className = 'match-status';
    status.textContent = match.isWalkover
      ? '確定（不戦勝）'
      : `確定${match.score ? ` (${escapeHtml(match.score)})` : ''}`;
    box.appendChild(status);

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'edit-match-btn';
    editBtn.textContent = '編集';
    editBtn.addEventListener('click', () => {
      const confirmed = confirm('この試合の結果を編集しますか？以降のラウンドに既に反映・確定している結果があれば、それらも未確定に戻ります。');
      if (!confirmed) return;
      const result = editMatch(tournamentId, match.id);
      if (!result.ok) {
        alert(result.error);
        return;
      }
      onChanged();
    });
    box.appendChild(editBtn);
  } else if (match.player1Id && match.player2Id) {
    const form = document.createElement('form');
    form.className = 'match-form';

    const score1Input = document.createElement('input');
    score1Input.type = 'number';
    score1Input.min = '0';
    score1Input.className = 'score-num-input';
    score1Input.setAttribute('aria-label', `${p1Name}のスコア`);

    const score2Input = document.createElement('input');
    score2Input.type = 'number';
    score2Input.min = '0';
    score2Input.className = 'score-num-input';
    score2Input.setAttribute('aria-label', `${p2Name}のスコア`);

    row1.appendChild(score1Input);
    row2.appendChild(score2Input);

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
    walkoverSelect.innerHTML = `
      <option value="">勝者を選択</option>
      <option value="${escapeHtml(match.player1Id)}">${p1Name}</option>
      <option value="${escapeHtml(match.player2Id)}">${p2Name}</option>
    `;
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

    form.appendChild(walkoverLabel);
    form.appendChild(walkoverWinnerWrap);
    form.appendChild(submitBtn);

    form.addEventListener('submit', (e) => {
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
      const winnerId = s1 > s2 ? match.player1Id : match.player2Id;
      const result = confirmMatch(tournamentId, match.id, winnerId, `${s1}-${s2}`);
      if (!result.ok) {
        alert(result.error);
        return;
      }
      onChanged();
    });

    box.appendChild(form);
  } else {
    const status = document.createElement('div');
    status.className = 'match-status';
    status.textContent = '対戦カード未確定';
    box.appendChild(status);
  }

  return box;
}

export function renderBracket(tournamentId, containerEl, onChanged) {
  lastRenderArgs = { tournamentId, containerEl, onChanged };

  const bracket = state.brackets[tournamentId];
  containerEl.innerHTML = '';

  if (!bracket) {
    containerEl.innerHTML = '<p class="empty-hint">まだブラケットが生成されていません。</p>';
    return;
  }

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

      const box = renderMatchBox(tournamentId, match, onChanged);
      matchElements.set(match.id, box);
      slot.appendChild(box);
      body.appendChild(slot);
    });

    col.appendChild(body);
    wrapper.appendChild(col);
  });

  containerEl.appendChild(wrapper);
  drawConnectorLines(bracket, wrapper, matchElements);

  const championId = getChampionId(bracket);
  if (championId) {
    const banner = document.createElement('div');
    banner.className = 'champion-banner';
    banner.textContent = `優勝: ${getPlayerName(championId)}`;
    containerEl.appendChild(banner);
  }
}

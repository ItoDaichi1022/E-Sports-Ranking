// 選手プロフィールの入力フォームと表示。
// 新規登録（初回ログイン後のオンボーディング）と、あとからの編集で同じフォームを使う。

import { escapeHtml } from './players.js';

// 使用キャラは配列で持つが、入力はカンマ区切りの1行で受ける。
function parseCharacters(text) {
  return text.split(',').map((s) => s.trim()).filter(Boolean);
}

// href に入れてよいURLだけを通す。javascript: や data: を弾かないと、
// プロフィールに書かれた文字列がそのままスクリプト実行に使われてしまう。
export function safeUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : null;
  } catch {
    return null;
  }
}

// URLでもハンドル名でも受け付け、表示用のリンク先に整える。
function socialUrl(kind, value) {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return safeUrl(trimmed);

  const handle = trimmed.replace(/^@/, '');
  if (!/^[\w.-]+$/.test(handle)) return null;
  if (kind === 'x') return `https://x.com/${handle}`;
  if (kind === 'twitch') return `https://twitch.tv/${handle}`;
  if (kind === 'youtube') return `https://youtube.com/@${handle}`;
  return null;
}

const FIELDS = [
  { key: 'currentName', label: '表示名', required: true, placeholder: '例: Gyu',
    note: '変更すると、以前の名前は「過去名」として選手ページに残ります。' },
  { key: 'gameAccountId', label: 'ゲームアカウントID', placeholder: '例: SW-1234-5678-9012' },
  { key: 'mainCharacters', label: '使用キャラクター', placeholder: '例: マリオ, リンク（カンマ区切り）' },
  { key: 'snsX', label: 'X', placeholder: '@handle または URL' },
  { key: 'snsTwitch', label: 'Twitch', placeholder: 'handle または URL' },
  { key: 'snsYoutube', label: 'YouTube', placeholder: '@handle または URL' },
];

// フォームを作り直さずに、現在の入力内容だけを取り出せるようにしておく。
// 背景の自動更新でフォームごと作り直すと入力が消えるため、呼び出し側が
// 「もう建っているフォームは触らない」判断をできる必要がある。
export function isProfileFormMounted(containerEl) {
  return Boolean(containerEl.querySelector('form.profile-form'));
}

// プロフィール編集フォームを描画する。
// onSubmit(profile) は入力内容をまとめたオブジェクトを受け取る。
export function renderProfileForm(containerEl, player, { onSubmit, submitLabel = '保存', onCancel = null }) {
  containerEl.innerHTML = '';

  const form = document.createElement('form');
  form.className = 'inline-form profile-form';

  FIELDS.forEach((field) => {
    const label = document.createElement('label');
    label.appendChild(document.createTextNode(field.label));

    const input = document.createElement('input');
    input.type = 'text';
    input.name = field.key;
    input.placeholder = field.placeholder ?? '';
    if (field.required) input.required = true;
    input.value = field.key === 'mainCharacters'
      ? (player?.mainCharacters ?? []).join(', ')
      : (player?.[field.key] ?? '');

    label.appendChild(input);
    if (field.note) {
      const note = document.createElement('span');
      note.className = 'field-note';
      note.textContent = field.note;
      label.appendChild(note);
    }
    form.appendChild(label);
  });

  const bioLabel = document.createElement('label');
  bioLabel.className = 'rules-field';
  bioLabel.appendChild(document.createTextNode('自己紹介'));
  const bio = document.createElement('textarea');
  bio.name = 'bio';
  bio.rows = 4;
  bio.placeholder = '選手ページに表示されます。';
  bio.value = player?.bio ?? '';
  bioLabel.appendChild(bio);
  form.appendChild(bioLabel);

  // form-message は flex の中で必ず1行を占有する（.profile-form の flex-basis:100%）。
  // 指定が無いと幅を持てずに潰れ、エラーが出ていても読めなかった。
  const messageEl = document.createElement('p');
  messageEl.className = 'form-message';
  form.appendChild(messageEl);

  const setMessage = (text, kind) => {
    messageEl.textContent = text;
    messageEl.className = `form-message${text ? ` ${kind}` : ''}`;
  };

  const actions = document.createElement('div');
  actions.className = 'dialog-actions';

  if (onCancel) {
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.addEventListener('click', onCancel);
    actions.appendChild(cancelBtn);
  }

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.textContent = submitLabel;
  actions.appendChild(submitBtn);
  form.appendChild(actions);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = form.elements.currentName.value.trim();
    if (!name) {
      setMessage('表示名を入力してください。', 'error');
      return;
    }

    const originalLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = '送信中...';
    setMessage('', null);
    try {
      await onSubmit({
        currentName: name,
        gameAccountId: form.elements.gameAccountId.value.trim(),
        mainCharacters: parseCharacters(form.elements.mainCharacters.value),
        snsX: form.elements.snsX.value.trim(),
        snsTwitch: form.elements.snsTwitch.value.trim(),
        snsYoutube: form.elements.snsYoutube.value.trim(),
        bio: bio.value.trim(),
      });
      // 成功しても画面の見た目がほとんど変わらないことがあるので、その場に明示する
      setMessage('保存しました。', 'success');
    } catch (err) {
      // 画面に出すだけでなくコンソールにも残す。捕まえた例外は既定では
      // 開発者ツールに何も出ないため、原因調査の手がかりが消えてしまう。
      console.error('プロフィールの保存に失敗しました', err);
      setMessage(err.message, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  });

  containerEl.appendChild(form);
}

// 選手ページに出すプロフィール部分（自己紹介・使用キャラ・ゲームID・SNS）。
// 何も登録されていなければ空文字を返す。
export function profileSectionHtml(player) {
  const links = [
    ['X', socialUrl('x', player.snsX)],
    ['Twitch', socialUrl('twitch', player.snsTwitch)],
    ['YouTube', socialUrl('youtube', player.snsYoutube)],
  ].filter(([, url]) => url);

  const rows = [];
  if (player.gameAccountId) {
    rows.push(`<div><dt>ゲームアカウントID</dt><dd><code>${escapeHtml(player.gameAccountId)}</code></dd></div>`);
  }
  if (player.mainCharacters?.length) {
    rows.push(`<div><dt>使用キャラクター</dt><dd>${escapeHtml(player.mainCharacters.join('、'))}</dd></div>`);
  }
  if (links.length) {
    const linkHtml = links
      .map(([label, url]) =>
        `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`)
      .join(' ');
    rows.push(`<div><dt>リンク</dt><dd class="sns-links">${linkHtml}</dd></div>`);
  }

  let html = '';
  if (rows.length) {
    html += `<dl class="tournament-info-grid profile-grid">${rows.join('')}</dl>`;
  }
  if (player.bio) {
    html += `<p class="player-bio">${escapeHtml(player.bio)}</p>`;
  }
  return html;
}

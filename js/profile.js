// 選手プロフィールの入力フォームと表示。
// 新規登録（初回ログイン後のオンボーディング）と、あとからの編集で同じフォームを使う。

import { escapeHtml, safeUrl, initialOf } from './util.js';
import { keepFormDraft, clearFormDraft } from './formDraft.js';
import { createCharacterField } from './characterPicker.js';

// SNS欄に入れられるドメインの白名簿。
//
// どんなURLでも受けてしまうと、プロフィールが外部サイトへの誘導（ウイルスの配布や
// フィッシング）に使われてしまう。「Xの欄にはXのURLしか入らない」と決めることで、
// リンク先をこちらが把握しているドメインに限定する。
const SNS_SERVICES = {
  x: {
    label: 'X',
    hosts: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'],
    example: 'https://x.com/yourname',
    handleUrl: (handle) => `https://x.com/${handle}`,
  },
  youtube: {
    label: 'YouTube',
    hosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'],
    example: 'https://youtube.com/@yourname',
    handleUrl: (handle) => `https://youtube.com/@${handle}`,
  },
};

// URLでもハンドル名でも受け付け、表示用のリンク先に整える。
// そのサービスのURLでない場合は null を返し、呼び出し側でリンクを出さない。
function socialUrl(kind, value) {
  const service = SNS_SERVICES[kind];
  const trimmed = (value ?? '').trim();
  if (!service || !trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    const href = safeUrl(trimmed); // http / https 以外はここで落ちる
    if (!href) return null;

    const { hostname, username, password } = new URL(href);
    // user:pass@host の形は、見た目のドメインと実際の宛先が食い違うので受けない
    // （https://x.com@example.com/ の宛先は example.com）。
    if (username || password) return null;

    // 完全一致で照合する。部分一致にすると x.com.example.com や
    // notyoutube.com のような紛らわしいドメインを通してしまう。
    return service.hosts.includes(hostname.toLowerCase()) ? href : null;
  }

  const handle = trimmed.replace(/^@/, '');
  if (!/^[\w.-]+$/.test(handle)) return null;
  return service.handleUrl(handle);
}

const FIELDS = [
  { key: 'currentName', label: '表示名', required: true, placeholder: '例: Gyu',
    note: '変更すると、以前の名前は「過去名」として選手ページに残ります。' },
  { key: 'gameAccountId', label: 'ゲームアカウントID', placeholder: '例: SW-1234-5678-9012' },
  { key: 'snsX', label: 'X', optional: true, placeholder: '@handle または https://x.com/...' },
  { key: 'snsYoutube', label: 'YouTube', optional: true, placeholder: '@handle または https://youtube.com/...' },
];

// フォームを作り直さずに、現在の入力内容だけを取り出せるようにしておく。
// 背景の自動更新でフォームごと作り直すと入力が消えるため、呼び出し側が
// 「もう建っているフォームは触らない」判断をできる必要がある。
export function isProfileFormMounted(containerEl) {
  return Boolean(containerEl.querySelector('form.profile-form'));
}

// ラベル文字列と「任意」の印を並べて1行に収める。
//
// 印を出すのはSNSと自己紹介だけにしている。必須でない欄すべてに付けると、
// 画面じゅうが「任意」だらけになって、かえってどこを埋めればよいか分からない。
function buildLabelHeading(text, { optional = false } = {}) {
  const heading = document.createElement('span');
  heading.className = 'field-label-text';
  heading.appendChild(document.createTextNode(text));
  if (optional) {
    const tag = document.createElement('span');
    tag.className = 'optional-tag';
    tag.textContent = '任意';
    heading.appendChild(tag);
  }
  return heading;
}

// プロフィール編集フォームを描画する。
// onSubmit(profile) は入力内容をまとめたオブジェクトを受け取る。
//
// draftKey を渡すと、入力中の内容を控えて次に建てたときに書き戻す（js/formDraft.js）。
// スマートフォンで他のアプリへ移って戻るとページごと捨てられていることがあり、
// そこで書きかけが消えるという声があったため。
export function renderProfileForm(
  containerEl, player, { onSubmit, submitLabel = '保存', onCancel = null, draftKey = null },
) {
  containerEl.innerHTML = '';

  const form = document.createElement('form');
  form.className = 'inline-form profile-form';

  FIELDS.forEach((field) => {
    const label = document.createElement('label');
    label.appendChild(buildLabelHeading(field.label, { optional: field.optional }));

    const input = document.createElement('input');
    input.type = 'text';
    input.name = field.key;
    input.placeholder = field.placeholder ?? '';
    if (field.required) input.required = true;
    input.value = player?.[field.key] ?? '';

    label.appendChild(input);
    if (field.note) {
      const note = document.createElement('span');
      note.className = 'field-note';
      note.textContent = field.note;
      label.appendChild(note);
    }
    form.appendChild(label);
  });

  // ---- 使用キャラクター ----
  //
  // 選んだ内容は、見えない入力欄（name="mainCharacters"）に文字列として持たせる。
  // 部品の中だけで持つと下書き（js/formDraft.js）の対象から外れ、スマートフォンで
  // 他のアプリへ移って戻ったときに選び直しになってしまう。あの仕組みは
  // form.elements を見て控えるので、フォームの部品として置いておけばそのまま乗る。
  const charLabel = document.createElement('label');
  charLabel.className = 'char-picker-field';
  charLabel.appendChild(buildLabelHeading('使用キャラクター'));

  const charInput = document.createElement('input');
  charInput.type = 'text';
  charInput.name = 'mainCharacters';
  charInput.hidden = true;
  charInput.value = (player?.mainCharacters ?? []).join(',');

  let charField = null;
  // 自分で書き戻したときにも input が飛ぶので、それで作り直しが二重に走らないようにする
  let writingBack = false;

  const setCharValue = (refs) => {
    writingBack = true;
    charInput.value = refs.join(',');
    // 下書きに拾ってもらうために合図を出す（値を入れるだけでは控えられない）
    charInput.dispatchEvent(new Event('input', { bubbles: true }));
    writingBack = false;
  };

  const buildCharField = () => {
    const refs = charInput.value.split(',').map((s) => s.trim()).filter(Boolean);
    const next = createCharacterField(refs, { onChange: setCharValue });
    if (charField) charField.element.replaceWith(next.element);
    else charLabel.appendChild(next.element);
    charField = next;
  };

  // 下書きの書き戻しは値を入れて input を投げてくる（js/formDraft.js の apply）。
  // 選んだ絵はそのままでは戻らないので、値が変わったら並びを作り直す。
  charInput.addEventListener('input', () => {
    if (writingBack) return;
    buildCharField();
  });

  charLabel.appendChild(charInput);
  buildCharField();
  form.appendChild(charLabel);

  // ---- アイコン ----
  // ファイルを選んだ時点ではまだアップロードせず、保存時にまとめて送る。
  // 保存せずに離れた場合に、使われない画像が溜まるのを避けるため。
  let pickedFile = null;

  const avatarLabel = document.createElement('label');
  avatarLabel.className = 'avatar-field';
  avatarLabel.appendChild(buildLabelHeading('アイコン'));

  const avatarRow = document.createElement('div');
  avatarRow.className = 'avatar-row';

  const preview = document.createElement('div');
  preview.className = 'avatar-preview';
  const setPreview = (src, name) => {
    preview.innerHTML = '';
    if (src) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      preview.appendChild(img);
    } else {
      preview.textContent = initialOf(name);
    }
  };
  setPreview(safeUrl(player?.avatarUrl), player?.currentName);

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/png,image/jpeg,image/webp,image/gif';

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn-secondary';
  clearBtn.textContent = 'アイコンを外す';
  clearBtn.hidden = !player?.avatarUrl;

  let removeAvatar = false;

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    pickedFile = file;
    removeAvatar = false;
    clearBtn.hidden = false;
    setPreview(URL.createObjectURL(file), player?.currentName);
  });

  clearBtn.addEventListener('click', () => {
    pickedFile = null;
    removeAvatar = true;
    fileInput.value = '';
    clearBtn.hidden = true;
    setPreview(null, form.elements.currentName.value || player?.currentName);
  });

  const hint = document.createElement('span');
  hint.className = 'field-note';
  hint.textContent = 'PNG / JPEG / WebP / GIF、2MBまで。正方形の画像が綺麗に表示されます。';

  avatarRow.append(preview, fileInput, clearBtn);
  avatarLabel.append(avatarRow, hint);
  form.appendChild(avatarLabel);

  const bioLabel = document.createElement('label');
  bioLabel.className = 'rules-field';
  bioLabel.appendChild(buildLabelHeading('自己紹介', { optional: true }));
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

    // SNSは保存する前に確かめる。表示側でも弾いているが、それだけだと
    // 「保存できたのに選手ページに出ない」となり、原因が分からない。
    const snsX = form.elements.snsX.value.trim();
    const snsYoutube = form.elements.snsYoutube.value.trim();
    const badField = [['x', snsX], ['youtube', snsYoutube]]
      .find(([kind, value]) => value && !socialUrl(kind, value));
    if (badField) {
      const service = SNS_SERVICES[badField[0]];
      setMessage(
        `${service.label}の欄には、${service.label}のURL（例: ${service.example}）`
        + 'か @ハンドル名 を入力してください。他のサイトのURLは登録できません。',
        'error',
      );
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
        mainCharacters: charField.get(),
        snsX,
        snsYoutube,
        bio: bio.value.trim(),
        // アイコンは呼び出し側でアップロードする（DBアクセスをここに持ち込まない）
        avatarFile: pickedFile,
        removeAvatar,
      });
      pickedFile = null;
      removeAvatar = false;
      fileInput.value = '';
      // 保存できたので下書きは用済み。残すと、次に開いたときに古い内容が上書きしてくる
      if (draftKey) clearFormDraft(draftKey);
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

  // 書き戻しは、保存済みの内容を入れ終えて画面に付けた後に行う（下書きを上に重ねる）
  if (draftKey) keepFormDraft(form, draftKey);
}

// 選手ページに出すプロフィール部分（自己紹介・使用キャラ・ゲームID・SNS）。
// 何も登録されていなければ空文字を返す。
export function profileSectionHtml(player) {
  const links = [
    ['X', socialUrl('x', player.snsX)],
    ['YouTube', socialUrl('youtube', player.snsYoutube)],
  ].filter(([, url]) => url);

  const rows = [];
  if (player.gameAccountId) {
    rows.push(`<div><dt>ゲームアカウントID</dt><dd><code>${escapeHtml(player.gameAccountId)}</code></dd></div>`);
  }

  let html = '';
  if (rows.length) {
    html += `<dl class="tournament-info-grid profile-grid">${rows.join('')}</dl>`;
  }

  // 使用キャラクターは項目としては出さない。選手ページの背景に大きく敷いているので
  // （js/app.js の playerArtHtml）、札を並べると同じ絵が2度出ることになる。
  // 登録そのものは残っていて、この背景と一覧の行の絵がその表示先になる。
  if (player.bio) {
    html += `<p class="player-bio">${escapeHtml(player.bio)}</p>`;
  }

  // SNSリンクはプロフィールの一番下にまとめる。
  // 外部へ出ていく導線なので、先に本人の紹介を読ませてから見せる。
  if (links.length) {
    const linkHtml = links
      .map(([label, url]) =>
        `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`)
      .join('');
    html += `<div class="sns-links">${linkHtml}</div>`;
  }
  return html;
}

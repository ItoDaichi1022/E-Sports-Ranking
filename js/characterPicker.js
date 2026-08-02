// 使用キャラクターを絵から選ぶ部品。プロフィールの入力フォームで使う。
//
// なぜ絵で選ばせるか:
//   以前はカンマ区切りの1行に手で書いてもらっていた。同じキャラクターでも
//   「シビ」「Sivi」「しび」と揺れ、スキンまでは書きようがなく、選手ページに
//   並んでも見分けがつかなかった。絵から選べば表記は1つに定まり、
//   スキンまで含めて「自分はこれ」と示せる。
//
// 【並びに意味がある】先頭がメインキャラクター。選手ページではここだけを
// 大きく出すので、順番は入れ替えられるようにしてある。
//
// 保存される文字列の形は js/characters.js を参照。

import {
  parseCharacterRef, characterImageUrl, representativeRef, searchCharacters,
} from './characters.js';

// 選べる数の上限。多く登録できても選手ページには並びきらないうえ、
// 「使うキャラクター」としての意味も薄れるので、ここで止める。
const MAX = 6;

// ---------------------------------------------------------------------------
// 選んだものを並べる帯（入力フォームの中に出る側）
// ---------------------------------------------------------------------------

// 1つ分の札。絵・名前・操作（メインにする／外す）を持つ。
function buildChip(ref, index, { onRemove, onPromote }) {
  const parsed = parseCharacterRef(ref);
  const chip = document.createElement('div');
  chip.className = `char-chip${index === 0 ? ' is-main' : ''}`;

  const url = characterImageUrl(parsed, 'thumb');
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    chip.appendChild(img);
  }

  const body = document.createElement('div');
  body.className = 'char-chip-body';

  if (index === 0) {
    const tag = document.createElement('span');
    tag.className = 'char-chip-main-tag';
    tag.textContent = 'メイン';
    body.appendChild(tag);
  }

  const name = document.createElement('span');
  name.className = 'char-chip-name';
  // 読めなかった文字列（この仕組みより前の登録）は、そのまま文字で出す
  name.textContent = parsed.known ? parsed.name : parsed.label;
  body.appendChild(name);

  if (parsed.known) {
    const skin = document.createElement('span');
    skin.className = 'char-chip-skin';
    skin.textContent = parsed.color ? `${parsed.skinLabel}・${parsed.color}` : parsed.skinLabel;
    body.appendChild(skin);
  }

  chip.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'char-chip-actions';

  if (index > 0) {
    const promote = document.createElement('button');
    promote.type = 'button';
    promote.className = 'char-chip-promote';
    promote.textContent = 'メインにする';
    promote.addEventListener('click', () => onPromote(index));
    actions.appendChild(promote);
  }

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'char-chip-remove';
  remove.textContent = '×';
  remove.title = '外す';
  remove.setAttribute('aria-label', `${parsed.label}を外す`);
  remove.addEventListener('click', () => onRemove(index));
  actions.appendChild(remove);

  chip.appendChild(actions);
  return chip;
}

// フォームに置く欄そのもの。返り値の get() で今の選択内容を取り出せる
// （フォームを建て直さずに中身だけ読む、js/profile.js のアイコン欄と同じ作法）。
//
// onChange は選択が変わるたびに呼ばれる。呼び出し側が下書き用の入力欄へ
// 書き写すために使う（js/profile.js）。
export function createCharacterField(initial = [], { onChange = null } = {}) {
  const selected = [...initial];

  const wrap = document.createElement('div');
  wrap.className = 'char-field';

  const list = document.createElement('div');
  list.className = 'char-chip-list';

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn-secondary char-add-btn';

  const hint = document.createElement('span');
  hint.className = 'field-note';

  // changed は「選び直した結果として描き直すのか」。作り直しただけのときに
  // onChange を呼ぶと、下書きの書き戻し → 作り直し → 書き戻し…と回り続ける。
  const draw = (changed = false) => {
    if (changed) onChange?.([...selected]);

    list.innerHTML = '';
    selected.forEach((ref, i) => {
      list.appendChild(buildChip(ref, i, {
        onRemove: (index) => { selected.splice(index, 1); draw(true); },
        onPromote: (index) => {
          const [moved] = selected.splice(index, 1);
          selected.unshift(moved);
          draw(true);
        },
      }));
    });

    if (!selected.length) {
      const empty = document.createElement('p');
      empty.className = 'char-empty';
      empty.textContent = 'まだ選ばれていません。';
      list.appendChild(empty);
    }

    addBtn.textContent = selected.length ? 'キャラクターを選び直す' : 'キャラクターを選ぶ';
    addBtn.disabled = false;
    hint.textContent = selected.length > 1
      ? `${MAX}人まで。先頭のキャラクターが「メイン」として選手ページに大きく出ます。`
      : `${MAX}人まで絵から選べます。最初に選んだキャラクターが「メイン」になります。`;
  };

  addBtn.addEventListener('click', async () => {
    // 絵の無い登録（この仕組みより前に文字で入力されたもの）は、選ぶ画面には
    // 持ち込めない。ここでよけておいて、選び終わったあとに末尾へ戻す。
    // 黙って捨てると、絵を選び直しただけのつもりで前の登録が消えてしまう
    // ── 外すのは、札の × を押したときだけにする。
    const legacy = selected.filter((ref) => !parseCharacterRef(ref)?.known);

    const picked = await openCharacterPicker(selected);
    if (!picked) return; // キャンセル

    selected.length = 0;
    selected.push(...picked, ...legacy);
    draw(true);
  });

  draw();
  wrap.append(list, addBtn, hint);

  return { element: wrap, get: () => [...selected] };
}

// ---------------------------------------------------------------------------
// 選ぶダイアログ
// ---------------------------------------------------------------------------
//
// index.html ではなくここで組み立てている。他のダイアログ（ログイン・お知らせ・
// チャット）は画面のあちこちから開くので共有の場所に置いてあるが、これは
// この部品の中だけで完結していて、外から触る必要が無いため。

let dialog = null;

function ensureDialog() {
  if (dialog) return dialog;

  dialog = document.createElement('dialog');
  dialog.className = 'char-picker';
  dialog.innerHTML = `
    <h3>キャラクターを選ぶ</h3>
    <div class="char-picker-selected" id="char-picker-selected"></div>
    <div class="char-picker-search">
      <input type="text" id="char-picker-search" placeholder="名前で絞り込む（例: シビ / sivi / 剣道）"
             autocomplete="off" aria-label="キャラクターを名前で絞り込む">
    </div>
    <div class="char-picker-body" id="char-picker-body"></div>
    <div class="dialog-actions">
      <button type="button" class="btn-secondary" id="char-picker-cancel">キャンセル</button>
      <button type="button" id="char-picker-done">決定</button>
    </div>
  `;
  document.body.appendChild(dialog);
  return dialog;
}

// 絵を1枚並べるボタン。一覧（キャラクター選び）とスキン選びの両方で使う。
function buildTile(ref, { title, note, selectedIndex }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'char-tile';
  if (selectedIndex != null) btn.classList.add('is-selected');
  btn.setAttribute('aria-pressed', String(selectedIndex != null));

  const url = characterImageUrl(ref, 'thumb');
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    // 226枚あるので、画面に入ったものだけ読み込ませる。
    // ここを外すと選ぶ画面を開いた瞬間に全部取りに行ってしまう。
    img.loading = 'lazy';
    img.decoding = 'async';
    btn.appendChild(img);
  }

  // 何番目に選ばれているか。並びに意味がある（先頭＝メイン）ので、
  // 印だけでなく番号を出す。
  if (selectedIndex != null) {
    const badge = document.createElement('span');
    badge.className = 'char-tile-badge';
    badge.textContent = selectedIndex === 0 ? 'メイン' : String(selectedIndex + 1);
    btn.appendChild(badge);
  }

  const label = document.createElement('span');
  label.className = 'char-tile-label';
  label.textContent = title;
  btn.appendChild(label);

  if (note) {
    const sub = document.createElement('span');
    sub.className = 'char-tile-note';
    sub.textContent = note;
    btn.appendChild(sub);
  }

  return btn;
}

// 選ぶダイアログを開く。決定なら選んだ配列、キャンセルなら null を返す。
export function openCharacterPicker(initial = []) {
  const el = ensureDialog();
  const selectedEl = el.querySelector('#char-picker-selected');
  const searchEl = el.querySelector('#char-picker-search');
  const bodyEl = el.querySelector('#char-picker-body');
  const doneBtn = el.querySelector('#char-picker-done');
  const cancelBtn = el.querySelector('#char-picker-cancel');

  // ここで扱えるのは絵のあるものだけ。読めなかった文字列は呼び出し側が
  // よけて持っていて、閉じたあとに戻してくれる（createCharacterField）。
  const selected = initial.filter((ref) => parseCharacterRef(ref)?.known);
  let openCharacter = null;

  return new Promise((resolve) => {
    const drawSelected = () => {
      selectedEl.innerHTML = '';
      if (!selected.length) {
        selectedEl.innerHTML = '<p class="char-empty">絵を押すと選べます。最初の1人がメインです。</p>';
        return;
      }
      selected.forEach((ref, i) => {
        const parsed = parseCharacterRef(ref);
        const item = document.createElement('button');
        item.type = 'button';
        item.className = `char-picked${i === 0 ? ' is-main' : ''}`;
        item.title = `${parsed.label} を外す`;
        item.innerHTML = `<img src="${characterImageUrl(parsed, 'thumb')}" alt="" decoding="async">`
          + `<span>${i === 0 ? 'メイン' : i + 1}</span>`;
        item.addEventListener('click', () => {
          selected.splice(i, 1);
          drawSelected();
          drawBody();
        });
        selectedEl.appendChild(item);
      });
    };

    const toggle = (ref) => {
      const at = selected.indexOf(ref);
      if (at >= 0) selected.splice(at, 1);
      else if (selected.length < MAX) selected.push(ref);
      else return; // 上限。黙って何もしない（押せない見た目にしてある）
      drawSelected();
      drawBody();
    };

    // 一覧はキャラクター → スキンの2段。226枚を最初から全部並べると、
    // 目当てのキャラクターにたどり着く前に力尽きる。
    const drawBody = () => {
      bodyEl.innerHTML = '';

      if (openCharacter) {
        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'back-link as-button char-picker-back';
        back.textContent = '← すべてのキャラクター';
        back.addEventListener('click', () => { openCharacter = null; drawBody(); });
        bodyEl.appendChild(back);

        const head = document.createElement('p');
        head.className = 'char-picker-head';
        head.textContent = `${openCharacter.name}（${openCharacter.nameEn}）`;
        bodyEl.appendChild(head);

        for (const skin of openCharacter.skins) {
          const group = document.createElement('div');
          group.className = 'char-skin-group';

          const title = document.createElement('p');
          title.className = 'char-skin-title';
          title.textContent = skin.label;
          group.appendChild(title);

          const grid = document.createElement('div');
          grid.className = 'char-grid';
          // 色違いが複数あるときは、マスに出すのは色だけにする。すぐ上の見出しが
          // スキン名なので、マスにも同じ名前を並べると同じ字が5回続く。
          const many = skin.variants.length > 1;
          for (const variant of skin.variants) {
            const ref = `${openCharacter.id}:${variant.id}`;
            const at = selected.indexOf(ref);
            const tile = buildTile(ref, {
              title: many ? (variant.color ?? '標準') : skin.label,
              note: null,
              selectedIndex: at >= 0 ? at : null,
            });
            if (at < 0 && selected.length >= MAX) tile.disabled = true;
            tile.addEventListener('click', () => toggle(ref));
            grid.appendChild(tile);
          }
          group.appendChild(grid);
          bodyEl.appendChild(group);
        }
        return;
      }

      const matches = searchCharacters(searchEl.value);
      if (!matches.length) {
        bodyEl.innerHTML = '<p class="empty-hint">一致するキャラクターがいません。</p>';
        return;
      }

      const grid = document.createElement('div');
      grid.className = 'char-grid';
      for (const character of matches) {
        // 一覧では代表の1枚だけを出す。そのキャラクターのスキンが1つでも
        // 選ばれていれば、その番号を見せる（開かなくても分かるように）。
        const chosen = selected.findIndex((ref) => ref.startsWith(`${character.id}:`));
        const count = character.skins.reduce((n, s) => n + s.variants.length, 0);
        const tile = buildTile(representativeRef(character), {
          title: character.name,
          note: `${count}種`,
          selectedIndex: chosen >= 0 ? chosen : null,
        });
        tile.addEventListener('click', () => { openCharacter = character; drawBody(); });
        grid.appendChild(tile);
      }
      bodyEl.appendChild(grid);
    };

    // 一度きりの後片付け。ダイアログは使い回すので、開くたびに付けた
    // 聞き手を必ず外す（外さないと2回目以降、古い Promise も解決してしまう）。
    const finish = (result) => {
      el.close();
      searchEl.removeEventListener('input', onSearch);
      doneBtn.removeEventListener('click', onDone);
      cancelBtn.removeEventListener('click', onCancel);
      el.removeEventListener('cancel', onCancel);
      resolve(result);
    };
    const onSearch = () => { openCharacter = null; drawBody(); };
    const onDone = () => finish(selected);
    const onCancel = (e) => { e.preventDefault?.(); finish(null); };

    searchEl.addEventListener('input', onSearch);
    doneBtn.addEventListener('click', onDone);
    cancelBtn.addEventListener('click', onCancel);
    // Escキーで閉じたときも「キャンセル」として扱う
    el.addEventListener('cancel', onCancel);

    searchEl.value = '';
    drawSelected();
    drawBody();
    el.showModal();
  });
}


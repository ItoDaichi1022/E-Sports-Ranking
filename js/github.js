// GitHub Contents API の薄いラッパー。
// 閲覧はPagesの静的ファイル（認証不要）、書き込みは方式B（共有書き込みトークン）を使う。
// リポジトリ情報はこのサイト自身が同居するリポジトリで固定（UIからは変更・閲覧できない）。
export const githubConfig = {
  owner: 'ItoDaichi1022',
  repo: 'E-Sports-Ranking',
  branch: 'main',
  pathPrefix: 'data',
  token: '',
  rememberToken: false,
};

const TOKEN_SESSION_KEY = 'esr-github-token';
const TOKEN_LOCAL_KEY = 'esr-github-token-local';

// 保存済みトークンを復元する。localStorage優先（「この端末に保存」を選んだ場合）。
export function loadConfigFromStorage() {
  try {
    const localToken = localStorage.getItem(TOKEN_LOCAL_KEY);
    if (localToken) {
      githubConfig.token = localToken;
      githubConfig.rememberToken = true;
      return;
    }
    const sessionToken = sessionStorage.getItem(TOKEN_SESSION_KEY);
    if (sessionToken) githubConfig.token = sessionToken;
  } catch {
    // ストレージ不可な環境では毎回入力してもらう
  }
}

export function saveConfigToStorage() {
  try {
    if (githubConfig.token && githubConfig.rememberToken) {
      localStorage.setItem(TOKEN_LOCAL_KEY, githubConfig.token);
      sessionStorage.removeItem(TOKEN_SESSION_KEY);
    } else if (githubConfig.token) {
      sessionStorage.setItem(TOKEN_SESSION_KEY, githubConfig.token);
      localStorage.removeItem(TOKEN_LOCAL_KEY);
    } else {
      sessionStorage.removeItem(TOKEN_SESSION_KEY);
      localStorage.removeItem(TOKEN_LOCAL_KEY);
    }
  } catch {
    // ストレージ不可な環境ではメモリ上の値のみ有効
  }
}

// トークンがこのリポジトリへの書き込み権限を持つか検証する（編集モード切替時に使用）。
export async function verifyWriteAccess() {
  if (!githubConfig.token) return { ok: false, error: 'トークンを入力してください。' };
  let res;
  try {
    res = await fetch(apiBase(), { headers: authHeaders() });
  } catch {
    return { ok: false, error: 'GitHubに接続できませんでした。ネットワークを確認してください。' };
  }
  if (res.status === 401) return { ok: false, error: 'トークンが無効です。' };
  if (!res.ok) return { ok: false, error: `トークンの確認に失敗しました (${res.status})。` };
  const data = await res.json();
  if (!data.permissions?.push) {
    return { ok: false, error: 'このトークンには書き込み権限がありません。' };
  }
  return { ok: true };
}

function apiBase() {
  return `https://api.github.com/repos/${githubConfig.owner}/${githubConfig.repo}`;
}

function authHeaders(extra = {}) {
  const headers = { Accept: 'application/vnd.github+json', ...extra };
  if (githubConfig.token) headers.Authorization = `token ${githubConfig.token}`;
  return headers;
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function encodeBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

function decodeBase64Utf8(b64) {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

// 指定パスのJSONファイルを取得する。存在しない場合は { json: null, sha: null } を返す。
// GitHub APIの応答はブラウザに最大60秒キャッシュされるため、no-storeで常に最新を取る
// （他端末の保存を素早く取り込むために必要）。
export async function getFile(path) {
  const url = `${apiBase()}/contents/${path}?ref=${encodeURIComponent(githubConfig.branch)}`;
  const res = await fetch(url, { headers: authHeaders(), cache: 'no-store' });
  if (res.status === 404) return { json: null, sha: null };
  if (!res.ok) throw new Error(`GitHub読み込み失敗 (${path}): ${res.status} ${await safeText(res)}`);
  const data = await res.json();
  return { json: JSON.parse(decodeBase64Utf8(data.content)), sha: data.sha };
}

// ディレクトリ内のファイル一覧を返す（存在しなければ空配列）。
export async function listDirectory(path) {
  const url = `${apiBase()}/contents/${path}?ref=${encodeURIComponent(githubConfig.branch)}`;
  const res = await fetch(url, { headers: authHeaders(), cache: 'no-store' });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHubディレクトリ一覧取得失敗 (${path}): ${res.status} ${await safeText(res)}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// ブランチの最新コミットSHAを返す。他端末が保存したかどうかを1リクエストで
// 検知するために使う（変化があったときだけ全体を読み込み直す）。
export async function getBranchSha() {
  const url = `${apiBase()}/git/ref/heads/${encodeURIComponent(githubConfig.branch)}`;
  const res = await fetch(url, { headers: authHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error(`ブランチ情報の取得に失敗しました (${res.status})`);
  const data = await res.json();
  return data.object?.sha ?? null;
}

// JSONを書き込む（新規作成 or 更新）。sha は更新時の楽観ロック用（新規作成時はnull/undefinedでよい）。
// 戻り値は更新後のsha（次回更新時に必要）。
export async function putFile(path, jsonValue, sha, message) {
  if (!githubConfig.token) throw new Error('書き込みトークンが設定されていません。');
  const url = `${apiBase()}/contents/${path}`;
  const body = {
    message,
    content: encodeBase64Utf8(JSON.stringify(jsonValue, null, 2)),
    branch: githubConfig.branch,
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await safeText(res);
    if (res.status === 409 || res.status === 422) {
      // 他端末が先に保存した（楽観ロック失敗）。呼び出し側が最新を取り込んでマージ・再試行する。
      const err = new Error(`他の端末の変更と競合しました (${path})`);
      err.isConflict = true;
      throw err;
    }
    throw new Error(`GitHub書き込み失敗 (${path}): ${res.status} ${detail}`);
  }
  const data = await res.json();
  return data.content.sha;
}

// ファイルを削除する（大会削除時のブラケット/試合ファイル用）。
// 既に消えている(404)場合は成功扱い。競合(409/422)は isConflict 付きで投げる。
export async function deleteFile(path, sha, message) {
  if (!githubConfig.token) throw new Error('書き込みトークンが設定されていません。');
  const res = await fetch(`${apiBase()}/contents/${path}`, {
    method: 'DELETE',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message, sha, branch: githubConfig.branch }),
  });
  if (res.status === 404) return;
  if (!res.ok) {
    if (res.status === 409 || res.status === 422) {
      const err = new Error(`他の端末の変更と競合しました (${path})`);
      err.isConflict = true;
      throw err;
    }
    throw new Error(`GitHub削除失敗 (${path}): ${res.status} ${await safeText(res)}`);
  }
}

// ---- Git Data API（複数ファイルを1コミットにまとめて保存するための低レベルAPI）----
// Contents API は「1ファイル=1コミット」で、大会作成のように複数ファイルを一度に保存すると
// 短時間に多数のコミットが走り、GitHub側のブランチ参照更新が競合して 409 を返しやすい
// （特にモバイル回線で顕著）。blob/tree/commit/ref を直接組むことで、何ファイル変更しても
// 1コミットにまとめられ、Pages配信の連続キャンセルも起きなくなる。

// コミットが指すツリー（そのコミット時点の全ファイル構成）のshaを返す。
export async function getCommitTreeSha(commitSha) {
  const url = `${apiBase()}/git/commits/${commitSha}`;
  const res = await fetch(url, { headers: authHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error(`コミット情報の取得に失敗しました (${res.status})`);
  const data = await res.json();
  return data.tree?.sha ?? null;
}

// baseTreeSha を土台に、変更ファイルだけを差し替えた新しいツリーを作る。
// files: 書き込みは { path, content }、削除は { path, delete: true }。
// 変更していないファイルは base_tree から引き継がれる。
export async function createTree(baseTreeSha, files) {
  const tree = files.map((f) =>
    f.delete
      ? { path: f.path, mode: '100644', type: 'blob', sha: null }
      : { path: f.path, mode: '100644', type: 'blob', content: f.content },
  );
  const res = await fetch(`${apiBase()}/git/trees`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ base_tree: baseTreeSha, tree }),
  });
  if (!res.ok) throw new Error(`ツリー作成に失敗しました (${res.status}) ${await safeText(res)}`);
  return (await res.json()).sha;
}

// 新しいツリーを指すコミットを作る（parentSha を親にする）。
export async function createCommit(message, treeSha, parentSha) {
  const res = await fetch(`${apiBase()}/git/commits`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message, tree: treeSha, parents: [parentSha] }),
  });
  if (!res.ok) throw new Error(`コミット作成に失敗しました (${res.status}) ${await safeText(res)}`);
  return (await res.json()).sha;
}

// ブランチ参照を新しいコミットへ進める。force=false のため、読み込み以降に他端末が
// ブランチを進めていた場合は非fast-forwardとして 422 が返る＝楽観ロックの競合として扱う。
export async function updateBranchRef(commitSha) {
  const url = `${apiBase()}/git/refs/heads/${encodeURIComponent(githubConfig.branch)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ sha: commitSha, force: false }),
  });
  if (!res.ok) {
    if (res.status === 422 || res.status === 409) {
      const err = new Error('他の端末の変更と競合しました');
      err.isConflict = true;
      throw err;
    }
    throw new Error(`ブランチ更新に失敗しました (${res.status}) ${await safeText(res)}`);
  }
  return (await res.json()).object?.sha ?? commitSha;
}

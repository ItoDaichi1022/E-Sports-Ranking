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
export async function getFile(path) {
  const url = `${apiBase()}/contents/${path}?ref=${encodeURIComponent(githubConfig.branch)}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 404) return { json: null, sha: null };
  if (!res.ok) throw new Error(`GitHub読み込み失敗 (${path}): ${res.status} ${await safeText(res)}`);
  const data = await res.json();
  return { json: JSON.parse(decodeBase64Utf8(data.content)), sha: data.sha };
}

// ディレクトリ内のファイル一覧を返す（存在しなければ空配列）。
export async function listDirectory(path) {
  const url = `${apiBase()}/contents/${path}?ref=${encodeURIComponent(githubConfig.branch)}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHubディレクトリ一覧取得失敗 (${path}): ${res.status} ${await safeText(res)}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
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
      throw new Error(`GitHub書き込み失敗 (${path}): 他の変更と競合した可能性があります。先に「GitHubから読み込み」してやり直してください。 (${res.status})`);
    }
    throw new Error(`GitHub書き込み失敗 (${path}): ${res.status} ${detail}`);
  }
  const data = await res.json();
  return data.content.sha;
}

// ファイルを削除する（大会削除時のブラケットファイル用）。
export async function deleteFile(path, sha, message) {
  if (!githubConfig.token) throw new Error('書き込みトークンが設定されていません。');
  const res = await fetch(`${apiBase()}/contents/${path}`, {
    method: 'DELETE',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message, sha, branch: githubConfig.branch }),
  });
  if (!res.ok) {
    throw new Error(`GitHub削除失敗 (${path}): ${res.status} ${await safeText(res)}`);
  }
}

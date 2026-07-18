// GitHub Contents API の薄いラッパー。
// 閲覧（GET）はpublicリポジトリなら認証不要。書き込み（PUT）は方式B（共有書き込みトークン）を使う。
const CONFIG_STORAGE_KEY = 'esr-github-config';

// このサイト自体が同居しているリポジトリを既定値にしておく。
// トークンだけは秘密情報のため既定値を持たせず、本人に入力してもらう。
// rememberToken を有効にした場合のみ localStorage に保存する（本人の明示的な選択）。
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

export function loadConfigFromStorage() {
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (raw) Object.assign(githubConfig, JSON.parse(raw));
  } catch {
    // 破損データは無視して既定値を使う
  }
  try {
    const token = githubConfig.rememberToken
      ? localStorage.getItem(TOKEN_LOCAL_KEY)
      : sessionStorage.getItem(TOKEN_SESSION_KEY);
    if (token) githubConfig.token = token;
  } catch {
    // ストレージ不可な環境では毎回入力してもらう
  }
}

export function saveConfigToStorage() {
  const { owner, repo, branch, pathPrefix, rememberToken } = githubConfig;
  localStorage.setItem(
    CONFIG_STORAGE_KEY,
    JSON.stringify({ owner, repo, branch, pathPrefix, rememberToken }),
  );
  try {
    if (githubConfig.token && rememberToken) {
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

export function isConfigured() {
  return Boolean(githubConfig.owner && githubConfig.repo);
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

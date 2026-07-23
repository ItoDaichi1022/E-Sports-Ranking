// ログイン状態と、それに紐づく選手行の管理。
//
// このアプリでは「選手 = ユーザーアカウント」。ログインすると players から
// user_id = 自分のアカウント の行を引き当て、それがその人の選手プロフィールになる。
// 行がまだ無い＝初回ログインなので、呼び出し側がオンボーディングフォームを出す。

import { supabase, redirectUrl } from './supabaseClient.js';

export const auth = {
  user: null,        // Supabaseのアカウント（未ログインなら null）
  player: null,      // 自分の選手行（未登録なら null）
  ready: false,      // 最初のセッション確認が終わったか
};

export function isLoggedIn() {
  return Boolean(auth.user);
}

// 選手行がまだ無いログイン済みユーザー＝新規登録の途中。
export function needsOnboarding() {
  return Boolean(auth.user) && !auth.player;
}

export function isAdmin() {
  return auth.player?.role === 'admin';
}

// 表示用の呼び名。選手登録前はアカウントのメールアドレスで代用する。
export function accountLabel() {
  if (auth.player) return auth.player.currentName;
  return auth.user?.email ?? auth.user?.user_metadata?.name ?? 'ログイン中';
}

// 自分の選手行を取り込む。行が無いのは「まだ登録していない」という正常な状態なので、
// エラーにせず null を入れる（maybeSingle が 0件を許容する）。
async function refreshOwnPlayer() {
  if (!auth.user) {
    auth.player = null;
    return;
  }
  const { data, error } = await supabase
    .from('players')
    .select('*')
    .eq('user_id', auth.user.id)
    .maybeSingle();

  if (error) throw new Error(`アカウント情報の取得に失敗しました: ${error.message}`);

  auth.player = data
    ? {
        id: data.id,
        userId: data.user_id,
        currentName: data.display_name,
        pastNames: data.past_names ?? [],
        gameAccountId: data.game_account_id ?? '',
        bio: data.bio ?? '',
        mainCharacters: data.main_characters ?? [],
        snsX: data.sns_x ?? '',
        snsTwitch: data.sns_twitch ?? '',
        snsYoutube: data.sns_youtube ?? '',
        role: data.role ?? 'player',
      }
    : null;
}

// ログイン状態が変わるたびに呼ばれるコールバック。
let onChange = () => {};

// アプリ起動時に一度だけ呼ぶ。既存セッションの復元と、以後の変化の監視を始める。
export async function initAuth(handler) {
  onChange = handler ?? (() => {});

  const { data } = await supabase.auth.getSession();
  auth.user = data.session?.user ?? null;
  await refreshOwnPlayer();
  auth.ready = true;

  // OAuthから戻ってきた直後や、トークン更新・ログアウトのたびに発火する。
  supabase.auth.onAuthStateChange(async (event, session) => {
    const nextUser = session?.user ?? null;
    const changed = nextUser?.id !== auth.user?.id;
    auth.user = nextUser;

    // TOKEN_REFRESHED では同じユーザーのままなので選手行を引き直す必要はない
    if (changed || event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
      await refreshOwnPlayer();
      onChange();
    }
  });

  onChange();
}

// 選手登録やプロフィール編集のあと、手元の auth.player を最新にする。
export async function reloadOwnPlayer() {
  await refreshOwnPlayer();
  onChange();
}

// ---- ログイン手段 ----

// Google / Discord。認可画面へ遷移し、戻ってきたときにセッションが確立される。
export async function signInWithProvider(provider) {
  const { error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: redirectUrl() },
  });
  if (error) throw new Error(`ログインに失敗しました: ${error.message}`);
}

export async function signInWithEmail(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.message.includes('Invalid login credentials')) {
      throw new Error('メールアドレスまたはパスワードが違います。');
    }
    if (error.message.includes('Email not confirmed')) {
      throw new Error('メールアドレスの確認が済んでいません。届いているメールのリンクを開いてください。');
    }
    throw new Error(`ログインに失敗しました: ${error.message}`);
  }
}

// 新規登録。プロジェクトの設定によっては確認メールのリンクを開くまで
// セッションが確立しないので、その場合を戻り値で伝える。
export async function signUpWithEmail(email, password) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: redirectUrl() },
  });
  if (error) {
    if (error.message.includes('already registered')) {
      throw new Error('このメールアドレスは既に登録されています。ログインしてください。');
    }
    if (error.message.includes('Password should be')) {
      throw new Error('パスワードは6文字以上にしてください。');
    }
    throw new Error(`登録に失敗しました: ${error.message}`);
  }
  return { needsEmailConfirmation: !data.session };
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(`ログアウトに失敗しました: ${error.message}`);
}

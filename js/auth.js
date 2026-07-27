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
        avatarUrl: data.avatar_url ?? '',
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
  //
  // 重要: このコールバックの中で supabase を await してはいけない。
  // supabase-jsはNavigator LockManagerの排他ロックを保持したままこのコールバックを
  // await で待つ。そのためコールバック内で supabase.from(...) や getSession を呼ぶと、
  // それらが同じロックを取り直そうとして「ロックを持っている処理（＝このコールバック）の
  // 完了」を待つ循環になり、デッドロックする。ロックは解放されないまま残るので、
  // 以後の保存・ログアウト等がすべて無反応で固まり、再読み込みするまで直らない。
  // → auth.user の更新だけ同期で行い、DB取得と再描画は setTimeout でロックの外へ逃がす。
  supabase.auth.onAuthStateChange((event, session) => {
    const nextUser = session?.user ?? null;
    const changed = nextUser?.id !== auth.user?.id;
    auth.user = nextUser;

    // TOKEN_REFRESHED では同じユーザーのままなので選手行を引き直す必要はない
    if (changed || event === 'SIGNED_IN' || event === 'SIGNED_OUT') {
      setTimeout(async () => {
        try {
          await refreshOwnPlayer();
        } catch (err) {
          console.error('[auth] 選手行の取得に失敗', err);
          auth.player = null;
        }
        onChange();
      }, 0);
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

// 認可画面へ渡す追加パラメータ（プロバイダごと）。
//
// Googleは一度ログインした端末だと、次からアカウント選択を挟まずに前回の
// アカウントで自動的に入ってしまう。複数のGoogleアカウントを使い分けられるよう、
// 毎回アカウント選択画面を出させる。
// prompt=consent ではなく select_account を使うのは、権限の再承認まで
// 毎回求めると余計な手間になるため（選び直したいだけなのでこちらで足りる）。
//
// Discordは既定で認可画面が出て、そこからアカウントを切り替えられるので指定しない。
const OAUTH_QUERY_PARAMS = {
  google: { prompt: 'select_account' },
};

// Google / Discord。認可画面へ遷移し、戻ってきたときにセッションが確立される。
export async function signInWithProvider(provider) {
  const { error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: redirectUrl(),
      // 未指定のプロバイダでは undefined になり、URLには何も足されない
      queryParams: OAUTH_QUERY_PARAMS[provider],
    },
  });
  if (error) throw new Error(`ログインに失敗しました: ${error.message}`);
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(`ログアウトに失敗しました: ${error.message}`);
}

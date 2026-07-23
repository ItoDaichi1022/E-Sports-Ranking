// Supabaseクライアント。
//
// js/vendor/supabase.js（UMDバンドル）を index.html の通常の <script> で先に読み込み、
// window.supabase として公開されたものをここでラップする。モジュールスクリプトは
// defer 扱いなので、通常スクリプトのほうが必ず先に実行される。
// CDNから実行時に取りに行かず同梱しているのは、外部サービスの停止でサイト全体が
// 動かなくなるのを避けるためと、ビルド工程を持たない構成を維持するため。

// ---------------------------------------------------------------------------
// ここ2行を自分のSupabaseプロジェクトの値に書き換える（supabase/SETUP.md 参照）。
// anonキーは公開前提の値で、実際の防御はデータベース側のRLSが行う。
// リポジトリにコミットして問題ない。
// ---------------------------------------------------------------------------
export const SUPABASE_URL = 'https://zgqoeicdnneivzasneez.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_yTrfsOpDxshekZrQtZ8f9Q_m5TKjqfZ';

const PLACEHOLDER_PATTERN = /YOUR-(PROJECT-REF|ANON-KEY)/;

export function isConfigured() {
  return !PLACEHOLDER_PATTERN.test(SUPABASE_URL) && !PLACEHOLDER_PATTERN.test(SUPABASE_ANON_KEY);
}

if (!window.supabase?.createClient) {
  throw new Error(
    'supabase-jsが読み込まれていません。index.html で js/vendor/supabase.js を先に読み込んでください。',
  );
}

export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // OAuthから戻ってきたURLを自動で処理してセッションを確立する
    detectSessionInUrl: true,
    // PKCEを使う。既定のimplicitフローはアクセストークンをURLのハッシュ（#access_token=...）で
    // 返すため、このアプリのハッシュベースのルーティング（#home, #bracket/xxx）と衝突する。
    // PKCEはクエリ文字列（?code=...）で返るので干渉しない。安全性の面でも推奨される。
    flowType: 'pkce',
  },
});

// OAuthのリダイレクト先。GitHub Pagesのサブディレクトリ配信でも正しく戻れるよう、
// 現在のパスから組み立てる（ハッシュは落とす）。
export function redirectUrl() {
  return `${location.origin}${location.pathname}`;
}

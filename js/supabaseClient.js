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
//
// 【wrangler.jsonc の vars も同時に直すこと】ページの title や og: をサーバー側で
// 埋める Worker はブラウザ用のこのモジュールを読めないので、同じ2つの値を
// あちらにも持たせてある。片方だけ直すと、検索結果とSNSのプレビューだけが
// 古いプロジェクトを見に行く。
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
    // 返すため、旧URL（#tournament/xxx）で着地した人を新しいパスへ書き換える処理
    // （js/router.js の migrateLegacyUrl）とぶつかる。
    // PKCEはクエリ文字列（?code=...）で返るので干渉しない。安全性の面でも推奨される。
    flowType: 'pkce',
  },
});

// OAuthのリダイレクト先。配信先（*.workers.dev・独自ドメイン・ローカル等）に
// 依存せず正しく戻れるよう、今アクセスしているURLの origin から組み立てる。
//
// 【いま開いているページには戻さない】ページのURLがパスになったので、
// location.pathname を足せば「ログインした場所」へ帰せる ── が、Supabase は
// 戻り先を Redirect URLs の許可リストと突き合わせるので、/tournaments/** まで
// 登録しておかないと、深いページから押した人だけがログインできなくなる。
// リポジトリの外（Supabaseの管理画面）の設定に挙動が依存するのは避けたいので、
// 常にトップへ戻す ── ハッシュだった頃と同じ着地点でもある。
//
// 戻る場所を「押したページ」にしたくなったら、先に Supabase の
// Redirect URLs へ `{配信先}/**` を足すこと。
export function redirectUrl() {
  return `${location.origin}/`;
}

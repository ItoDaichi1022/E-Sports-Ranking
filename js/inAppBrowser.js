// SNSアプリに埋め込まれたブラウザ（アプリ内ブラウザ）を見分けて、
// 普通のブラウザで開き直してもらうための案内を作る。
//
// 【なぜ要るか】XやDiscordの投稿からURLを踏むと、多くの端末はアプリの中に
// 埋め込まれたブラウザでこのサイトを開く。そこからログインしようとすると、
// 別々の理由で二重に失敗する:
//
//   1. Googleが認可画面を出してくれない。埋め込みブラウザからのOAuthは
//      User-Agentで見分けて拒否される（403 disallowed_useragent）。
//      Google側の方針なので、こちらの実装では回避できない。
//
//   2. 認可を通せても戻ってこられない。PKCEは code_verifier を localStorage に
//      置いて、?code= を持って戻ってきたときに引き換える
//      （js/supabaseClient.js の flowType: 'pkce'）。アプリ内ブラウザは認可画面を
//      別のブラウザや新しいWebViewで開いたり、閉じた時点でストレージを捨てたり
//      するので、verifierを書いた場所と読む場所が別物になって引き換えに失敗する。
//
// 2番のたちの悪いところは、失敗が例外にならないこと。supabase-js はセッションを
// nullにして黙って戻るので、画面にはエラーひとつ出ず、URLに ?code= が付いたままの
// 未ログイン状態になる ── 押した人からは「何も起きなかった」ようにしか見えない。
//
// どちらも「普通のブラウザで開き直してもらう」以外に直しようがないので、
// 押す前に伝える。ログインボタン自体は消さない ── 埋め込みでも通ってしまう
// 組み合わせは実際にあり、見分けは万全ではないためで、
// 塞いでしまうと「本当は入れた人」の道まで閉ざすことになる。

// User-Agentに名前が出るアプリ。ここに載っていなくても下のWebView判定で拾える
// ので、この表の役目は「アプリ名を名指しして、案内を具体的にする」こと。
//
// 【Line だけ \b で囲ってあること】'line' はUAの中の別の語（online など）に
// 埋もれて出てくる。囲わないと、無関係なブラウザまでLINEだと言い出す。
const KNOWN_APPS = [
  [/Twitter|TwitterAndroid/i, 'X'],
  [/\bDiscord\b/i, 'Discord'],
  [/Instagram/i, 'Instagram'],
  [/FBAN|FBAV|FB_IAB/, 'Facebook'],
  [/\bLine\//i, 'LINE'],
];

// いま開いているのがアプリ内ブラウザなら { app, platform } を返す。
// app はアプリ名（分からなければ null）、platform は 'android' | 'ios' | 'other'。
// 普通のブラウザなら null。
export function detectInAppBrowser() {
  const ua = navigator.userAgent || '';

  const platform = /Android/i.test(ua) ? 'android'
    : /iPhone|iPad|iPod/i.test(ua) ? 'ios'
      : 'other';

  const app = KNOWN_APPS.find(([re]) => re.test(ua))?.[1] ?? null;

  // アプリ名がUAに出ていなくても、器がWebViewなら同じことが起きる。
  //   Android … Chrome由来のWebViewはUAに "; wv)" を入れる決まりになっている。
  //             X・Discord・Instagramの内蔵ブラウザはどれもこれに当たる。
  //   iOS    … WKWebViewはUAに "Safari/" を入れない。本物のSafariも、アプリが
  //             呼び出す SFSafariViewController も入れるので、これで分けられる
  //             （Chrome や Firefox の iOS 版も CriOS/FxiOS と一緒に Safari/ を持つ）。
  const isWebView = platform === 'android' ? /;\s*wv\)/.test(ua)
    : platform === 'ios' ? !/Safari\//.test(ua)
      : false;

  if (!app && !isWebView) return null;
  return { app, platform };
}

// Androidで、いま開いているURLをChromeに渡すためのURL。
//
// intent:// はAndroidの決まりで、scheme= に本来のスキーム、package= に開かせたい
// アプリを書く。S.browser_fallback_url を添えてあるのは、Chromeが入っていない
// 端末で何も起きずに終わらせないため（そのときは元のブラウザで開き直される）。
//
// iOSに同じ手立ては無い。Safariを名指しで開くスキームは用意されていないので、
// あちらはアプリのメニューから開き直してもらうしかない。
export function chromeIntentUrl() {
  const url = location.href;
  const withoutScheme = url.replace(/^https?:\/\//, '');
  return `intent://${withoutScheme}#Intent;scheme=https;package=com.android.chrome;`
    + `S.browser_fallback_url=${encodeURIComponent(url)};end`;
}

// URLをクリップボードへ。
//
// navigator.clipboard はアプリ内ブラウザで塞がれていることがあるので、
// 古いやり方（画面外のtextareaを選択して execCommand）を控えに置く。
// どちらも押した直後にしか働けないので、必ずクリックの中から呼ぶこと。
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 下の控えへ
  }

  const area = document.createElement('textarea');
  area.value = text;
  // 画面の外へ出す。display:none や hidden にすると選択できない。
  area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
  document.body.appendChild(area);
  try {
    area.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

// アプリ内ブラウザのときだけ案内の要素を返す。普通のブラウザなら null。
//
// ログインの入口は2か所（ダイアログとマイページ）あり、同じ要素は片方にしか
// 置けないので、呼ばれるたびに作り直す。
export function inAppBrowserNotice() {
  const found = detectInAppBrowser();
  if (!found) return null;

  const box = document.createElement('div');
  box.className = 'inapp-notice';

  const title = document.createElement('p');
  title.className = 'inapp-notice-title';
  title.textContent = found.app
    ? `${found.app}アプリの中のブラウザで開いています`
    : 'アプリの中のブラウザで開いています';
  box.appendChild(title);

  const body = document.createElement('p');
  body.className = 'inapp-notice-body';
  // 「できない」で終わらせず、何をすれば入れるのかまで書く。ここで詰まった人は
  // 原因が自分の操作ではないことを知りようがない。
  body.textContent = 'このままではGoogle・Discordのログインができません。'
    + 'ChromeやSafariで開き直すとログインでき、エントリーに進めます。';
  box.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'inapp-notice-actions';

  if (found.platform === 'android') {
    // <a> をボタンに見せるのは .as-link の役目（css/style.css の「ボタン」の節）。
    // クラスを付けないと、ここだけ素のリンクとして出る。
    const openBtn = document.createElement('a');
    openBtn.className = 'as-link';
    openBtn.href = chromeIntentUrl();
    openBtn.textContent = 'Chromeで開く';
    // intent:// を拾えないWebViewもある。押しても何も起きなかった人が
    // 手詰まりにならないよう、下のコピーは常に並べておく。
    actions.appendChild(openBtn);
  }

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'btn-secondary';
  copyBtn.textContent = 'URLをコピー';
  copyBtn.addEventListener('click', async () => {
    const ok = await copyText(location.href);
    copyBtn.textContent = ok ? 'コピーしました' : 'コピーできませんでした';
    setTimeout(() => { copyBtn.textContent = 'URLをコピー'; }, 2000);
  });
  actions.appendChild(copyBtn);

  box.appendChild(actions);

  // 手順。iOSはメニューから開き直すしか手が無いので、その場所まで書く。
  const how = document.createElement('p');
  how.className = 'inapp-notice-how';
  how.textContent = found.platform === 'ios'
    ? '「Chromeで開く」に当たるものがiOSにはありません。画面のすみにあるメニュー'
      + '（…／矢印のアイコン）から「Safariで開く」を選ぶか、上でURLをコピーして'
      + 'ブラウザに貼り付けてください。'
    : 'ボタンが働かないときは、URLをコピーしてブラウザのアドレス欄に貼り付けてください。';
  box.appendChild(how);

  return box;
}

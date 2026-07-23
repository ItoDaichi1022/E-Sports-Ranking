# セットアップ手順

Supabaseプロジェクトの作成とOAuthの登録は、あなたのアカウントでの操作が必要です。
上から順に進めれば動く状態になります。所要時間は30分程度、費用はかかりません。

公開URLはこの手順の中で何度も使うので、先に控えておいてください。

```
https://itodaichi1022.github.io/E-Sports-Ranking/
```

---

## 1. Supabaseプロジェクトを作る

1. https://supabase.com にGitHubアカウントでサインイン
2. 「New project」を押す
3. 入力する項目
   - **Name**: 何でもよい（例 `esports-ranking`）
   - **Database Password**: 自動生成されたものをパスワードマネージャに保存する。日常の操作では使わないが、紛失すると再発行が面倒
   - **Region**: `Northeast Asia (Tokyo)`
   - **Plan**: Free
4. 作成完了まで1〜2分待つ

> **無料プランの注意**：1週間まったくアクセスが無いとプロジェクトが一時停止します。
> ダッシュボードから即座に再開できますが、その間サイトはデータを読めません。
> 週に1度でも誰かが閲覧していれば起きません。

## 2. テーブルを作る

1. 左メニューの **SQL Editor** → 「New query」
2. このリポジトリの [`supabase/schema.sql`](schema.sql) の中身を全部貼り付ける
3. 「Run」を押す。`Success. No rows returned` と出れば成功

何度実行しても同じ結果になるよう書いてあるので、後からやり直しても問題ありません。

## 3. 接続先をコードに書く

1. 左メニューの **Project Settings** → **API**
2. 次の2つをコピーする
   - **Project URL**（`https://xxxxxxxx.supabase.co`）
   - **Project API keys** の **anon public**（`publishable` と表示されている場合はそちら）
3. [`js/supabaseClient.js`](../js/supabaseClient.js) の先頭2行を書き換える

```js
export const SUPABASE_URL = 'https://xxxxxxxx.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGci...';
```

このキーは**公開して問題ありません**。ブラウザに配信される前提の値で、実際の防御は
データベース側の行レベルセキュリティ（RLS）が行います。リポジトリにコミットしてください。

> `service_role` キーは絶対にここに書かないでください。そちらはRLSを迂回する管理用の鍵です。

## 4. ログイン方法を設定する

左メニューの **Authentication** → **Sign In / Providers** で設定します。

### 4-1. メール＋パスワード

**Email** を有効にするだけです。追加設定は要りません。

確認メールは無料枠だと1時間あたり数通に制限されています。人数が増えて足りなくなったら、
Authentication → Emails から自前のSMTP（Resend、SendGrid等の無料枠）を設定してください。

### 4-2. Google

1. https://console.cloud.google.com/apis/credentials を開く
2. プロジェクトが無ければ作る（無料）
3. 「認証情報を作成」→「OAuth クライアント ID」→ アプリケーションの種類は **ウェブ アプリケーション**
4. **承認済みのリダイレクト URI** に、Supabaseのコールバックを登録する

   ```
   https://xxxxxxxx.supabase.co/auth/v1/callback
   ```

   （`xxxxxxxx` は自分のプロジェクトのもの。Supabaseの Providers → Google 画面にも同じURLが表示されています）
5. 発行された **クライアント ID** と **クライアント シークレット** を、Supabaseの Providers → Google に貼って有効化

### 4-3. Discord

1. https://discord.com/developers/applications で「New Application」
2. 左メニュー **OAuth2** → **Redirects** に同じコールバックURLを追加

   ```
   https://xxxxxxxx.supabase.co/auth/v1/callback
   ```

3. **Client ID** と **Client Secret**（Reset Secret で発行）を、Supabaseの Providers → Discord に貼って有効化

### 4-4. 戻り先URLを登録する

**Authentication** → **URL Configuration**

- **Site URL**: `https://itodaichi1022.github.io/E-Sports-Ranking/`
- **Redirect URLs**: 上と同じものを追加。ローカルで動作確認するなら `http://localhost:8000/` も追加しておく

ここを設定しないと、ログイン後に元のサイトへ戻れません。

## 5. GitHub Pagesで公開する

1. GitHubのリポジトリ → **Settings** → **Pages**
2. **Source** を `Deploy from a branch`、ブランチを `main` / `/ (root)` にして Save
3. 数分待つと上記のURLで公開される

ビルド工程は無いので、以後は `git push` するだけで反映されます。

## 6. 自分を運営者にする

最初の運営者だけは手動で設定します（サイト上には、まだ誰も運営者がいないため）。

1. 公開したサイトを開き、**ログイン**して**選手登録**を済ませる（表示名を入れるだけ）
2. Supabaseの **Table Editor** → `players` テーブルを開く
3. 自分の行を探し、`role` を `player` から `admin` に書き換えて保存
4. サイトを再読み込みすると、「大会作成」やランキングの公開ボタンが現れる

2人目以降の運営者は、この作業を繰り返すか、`admin_set_player_role` を使ってください。

## 7. 旧データを移行する（任意）

`data/` に残っているJSONをDBへ入れる場合だけ実行します。
現在入っているのは動作確認用のテストデータ（大会名 `test1`〜`test4`、選手 `A`〜`Y` など）なので、
**まっさらな状態で始めるならこの手順は飛ばしてください。**

```bash
# 変換結果だけ確認する（DBには書き込まない）
node scripts/migrate.mjs --dry-run

# 実際に投入する
SUPABASE_URL=https://xxxxxxxx.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=eyJ... \
node scripts/migrate.mjs
```

`SUPABASE_SERVICE_ROLE_KEY` は Project Settings → API の **service_role** キーです。
RLSを迂回する強い権限を持つので、このコマンドを打つ時だけ使い、コードには書かないでください。

移行前後でランキングや戦績が変わっていないことは、次のコマンドで確認できます。

```bash
node scripts/verify-migration.mjs
```

移行してきた選手は「代理登録」（本人のアカウントが無い状態）になります。
本人がログインして選手登録したら、**選手ページの一覧**でその行の
「本人のアカウントを統合...」から本人を選んでください。過去の戦績が引き継がれます。

## 8. 後始末

GitHubをデータベース代わりに使う仕組みは廃止されました。

- `.env` に置いていた GitHub パーソナルアクセストークンを、GitHubの
  Settings → Developer settings → Personal access tokens から**失効させる**
- 運営者に共有していた書き込みトークンも同様に無効になる旨を伝える。
  以後はそれぞれのアカウントでログインしてもらう

---

## ローカルでの動作確認

```bash
python -m http.server 8000
```

`http://localhost:8000/` を開きます。OAuthを試す場合は、手順4-4のRedirect URLsに
`http://localhost:8000/` を追加しておいてください。

## うまくいかないとき

| 症状 | 原因と対処 |
|---|---|
| 「Supabaseの接続先が未設定です」 | 手順3が済んでいない。`js/supabaseClient.js` を確認 |
| ログイン後に真っ白なページへ飛ぶ | 手順4-4のRedirect URLsに公開URLが入っていない |
| ログインはできるが編集ボタンが出ない | 手順6のroleが`admin`になっていない。書き換え後は再読み込みが必要 |
| 「〜の権限がありません」 | RLSが正しく効いている状態。運営操作なら手順6を、本人の編集なら別アカウントでログインしていないか確認 |
| データが一切読めない | プロジェクトが一時停止しているかもしれない。Supabaseダッシュボードを開くと再開する |

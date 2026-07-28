# セットアップ手順

Supabaseプロジェクトの作成とOAuthの登録は、あなたのアカウントでの操作が必要です。
上から順に進めれば動く状態になります。所要時間は30分程度、費用はかかりません。

公開URLはこの手順の中で何度も使います。Cloudflare Pagesで配信するので、URLは

```
https://（自分で決めたプロジェクト名）.pages.dev/
```

の形になります（アカウント名は入りません）。プロジェクト名は手順5で決めるので、
先にサイトを公開してURLを確定させてから、手順4-4でSupabaseに登録すると迷いません。

> このリポジトリ内でGitHub PagesのURL（`itodaichi1022.github.io/...`）を使っているのは
> この説明文だけです。コードはログイン後の戻り先を「今アクセスしているURL」から自動で
> 組み立てる（[`js/supabaseClient.js`](../js/supabaseClient.js) の `redirectUrl`）ため、
> 配信先を変えてもコードの書き換えは不要です。

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

ログインはGoogleとDiscordのみです。**Email** プロバイダは無効にしておいてください
（アプリ側にメール＋パスワードの入力欄はありません）。

### 4-1. Google

1. https://console.cloud.google.com/apis/credentials を開く
2. プロジェクトが無ければ作る（無料）
3. 「認証情報を作成」→「OAuth クライアント ID」→ アプリケーションの種類は **ウェブ アプリケーション**
4. **承認済みのリダイレクト URI** に、Supabaseのコールバックを登録する

   ```
   https://xxxxxxxx.supabase.co/auth/v1/callback
   ```

   （`xxxxxxxx` は自分のプロジェクトのもの。Supabaseの Providers → Google 画面にも同じURLが表示されています）
5. 発行された **クライアント ID** と **クライアント シークレット** を、Supabaseの Providers → Google に貼って有効化

### 4-2. Discord

1. https://discord.com/developers/applications で「New Application」
2. 左メニュー **OAuth2** → **Redirects** に同じコールバックURLを追加

   ```
   https://xxxxxxxx.supabase.co/auth/v1/callback
   ```

3. **Client ID** と **Client Secret**（Reset Secret で発行）を、Supabaseの Providers → Discord に貼って有効化

### 4-3. 戻り先URLを登録する

**Authentication** → **URL Configuration**

- **Site URL**: `https://（自分のプロジェクト名）.pages.dev/`
- **Redirect URLs**: 上と同じものを追加。ローカルで動作確認するなら `http://localhost:8000/` も追加しておく

ここを設定しないと、ログイン後に元のサイトへ戻れません。

> このURLは次の手順5でCloudflareがサイトをデプロイしたときに確定します。
> 先に手順5を済ませて実際のURLをコピーしてから、ここに貼るのが確実です。
> あとで独自ドメインを当てたら、そのURLもここに追加してください（複数登録できます）。

## 5. Cloudflare Pagesで公開する

アカウント名がURLに出ないよう、GitHub PagesではなくCloudflare Pagesで配信します。
URLは `https://好きな名前.pages.dev/` になり、`git push` で自動デプロイされる点は同じです。

1. https://dash.cloudflare.com にサインアップ（無料。メールアドレスだけで作れる）
2. 左メニュー **Compute (Workers & Pages)** → **Create** → **Import a repository**
   （＝Gitと連携する方式）
3. GitHubアカウントを連携し、このリポジトリ（`E-Sports-Ranking`）を選ぶ
4. 設定はほぼ既定のままでよい。ポイントは2つだけ
   - **Project name**: ここで入れた名前がURLになる（例 `esports-ranking` →
     `https://esports-ranking.pages.dev/`）。アカウント名は入らない
   - **Production branch**: `main`
   - ビルドコマンド・出力ディレクトリは触らなくてよい。配信対象とアップロード除外は
     リポジトリ直下の [`wrangler.jsonc`](../wrangler.jsonc) と
     [`.assetsignore`](../.assetsignore) に書いてあり、Cloudflareがそれを読む
5. **Deploy** を押す。1〜2分で `https://プロジェクト名.pages.dev/` に公開される
6. 公開されたURLをコピーし、**手順4-4に戻ってSupabaseのSite URL / Redirect URLsへ登録する**

以後は `main` に `git push` するたびに自動でデプロイされます。

> **なぜ設定ファイルが要るのか**：CloudflareのGit連携は内部で `wrangler deploy` を実行し、
> リポジトリ直下を丸ごとアップロードしようとします。素のままだとビルド環境が生成する
> `node_modules`（100MB超のバイナリを含む）まで巻き込み、1ファイル25MiBの上限で失敗します。
> `.assetsignore` で `node_modules` などを除外し、`wrangler.jsonc` で配信対象を固定することで、
> 実際にサイトが使う `index.html` / `css/` / `js/` だけが上がるようにしています。

> **独自ドメインを当てる場合**（任意）：プロジェクトの **Custom domains** タブから
> 追加できます。サブドメインすら見せたくない場合の選択肢です。当てたら、そのURLも
> 手順4-4のRedirect URLsに追加してください。

> **GitHub Pagesを既に有効にしていた場合**：混乱を避けるため、リポジトリの
> Settings → Pages で Source を `None` にして無効化しておくとよいです（必須ではありません）。

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

## 7.5. 既に構築済みの場合：差分を適用する

既に `schema.sql` を実行してあるプロジェクトには、あとから入った変更だけを当てます。
**新しくプロジェクトを作る場合は不要です**（`schema.sql` に取り込み済み）。

**SQL Editor** → 「New query」に、下の順で1つずつ貼り付けて「Run」します。
どれも何度実行しても同じ結果になるので、当てたか分からないものは実行して構いません。

| ファイル | 内容 |
|---|---|
| [`migration-002.sql`](migration-002.sql) | 定員チェックの作り直し ＋ アイコン画像（`players.avatar_url` と `avatars` バケット） |
| [`migration-003.sql`](migration-003.sql) | ホーム画面のお知らせ（`announcements` テーブル） |
| [`migration-004.sql`](migration-004.sql) | 大会・お知らせの画像（`image_url` 列と `images` バケット） |
| [`migration-005.sql`](migration-005.sql) | 確定した成績の保存（`tournament_entries.placement`） |
| [`migration-006.sql`](migration-006.sql) | 大会の対戦方法（`tournaments.match_type`）＝ランキング反映の条件 |
| [`migration-007.sql`](migration-007.sql) | 2v2（チーム戦）対応（`tournament_teams` テーブルとチームでのエントリー） |
| [`migration-008.sql`](migration-008.sql) | 対戦カードごとのチャット（`match_chat_messages` テーブル） |

補足:

- **002 の定員チェック** — 定員ちょうどまで埋まった大会が締め切れなくなる不具合と、
  まとめて登録したときに定員が素通りする不具合の修正です。
- **002 の `avatars` バケット** — 「誰でも閲覧可・書き込みは自分のフォルダのみ」。画像は
  `avatars/{自分のユーザーID}/...` に保存され、他人のアイコンは差し替えられません。
- **004 の `images` バケット** — 閲覧は誰でも、アップロードは運営だけです。
- **005 の `placement`** — 優勝・準優勝・ベストNを、結果を確定した時点でエントリー行に
  書き込みます。これが無いと、選手ページを開くだけで全大会の対戦表を読むことになり、
  無料枠の転送量をいちばん食っていました。既存の確定済み大会は実行時に埋め戻されます。
- **006 の `match_type`** — 参加24人以上かつ1v1／リレーの大会だけをランキングのスコアに
  反映するための列です。既存の大会は対戦方法が分からないため `null`（＝反映対象外）で
  入ります。反映させたい大会は、大会詳細の「大会情報を編集」から対戦方法を選び直してください。
- **007 の 2v2 対応** — チーム戦ではブラケットの枠に入るのがチームになるため、
  `tournament_teams` テーブルと、チーム単位でエントリーするRPCを追加します。
  `matches` の選手列を `null` 許容にし、チーム用の列を足します（どちらか一方だけが
  入ることを制約で保証）。既存の大会は `team_id` が `null` のままなので挙動は変わりません。
  定員の数え方も「チーム大会ならチーム数」に変わります。
- **008 の対戦カードチャット** — このテーブルだけは**ゲスト（anon）に権限を与えません**。
  読み書きできるのは その試合の当事者と運営だけで、判定はブラケットのJSONを読む関数
  （`can_use_match_chat`）が行います。Realtimeのパブリケーションにも意図的に入れて
  いません（理由は `doc/design.md`）。

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
| ログイン後に真っ白なページへ飛ぶ | 手順4-4のRedirect URLsに、公開URL（`https://…​.pages.dev/`）が入っていない。デプロイ後にURLが確定するので、手順5の後に登録したか確認 |
| Cloudflareで404になる／ページが出ない | 手順5でBuild output directoryが `/`（ルート）になっているか確認。ビルドコマンドは空欄でよい |
| ログインはできるが編集ボタンが出ない | 手順6のroleが`admin`になっていない。書き換え後は再読み込みが必要 |
| 「〜の権限がありません」 | RLSが正しく効いている状態。運営操作なら手順6を、本人の編集なら別アカウントでログインしていないか確認 |
| データが一切読めない | プロジェクトが一時停止しているかもしれない。Supabaseダッシュボードを開くと再開する |

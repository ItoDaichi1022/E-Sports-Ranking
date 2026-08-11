# IgniteArena — どこでも熱く、遊べ。

コミュニティ内のトーナメント運営と個人ランキングをまとめて扱うWebアプリです。
（リポジトリ名は E-sportsRanking、サイト名は IgniteArena）

- **ゲスト**（ログイン不要）で大会履歴・ブラケット・選手プロフィールを閲覧できる
- **Google / Discord**でログインすると、自分の選手プロフィールを持てる
- 募集中の大会に**エントリーボタン1つ**で参加登録できる
  （2v2の大会だけは、チーム名と相方を選んでチーム単位で登録する）
- **大会は誰でも開ける**。作った人がその大会の運営になり、いっしょに進行する人を
  選手名簿から指名できる（権限はその大会に限られる）
- ランキングは**サイトに一覧を置かず**、集計してお知らせや順位発表の動画で出す
  （集計と発表画面はサイトの持ち主だけが使う）
- 運営が**エントリー締切**を決めておくと、募集ページと大会ページに残り時間つきで出る
  （掲示だけで、時刻が来ても自動では締まらない）
- 締め切ると**それまでの戦績を元にシード**が決まり、ブラケットが生成される
- 運営が**回戦を開始**すると、選手が**自分の対戦のゲームカウントを入力**できる（配信台の指定は任意）
  （当事者のどちらが入れてもその場で確定し、間違いは運営が直す）
- 対戦表の**自分のいるところをタップすると、その対戦相手とチャット**できる（運営はどの対戦にも入れる）
- もめたときはチャットから**運営に報告**でき、運営の画面ではその大会と対戦に印が出る
- 勝敗が確定するたびに、各選手のプロフィールの戦歴に反映される

## 構成

| 役割 | 使うもの |
|---|---|
| ホスティング | Cloudflare（静的アセット＋Worker。ページのURLと共有リンクをWorkerが受ける） |
| データベース・認証 | Supabase (PostgreSQL + Auth + RLS) |
| 自動更新 | Supabase Realtime |
| フロントエンド | 素のJavaScript（ESモジュール、**ビルド工程なし**） |

いずれも無料枠の範囲で運用できます。

## セットアップ

Supabaseプロジェクトの作成とOAuthの登録が必要です。手順は **[supabase/SETUP.md](supabase/SETUP.md)** にまとめてあります。

## ディレクトリ

```
index.html             画面の骨組み（各ページの器と、JSが触る入力欄）
pages/                  中身が長い読み物ページ。index.html の空の <section> に
                        初回表示のときだけ読み込む（index.html を短く保つため）
  guide.html           はじめに（使い方）
  terms.html           利用規約
  privacy.html         プライバシーポリシー
css/style.css
fonts/                 見出し・数字用フォント Oxanium（OFLライセンス、woff2を同梱）
js/
  app.js               画面の描画とイベント配線
  router.js            URLとページの対応表。リンクの横取り・戻る進む・旧URLの読み替え
                       （worker/index.js もこの表を読む。増やすときはここだけ直す）
  seo.js               ページごとの title・説明文・canonical・構造化データの文言
                       （worker/index.js もこれを読んで、返すHTMLに埋め込む）
  supabaseClient.js    接続先の設定（ここを書き換える）
  auth.js              ログイン状態と自分の選手行
  db.js                DBとの読み書き。snake_case ⇄ camelCase の唯一の境界
  state.js             アプリ全体で共有する in-memory データ。出場枠（選手／チーム）の解決もここ
  bracket.js           ブラケットの生成と勝敗の確定
  bracketView.js       ブラケットの描画（2v2ではチーム名＋メンバーを出す）
  bracketZoom.js       対戦表の拡大縮小（地図のように、つまんで寄る・引く）
  matchChat.js         対戦カードごとのチャットと運営への報告（当事者と運営だけ）
  ranking.js           ランキング計算（LumiRank軽量版）
  rankingEligibility.js 大会をランキングに反映するかの条件（16人以上・1v1／リレー・YouTube配信・運営の設定）
  playerStats.js       選手ごとの戦績集計
  entries.js           募集ページとエントリー（2v2のチーム編成フォームを含む）
  profile.js           プロフィールの入力と表示
  players.js           選手一覧と検索
  organizerPicker.js   「この大会の運営」を選手名簿から選ぶ欄
  reveal.js            順位発表の画面（持ち主専用）。集計と「前回の順位」の保存もここ
  util.js              エスケープ・URL検証・アイコン描画の共通処理
  tournamentTier.js    参加人数から大会規模Tierを判定
  vendor/supabase.js   supabase-js（同梱。CDNに依存しないため）
worker/index.js        URLをサーバー側で受ける小さなWorker。仕事は3つ。
                       (1) /tournaments/{ID}/ のようなページのURLに index.html を返す
                           （直リンクとリロードを404にしないため）
                       (2) その <head> に、そのページの title・og:・canonical・
                           構造化データを埋めて返す（HTMLRewriter）。文言を作るのは
                           ブラウザ側と同じ js/seo.js。UAでの出し分けはしない
                       (3) 古い共有リンク /t/{大会ID} を新URLへ301
supabase/
  schema.sql           テーブル・RLS・トリガー・RPC
  migration-002.sql    構築済みプロジェクトへの差分適用（〜022まで番号順に当てる）
  SETUP.md             セットアップ手順
scripts/
  check-cache-version.mjs デプロイ前にキャッシュ更新の版数を確認する
doc/design.md          設計ドキュメント
_headers               Cloudflareが返すキャッシュ指定。?v= の付くものは1年、
                       index.html は毎回確認。中身に理由を書いてある
```

## ローカルで動かす

Cloudflare の開発サーバーを使います。先に [supabase/SETUP.md](supabase/SETUP.md) の
手順3まで済ませてください。

```bash
npx --yes wrangler dev   # http://localhost:8787/
```

**素の静的サーバー（`serve` や `python -m http.server`）では、トップページ以外が
すべて404になります。** ページのURLは `/tournaments/{大会ID}/` のようなパスですが、
そんなファイルは実在せず、どのURLでも index.html を返すという判断を
[worker/index.js](worker/index.js) が受け持っているためです。検索結果とSNSに出る
title・og: も同じところで埋めているので、そこを確かめるにもWorkerが要ります。

トップページだけを見て済む作業（ホームの見た目やCSSの調整）であれば、
静的サーバーでも足ります。

### `wrangler dev` が「Reloading local server...」を繰り返して応答しないとき

`assets.directory` がリポジトリ直下（`.`）なので、wrangler 自身が作業用に書き込む
`.wrangler/` が監視対象の中に入ってしまい、書き込み → 再読み込み → 書き込み …
と回り続けることがある（`.assetsignore` はアップロード対象を絞るだけで、
監視までは止めない）。回り出したら `.wrangler/` を消してから起動し直す。

```bash
rm -rf .wrangler && npx --yes wrangler dev
```

### 検索結果とSNSのプレビューを確かめる

UAでの出し分けはしていないので、クローラーと同じものが `curl` でそのまま見える。
**この2つの出力は完全に一致していなければならない**（食い違ったらそれは不具合）。

```bash
curl -s "http://localhost:8787/tournaments/{大会ID}/"                      | grep -E 'og:|<title>'
curl -s -A "Twitterbot/1.0" "http://localhost:8787/tournaments/{大会ID}/"  | grep -E 'og:|<title>'
```

構造化データ（JSON-LD）は、出力の `application/ld+json` の中身を
[リッチリザルトテスト](https://search.google.com/test/rich-results)（コードを直接貼る方）と
[validator.schema.org](https://validator.schema.org/) に貼って確かめる。

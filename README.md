# IgniteArena — どこでも熱く、遊べ。

コミュニティ内のトーナメント運営と個人ランキングをまとめて扱うWebアプリです。
（リポジトリ名は E-sportsRanking、サイト名は IgniteArena）

- **ゲスト**（ログイン不要）で大会履歴・ブラケット・選手プロフィール・ランキングを閲覧できる
- **Google / Discord**でログインすると、自分の選手プロフィールを持てる
- 募集中の大会に**エントリーボタン1つ**で参加登録できる
  （2v2の大会だけは、チーム名と相方を選んでチーム単位で登録する）
- 締め切ると**それまでの戦績を元にシード**が決まり、ブラケットが生成される
- 運営が**配信台を決めて回戦を開始**すると、選手が**自分の対戦のゲームカウントを入力**できる
  （相手が承認して確定する）
- 対戦表の**自分のいるところをタップすると、その対戦相手とチャット**できる（運営はどの対戦にも入れる）
- もめたときはチャットから**運営に報告**でき、運営の画面ではその大会と対戦に印が出る
- 勝敗が確定するたびに、各選手のプロフィールの戦歴に反映される

## 構成

| 役割 | 使うもの |
|---|---|
| ホスティング | Cloudflare Pages |
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
  app.js               画面のルーティングとイベント配線
  supabaseClient.js    接続先の設定（ここを書き換える）
  auth.js              ログイン状態と自分の選手行
  db.js                DBとの読み書き。snake_case ⇄ camelCase の唯一の境界
  state.js             アプリ全体で共有する in-memory データ。出場枠（選手／チーム）の解決もここ
  bracket.js           ブラケットの生成と勝敗の確定
  bracketView.js       ブラケットの描画（2v2ではチーム名＋メンバーを出す）
  matchChat.js         対戦カードごとのチャットと運営への報告（当事者と運営だけ）
  ranking.js           ランキング計算（LumiRank軽量版）
  rankingEligibility.js 大会をランキングに反映するかの条件（24人以上・1v1／リレー）
  playerStats.js       選手ごとの戦績集計
  entries.js           募集ページとエントリー（2v2のチーム編成フォームを含む）
  profile.js           プロフィールの入力と表示
  players.js           選手一覧
  util.js              エスケープ・URL検証・アイコン描画の共通処理
  rankingView.js       ランキング表
  rankingCard.js       ランキング発表カードのPNG書き出し
  tournamentTier.js    参加人数から大会規模Tierを判定
  vendor/supabase.js   supabase-js（同梱。CDNに依存しないため）
supabase/
  schema.sql           テーブル・RLS・トリガー・RPC
  migration-002.sql    構築済みプロジェクトへの差分適用（〜015まで番号順に当てる）
  SETUP.md             セットアップ手順
scripts/
  check-cache-version.mjs デプロイ前にキャッシュ更新の版数を確認する
doc/design.md          設計ドキュメント
```

## ローカルで動かす

静的ファイルを配るだけなので、どんな静的サーバーでも動きます。

```bash
npx --yes serve .        # Node があるとき
python -m http.server 8000   # Python があるとき
```

`http://localhost:8000/`（`serve` は表示されたポート）を開きます。
先に [supabase/SETUP.md](supabase/SETUP.md) の手順3まで済ませてください。

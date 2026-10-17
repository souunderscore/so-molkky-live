# so-molkky-live

Google Apps Script 上で稼働する Live Scheduler v0.6 と、GitHub Pages向け移行版の開発用ソースです。

## GitHub Pages版（検証版）

現在の画面を引き継ぎ、Google認証後にブラウザからYouTube APIへ直接接続します。GAS版は残しています。Pages版はGoogle CloudのクライアントID設定と実機での連携確認が必要です。

- `Index.html`：両版で共有する画面。GASでは従来どおりこのファイルを使用。
- `pages/client.js`：Google認証、YouTube操作、端末内のテンプレート・作成記録。
- `pages/ui.js`：接続先チャンネル表示、通信中断時の確認、下書きの読み込み。
- `npm run build:pages`：共有画面から `dist/index.html` などの公開用ファイルを生成。
- `.github/workflows/ci.yml`：GAS・Pages版のテストとプレビュー成果物の作成。
- `.github/workflows/pages.yml`：mainの更新または手動実行で、テスト後にPagesを公開。

Pages版の下書き・テンプレートは端末のブラウザ保存です。アカウント・端末間での自動同期は行いません。接続トークンはメモリだけで保持します。

[Google連携・公開・データ移行・iPhoneでの確認手順](docs/pages-migration.md)を参照してください。

## ローカルテスト

Node.js 24 以上と npm を使用します。リポジトリのルートで実行してください。

```sh
npm ci
npm test
```

`npm test` は既存のGASテスト、Pagesのビルド、Pages版の認証・API・保存・移行・画面テストを実行します。実際のGoogle APIには接続しません。

`tests/smoke.cjs` は配置先に依存せず、このリポジトリの `Index.html` と
`Code.gs` を読み込みます。

- jsdom による画面の初期化、試合追加、タイトル生成、下書き保存、入力例の解析・取り込み
- GAS 外での API 呼び出しが適切にエラーになること
- Google サービスを模した予約リクエスト、日本時間から UTC への変換、二重登録防止、不正入力の拒否、テンプレート操作

テストは Google API と通信せず、GAS への書き込み・プロジェクト作成・デプロイを行いません。
Google 認証、本番連携、実ブラウザの表示は検証対象外です。

## GAS との同期

clasp 3.4.1 も開発依存として固定しています。
CLI の確認には `./node_modules/.bin/clasp --version` を使用できます。
`npm ci` と `npm test` は clasp による同期を実行しません。

既存の GAS プロジェクトを維持し、同期対象の差分を確認してから明示的な指示に従って同期します。
GAS本番への自動同期・デプロイ設定はありません。Pages公開は前述の別ワークフローです。
プロジェクト設定・認証情報はローカルで別途設定し、トークンをソース・チャット・GitHub に記載しないでください。

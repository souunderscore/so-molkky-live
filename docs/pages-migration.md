# GASからGitHub Pagesへの移行（検証版）

既存の `Code.gs` と `Index.html` によるGAS版を残し、Pages版は `pages/index.html`・`app.css`・`ui.js` の3ステップ画面からビルドします。
Pages版はブラウザからYouTube APIを呼びます。Google Cloudの初期設定が完了するまで、YouTubeの操作はできません。現時点では自動テストとローカル表示の検証用です。実アカウントでの認証・YouTubeへの書き込み・PRISM連携は、下記の実機確認後に利用を切り替えてください。

## 1. Google連携を設定する

1. [Google Cloud Console](https://console.cloud.google.com/)を開き、YouTube Data API v3を使うプロジェクトを選択します。既存のGASに関連付けた管理可能な標準プロジェクトがある場合は、そのプロジェクトの利用を検討してください。GAS専用の既定プロジェクトしかない場合は、管理可能なプロジェクトを用意します。
2. **APIとサービス → ライブラリ**で **YouTube Data API v3** を有効にします。
3. **Google Auth Platform**でアプリ名・連絡先・対象ユーザー・同意画面を設定します。個人の検証段階では、テストユーザーに利用するGoogleアカウントを登録します。一般向けに配布する場合は、Googleが求める公開・確認手続きを別途確認してください。
4. データアクセスのスコープに `https://www.googleapis.com/auth/youtube.force-ssl` を設定します。予約の作成・編集・削除とサムネイル設定に使います。
5. **クライアント → クライアントを作成**で種類を **ウェブアプリケーション**にし、**承認済みのJavaScript生成元**に `https://souunderscore.github.io` を登録します。リポジトリ名のパスや末尾の `/` は入れません。独自ドメインを使う場合は、そのオリジンも登録します。
6. ローカルで認証を確認する場合は、生成元に `http://localhost` と `http://localhost:8000` も登録します。
7. 発行された **クライアントID** をPages版画面上部の **設定 → Google連携設定** に入力します。この公開用IDはブラウザに保存されます。**クライアントシークレットは使用しません**。

この方式はトークンをサーバーへ送信せず、メモリにだけ保持します。ページを閉じた場合や有効期限が切れた場合は、「Googleに接続」から再接続してください。期限切れや401で、予約作成を自動再送することはありません。

同じGoogleアカウントに複数のYouTubeチャンネルがある場合は、接続後のチャンネル名・IDを必ず確認します。複数チャンネルが返り、操作対象を特定できない場合は操作を止めます。

## 2. GitHub Pagesを公開する

実装をmainへ取り込んだ後に行います。PRを作成しただけでは公開されません。

1. リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** に設定します。リポジトリ設定を変更できる権限が必要です。
2. **Actions → Deploy Pages → Run workflow** でmainを選択して実行します。
3. デプロイが成功したら、Actionsが表示するURLを開きます。標準設定なら `https://souunderscore.github.io/so-molkky-live/` です。
4. 設定 → Google連携設定にクライアントIDを入力し、「Googleに接続」を押します。Safariで接続画面が開けることと、接続先チャンネルを確認します。

公開対象はビルド出力 `dist/` のHTML・JavaScriptだけです。GAS、テスト、開発用依存関係はPagesの配布物に含めません。mainへ変更が入るとテスト・ビルド後に再公開します。デプロイ用ワークフローはmainだけを許可し、PRのCIでは公開しません。

## 3. 下書きの保存

予約作成画面の「下書き保存」で、現在の入力・共通設定・個別設定をこのブラウザに保存します。「下書きを読み込む」で再開できます。画像は保存しないため、再選択してください。以前のブラウザ版で保存した下書きも読み込めます。

共通設定テンプレートと設定・下書きの引き継ぎはブラウザ版の画面から削除しました。設定画面はGoogle連携だけです。既存の保存データを自動削除する処理はありません。

GAS版とブラウザ版では保存場所が異なり、データは自動では移りません。必要な時刻・タイトルをブラウザ版の入力欄に貼り付けてください。登録済みの予約を重複して作成しないよう、移行前にYouTube Studioで確認してください。

## 4. 通信中断後の確認

作成前に予約のリクエストIDと内容を端末へ記録し、同じチャンネル・同じIDの重複作成を抑止します。同じブラウザの複数タブはWeb Locksで直列化します。対応していないブラウザでは作成を止め、更新を案内します。

通信切断・タイムアウト・サーバーエラー・不正な成功応答などで作成結果が不明な場合、該当記録を残し、同じチャンネルの新しい作成も止めます。画面下部の **登録結果の確認** から次のどちらかを行います。

- **予約が存在する場合**：動画のURLまたはIDを入力し、作成済み予約と照合します。チャンネル・タイトル・開始時刻が一致した場合だけ作成済みとして記録します。元の試合一覧から再試行すると、予約を増やさず結果を取り込みます。
- **存在しない場合**：YouTube Studioの一覧を更新して未登録を確認後、**未登録を確認して再試行を許可** で確認待ち記録を解除します。その後、試合一覧から再試行します。

サムネイルだけ失敗した場合、予約の作成は成功として扱います。予約管理の編集からサムネイルを差し替えられます。作成APIを自動再送しません。

この重複防止は同一ブラウザ内の機能です。端末・ブラウザ・別オリジン・GAS版をまたぐ重複は防げず、保存データを消した場合も記録を引き継げません。

## 5. 切り替え前の実機確認

- iPhoneのSafariで接続・アカウント選択・チャンネル名とIDの表示。
- 本人が指定したタイトル・日時で非公開予約を1件作成し、YouTube Studioで日本時間・説明文・公開設定・サムネイルを照合。
- その予約をPages版で取得し、編集・サムネイル差し替え・削除。
- 本人が指定した複数試合で一括作成し、成功件数・順序・部分失敗時の挙動を確認。
- 再読み込み後の再接続、期限切れ時の案内、下書きの保存と読み込み。
- PRISM Liveで作成した予約を選択できることを確認。
- 公開・限定公開を使う前に、意図した公開設定がYouTubeへ反映されることを確認。

実機確認のためのYouTube予約の作成・変更・削除はユーザーの指示に従って実行します。自動テストやPagesの公開処理がYouTubeの予約を操作することはありません。

## 開発・検証

```sh
npm ci
npm test
npm run build:pages
python3 -m http.server 8000 --directory dist
```

`npm test` はGAS版の既存スモークテストとPages版のテストを実行します。Google OAuth、YouTube API、ローカル保存、Web Locksはテスト用に置き換えます。実Google認証・実API・Safariのポップアップ許可は自動テストの対象外です。

## 新しい画面の保存互換性

時刻・タイトルの自由入力、3ステップでの作成、共通設定と試合別設定に対応しています。旧ブラウザ版で保存した下書きは引き続き読み込めます。画像は再選択が必要です。

## 公式資料

- [Google Identity Servicesのトークン方式](https://developers.google.com/identity/oauth2/web/guides/use-token-model)
- [Web用クライアントIDの設定](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid)
- [YouTubeライブ予約の作成](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/insert)
- [YouTubeライブ予約の更新](https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/update)
- [サムネイル設定](https://developers.google.com/youtube/v3/docs/thumbnails/set)
- [GitHub ActionsによるPagesの公開](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

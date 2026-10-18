# Google Drive API と Web 閲覧

Windows 版から Google Drive API でライブラリを保存し、GitHub Pages の静的な Web 画面から同じ Google アカウントで読みます。既存のフォルダー同期とは別の、一方向のアップロードです。Web での編集・翻訳・Windows への書き戻しには対応しません。

## Google Cloud の設定

同じ Google Cloud プロジェクトで Google Drive API を有効にし、デスクトップアプリ用とウェブアプリケーション用の OAuth クライアントを用意します。両方ともスコープは `https://www.googleapis.com/auth/drive.file` です。このアプリが作ったファイルだけを対象とし、Drive 全体へのアクセスや一般公開は要求しません。テスト公開中なら利用する Google アカウントをテストユーザーに追加してください。

Web 用クライアントの「承認済みの JavaScript 生成元」に、次を登録します（リポジトリー名を含めません）。

```text
https://hooked-on-mas.github.io
```

ローカル開発には `http://localhost:5173` も追加します。Web 版は Google Identity Services のトークン方式を使い、クライアントシークレットは使いません。アクセストークンはメモリー内だけに保持し、有効期限が切れたら「再ログイン」を押します。

このリポジトリーには指定された Web 用クライアント ID を公開設定として入れています。別のプロジェクトに変える場合は、GitHub の Repository variable `GOOGLE_WEB_CLIENT_ID`、またはビルド時の環境変数 `VITE_GOOGLE_CLIENT_ID` で上書きできます。Web クライアント ID は秘密情報ではありません。

## Windows から保存

1. 設定 → 保存先・同期 → **Google Drive API・Web閲覧** を開きます。
2. デスクトップ用 OAuth クライアントの ID とシークレットを入力し、「Googleに接続」を押します。
3. 既定のブラウザーで Google にログインして許可し、Papeer に戻ります。
4. **今すぐアップロード** を押します。以後は起動中に 5 分ごと、変更があるときに保存します。設定画面・編集ダイアログ・ほかの処理が開いている間は待機します。

初回はライブラリ全体を転送します。一時コピーと書き込み付きPDFを作るため、ローカルにも空き容量が必要です。保存内容が一貫するよう、転送中は編集を一時停止します。処理一覧から中止できます。アプリ終了後の自動転送はありません。PCを閉じる前に最新の内容をWebで読みたいときは、手動アップロードの完了を確認してください。

認証にはランダムなループバックポートと PKCE・state を使います。更新トークンなどは `%LOCALAPPDATA%\PapeerSync\google-drive-credentials.dpapi` に Windows DPAPI で暗号化して保存します。ライブラリ・バックアップ・Drive・GitHub Pagesには含めません。APIへの接続は現在Windows版のみです。

## GitHub Pages

1. GitHub の `hooked-on-mas/papeer` → Settings → Pages → Source を **GitHub Actions** に設定します。
2. `.github/workflows/pages.yml` がデフォルトブランチに入ったら、Actions → **Web Library (GitHub Pages)** → Run workflow を実行します。以後、main のフロントエンド変更で再配信します。
3. 配信が成功すると `https://hooked-on-mas.github.io/papeer/` で開けます。
4. Windows で使ったのと同じ Google アカウントでログインします。

Pages に配信するのは `frontend/web-dist` のアプリだけです。PDFや個人データ、デスクトップ用シークレットをこのフォルダーに入れないでください。GitHubリポジトリーの公開範囲は変更する必要がありません。非公開リポジトリーからのPages利用可否はGitHubの契約に依存します。

```powershell
cd frontend
pnpm dev:web
pnpm build:web
```

通常の `pnpm build` は従来のWindows/Tauri UIをビルドします。Web版にはローカルsidecarへの接続やTauri依存を含めません。相対URLでビルドするのでリポジトリー配下でも読み込めます。

## 保存されるデータと閲覧

ライブラリの全ファイル（原文・訳文・翻訳途中のページ・画像・解説・複数メモ・HTML資料・ノート用紙・辞書・設定・プロンプト等）と、SQLiteの整合したコピーを保存します。SQLiteには書き込み、付箋、ハイライト、チャット、書誌、読書状態、タグ、フォルダー、項目間リンクなどが含まれます。一時ファイルとSQLiteのWAL/SHMは除外します。端末専用の履歴・OAuth資格情報など、ライブラリ外の情報は対象外です。

Webでは論文・ノートを検索して選び、資料を切り替えます。PDFはページ移動、Markdownはプレビュー、HTML資料はスクリプト・外部通信を止めた表示、付箋・チャットは専用の一覧で読めます。元の手書きデータも残し、原文・訳文・ノートに書き込みがあれば書き込み付きPDFを追加で生成します。その他のデータは「ライブラリ全体のファイル」から閲覧またはダウンロードできます。HTML内の外部リソースは読み込めません。

Drive内ではPC上のライブラリごとに `Papeer Library` フォルダーを作ります。ファイルは内容のSHA-256を名前にした `blob-…` として重複を避けて保存し、全ファイルがそろってから `papeer-library.json` を更新します。途中で失敗しても直前に保存できた世代をWebで開けます。次回は転送済みのファイルを再利用します。手動アップロードではDrive側のチェックサムも照合し、消失・破損したファイルを再送します。ブラウザーもダウンロードした内容のSHA-256を確認します。

失敗した自動アップロードは停止し、設定画面と処理一覧に表示します。手動で再試行してください。変更なしの定期確認では転送しません。複数PC・再接続で複数の保存ライブラリがある場合、Web上部で選べます。別PC間の編集の統合は行いません。

古いblob・途中で止めた転送済みblobはこの版では自動削除しません。更新を重ねるとDriveの使用容量が増えます。接続解除もDriveのデータは消しません。不要になった保存ライブラリは、もう使わないことを確かめてDriveのフォルダー単位で削除してください。

## 参照

- [Google: デスクトップOAuth・PKCE・ループバック](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google: Driveのスコープ](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Google: Webトークン方式](https://developers.google.com/identity/oauth2/web/guides/use-token-model)
- [Google: 再開可能なアップロード](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [GitHub: Pagesのカスタムワークフロー](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

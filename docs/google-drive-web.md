# Google Drive API と Web 閲覧

Windows版からGoogle Drive APIでライブラリを直接保存し、GitHub PagesのWeb画面から同じGoogleアカウントで読みます。WebでPDFへの手書き・文字メモを追加でき、PCの次回同期で取り込めます。Google Drive for desktopの同期フォルダーや追加サーバーは不要です。

Webでは翻訳開始・AI接続設定・新しいチャット送信を提供せず、PCで作成した解説やチャット履歴を読みます。環境による操作の違いと書き込みの保存仕様は [Webプラットフォーム計画](web-platform-plan.md) を参照してください。

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
2. **Googleに接続** を押します。クライアントIDやシークレットの入力は不要です。
3. 既定のブラウザーで Google にログインして許可し、Papeer に戻ります。
4. **今すぐアップロード** を押します。以後は起動中に 5 分ごと、変更があるときに保存します。設定画面・編集ダイアログ・ほかの処理が開いている間は待機します。

認証画面を閉じた場合は、待機中の **認証画面をもう一度開く** で開き直せます。最初からやり直す場合は **接続をキャンセル** → **Googleに接続** を押します。Googleの接続結果を確認中もキャンセルでき、キャンセル前の結果が後から届いても接続を保存しません。

失敗時は、許可の拒否・時間切れ・通信失敗・OAuthクライアントの拒否・端末への保存失敗を区別して表示します。Googleの応答本文や認証コード・トークンは表示せず、`auth_error_code` には固定の診断コードだけを返します。

初回はライブラリ全体を転送します。一時コピーと書き込み付きPDFを作るため、ローカルにも空き容量が必要です。保存内容が一貫するよう、転送中は編集を一時停止します。処理一覧から中止できます。アプリ終了後の自動転送はありません。PCを閉じる前に最新の内容をWebで読みたいときは、手動アップロードの完了を確認してください。

認証にはランダムなループバックポートと PKCE・state を使います。更新トークンなどは `%LOCALAPPDATA%\PapeerSync\google-drive-credentials.dpapi` に Windows DPAPI で暗号化して保存します。ライブラリ・バックアップ・Drive・GitHub Pagesには含めません。APIへの接続は現在Windows版のみです。

## OSS・公式配布版のOAuth設定（開発者向け）

通常の利用者がGoogle Cloudの設定を作成したり、資格情報を入力したりする必要はありません。公式配布版は `papeer/core/assets/google-oauth.json` にある公開のデスクトップ用クライアントIDとPKCEを使います。Web用IDとは別で、同じGoogle Cloudプロジェクトに作成したデスクトップアプリ用IDを使います。

GoogleのデスクトップOAuth文書では `client_secret` は任意とされていますが、この公式クライアントでは正規のPKCE認証・アクセス許可後にGoogleが `client_secret` を要求することを確認しました。Google公式SDKと同様、配布側がデスクトップ用IDと `client_secret` を組み込み、PKCE・stateも引き続き使います。デスクトップクライアントはpublic clientなので、配布した値を秘密として保持できる前提にはしません。実トークン取得・更新の成功は、必要な配布設定を組み込んだ後に確認します。

フォーク版を公開配布する場合は、配布者自身のGoogle CloudプロジェクトでWindows用・Web用のIDを用意します。ソースの公開設定を変更するか、ビルド時に次を指定します。クライアントIDは秘密情報ではありません。

```powershell
$env:PAPEER_GOOGLE_OAUTH_CONFIG_FILE = 'C:\private\google-desktop-oauth.json'
just build
```

GitHub Actionsの公式Windows Releaseでは、Repository secret `GOOGLE_DESKTOP_CLIENT_SECRET` をビルドステップだけに渡します。Repository variable `GOOGLE_DESKTOP_CLIENT_ID` でIDを上書きする場合、シークレットも同じクライアントの値にしてください。Web側の `GOOGLE_WEB_CLIENT_ID` は同じプロジェクトのWeb用IDに設定します。Webビルドへシークレットは渡しません。公式Windowsタグビルドは、実クライアントで必要と判明している設定が不足していればビルド前に停止します。設定不備がある開発ビルドは「Googleに接続」を無効化し、対応版への更新を案内します。

`just build-sidecar` は `build/google-desktop-oauth.json` を生成して配布用sidecarへ取り込みます。この生成ファイルはGit管理外です。含める設定はsidecarの内容ハッシュでも照合し、古い設定のsidecarを誤って配布しないようにします。

既存接続のトークン更新には、保存済みのデスクトップ用IDと対応する `client_secret` を使います。配布者によるローカルビルドでは `PAPEER_GOOGLE_OAUTH_CONFIG_FILE` にGoogleからダウンロードしたデスクトップ用JSONのローカルパスを指定する方法、または `PAPEER_GOOGLE_DESKTOP_CLIENT_SECRET` の明示指定も残します。IDを別クライアントへ上書きした場合、元のJSON・同梱設定のシークレットは引き継ぎません。シークレットの環境変数を空に明示設定した場合も省略します。これらは一般利用者の設定画面には表示しません。資格情報JSON・シークレット・ユーザーのトークンをGitへ登録したり、ログへ出したりしないでください。配布物に同梱する値は、ビルド時に隠しても配布後に秘密として保持できません。

Web版はGoogle Identity Servicesのトークン方式を維持し、Webサーバー用のシークレットをPagesへ配置しません。ユーザーのアクセストークンはWebではメモリー内だけ、Windowsの更新トークンは端末内のDPAPI保護領域だけに保存します。OAuth設定はアプリ単位、認証トークンは利用者単位で分離します。

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

Webでは論文・ノートを検索して選び、資料を切り替えます。PDFはページ移動と書き込み、Markdownはプレビュー、HTML資料はスクリプト・外部通信を止めた表示、付箋・チャットは専用の一覧で読めます。元の手書きデータも残し、原文・訳文・ノートに書き込みがあれば書き込み付きPDFも生成します。「ライブラリ全体のファイル」では資料・ノートのファイルだけを表示し、AI接続や端末設定は表示しません。HTML内の外部リソースは読み込めません。

## WebからのPDFへの書き込み

最新版のPCアプリから一度アップロードし、Web版で原文または日本語訳を開きます。ペン・蛍光ペン・文字メモ、Webで追加した線の消去、元に戻す・やり直すを使えます。PCの既存の手書きやハイライトも表示します。消しゴムはPCの既存書き込みを消しません。Apple Pencilとマウスに対応するPointer Eventsを使い、通常は指でスクロールし、「指でも書く」を有効にすると指でも描けます。

各追記はPDF本体と別の `ink-<UUID>.json` としてDrive APIで直接保存します。画面に「Driveに保存済み」と出ることを確認してください。PCや追加サーバーの起動は不要です。通信に失敗した場合は1操作ずつ端末のlocalStorageに下書きを保持し、再読み込み後も回復します。「書き込みを同期・再試行」で送信できます。未送信の状態でブラウザーのサイトデータを消すと下書きも消えるため、送信完了を先に確認してください。

複数タブ・端末の追記は上書きせず統合し、30秒ごと・画面へ戻ったとき・同期ボタンで他端末の追記を確認します。PCアプリは次回の手動アップロードまたは起動中の自動処理でWebの追記を取り込んでからPC側の最新版をアップロードします。Webの「更新」でその最新版を取得できます。

元のPDFのSHA-256とページを照合するため、訳文PDFを作り直した場合は古い追記を新しいページへ適用しません。追記ファイルはDriveに残してWebに案内を表示します。PCに取り込んだ書き込みも二重に描画せず、同じ操作の再送で線を増やしません。

「PDF本体を保存」にはWeb追記を含めません。書き込み付きPDFが必要な場合はPCへ取り込んでからPCのPDF出力機能を使ってください。Webからの翻訳、AIへの新規質問、PCの既存メモ・付箋の編集やライブラリの整理は提供しません。

Drive内ではPC上のライブラリごとに `Papeer Library` フォルダーを作ります。ファイルは内容のSHA-256を名前にした `blob-…` として重複を避けて保存し、全ファイルがそろってから `papeer-library.json` を更新します。途中で失敗しても直前に保存できた世代をWebで開けます。次回は転送済みのファイルを再利用します。手動アップロードではDrive側のチェックサムも照合し、消失・破損したファイルを再送します。ブラウザーもダウンロードした内容のSHA-256を確認します。

失敗した自動アップロードは停止し、設定画面と処理一覧に表示します。手動で再試行してください。変更なしの定期確認ではスナップショットを再転送しませんが、Webの追記は確認します。複数PC・再接続で複数の保存ライブラリがある場合、Web上部で選べます。別の保存ライブラリ間でのPC編集の統合は行いません。

古いblob・途中で止めた転送済みblobはこの版では自動削除しません。更新を重ねるとDriveの使用容量が増えます。接続解除もDriveのデータは消しません。不要になった保存ライブラリは、もう使わないことを確かめてDriveのフォルダー単位で削除してください。

## 参照

- [Google: デスクトップOAuth・PKCE・ループバック](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google: Python SDKのPKCEとクライアント設定](https://googleapis.dev/python/google-auth-oauthlib/latest/_modules/google_auth_oauthlib/flow.html#Flow.fetch_token)
- [RFC 8252: Native Appの共有シークレット](https://www.rfc-editor.org/rfc/rfc8252.html#section-8.5)
- [Google: Driveのスコープ](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Google: Webトークン方式](https://developers.google.com/identity/oauth2/web/guides/use-token-model)
- [Google: 再開可能なアップロード](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Google: 追記ファイルを識別するカスタムプロパティ](https://developers.google.com/workspace/drive/api/guides/properties)
- [GitHub: Pagesのカスタムワークフロー](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

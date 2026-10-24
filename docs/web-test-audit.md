# Web/PWA・Drive連携のテスト監査

確認日: 2026-10-19。対象は、PCで保存した原文・訳文・メモ等をDrive API経由でWebから閲覧し、PDFへ追記する現在の仕様。Web翻訳は対象外。

2026-10-22追記: 利用者からiOS更新後の文字選択成功が報告されたため、最新iOS/Safariの標準選択を使う構成へ整理した。独自の長押し選択・コピーUI、代替テキスト表示、古いiOS用の文字取得の補完処理とその専用試験は削除した。現在は `webIphone.browser.test.ts` で実PDFの原文・日本語訳の標準部分選択とChromiumでのClipboard読戻しを、`webReaderInteractions.browser.test.ts` でピンチ操作を確認する。OSの選択メニューと実機の操作はブラウザー自動試験では再現しない。以下の件数・独自選択UIの試験結果は、2026-10-19時点の監査記録。

## 結論と今回の変更

従来のテストは正常系だけではないものの、文字選択の失敗・中断・非同期処理の競合が不足していた。また、ブラウザー試験は通常CI・Pages公開の必須条件になっていなかった。従来の単体テスト合格だけを、iPhone PWAでの動作確認済みと説明することはできない。

- 選択Aのコピー完了を待つ間にBを選ぶと、Aの完了でBまで「コピーしました」と表示される不具合を、WebKit・Chromiumの双方で再現した。選択とコピー要求の世代を照合する修正後、同じ回帰試験で成功・失敗の遅延応答を確認する。
- 文字選択・ピンチ操作を、新しいブラウザーコンテキストで独立して確認する10ケースを両エンジンに追加した。
- ハッシュが正しくてもPDFとして壊れている場合の表示失敗、実ファイルのダウンロード、PC側の修正版への切替、旧Blob URLの失効を両エンジンに追加した。
- Web認証の拒否・ポップアップ失敗・SDK例外・期限切れ、Driveの401/403/429/503後の再試行、追記アップロード先・親フォルダー検証を単体テストに追加した。
- Google/Driveを模擬する試験ではService Workerを無効にし、模擬通信がWorkerに迂回されないようにした。Workerの動作は別のPWA試験で確認する。
- `test:web` がWeb用試験ファイルを自動列挙する。Pagesはブラウザー試験の成功後に公開する。ログと合成データの画像をActions成果物に残す。公開済みサイトの確認は環境変数で明示的に加え、公開前の試験に意図的なskipを混ぜない。

## 要求と試験の対応

下記は「試験が存在し、今回の実行対象に含めた」範囲。ネットワークは原則として模擬し、実アカウントの権限・実端末の入力装置を確認したという意味ではない。

| 範囲 | 確認する挙動 | 主な試験 |
| --- | --- | --- |
| PCからDrive保存 | 原文・訳文・途中の翻訳・メモ・画像・既存の書き込みを含むスナップショット、変更なしの再利用、破損の再送 | `tests/test_cloud_drive.py` |
| 保存中の失敗 | キャンセル・通信失敗では直前の公開世代を保持、再試行、一覧のページング、308の再開可能アップロード | 同上 |
| PCのOAuth | PKCE・state・loopback、不完全なコールバックの期限、再オープン・取消・古い応答の無効化、エラー中の機密情報の非表示 | `tests/test_cloud_drive_auth.py` |
| PCの資格情報設定 | 配布設定、Desktop/Webクライアントの区別、設定の混在防止、利用者へ資格情報入力を求めないAPI、DPAPI保存 | `tests/test_cloud_drive_config.py`, `tests/test_cloud_drive.py` |
| Web認証 | SDK失敗から再取得、認証の取消・期限・遅延応答、拒否・ポップアップ失敗・期限切れ、再ログイン、期限内のタブ接続復元 | `frontend/tests/webDrive.test.ts`, `webRecovery.browser.test.ts`, `webSession.browser.test.ts` |
| Drive通信 | Bearerヘッダー、ページング、サイズ・SHA-256照合、ログアウトをまたぐ読込の遮断、タイムアウト、HTTPエラー後の再試行、追記のmultipart送信先・親検証 | `frontend/tests/webDrive.test.ts` |
| データの境界 | アカウント・ライブラリ・世代の切替で旧データを破棄、相対画像の範囲制限、PC/Webの機能差 | `frontend/tests/libraryRuntime.test.ts`, `runtimeCapabilities.test.ts`, Web復旧試験 |
| ライブラリ | ツリー・フォルダー・ノート・検索・キーボード移動、本文・メモ・保存済みチャットの表示 | `webSidebar.browser.test.ts`, `webLibrary.browser.test.ts`, `frontend/tests/webLibraryTree.test.ts` |
| 原文・訳文 | 実際のPDF.js表示、日本語テキスト、単独/対訳切替、ページ対応、未保存訳文の案内、添付資料の独立したページ位置 | `webIphone.browser.test.ts`, `webRecovery.browser.test.ts`, runtime単体試験 |
| スマホ・レイアウト | 320/375/390/430px幅、横向き、コンパクトなタイトル、操作領域、集中表示、パネル、ダークモード | `webIphone.browser.test.ts`, `webLibrary.browser.test.ts`, `pdfReaderResize.browser.test.ts` |
| 拡大 | PDF内の倍率変更とヘッダー固定、倍率上限・下限、中断、左右ペインの操作所有権 | `webIphone.browser.test.ts`, `webReaderInteractions.browser.test.ts` |
| 文字選択 | 原文・日本語訳、マウス選択、長押し・範囲拡張、既存選択の維持、タップとキーボードでコピー | 同上 |
| 選択の異常系 | Clipboard拒否と手動コピー・再試行、古いコピー応答、二重送信防止、スワイプ・2本指・取消・ページ移動、ペン操作中・指書き中の誤選択防止、画像のみのページ | `webReaderInteractions.browser.test.ts` |
| 書き込み | ペン・蛍光ペン・文字・消去・undo/redo、PCの既存書き込みを保持、通信失敗・再読込からの下書き回復、回転・拡大後も編集可能 | `webAnnotations.browser.test.ts`, `webRecovery.browser.test.ts`, `pdfReaderResize.browser.test.ts`, annotations/textDrafts単体試験 |
| PCへの取込 | Pythonが作ったPCスナップショットをWebで編集し、実際のPython処理で再取込する往復。通信だけを模擬 | `webAnnotations.browser.test.ts`, `frontend/e2e/web_fixture.py` |
| 破損PDF | 整合性検査を通る非PDFデータ、案内表示・実バイトの保存、修正版への更新、旧Blob URL失効 | `webDocumentFailures.browser.test.ts` |
| HTML・メモの安全な表示 | sandbox/CSP、埋込スクリプト・外部画像の遮断、Markdownと保存済み相対画像 | `webLibrary.browser.test.ts`, runtime単体試験 |
| PWA | `/papeer/`配下のmanifest・アイコン・scope、オフラインでの起動シェル、私有データのキャッシュ除外、複数タブを閉じてからの更新、下書き保持 | `webPwa.browser.test.ts` |
| 公開先 | 配信済みmanifest・アイコン・オフライン起動シェル | `publishedPwa.browser.test.ts`（公開URL指定時のみ） |
| 公開の条件 | Pagesがブラウザー試験に依存すること、終了コードの伝達、権限・固定したActions、PC保存側の変更でも試験が走ること | `tests/test_ci_workflow.py` |

ブラウザー試験名だけのセルは `frontend/e2e/` 配下。ライブラリ・復旧・書き込み・PWAの既存試験にはChromiumのみのものもあり、全項目が両エンジンで同じ深さに確認されるわけではない。両エンジンで実行するのはスマホ閲覧、今回の独立操作ケース、破損PDFの復旧。

## 実行結果

ローカルはWindows上のPlaywright WebKitとEdge Chromium。iPhone相当の画面サイズ・タッチ設定を使う。WebKitでのSafari固有イベントは合成イベント、ChromiumのピンチにはCDPからのタッチ入力も使う。WebKitをiPhone実機と扱わない。

| チェック | 結果 |
| --- | --- |
| フロントエンド単体（PC共通部分を含む） | 678件成功、失敗・skipなし |
| PythonのDrive保存・OAuth・配布設定・CI契約 | 65件成功、失敗・skipなし |
| app/tests/e2eのTypeScript型チェック、ESLint | 成功 |
| Web版・デスクトップUIの本番ビルド | 成功。既存のbundleサイズ警告あり |
| 変更したPython試験のRuff | 成功 |
| Webブラウザー一式・公開先PWA | 34件成功（独立した実ケース32件＋親テスト2件）、失敗・skipなし。約221秒 |

公開前CIでは公開先PWAの1件を含めず、33件（実ケース31件＋親2件）を実行する。全体試験の初回にPlaywrightのWorker無効化スクリプトがHTMLのopaque sandbox内で例外を出したため、その試験だけWorkerスクリプトの取得を遮断する方法へ変更した。例外の無視やsandboxの緩和は行わず、単独試験と全体の再実行で合格を確認した。

Python全体・Rust・翻訳処理全体の回帰試験とは区別する。通常のCIは引き続き全Python試験、Rust検査等を実行する（長時間のslow試験等の既存の除外はそのまま）。今回のローカル65件はその代替ではない。行カバレッジ率は計測しておらず、この表から「100%網羅」とは判断しない。

実行ログはローカルの `output/test-audit-*.log`、画面画像は `output/reader-interactions/` と `output/iphone-review/`。出力はGit管理しない。Google資格情報・アクセストークン・個人PDFを試験に持ち込まず、合成データを使用する。

## 再実行

通常の開発チェックアウトで、依存関係をlockfile通りに導入してから実行する。WindowsにはEdgeが必要。

```powershell
uv sync --locked
pnpm --dir frontend install --frozen-lockfile
node frontend/node_modules/playwright-core/cli.js install webkit
pnpm --dir frontend typecheck
pnpm --dir frontend lint
pnpm --dir frontend test
pnpm --dir frontend build:web
pnpm --dir frontend test:web
uv run pytest -q tests/test_cloud_drive.py tests/test_cloud_drive_auth.py tests/test_cloud_drive_config.py tests/test_ci_workflow.py
```

公開後の確認も含める場合は次を実行する。公開前のCIではこの変数を設定しない。`PAPEER_WEB_TEST_URL` は通常設定しない。操作の独立試験・ツリー試験には開発サーバーの合成fixtureが必要になる。

```powershell
$env:PAPEER_PWA_TEST_URL = 'https://hooked-on-mas.github.io/papeer/'
pnpm --dir frontend test:web
```

## 残っている確認・要望差分

次の項目は未実施・未実装として残る。自動試験合格で置き換えない。

| 項目 | 現状と必要な確認 |
| --- | --- |
| iPhoneホーム画面PWA | 実機のOSバージョン・端末を記録し、原文/訳文の長押し選択、範囲変更、OSの選択ハンドル、別アプリへの貼付、拡大したまま訳切替を確認する。現時点の実機結果は未取得 |
| Clipboard | Chromiumでは実Clipboardへの書込・読戻しも確認する。WebKitの自動試験はAPI呼出内容と拒否時の表示の確認で、iOSの権限UI・OS貼付は未確認 |
| Apple Pencil | Pointer Eventsの合成入力による処理確認はあるが、実Pencilの筆圧・パームリジェクション・指との同時操作は未確認 |
| 実Google/Drive | 今回は模擬通信。実際の同意画面、アカウント切替、権限取消、容量/利用制限、実ネットワークでの複数端末の同時追記は未確認。過去のアップロード成功は今回の実機試験を代替しない |
| ログイン保持 | メモリーとタブ単位のsessionStorageを使い、Googleの有効期限内の再読み込みで接続を復元する。PWAの完全終了後の保持はブラウザーのセッション復元に依存し、iOS実機では未確認。期限切れ後の日をまたいだ自動接続は未実装で、認証用バックエンドが必要。下書き保持とは別の話 |
| 端末ライフサイクル | iOSでのバックグラウンド復帰・プロセス強制終了・ストレージ消去/容量不足、画面上部の領域・ソフトキーボードとの干渉は実機未確認 |
| 大きいPDF | 多数ページ・大きい画像・低メモリー端末の連続利用、長時間のメモリー使用量は負荷試験未実施 |
| PDFの境界 | 画像のみのページに文字がない場合は文字選択できない。OCRをWebで追加する機能はない。暗号化PDF・特殊フォント等の全形式互換を保証する試験ではない |

実機確認時は端末名・OS・通常Safari/PWA・原文/訳文・操作・結果・証拠を残し、未確認のセルを埋める。現時点で「iPhone PWAを含め完全確認済み」とは報告しない。

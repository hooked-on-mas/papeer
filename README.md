# Papeer

英語の学術論文 PDF を日本語に翻訳し、原文と並べて読むための Windows 向けデスクトップアプリです。翻訳・解説・チャットには、ChatGPT（Codex CLI）、Claude Code CLI、Gemini（Antigravity CLI）、または OpenAI 互換 API を使います。

## 主な機能

| 機能 | 内容 |
| --- | --- |
| 日本語訳 | PDF からテキストを抽出して AI で翻訳し、原文と同じレイアウトの日本語 PDF を生成 |
| 数式・表・参考文献の保持 | 数式は元 PDF の描画を切り出して配置。表のセルと参考文献は原文のまま保持 |
| 再開 | 翻訳済みブロックをキャッシュし、中断・エラー後も続きから再開 |
| 左右表示 | 原文と訳文を並べて表示。スクロールと倍率を同期 |
| 解説・チャット | 論文の解説記事を Markdown で生成。本文のページを引用して回答。PDF で選んだ箇所を添付して聞ける（添付をクリックで PDF のその箇所へ移動） |
| ライブラリ | 入れ子フォルダーでの整理、ドラッグ＆ドロップ、検索、Markdown メモ |
| 論文内検索・付箋 | PDFの文章や図のそばに付箋を貼り、小さなダイアログでメモを入力。「付箋」タブで一覧・検索・編集 |
| PDFの書き込み・編集 | ペン・蛍光ペン・図形・テキスト、範囲選択／投げ縄、移動・コピー・拡縮・回転、部分消しゴム、自動保存、書き込み付きPDFの保存 |
| 図・数式のコピー | PDFの範囲をPNG画像としてコピー、出典ページ付きで読書メモに追加 |
| 対応箇所の表示 | PDFの本文ブロックをクリックして両側の対応領域を強調 |
| 用語辞書・チャット範囲 | 論文ごとの訳語を指定。チャットの参照対象を現在の論文、選んだ論文、フォルダーから指定 |
| 書き出し | 日本語訳 PDF、原文と訳文の交互 PDF、左右対訳 PDF、Markdown |
| 読書状態・タグ | 未読・読書中・読了・再読したいを管理。自由な名前のタグを複数付け、ライブラリを絞り込み |
| 読書メモのテンプレート | 標準の読書メモを挿入。見出しを自由に変更した自分用テンプレートを保存・編集 |
| 翻訳の確認・修正 | 要確認ページの一覧、段落の手動修正・AI修正案、変更前後の比較、PDFへの反映と取り消し |
| 共通用語辞書 | 全論文で共有。翻訳前にAIが訳語に迷う未登録語と訳語案を抽出し、過去の登録語と一緒に確認・修正して追加。JSONでエクスポート・読み込み可能 |
| 横断検索 | 論文情報・タグ・原文・訳文・メモを検索し、抜粋から該当ページへ移動 |
| バックアップ・復元 | 設定画面からライブラリ全体をZIPで保存・復元。復元前のデータは別フォルダーに保持。設定とプロンプトは、選んだときだけバックアップのものに戻す |

翻訳処理の詳細な挙動と制限は [docs/translation.md](docs/translation.md) を参照してください。OCR は未実装のため、文字情報のある PDF が対象です。

PDF上部の「ペン」で書き込めます。「範囲」または投げ縄で書き込みを囲むと、移動・コピー・貼り付け・拡縮・回転ができます。「本文」に戻すとPDF本文を選択できます。書き込みは原文・日本語訳のページごとに自動保存され、再起動後も表示されます。「PDF保存」はその側の全ページを、書き込み入りの別PDFとして保存します。操作と保存形式は [docs/annotations.md](docs/annotations.md) を参照してください。

## 構成

```text
papeer/        翻訳・PDF 処理・ライブラリ管理のコア (Python)
  core/           設定、ストレージ、サービス層、プロンプト、フォント
  providers/      AI 接続（Codex / Claude Code / Antigravity / OpenAI 互換 API）。1 接続 1 モジュール
  layout/         読み順・数式・表・図・参考文献のレイアウト解析
  pdf/            PDF の抽出と生成 (PyMuPDF)
  translation/    翻訳バッチ処理とプレビュー
sidecar/          papeer を HTTP/WebSocket で公開する FastAPI サーバー
frontend/         デスクトップ UI (Tauri 2 + React 19 + Tailwind v4)
  src/            React アプリ
  tests/          node:test によるフロントエンドのテスト
  src-tauri/      Tauri (Rust)。本番では sidecar を子プロセスとして起動
tests/            pytest によるバックエンドのテスト
tools/            翻訳レイアウトの検証用スクリプト (開発用)
docs/             仕様ドキュメント
```

フロントエンドは sidecar の REST API と WebSocket でバックエンドと通信します。本番ビルドでは Tauri が空きポートと起動ごとの認証トークンを決め、PyInstaller で単一 exe 化した sidecar を起動します。設計の背景は [DESIGN-REWRITE.md](DESIGN-REWRITE.md) と [DESIGN-UI.md](DESIGN-UI.md) にあります。

## 開発環境のセットアップ

Windows 11 x64 を対象にしています。次のツールを用意してください。

- [uv](https://docs.astral.sh/uv/)（Python 3.12 は uv が自動で導入します）
- [Node.js](https://nodejs.org/) 22.18 以上と [pnpm](https://pnpm.io/)（フロントエンドのテストは Node が `.ts` を直接実行します）
- [Rust](https://www.rust-lang.org/tools/install) と [Tauri の前提条件](https://tauri.app/start/prerequisites/)
- [just](https://github.com/casey/just) 1.38 以上（`winget install Casey.Just`）

```bash
just setup
```

### 開発時の起動

開発時は sidecar とフロントエンドを別々のターミナルで起動します。デバッグビルドの Tauri は sidecar を起動せず、`127.0.0.1:8000` に接続します。

```bash
just dev-sidecar    # ターミナル 1: FastAPI サーバー (ポート 8000)
just dev-frontend   # ターミナル 2: Tauri + Vite
```

sidecar は `/health` 以外のすべての API と WebSocket に認証トークンを求め、`PAPEER_TOKEN` が未設定なら起動しません。`just dev-sidecar` は開発用の固定トークン `dev_token` で起動し、デバッグビルドの Tauri も同じ値をフロントエンドへ渡します。Tauri を使わずブラウザーで Vite を開く場合も、開発サーバーでは同じ値を既定で使います（別の値にするときは `VITE_PAPEER_TOKEN` を指定）。本番ビルドでは Tauri が起動ごとに OS の乱数生成器で 256 bit のトークンを作ります。API ドキュメント（`/docs`、`/openapi.json`）は配信しません。

フロントエンドの `frontend/openapi.json` は、リポジトリのルートで `uv run python -c "import json; from sidecar.app import app; open('frontend/openapi.json', 'wb').write(json.dumps(app.openapi(), indent=2).encode())"` を実行して作り直します（`frontend/src/api/schema.d.ts` はこれを openapi-typescript で変換したものです）。

### テストと lint

```bash
just test   # pytest、TypeScript の型チェック、フロントエンドのテスト (node:test)
just lint   # ruff, pyright, tsc
```

pytest は `tests/conftest.py` で `LOCALAPPDATA` と `PAPEER_DATA_DIR` をテストごとの一時フォルダーに向けます。実際のデータフォルダー（`%LOCALAPPDATA%\Papeer`、`PaperDesk`、`PapeerSync`）でファイルを開いたり書き込んだりすると、そのテストは失敗します。

### データベースの変更

`library.sqlite3` の版は `PRAGMA user_version` で管理します。列・テーブル・索引の追加や保存値の変換は、`papeer/core/storage.py` の `MIGRATIONS` に関数を 1 つ追加して行います（約束事は同ファイルのコメント、テストは `tests/test_schema_migration.py`）。バックアップの `papeer-backup.json` と同期の世代の `revision.json` には `schema_version` と `app_version` を記録し、自分より新しい版のライブラリ・バックアップ・同期データは開かずに Papeer の更新を促します。新しい版で開いた（移行済みの）ライブラリのまま Papeer を古い版に戻すと、復元を含むすべての操作がこのエラーになるため、最新版を入れ直してください。

## ビルド

```bash
just build
```

次の処理を順に行います。

1. `code-version.txt`（翻訳キャッシュの識別値）を生成する
2. PyInstaller で `sidecar.spec` から `dist/sidecar-x86_64-pc-windows-msvc.exe` を作る
3. その exe を `frontend/src-tauri/` へコピーする
4. `pnpm tauri build` でインストーラーを作る

インストーラーは `frontend/src-tauri/target/release/bundle/` に出力されます。

## AI 接続

アプリ内の「接続・設定」で接続先を選びます。CLI 経由の接続では、各 CLI にログインしたアカウントの利用枠を使います。

| 接続先 | 必要なもの |
| --- | --- |
| ChatGPT | [Codex CLI](https://developers.openai.com/codex/cli)。アプリ内の「ログイン」でブラウザー認証 |
| Claude | [Claude Code](https://docs.anthropic.com/claude-code) の `claude` コマンド |
| Gemini | Antigravity CLI の `agy` コマンド |
| OpenAI 互換 API | ベース URL と API キー |

CLI は PATH と既定のインストール先から自動検出します。見つからない場合は設定画面でパスを指定してください。npm・pnpm 版の `.cmd` は cmd.exe を経由するためそのまま実行せず、`.cmd` と同じフォルダー配下にある本体（npm の既定の配置、なければ `.cmd` が起動するもの）を直接起動します（JavaScript なら Node.js で、`.exe` ならそのまま）。本体が見つからない `.cmd`・`.bat`・`.ps1` は使えないので、yarn などで入れた場合は `.exe` か npm 版のパスを指定してください。API キーはファイルに保存せず、起動中のセッションだけで保持します。

PDF の本文は信頼できない入力として扱い、CLI にはツールを使わせない指定で渡します。Claude Code はツール・MCP サーバー・プロジェクト設定・スキルを無効にし、Codex は読み取り専用サンドボックスでシェル・Web 検索・プラグイン・アプリと `config.toml` の MCP サーバーを無効にします。Antigravity は `--sandbox` で起動し、本文はコマンドラインではなく標準入力で渡します（Windows のコマンドライン長の上限を超える長いチャットも送れます）。CLI には Papeer 自身の環境変数（`PAPEER_*`、sidecar の認証トークンなど）を引き継ぎません。

翻訳・解説・チャットを実行したときだけ、必要なテキストが選択した AI へ送られます。PDF を追加しただけでは送信しません。

### 接続先の追加・変更（開発者向け）

接続先ごとの処理は `papeer/providers/` に 1 モジュールずつ置いています。CLI のフラグや出力形式が変わったときは、その接続のモジュールだけを直します。

1. `papeer/providers/base.py` の `ProviderBackend` を継承し、`spec`（表示名・説明・設定項目）と `_generate()` を実装する。CLI なら `common.CliBackend` も継承すると、パス検出・ログイン・接続確認が付く。
2. `papeer/providers/registry.py` の `BACKENDS` に 1 行追加する。
3. `papeer/core/code_version.py` の `TRANSLATION_SOURCES` に新しいファイルを追加する（`registry.py` は対象外なので、1 行追加だけではキャッシュは無効にならない）。

設定画面の選択肢と入力欄は `GET /api/providers` から作られるため、フロントエンドの変更は不要です。接続先ごとの設定のうち、最後に選んだモデルと effort はライブラリの `settings.json` の `provider_options` に、CLI のパスと API URL（`config.DEVICE_OPTION_KEYS`）は PC ごとの `%LOCALAPPDATA%\PapeerSync\device-settings.json` に保存されます。後者は同期・バックアップに含めず、別の PC から届いた `settings.json` や復元したバックアップに書かれていても使いません（以前の版の `settings.json` にあった値は、初回の読み込み時に一度だけ PC ごとの保存先へ移します）。モデル名は半角英数字と `. : / @ [ ] + - _` だけ（先頭の `-` は不可）を受け付けます。保存済みのモデル名が不正な場合は、接続先の既定のモデルを使います。

`papeer/providers/` のファイルは翻訳キャッシュの識別値に含まれます。編集すると、既存の論文は次回の翻訳で指定ページを訳し直します。

## データの保存場所

「設定 → 保存先・同期」でPC版Google Driveのローカルフォルダーを指定すると、PDF・書き込み・サマリーを含むライブラリ全体を別PCと同期できます。Papeer内でのGoogleログインやOAuth設定は不要です。導入手順、競合時の操作、容量・転送の制限は [Google Drive同期](docs/google-drive-sync.md) を参照してください。

新規環境では `%LOCALAPPDATA%\Papeer` に保存します。新しい保存先がなく、旧 `%LOCALAPPDATA%\PaperDesk` が存在する場合は、その保存先を引き続き使います。「設定 → バックアップ」からライブラリ全体を保存・復元できます。新しいバージョンのPapeerで作成したバックアップは復元できません（更新を促すメッセージを表示します）。手動でコピーする場合は、アプリを閉じてからフォルダー全体をコピーしてください。

```text
Papeer/
  settings.json
  ui-state.json
  library.sqlite3
  prompts/                    カスタマイズしたプロンプト
  papers/<論文ID>/
    original.pdf
    document.json             抽出結果
    translated.pdf
    interleaved.pdf           原文と訳文の交互ページ（「原文・日本語訳（交互）を外部で開く」で作成し、訳文が変わるまで再利用）
    translation-pages/        翻訳途中のページ（翻訳の完了時と起動時に不要なものを削除）
    translation.md
    translation-cache.json
    translation-report.json
    glossary.json               旧辞書の移行元（共通辞書はlibrary.sqlite3に保存）
    article.md                解説
    note.md                   メモ

PapeerSync/                   このPCだけの設定（同期・バックアップの対象外）
  device-settings.json        CLI のパスと API URL
  <ハッシュ>.json             同期フォルダーの保存先と最終同期の基準
```

## 環境変数

| 変数 | 用途 |
| --- | --- |
| `PAPEER_DATA_DIR` | データの保存先を変更する |
| `PAPEER_PORT` | sidecar の待ち受けポート（既定 8000） |
| `PAPEER_TOKEN` | sidecar の認証トークン。必須で、未設定なら sidecar は起動しない（本番は Tauri が起動ごとに生成、開発は `just dev-sidecar` が `dev_token` を設定） |
| `PAPEER_DEV_NO_AUTH` | `1` のとき、`PAPEER_TOKEN` なしで認証なしの sidecar を起動する（開発専用。PyInstaller で作った sidecar では無視） |
| `PAPEER_API_KEY` | API 接続で使う API キーの初期値（未設定なら `OPENAI_API_KEY`、次に `GEMINI_API_KEY`） |

## キーボードショートカット

| キー | 操作 |
| --- | --- |
| `Ctrl+O` | PDF を追加 |
| `Ctrl+F` | 開いている論文を検索（閲覧画面以外ではライブラリを検索） |
| `Ctrl+Shift+F` | ライブラリを検索 |
| `Ctrl+L` | 閲覧中の論文をライブラリで表示 |
| `Ctrl+G` | ページ番号を指定して移動 |
| `Ctrl+T` | 翻訳を開始 |
| `Ctrl+B` | サイドバーの表示切り替え |
| `←` / `→` | 前後のページへ移動 |
| `F2` | フォルダー・論文の名前を変更 |
| `Delete` | ライブラリで選んだフォルダー・論文を削除（確認あり） |
| `Ctrl+Shift+N` | フォルダーを作成 |
| `F11` | 集中表示 |

## ライセンス

Papeer のコードは AGPL-3.0-or-later で提供します。ライセンス本文は [LICENSE](LICENSE) です。

同梱の源ノ明朝・源ノ角ゴシックは SIL Open Font License 1.1 です。出典は [papeer/core/assets/fonts/README.md](papeer/core/assets/fonts/README.md) を参照してください。PyMuPDF は AGPL または商用ライセンスで提供されています。その他の依存ライブラリはそれぞれのライセンスに従います。

### 旧名称との互換性

環境変数は `PAPEER_*` を優先し、未設定なら旧 `PAPERDESK_*` も受け付けます。既存の辞書・バックアップ・`paperdesk://` 引用リンクも読み込めます。画面設定と手書きの未保存データは、新しい保存キーへ初回起動時に引き継ぎます。インストール済みアプリと WebView のデータを引き継ぐため、Tauri の内部識別子 `local.paperdesk` は維持しています。ソースのルートディレクトリ名は変更不要です。

# PaperDesk

英語の学術論文 PDF を日本語に翻訳し、原文と並べて読むための Windows 向けデスクトップアプリです。翻訳・解説・質問には、ChatGPT（Codex CLI）、Claude Code CLI、Gemini（Antigravity CLI）、または OpenAI 互換 API を使います。

## 主な機能

| 機能 | 内容 |
| --- | --- |
| 日本語訳 | PDF からテキストを抽出して AI で翻訳し、原文と同じレイアウトの日本語 PDF を生成 |
| 数式・表・参考文献の保持 | 数式は元 PDF の描画を切り出して配置。表のセルと参考文献は原文のまま保持 |
| 再開 | 翻訳済みブロックをキャッシュし、中断・エラー後も続きから再開 |
| 左右表示 | 原文と訳文を並べて表示。スクロールと倍率を同期 |
| 解説・質問 | 論文の解説記事を Markdown で生成。本文のページを引用して質問に回答 |
| ライブラリ | 入れ子フォルダーでの整理、ドラッグ＆ドロップ、検索、Markdown メモ |
| 書き出し | 日本語訳 PDF、原文と訳文の交互 PDF、左右対訳 PDF、Markdown |

翻訳処理の詳細な挙動と制限は [docs/translation.md](docs/translation.md) を参照してください。OCR は未実装のため、文字情報のある PDF が対象です。

## 構成

```text
paperdesk/        翻訳・PDF 処理・ライブラリ管理のコア (Python)
  core/           設定、ストレージ、AI プロバイダー、サービス層、プロンプト、フォント
  layout/         読み順・数式・表・図・参考文献のレイアウト解析
  pdf/            PDF の抽出と生成 (PyMuPDF)
  translation/    翻訳バッチ処理とプレビュー
sidecar/          paperdesk を HTTP/WebSocket で公開する FastAPI サーバー
frontend/         デスクトップ UI (Tauri 2 + React 19 + Tailwind v4)
  src/            React アプリ
  src-tauri/      Tauri (Rust)。本番では sidecar を子プロセスとして起動
tests/            pytest によるバックエンドのテスト
tools/            翻訳レイアウトの検証用スクリプト (開発用)
docs/             仕様ドキュメント
```

フロントエンドは sidecar の REST API と WebSocket でバックエンドと通信します。本番ビルドでは Tauri が空きポートと起動ごとの認証トークンを決め、PyInstaller で単一 exe 化した sidecar を起動します。設計の背景は [DESIGN-REWRITE.md](DESIGN-REWRITE.md) と [DESIGN-UI.md](DESIGN-UI.md) にあります。

## 開発環境のセットアップ

Windows 11 x64 を対象にしています。次のツールを用意してください。

- [uv](https://docs.astral.sh/uv/)（Python 3.12 は uv が自動で導入します）
- [Node.js](https://nodejs.org/) LTS と [pnpm](https://pnpm.io/)
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

### テストと lint

```bash
just test   # pytest と TypeScript の型チェック
just lint   # ruff, pyright, tsc
```

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

CLI は PATH と既定のインストール先から自動検出します。見つからない場合は設定画面でパスを指定してください。API キーはファイルに保存せず、起動中のセッションだけで保持します。

翻訳・解説・質問を実行したときだけ、必要なテキストが選択した AI へ送られます。PDF を追加しただけでは送信しません。

## データの保存場所

既定では `%LOCALAPPDATA%\PaperDesk` に保存します。バックアップするときは、アプリを閉じてからフォルダー全体をコピーしてください。

```text
PaperDesk/
  settings.json
  ui-state.json
  library.sqlite3
  prompts/                    カスタマイズしたプロンプト
  papers/<論文ID>/
    original.pdf
    document.json             抽出結果
    translated.pdf
    interleaved.pdf
    translation.md
    translation-cache.json
    translation-report.json
    article.md                解説
    note.md                   メモ
```

## 環境変数

| 変数 | 用途 |
| --- | --- |
| `PAPERDESK_DATA_DIR` | データの保存先を変更する |
| `PAPERDESK_PORT` | sidecar の待ち受けポート（既定 8000） |
| `PAPERDESK_TOKEN` | sidecar の認証トークン。未設定なら認証なし（開発用） |
| `PAPERDESK_API_KEY` | API 接続で使う API キーの初期値 |

## キーボードショートカット

| キー | 操作 |
| --- | --- |
| `Ctrl+O` | PDF を追加 |
| `Ctrl+F` | ライブラリを検索 |
| `Ctrl+L` | 閲覧中の論文をライブラリで表示 |
| `Ctrl+G` | ページ番号を指定して移動 |
| `Ctrl+T` | 翻訳を開始 |
| `Ctrl+B` | サイドバーの表示切り替え |
| `←` / `→` | 前後のページへ移動 |
| `F2` | フォルダー・論文の名前を変更 |
| `Ctrl+Shift+N` | フォルダーを作成 |
| `F11` | 集中表示 |

## ライセンス

PaperDesk のコードは AGPL-3.0-or-later で提供します。ライセンス本文は [LICENSE](LICENSE) です。

同梱の源ノ明朝・源ノ角ゴシックは SIL Open Font License 1.1 です。出典は [paperdesk/core/assets/fonts/README.md](paperdesk/core/assets/fonts/README.md) を参照してください。PyMuPDF は AGPL または商用ライセンスで提供されています。その他の依存ライブラリはそれぞれのライセンスに従います。

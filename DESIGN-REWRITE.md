# PaperDesk 再構築 設計書（GUI フレームワーク移行）

作成日: 2026-09-24
対象: `paperdesk/` 現行実装（コミット `d19e884` + 作業ツリーの未コミット変更）

---

## 0. 結論（先に要点）

| 項目 | 推奨 |
| --- | --- |
| UI シェル | **Tauri 2**（Windows: WebView2 / macOS: WKWebView / Linux: WebKitGTK） |
| フロントエンド | **React 19 + TypeScript + Vite**、Tailwind CSS + shadcn/ui、react-markdown + KaTeX（同梱） |
| バックエンド | **既存 Python コアをそのまま維持**し、FastAPI + uvicorn の **ローカル sidecar プロセス**として起動（PyInstaller で各 OS 向けにビルド） |
| PDF 表示 | 第1段階: 現行どおり pypdfium2 でラスタライズした PNG を sidecar が配信（Qt 依存だけ除去）。第2段階（任意）: pdf.js に置換して文字選択・検索を追加 |
| データ | `%LOCALAPPDATA%\PaperDesk`（`library.sqlite3` / `papers/<id>/…`）を**無変更で引き継ぐ**。`window.ini` のみ移行 |

理由の要約:

- 既存資産のうち **Qt に依存しているのは `paperdesk/gui/*`（約 2,700 行）と `pdf/pdf_viewer.py` の QImage 部分だけ**。PDF 抽出・レイアウト解析・翻訳・訳文 PDF 生成・チャット・ストレージ（約 4,000 行、ユニットテスト約 160 件）は純 Python で、書き直す理由がない。
- 作業ツリーでは既に Markdown/数式表示を `QWebEngineView + KaTeX` に切り替えており、**「表示は Web 技術で行う」方針を事実上採用済み**。ならば Qt WebEngine（PySide6 フル版で +200 MB、CDN 依存）を抱えるより、UI 全体を Web 技術に寄せた方が一貫する。
- Tauri 2 は、現行の Windows 連携（タスクバー進捗・通知・トレイ・ドラッグ＆ドロップ・ウィンドウ位置記憶・ピン留め）に相当する機能を **公式 API/プラグインで 3 OS 共通に**提供する。
- フロントエンドは HTTP/WebSocket で sidecar と話すだけなので、**シェルを Electron や pywebview に差し替えても UI と Python コアは無変更**。Rust ツールチェーン導入が障害になった場合の退路がある。

「必ず確認してほしい」と指定された既存機能（数式レンダリング・画像挿入・Markdown・PDF・PDF チャット）の対応可否は **第 3 章の対応表**にまとめた。結論として **すべて対応可能**で、うち sidecar/フロントで実装し直すのは「表示」部分のみ、生成ロジックは既存コードをそのまま使う。

---

## 1. 現状の構成（調査結果）

### 1.1 モジュール構成と Qt 依存

| 層 | ファイル | 行数 | Qt 依存 | 役割 |
| --- | --- | --- | --- | --- |
| GUI | `gui/gui.py`, `gui_window_base.py`, `gui_window_library.py`, `gui_window_viewer.py`, `gui_widgets.py`, `gui_dialogs.py` | 約 2,670 | **あり（全面）** | メインウィンドウ、ライブラリツリー、PDF 左右表示、サマリー/質問/メモ タブ、設定・翻訳ダイアログ、ジョブ実行（QThread） |
| PDF | `pdf/pdf_engine.py`, `pdf_typography.py`, `pdf_math_crops.py`, `pdf_fonts.py` | 約 790 | なし | 抽出（PyMuPDF）、訳文 PDF 生成（`insert_htmlbox` + 同梱フォント）、インライン数式の切り出し画像 |
| PDF | `pdf/pdf_viewer.py` | 160 | **あり（QImage / QBuffer / Signal のみ）** | pypdfium2 でページをラスタライズし QImage で返す。背景スレッド `PageRenderer` |
| Core | `core/service.py` | 358 | なし | `translate` / `article` / `ask` / `export_*`、引用リンク生成 `link_citations` |
| Core | `core/providers.py` | 443 | なし | Codex CLI / Claude Code CLI / agy CLI / OpenAI 互換 API。subprocess + 一時ファイル、非ストリーミング、`threading.Event` でキャンセル |
| Core | `core/storage.py`, `config.py`, `bibliography.py`, `code_version.py`, `review_publish.py`, `prompts.py` | 約 650 | なし | SQLite（WAL）、`settings.json`、書誌情報、翻訳キャッシュのバージョン識別 |
| Core | `core/winintegration.py` | 278 | なし（ctypes COM） | AppUserModelID、`ITaskbarList3` 進捗、`.lnk` 作成、ウィンドウ再起動情報 |
| 翻訳/レイアウト | `translation/*`, `layout/*` | 約 1,330 | なし | 翻訳バッチ・再翻訳・数式トークン保護、読み順復元、表/図/参考文献の検出 |

`code_version.py` の `TRANSLATION_SOURCES` は GUI ファイルを含まないため、**GUI を書き換えても既存の翻訳キャッシュは無効化されない**。

### 1.2 GUI が担っている「表示」の実装（今回の移植対象）

| 機能 | 現行実装 | 備考 |
| --- | --- | --- |
| Markdown 表示（サマリー・質問） | 作業ツリー: `markdown` ライブラリで HTML 化 → `QWebEngineView` に流し込み、KaTeX を **jsDelivr CDN** から読込 → `renderMathInElement`（`$`, `$$`, `\(`, `\[`） | コミット済み版は `QTextBrowser.setMarkdown` + matplotlib で数式を PNG 化。CDN 版はオフラインで数式が出ない |
| 数式（画面） | 上記 KaTeX | 数式そのものは LLM 出力の Markdown 内に TeX で含まれる |
| 数式（訳文 PDF） | `pdf_engine.py:270-283` 元 PDF から 4 倍で切り出し `<img>` として `insert_htmlbox` に埋込 | **GUI 非依存。移行の影響なし** |
| 画像挿入（サマリー） | `service.article` が図表ブロックを `papers/<id>/media/<block>.png`（150 dpi）に切り出し、LLM に `![figure p.N](file:///…)` を書かせる（`service.py:269-298`） | 生成済み `article.md` は **絶対 `file://` URI** を含む |
| 引用リンク | `link_citations` が `[docid:pN]` → `[p.N](paperdesk://<id>/<page>)` に変換。GUI は `acceptNavigationRequest` で `paperdesk:` を横取り → `follow_citation` | `paperdesk://` スキームの扱いが移植のポイント |
| PDF 閲覧 | 原文/訳文の 2 ペイン。`PageRenderer` が pypdfium2 で **DPR 考慮の幅**にラスタライズ → `QLabel` に貼付。スクロール同期（`LinkedScrollBars`）、倍率 1–4x、Ctrl+ホイール、ピンチ | 訳文ペインは翻訳中 `translation-pages/<run>/page-N.pdf` を `translated_page()` で解決 |
| チャット | `library.messages()` を 1 本の Markdown（`### あなた` / `### 回答`）に連結して表示。ユーザー発言は `html.escape` | 非ストリーミング。「保存したほかの論文も検索する」チェック |
| ジョブ | `Job(QThread)`: `action(cancel: Event, progress: Callable[[str], None])`。進捗は日本語文字列、`(\d+)/(\d+)` を正規表現で拾ってプログレスバー・タスクバーへ | 論文ごとに 1 ジョブ + グローバル 1 ジョブ |
| 永続化（GUI 側） | `window.ini`（QSettings）: ウィンドウ位置、スプリッタ、並べ替え、展開フォルダー、**論文ごとの最終ページ** | 移行が必要 |
| Windows 連携 | ctypes COM + `QSystemTrayIcon` | 他 OS では全関数が no-op |

### 1.3 作業ツリーの未コミット変更（本設計への影響）

- `LocalTextBrowser` を `QTextBrowser` → `QWebEngineView` へ変更、`requirements.txt` を `PySide6-Essentials` → `PySide6`（フル、QtWebEngine 同梱）に変更。`matplotlib` は残っているが未使用。
- `requirements-windows-lock.txt` と CI（`windows.yml`）は Essentials のままで、`QtWebEngineWidgets` の import に失敗する状態。
- この変更が示す方向（Markdown+KaTeX を Web で描画）を、本設計では UI 全体に広げる。

---

## 2. フレームワーク候補の比較

評価軸は「見た目のモダンさ」「Windows 以外への展開しやすさ」「既存 Python コアの再利用」「必須機能の実現性」「ビルド・配布」「保守性」。

| 候補 | 言語 | 見た目 | 3 OS 対応 | Python コア再利用 | Markdown+KaTeX（Mermaid も同条件） | 画像 (`media/*.png`) | PDF 表示 | `paperdesk://` 引用 | タスクバー進捗/通知/トレイ/DnD | 配布 | 総評 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Tauri 2 + React + Python sidecar** | TS + Python（Rust は雛形のみ） | ◎ Web UI | ◎ | ◎ sidecar で無変更 | ◎ KaTeX 同梱 | ◎ sidecar HTTP で配信 | ◎ PNG or pdf.js | ◎ クリック横取り | ◎ 公式 API/プラグイン（Linux 進捗は libunity 系 DE のみ） | ◎ MSI/NSIS, DMG, AppImage/deb、数 MB～ | **推奨** |
| Electron + React + Python sidecar | TS + Python | ◎ | ◎ | ◎ | ◎ | ◎ | ◎ | ◎ | ◎ `setProgressBar`, Tray, Notification | ○ 150 MB 超、メモリ大 | Tauri と同じ UI/sidecar を流用可能な代替 |
| pywebview + React（Python 単一プロセス） | Python + TS | ◎ | ○ Linux は WebKitGTK の DnD 制約 | ◎ 同一プロセス | ◎ | ◎ | ◎ | ◎ | △ 進捗/トレイは自前（既存 ctypes を流用可、他 OS は別途） | ○ PyInstaller + Inno/dmg を自作 | Rust/Node 不要の最小構成。ネイティブ連携を自作する覚悟があれば可 |
| PySide6 + QML（Qt Quick Controls Material） | Python | ○ Material 風 | ◎ | ◎ | △ QtWebEngine 同梱で +200 MB、または `QtPdf`+独自数式 | ○ | ◎ `QtPdf.PdfMultiPageView` | ○ | ○ Qt6 に WinExtras なし、ctypes 継続 | ○ PyInstaller、GPL/LGPL 注意 | 「書き直し」の割に見た目の伸びしろが小さい |
| Flet（Flutter） | Python | ◎ Material | ◎ | ◎ | △ `Markdown` の LaTeX 対応は不安定との報告、`flet_math` 併用 | ○ base64 経由 | ○ PNG のみ | ◎ `on_tap_link` | × 進捗/トレイなし | △ `flet build` に Flutter SDK 必須、API 変更が激しい | 数式とネイティブ連携で不利 |
| .NET MAUI / Avalonia / Flutter 本体 | C# / Dart | ◎ | ◎ | △ sidecar 必須 | ○ | ○ | ○ | ○ | ○ | ○ | 新言語の学習コストが Tauri 比で大きく、利点が薄い |

**選定理由（Tauri 2）**

1. UI を Web 技術に統一すると、Markdown・KaTeX・画像・リンク横取りが **npm の標準的な部品**で完結し、現行の `QWebEngineView` で試している内容をそのまま昇華できる。
2. 必須のネイティブ連携（タスクバー進捗、通知、トレイ、ファイル DnD、ウィンドウ状態、外部アプリで開く、ファイルダイアログ）が公式 API で揃う。
3. インストーラー生成（MSI/NSIS/DMG/AppImage/deb）と GitHub Actions（`tauri-action`）が整備済み。
4. Python 側は **FastAPI を薄く被せるだけ**。`PaperService` / `Library` / `Provider` のシグネチャを変えない。
5. リスク対策として、フロントエンドは `ShellAdapter`（後述）経由でのみシェル機能を呼び、Electron/pywebview へ置換可能にしておく。

Rust については `src-tauri/src/main.rs` の雛形に sidecar 起動・終了（30 行程度）を足すだけで、アプリロジックは書かない。

---

## 3. 既存機能の対応表（必須確認事項）

凡例: ✅ 既存コードをそのまま使用 / 🔁 表示部分を再実装 / 🛠 バックエンド小変更

### 3.1 数式レンダリング

| 対象 | 現行 | 新構成 | 状態 |
| --- | --- | --- | --- |
| 訳文 PDF 内のインライン数式（元 PDF から切り出し、`<img>` で `insert_htmlbox`） | `pdf_engine.py` | 無変更 | ✅ |
| 訳文 PDF 内のブロック数式（元描画を保持） | `pdf_engine.py` | 無変更 | ✅ |
| サマリー・回答の Markdown 内 TeX（`$…$`, `$$…$$`, `\(…\)`, `\[…\]`） | KaTeX（CDN） | `katex` npm を同梱し **オフライン動作**。`remark-math` + `rehype-katex` を使い、`\(`/`\[` は前処理で `$`/`$$` に正規化（現行 auto-render と同じ 4 区切りを維持）。`throwOnError:false` で不正な TeX はソース表示 | 🔁 |
| 旧実装の `\text→\mathrm` 置換（matplotlib 対策） | `render_markdown_with_math` | 不要（KaTeX は `\text` 対応） | 削除 |

### 3.2 画像挿入（サマリーの図表）

| 対象 | 現行 | 新構成 | 状態 |
| --- | --- | --- | --- |
| 図表の切り出し `media/<block>.png` | `service.article` (PyMuPDF 150 dpi) | 無変更 | ✅ |
| LLM への画像構文の指示 | `prompts/summary_notes.txt`, `summary_article.txt` | 無変更（URI の形は 🛠 参照） | ✅ |
| Markdown 中の `![…](file:///…/media/x.png)` の表示 | `QWebEngineView` が `file://` を直接読込 | WebView は `file://` を読めないため、sidecar の `GET /api/papers/{id}/media/{name}` で配信。react-markdown の `urlTransform` で **既存 `article.md` の絶対 `file://` パスを API URL に書き換え**（後方互換）。新規生成は相対パス `media/<name>` を書かせる | 🔁 + 🛠（`service.py:296` の `as_uri()` → 相対パス） |
| 回答（チャット）内の画像 | プロンプトで禁止（`chat_answer.txt`） | 同じ | ✅ |

### 3.3 Markdown 対応

| 対象 | 現行 | 新構成 | 状態 |
| --- | --- | --- | --- |
| サマリー表示 | `markdown`（tables, fenced_code）→ HTML | `react-markdown` + `remark-gfm`（表・脚注・取り消し線）+ `rehype-highlight`（コード） | 🔁 |
| 回答表示（ユーザー発言は HTML エスケープ） | 1 本の Markdown に連結 | メッセージ配列を個別カードで描画。ユーザー発言はプレーンテキスト、回答は Markdown | 🔁（見た目改善） |
| メモ（Markdown 入力、600 ms 後自動保存） | `QPlainTextEdit` + `QTimer` | CodeMirror 6 or textarea + デバウンス保存。プレビュー切替を追加可 | 🔁 |
| `translation.md` / `article.md` の書き出し | ファイルコピー | sidecar `POST /api/papers/{id}/export/markdown` + 保存ダイアログ（tauri-plugin-dialog） | 🔁 |
| サニタイズ | なし | `rehype-sanitize` で `<script>` 等を除去し、`img` と `a`（`paperdesk:` スキーム）は許可 | 追加 |
| Mermaid 図（新規） | なし | ```` ```mermaid ```` フェンスを `code` コンポーネントで捕捉し、`mermaid` npm（同梱、動的 import）で SVG 化。`mermaid.parse()` で事前検査し、失敗時はコードブロックのまま表示。`securityLevel:'strict'`、テーマ切替で再描画。サマリーに図を出させるには `summary_article.txt` へ一文追加 | 追加 |

### 3.4 PDF 対応

| 対象 | 現行 | 新構成 | 状態 |
| --- | --- | --- | --- |
| 追加（複数選択、SHA-256 重複判定、300 MB 上限、画像のみ PDF 検出） | `Library.import_pdf` | `POST /api/papers/import`（パスのリスト）。パスはダイアログ or DnD から取得 | ✅ |
| 抽出・レイアウト解析（`document.json`、`LAYOUT_VERSION` 更新時の再抽出） | `Library.document` | 無変更 | ✅ |
| 翻訳（ページ指定、継続ページ展開、キャッシュ再開、再翻訳、ページごとの preview PDF） | `PaperService.translate` | 無変更。ジョブとして sidecar のスレッドで実行 | ✅ |
| 訳文 PDF / 交互 / 対訳 PDF 生成 | `pdf_engine.py` | 無変更 | ✅ |
| ページ画像（DPR 考慮の幅指定、8192 px / 24 M px 上限） | `pdf_viewer.page_image` → QImage | **Qt を除去**して RGB bytes → PNG（`pypdfium2` の `to_pil()` か `Pixmap` → `png` エンコード）。`GET /api/papers/{id}/pages/{n}/image?width=…&variant=original|translated` を `Cache-Control` 付きで返す | 🛠 |
| 翻訳中の訳文ページ解決（`translated_page`, `read_preview`） | GUI がファイルを直接読む | sidecar の `GET /api/papers/{id}/reading` が完了ページ・対象ページ・スキップ・翻訳時 SHA/モデルをまとめて返す | 🛠（読み取りロジックは既存関数を呼ぶだけ） |
| 2 ペイン同期スクロール・倍率（幅合わせ〜400%）・Ctrl+ホイール・ピンチ | Qt イベント | `scroll` イベントの比率同期、`wheel`（ctrlKey）と `gesturechange`/`pointer` ピンチ。倍率プリセットは同じ | 🔁 |
| ←/→ ページ移動、Ctrl+G、Ctrl+F、Ctrl+L、Ctrl+O、F11 集中表示、F2 | QAction | フロントのキーボードショートカット（入力中は無効） | 🔁 |
| 「翻訳済みページのみ」表示 | GUI | 同じロジックをフロントで（`reading` API のデータから） | 🔁 |
| 外部ビューアで開く / エクスプローラーで開く | `QDesktopServices` | `tauri-plugin-opener`（`openPath`, `revealItemInDir`） | 🔁 |
| 原文 PDF の別名保存、PDF 書き出し（3 種） | `QFileDialog` + `shutil` / `service.export_*` | 保存ダイアログ → sidecar へパスを渡す | 🔁 |
| 文字選択・検索（現状なし） | — | 第 2 段階で pdf.js 化すれば追加可能。`pdf_viewer.page_text_info` は既存 | 任意 |

### 3.5 PDF チャット（質問）

| 対象 | 現行 | 新構成 | 状態 |
| --- | --- | --- | --- |
| 質問実行（キーワード生成 → `search_pages` 最大 10 ページ → 回答、履歴 6 件、全論文検索） | `PaperService.ask` | 無変更。`POST /api/papers/{id}/ask` がジョブを開始し、完了イベントで履歴を再取得 | ✅ |
| 履歴保存（`messages` テーブル） | `Library.add_exchange` / `messages` | `GET /api/papers/{id}/messages` | ✅ |
| 引用 `[p.3](paperdesk://<id>/3)` のクリックで原文ページへ移動（ページ範囲検査、「全ページ」表示へ切替） | `follow_citation` | react-markdown の `urlTransform` で `paperdesk:` を保持し、`a` コンポーネントで横取り → リーダーへ遷移。`allowed` の検査は既存の `link_citations` が済ませている | 🔁 |
| 「参照未確認: …」表示 | `link_citations` | 無変更 | ✅ |
| 回答末尾の参照範囲 | `service.ask` | 無変更 | ✅ |
| ストリーミング表示 | なし（全 Provider が完了時に一括返却） | 当面なし。UI は「回答中」インジケーターとキャンセルボタン。将来 API 版だけ SSE 化する余地を `Provider.generate` の外側に残す | 現状維持 |

### 3.6 その他の既存機能

| 機能 | 新構成 | 状態 |
| --- | --- | --- |
| ライブラリツリー（入れ子フォルダー、件数、並べ替え 4 種、検索、展開状態の記憶） | `GET /api/papers?query=`, `GET/POST/PATCH/DELETE /api/collections`。ツリーはフロントで構築 | 🔁 |
| ツリー内 DnD で分類変更、エクスプローラーからフォルダーへドロップして追加、「移動を戻す」 | ツリー内は HTML5 DnD（dnd-kit）。OS からのドロップは Tauri の `onDragDropEvent`（パスと座標が取れる）でフォルダー行を判定 | 🔁 |
| 右クリックメニュー（名前変更、子フォルダー、削除、分類変更、原文を開く、保存フォルダーを開く） | Radix ContextMenu | 🔁 |
| メモ・書誌情報（タイトル・筆頭著者・出版年・フォルダー） | `PATCH /api/papers/{id}` | ✅ |
| 設定（接続先 4 種、モデル一覧の再取得、effort、CLI パス、API URL/キー） | `GET/PUT /api/settings`, `GET /api/providers/{p}/models`, `/efforts`。API キーはセッション内のみ（現行どおり保存しない） | ✅（既存 `query_available_*` を呼ぶ） |
| ログイン（CLI をコンソール付きで起動）・接続確認 | `POST /api/providers/login`（sidecar が `Popen`。Windows は `CREATE_NEW_CONSOLE`、macOS/Linux は `open -a Terminal` / `x-terminal-emulator` で起動、ブラウザは CLI 自身が開く）、`POST /api/providers/check` はジョブ | 🔁（`gui.py:358-405` のロジックを sidecar へ移動） |
| 翻訳開始ダイアログ（全ページ/現在/指定、モデル・effort プリセット、前回指定の記憶） | フロントのダイアログ。`parse_page_selection` は sidecar でバリデーション | 🔁 |
| ジョブ（論文ごと 1 件 + グローバル 1 件、中止、失敗ダイアログにコピー、完了通知） | sidecar のジョブマネージャ + WebSocket イベント | 🔁 |
| タスクバー進捗（通常/不確定/エラー） | `getCurrentWindow().setProgressBar()`（Windows/macOS。Linux は libunity 対応 DE のみ） | 🔁 |
| 通知（非アクティブ時） | `tauri-plugin-notification` + `isFocused()` | 🔁 |
| トレイアイコン（開く/終了） | Tauri `TrayIcon` | 🔁 |
| ウィンドウ位置・最大化・スプリッタ幅の復元 | `tauri-plugin-window-state` + `ui-state.json` | 🔁 |
| 論文ごとの最終閲覧ページ、前回の論文から再開 | `ui-state.json`（sidecar 管理）。初回起動時に `window.ini` から移行 | 🛠 |
| スタートメニュー登録・ピン留め・AppUserModelID | インストーラー（MSI/NSIS）がショートカットを作成し、実行ファイルが本物の exe になるため `winintegration` の `.lnk`/再起動情報の細工は不要 | 廃止（Windows 版のみ、後述 §7.4） |
| exe ビルド・CI | `tauri build` + PyInstaller、3 OS マトリクス | 🔁 |

---

## 4. 新アーキテクチャ

### 4.1 プロセス構成

```
┌─────────────────────────────── PaperDesk.exe / .app / AppImage ───────────────────────────────┐
│  Tauri shell (Rust, 生成コード + sidecar 起動)                                                 │
│   ├─ WebView (WebView2 / WKWebView / WebKitGTK)                                                │
│   │    └─ React アプリ (Vite ビルド成果物, 同梱)                                               │
│   │         ├─ ShellAdapter ── Tauri API (dialog / opener / notification / tray / progress / dnd)│
│   │         └─ ApiClient ──── HTTP + WebSocket ──▶ 127.0.0.1:<port> (token 付き)                │
│   └─ spawn ─────────────────────────────────────▶ paperdesk-sidecar (PyInstaller, onedir)      │
│                                                    ├─ FastAPI + uvicorn                        │
│                                                    ├─ JobManager (threads, cancel Event)      │
│                                                    └─ paperdesk.core / pdf / translation / layout (既存) │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
                                                     │
                                                     ▼
                                      %LOCALAPPDATA%\PaperDesk（既存レイアウトのまま）
```

- 起動: shell が空きポートとランダムトークンを生成し、環境変数 `PAPERDESK_PORT` / `PAPERDESK_TOKEN` / `PAPERDESK_DATA_DIR` を付けて sidecar を起動。sidecar は `GET /health` が 200 を返すまで待つ（起動画面表示）。
- 終了: shell の `CloseRequested` → フロントが実行中ジョブを確認（現行と同じく実行中なら中止を要求して閉じない）→ sidecar に `POST /shutdown` → プロセス終了を待って exit。異常終了に備え shell 側でも kill。
- セキュリティ: ループバックのみ bind、全リクエストに `Authorization: Bearer <token>`。WebSocket も同様。CORS は Tauri のオリジン（`tauri://localhost` / `http://tauri.localhost`）のみ許可。

### 4.2 リポジトリ構成（案）

```
paper-desk/
  paperdesk/            # 既存 Python コア（gui/ を削除、pdf_viewer から Qt を除去）
  sidecar/              # 新規: FastAPI アプリ
    app.py              # ルーティング、認証、起動/終了
    jobs.py             # JobManager（threading、進捗イベント）
    schemas.py          # pydantic モデル
    ui_state.py         # ui-state.json（window.ini からの移行を含む）
    pyinstaller.spec
  frontend/             # 新規: React + TS
    src/
      app/              # ルーティング、レイアウト、テーマ
      api/              # ApiClient（fetch + WebSocket）、型（OpenAPI から生成）
      shell/            # ShellAdapter インターフェイスと tauri 実装（electron/pywebview 用の差し替え点）
      features/
        library/        # ツリー、検索、DnD、コンテキストメニュー
        reader/         # 2 ペイン PDF、ズーム、同期スクロール、ページ操作
        summary/        # Markdown + KaTeX + 画像
        chat/           # メッセージ一覧、入力、引用リンク
        notes/          # メモ・書誌情報
        settings/       # 接続設定、モデル取得、ログイン、接続確認
        jobs/           # 進捗バー、中止、エラーダイアログ、通知
      components/       # shadcn/ui
  src-tauri/            # Tauri 設定と最小 Rust
  tests/                # 既存 unittest（GUI 依存分は sidecar/API テストへ置換）
  .github/workflows/    # 3 OS ビルド
```

### 4.3 sidecar API（抜粋）

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/health` | 起動確認、バージョン、`code_version` |
| GET | `/api/settings` / PUT | `Settings`（`api_key` はメモリのみ） |
| GET | `/api/providers/{p}/models`, `/efforts?model=` | 既存 `query_available_models/efforts` |
| POST | `/api/providers/login`, `/api/providers/check` | ログイン起動、接続確認ジョブ |
| GET | `/api/papers?query=&sort=` | 一覧（`Library.papers`） |
| POST | `/api/papers/import` | `{paths: [], collection}` → ジョブ（グローバル） |
| GET/PATCH | `/api/papers/{id}` | 詳細、メタ・メモ・分類更新 |
| POST | `/api/papers/{id}/rename` | ファイル名変更 |
| GET | `/api/papers/{id}/reading` | ページ数、完了ページ、preview 状態、スキップ、空ページ、翻訳 SHA/モデル、`translation-report` 要約 |
| GET | `/api/papers/{id}/pages/{n}/image?variant=&width=` | PNG（`ETag` = ファイル mtime + 幅） |
| POST | `/api/papers/{id}/translate` | `{pages, model?, effort?}` → ジョブ |
| POST | `/api/papers/{id}/article` | ジョブ |
| GET | `/api/papers/{id}/article` | `article.md` 本文 |
| GET | `/api/papers/{id}/media/{name}` | 図表 PNG |
| GET | `/api/papers/{id}/messages`, POST `/ask` | 履歴、質問ジョブ |
| POST | `/api/papers/{id}/export` | `{kind: translated|interleaved|bilingual|markdown, destination}` |
| GET/POST | `/api/collections`, PATCH `/rename`, DELETE | フォルダー操作 |
| GET | `/api/jobs`, POST `/api/jobs/{id}/cancel` | ジョブ一覧・中止 |
| WS | `/ws/events` | `job.progress {job_id, paper_id, message, done?, total?}`, `job.page_ready {paper_id, page}`, `job.finished {status, result|error, cancelled}`, `library.changed` |
| POST | `/shutdown` | 終了 |

OpenAPI から TypeScript 型を生成し（`openapi-typescript`）、フロントとスキーマを同期する。

### 4.4 ジョブモデル

- `JobManager` は現行 `run_job` の規則を踏襲: **論文ごとに 1 件、グローバル（追加・接続確認）1 件**。競合時は 409 を返す。
- 各ジョブは `threading.Thread` で `action(cancel: Event, progress)` を実行（`PaperService`, `Provider` のシグネチャそのまま）。
- `progress(message)` は既存の文字列のまま受け取り、sidecar が `(\d+)\s*/\s*(\d+)` を解釈して `done/total` を付与（現行 GUI の `COUNTER` を移動）。将来 `service.py` 側で構造化するときも API は不変。
- `page_ready` コールバックは `job.page_ready` イベントに変換。フロントは表示中の論文・ページなら該当画像を再取得（`ETag` が変わる）。
- 中止は `cancel.set()`。CLI プロセスは既存 `_run_cli_process` が `taskkill`/`killpg` で停止。

### 4.5 フロントエンド設計

**画面構成**（現行を踏襲しつつ整理）

- 左: ライブラリサイドバー（ブランド、PDF 追加、追加先、検索、並べ替え、ツリー、件数、接続・設定メニュー）。折りたたみ可。
- 右上: タイトル、メタ情報、「翻訳 / 再開」、「その他」メニュー（サマリー作成、PDF 書き出し、外部で開く 3 種、フォルダーを開く）。
- タブ: **PDF を読む** / **サマリー** / **質問** / **メモ・整理**。
- 下: ステータス行、移動を戻す、中止、進捗バー。集中表示（F11）でサイドバー・ヘッダー・タブを隠す。
- テーマ: ライト/ダーク自動、システム日本語フォント（Windows: Yu Gothic UI、macOS: Hiragino Sans、Linux: Noto Sans CJK JP）を CSS のフォントスタックで指定。

**主要ライブラリ**

| 用途 | 選定 |
| --- | --- |
| UI 部品 | shadcn/ui（Radix）+ Tailwind、アイコンは lucide |
| データ取得/キャッシュ | TanStack Query（`reading`・`messages`・一覧を WS イベントで無効化） |
| UI 状態 | zustand（選択論文、ページ、倍率、フィルター、集中表示） |
| Markdown | react-markdown + remark-gfm + remark-math + rehype-katex + rehype-highlight + rehype-sanitize |
| 図 | mermaid（`mermaid` フェンスのみ動的読込。`article.md` は Markdown のまま保存されるため外部ビューアでも描画可） |
| ツリー DnD | dnd-kit |
| PDF | 第 1 段階 `<img>`（sidecar PNG）、第 2 段階 pdf.js（`pdfjs-dist`） |
| キーボード | react-hotkeys-hook |

**Markdown レンダリングパイプライン**

```
text ──▶ normalizeMath()  // \( \) \[ \] → $ $$、既存 file:// media URI → /api/... に変換（正規表現）
     ──▶ react-markdown(remarkGfm, remarkMath) ──▶ rehypeKatex ──▶ rehypeHighlight ──▶ rehypeSanitize(schema)
     ──▶ components: { a: CitationLink, img: MediaImage }
urlTransform: 'http(s):', 'paperdesk:' と相対パスを許可（それ以外は除去）
CitationLink: href が paperdesk://<id>/<page> なら onNavigate(id, page) を呼ぶ（既存 follow_citation と同じ検査・タブ切替・「全ページ」への戻し）
```

**PDF リーダー（第 1 段階）**

- 各ペインは `overflow:auto` のコンテナに `<img>`。要求幅は `Math.ceil(fitWidth * zoom * devicePixelRatio)`、CSS 幅は `fitWidth * zoom`（現行と同じ DPR 処理）。
- 同期: `scrollTop/(scrollHeight-clientHeight)` の比率を相互反映（`LinkedScrollBars` 相当）。再入防止フラグ付き。
- 画像差し替え時のチラつき防止: 旧画像を保持し、新画像 `onload` で交換。ズーム変更時は CSS スケールで即時プレビュー → 高解像度取得後に差し替え。
- 翻訳中ページの文言（「翻訳待ち」「原文（未翻訳）」「PDF 生成をスキップ」）は `reading` API のデータから決定（`gui_window_viewer.py:85-88` のロジックを移植）。

**チャット**

- メッセージカード（ユーザー/回答）、回答は Markdown。送信後は入力欄をクリアし、ジョブ完了で履歴を再取得して末尾へスクロール。
- 「保存したほかの論文も検索する」トグル、実行中はキャンセル可能。

### 4.6 ShellAdapter（差し替え点）

```ts
interface ShellAdapter {
  openFiles(filters): Promise<string[]>;      // PDF 追加
  saveFile(defaultName, filters): Promise<string | null>;
  openPath(path): Promise<void>;              // 外部 PDF ビューア
  revealInFolder(path): Promise<void>;
  notify(title, body): Promise<void>;
  setProgress(state: 'none'|'normal'|'indeterminate'|'error', done?, total?): Promise<void>;
  onFileDrop(cb: (paths: string[], position: {x,y}) => void): Unsubscribe;
  isFocused(): Promise<boolean>;
  requestClose(handler: () => Promise<boolean>): void;
  setTray(menu): void;
}
```

Tauri 実装は各プラグインを呼ぶだけ。Electron 実装は `preload` 経由、pywebview 実装は `window.pywebview.api` 経由で同じ契約を満たす。

---

## 5. バックエンド変更点（最小限）

| ファイル | 変更 | 理由 |
| --- | --- | --- |
| `pdf/pdf_viewer.py` | `QImage`/`QBuffer`/`Signal` を除去。`page_image()` は `(rgb_bytes, width, height, stride)` または PNG bytes を返す。`PageRenderer` は sidecar 側の単純なスレッドプールに置換（`_RENDER_LOCK` は維持） | 唯一の Qt 依存を切る。`tests/test_pdf_viewer.py` を bytes ベースに更新 |
| `pdf/pdf_engine.py:399 page_png` | 上記に追従 | |
| `core/service.py:296` | `image_path.as_uri()` → `f"media/{name}"`（相対）。プロンプト文言は変更不要 | WebView から `file://` を読めない。既存 `article.md` はフロントで変換 |
| `core/service.py`（任意） | `progress` に構造化引数を追加する場合も**既存の文字列呼び出しを維持** | 互換 |
| `gui/` | 削除（`TRANSLATION_PRESETS`、`STYLE`、ダイアログのラベル文言はフロントへ移す） | |
| `core/winintegration.py` | `TaskbarProgress` / `apply_window_identity` / `install_shortcuts` は Tauri 側で代替されるため **sidecar からは呼ばない**。`icon_path` のみ残すか削除 | |
| `requirements.txt` | `PySide6`, `matplotlib`, `markdown` を削除し `fastapi`, `uvicorn`, `pydantic` を追加。`pillow` は pypdfium2 の PNG 化に使う場合のみ | |
| `tests/` | `gui_smoke.py`, `gui_folders.py`, `gui_usability.py`, `test_page_keyboard.py`, `test_reader_loading.py`, `test_scroll_sync.py`, `test_shell_integration.py` は Qt 依存。API テスト（`TestClient`）とフロントの vitest/Playwright に置換。残り約 140 件はそのまま | |

既知の不具合で、書き換え時に自然に解消されるもの: `gui_dialogs.py:477` 付近の接続確認スレッドが `cancel` に `lambda: False` を渡しており API 経路で `check_cancel` が `AttributeError` になる（sidecar では常に `threading.Event` を渡す）。

---

## 6. データ互換と移行

- **データディレクトリ、SQLite スキーマ、`papers/<id>/` 配下の全ファイル、`settings.json`、翻訳キャッシュ、`code_version` は無変更。** 旧版で翻訳した論文はそのまま閲覧・再開できる。
- `window.ini`（QSettings INI）: 初回起動時に `ui-state.py` が `configparser` で読み、`reading/<id>` → 最終ページ、`reading/last_paper`、`library/sort`、`library/expanded_collections` を `ui-state.json` に移す。ウィンドウ位置は `saveGeometry` のバイナリなので引き継がず、`tauri-plugin-window-state` に任せる。
- `article.md` の `file:///…/media/*.png`: 表示時に変換（§4.5）。ファイル自体は書き換えない。
- `PAPERDESK_DATA_DIR` / `PAPERDESK_API_KEY` / `GEMINI_API_KEY` は shell が sidecar に引き継ぐ。

---

## 7. ビルド・配布・CI

### 7.1 sidecar

- PyInstaller **onedir** を `src-tauri/resources/sidecar/<target>/` に配置し、Rust 側で `resource_dir()` から起動する（onefile は起動ごとに PyMuPDF 等を展開するため 1〜3 秒遅くなる。Tauri の `externalBin` は単一ファイル前提なので onedir はリソース扱いにする）。
- 同梱物: `paperdesk/core/assets/fonts/*.otf`（訳文 PDF 用、約 11 MB）、`prompts/*.txt`、`build/code-version.txt`（現行 `build-windows.cmd` と同じ手順）。
- ターゲット: `x86_64-pc-windows-msvc`, `aarch64-apple-darwin`（Intel Mac は必要なら `x86_64-apple-darwin`）, `x86_64-unknown-linux-gnu`。PyMuPDF / pypdfium2 / fontTools は 3 OS の wheel が提供済み。

### 7.2 Tauri

- `tauri.conf.json`: `identifier = "local.paperdesk"`（Windows の AppUserModelID に相当。ピン留め時にこの ID で 1 つのボタンにまとまる）、`productName = PaperDesk`、アイコンは `paperdesk.png` から `tauri icon` で生成。
- プラグイン: `dialog`, `opener`, `notification`, `window-state`, `shell`（ログイン用ターミナル起動が必要な場合）。トレイと進捗はコア API。
- Windows: NSIS/MSI（WebView2 はブートストラッパー同梱設定にする）。macOS: DMG（署名・公証は任意。未署名なら Gatekeeper の警告手順を README に記載）。Linux: AppImage + deb（`webkit2gtk-4.1` 依存）。

### 7.3 CI（GitHub Actions）

```
matrix: [windows-latest, macos-latest, ubuntu-22.04]
steps: setup-python → pip install → python -m unittest（コア）→ pytest sidecar（TestClient）
       → pyinstaller（onedir）→ setup-node → npm ci → vitest → tauri-apps/tauri-action（build, artifact upload）
```

### 7.4 Windows 固有事項の扱い

- 既存 `winintegration` の「python.exe ではなく PaperDesk としてピン留めされる」仕組みは、実行ファイルが本物の exe になるため不要。
- 以前の `.lnk`（`setup.cmd` / `create-shortcut.cmd` で作成）は起動先が `pythonw.exe` なので、新版インストール後に手動削除が必要。README に記載。
- 通知は Windows のトースト（Tauri notification プラグイン）。旧版のトレイ バルーンからの変更。

---

## 8. テスト戦略

| 層 | 手段 | 内容 |
| --- | --- | --- |
| Python コア | 既存 unittest（約 140 件を維持） | レイアウト、翻訳回復、PDF 生成、書誌、ストレージ |
| sidecar | pytest + FastAPI `TestClient` + `FakeProvider`（`tests/test_workflow.py` のものを流用） | 追加 → 翻訳ジョブ → `page_ready` イベント → `reading` の整合、ask と引用リンク、画像配信、エクスポート、キャンセル、409 の競合、トークン認証 |
| フロント単体 | vitest + Testing Library | `normalizeMath`（4 区切り）、`file://`→API 変換、`paperdesk:` リンク横取り、翻訳中ページの表示文言、スクロール同期比率 |
| E2E | Playwright（`tauri-driver` 経由、または dev サーバー + モック shell） | サンプル PDF の追加・翻訳（FakeProvider 設定の sidecar）・サマリー表示（数式・画像）・質問→引用クリック→ページ移動 |
| 目視 | 既存 `tools/review_fresh_layout.py` 等 | PDF 生成物は無変更のため従来どおり |

数式・画像・引用の回帰テストには、実データを模した固定の Markdown（`$…$`、`$$…$$`、`\(…\)`、`![figure p.3](file:///…/media/b12.png)`、`[p.3](paperdesk://<id>/3)`、`[参照未確認: …]` を含む）をフィクスチャとして用意する。

---

## 9. 移行計画

| フェーズ | 内容 | 完了条件 |
| --- | --- | --- |
| 0. 下準備（1 週） | `pdf_viewer.py` の Qt 除去、`service.py` の相対 media パス、`tests` 更新。**現行 Qt GUI はこの時点でも動く**（QImage 変換を GUI 側へ移す） | 既存テスト緑 |
| 1. sidecar（1〜2 週） | FastAPI、JobManager、WS イベント、`ui-state.json`、OpenAPI 出力。CLI だけで翻訳〜質問が回る | API テスト緑 |
| 2. フロント骨格（2 週） | Tauri 雛形 + sidecar 起動、ライブラリ、リーダー（PNG）、設定 | サンプル PDF の追加・閲覧・翻訳 |
| 3. サマリー/チャット/メモ（1〜2 週） | Markdown + KaTeX + 画像 + 引用、履歴、メモ自動保存、書き出し | §3 の対応表を全項目クリア |
| 4. ネイティブ連携・配布（1 週） | 進捗・通知・トレイ・DnD・ウィンドウ状態、3 OS ビルド、README 更新 | 3 OS でインストーラー生成、Windows 実機確認 |
| 5. 旧 GUI 削除 | `paperdesk/gui/`, `scripts/*.cmd`, `windows.yml` の PyInstaller 部分を撤去 | |
| 6.（任意）pdf.js 化 | 文字選択・検索・ベクター拡大 | |

各フェーズは独立してマージ可能。フェーズ 0〜1 の間は旧 GUI と新 sidecar が同じデータを共有できるので、並行して比較検証できる。

---

## 10. リスクと対策

| リスク | 影響 | 対策 |
| --- | --- | --- |
| Rust ツールチェーン導入・`tauri build` の環境差 | 着手遅れ | 雛形以外に Rust を書かない。行き詰まった場合は同じフロント/sidecar を Electron へ載せ替え（`ShellAdapter` のみ実装） |
| Linux WebKitGTK の描画・性能差（大きな PNG、KaTeX フォント） | Linux での体験低下 | Linux は「動作する」を目標にし、主対象は Windows/macOS。pdf.js 化を Linux で先に評価 |
| PyInstaller onedir の起動時間・サイズ（PyMuPDF + フォント） | 起動 1〜2 秒、100 MB 前後 | 起動画面で `/health` 待ちを可視化。フォントは訳文生成時のみ読み込む（現行どおり） |
| ループバック HTTP を他プロセスが叩く | データ漏えい | ランダムトークン必須、127.0.0.1 のみ、CORS 限定 |
| CLI（codex/claude/agy）の macOS/Linux での検出 | 接続不可 | 既存 `shutil.which` 経路は OS 非依存。Windows 固有フォールバックは条件分岐済み。GUI 起動時 `PATH` が shell と異なる問題（macOS）には `login shell` から PATH を取得する処理を sidecar に追加 |
| 既存 `article.md` の `file://` 変換漏れ | 画像が出ない | 変換はパス末尾 `papers/<id>/media/<name>` のみを見るため絶対パス差に依存しない。テストで固定 |
| KaTeX で描画できない TeX（LLM 出力の癖） | 数式が生テキストになる | `throwOnError:false`、`strict:'ignore'`。matplotlib 時代の置換は不要 |
| 翻訳中に旧 GUI と新 GUI を同時起動 | キャッシュ競合 | README の注意事項を維持（現行と同じ） |

---

## 11. 決めていない事項（実装前に確認したい点）

1. **Linux をどこまで正式対応にするか**（AppImage 提供のみ、進捗表示なし で良いか）。
2. **macOS の署名・公証**を行うか（Apple Developer Program が必要）。未署名なら初回起動に右クリック→開く の手順が要る。
3. **pdf.js 化（第 2 段階）を当初から入れるか**。文字選択・検索は新機能になるため、まず PNG で既存機能同等を達成する案を推奨。
4. 訳文 PDF 生成に使う **同梱フォント（約 11 MB）をインストーラーに含める**方針は現行どおりで良いか。
5. 旧 `window.ini` の閲覧位置移行を行うか（行わない場合は実装が簡単になる）。

---

## 付録 A. 参考資料

- Tauri 2 Sidecar: https://v2.tauri.app/develop/sidecar/
- Tauri 2 `window.setProgressBar` / drag-drop events: https://v2.tauri.app/reference/javascript/api/namespacewindow/ , https://v2.tauri.app/reference/javascript/api/namespaceevent/
- Tauri 2 + FastAPI sidecar のテンプレート例: https://github.com/dieharders/example-tauri-v2-python-server-sidecar , https://github.com/AlanSynn/vue-tauri-fastapi-sidecar-template
- Flet Markdown（LaTeX 関連プロパティと制約の議論）: https://docs.flet.dev/controls/markdown/ , https://github.com/flet-dev/flet/discussions/3955
- Flet WebView の Windows/Linux 対応（webview_all）: https://github.com/flet-dev/flet/pull/6836
- pywebview ドラッグ＆ドロップとフルパス取得: https://pywebview.flowrl.com/examples/drag_drop.html
- PySide6 QtPdf（QML `PdfMultiPageView`）: https://doc.qt.io/qt-6/qml-qtquick-pdf-pdfstyle.html

## 付録 B. 現行コードの参照箇所（設計判断の根拠）

- Markdown/KaTeX 表示: `paperdesk/gui/gui_widgets.py:236-332`
- 数式画像の PDF 埋め込み: `paperdesk/pdf/pdf_engine.py:267-295`
- 図表画像の切り出しと `file://` URI: `paperdesk/core/service.py:265-298`
- 引用リンク生成と横取り: `paperdesk/core/service.py:24-51`, `paperdesk/gui/gui.py:408-421`
- ページ描画と DPR: `paperdesk/pdf/pdf_viewer.py:75-96`, `paperdesk/gui/gui_window_viewer.py:106-152`
- ジョブと進捗の正規表現: `paperdesk/gui/gui.py:35,100-117,119-140`
- Windows 連携: `paperdesk/core/winintegration.py`, `paperdesk/gui/gui_window_base.py:70-119`
- 設定と永続化: `paperdesk/core/config.py`, `paperdesk/gui/gui_window_base.py:121-163`

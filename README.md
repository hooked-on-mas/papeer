# Papeer

英語の学術論文 PDF を日本語に翻訳し、原文と並べて読むための Windows 向けデスクトップアプリです。翻訳・解説・チャットには、ChatGPT（Codex CLI）、Claude Code CLI、Gemini（Antigravity CLI）、または OpenAI 互換 API を使います。

## 主な機能

| 機能 | 内容 |
| --- | --- |
| 日本語訳 | PDF からテキストを抽出して AI で翻訳し、原文と同じレイアウトの日本語 PDF を生成 |
| 数式・表・参考文献の保持 | 数式は元 PDF の描画を切り出して配置。表のセルと参考文献は原文のまま保持 |
| 再開 | 翻訳済みブロックをキャッシュし、中断・エラー後も続きから再開 |
| 処理の状況・エラー | ステータスバーから実行中の処理を一覧し、論文ごとに進み具合の確認と中止。表示していない論文のエラーは右下の通知とライブラリの印で知らせ、エラー画面に原因の要約と対処（設定を開く・再開・詳細をコピー）を表示。翻訳・解説・書き出し・バックアップ・同期の完了も右下の通知で知らせ、ステータスバーの一言は読める時間だけ表示して消える |
| 文字の大きさ | 設定「表示」で画面全体の文字とボタンを 90〜150% に拡大・縮小（PDF の表示倍率とは別） |
| 左右表示 | 原文と訳文を並べて表示。スクロールと倍率を同期。サマリー・チャット・メモを PDF の右に開ける（ツールバーのボタン。集中表示でも同じ）。ほかのタブから戻っても読んでいた位置のまま、論文を開き直すと前回のページのその位置から |
| 解説・チャット | 論文の解説記事を Markdown で生成（作り直すときは、今の解説を置き換える前に確認）。本文のページを引用して回答。PDF で選んだ箇所を添付して聞ける（右クリックの「説明してもらう」「チャットに添付」「メモに引用」は PDF の右に開き、添付をクリックで PDF のその箇所へ移動） |
| ライブラリ | 入れ子フォルダーでの整理、ドラッグ＆ドロップ、検索、Markdown メモ。Ctrl・Shift+クリックで複数の論文を選び、右クリックやドラッグでまとめて移動・タグ付け・読書状態の変更・削除 |
| 論文内検索・付箋・ハイライト | PDFの文章や図のそばに付箋を貼り、小さなダイアログでメモを入力。文章を選ぶと出るツールバーで色を付けてハイライト。「付箋」タブで一覧・検索・編集、p.N リンク付きでメモに書き出し |
| PDFの書き込み・編集 | ペン・蛍光ペン・図形・テキスト、範囲選択／投げ縄、移動・コピー・拡縮・回転、部分消しゴム、自動保存、書き込み付きPDFの保存 |
| 図・数式のコピー | PDFの範囲をPNG画像としてコピー、出典ページ付きで読書メモに追加 |
| 用語辞書・チャット範囲 | 論文ごとの訳語を指定。チャットの参照対象を現在の論文、選んだ論文、フォルダーから指定 |
| 書き出し | 日本語訳 PDF、原文と訳文の交互 PDF、左右対訳 PDF、Markdown、BibTeX（論文の右クリックでコピー、複数選択中は選んだ全論文。フォルダーの右クリックで .bib に保存）。BibTeX の掲載誌・DOI・arXiv ID は追加時に PDF から読み取り（インターネットでは調べない）、メモタブの論文情報で修正できる |
| 読書状態・タグ | 未読・読書中・読了・再読したいを管理（開いた論文は未読から読書中に）。自由な名前のタグを複数付け（名前を入力して新しいタグもその場で作成、右クリックからも）、ライブラリを絞り込み。出版年・筆頭著者・最近開いた順でも並べ替え |
| 読書メモのテンプレート | 標準の読書メモを挿入。見出しを自由に変更した自分用テンプレートを保存・編集 |
| 翻訳の確認・修正 | 要確認ページの一覧、段落の手動修正・AI修正案、変更前後の比較、PDFへの反映と取り消し |
| 共通用語辞書 | 全論文で共有。翻訳前に必要ならAIが訳語に迷う未登録語と訳語案を抽出し（任意）、過去の登録語と一緒に確認・修正して追加。JSONでエクスポート・読み込み可能 |
| 横断検索 | 論文情報・タグ・原文・訳文・メモを検索し、抜粋から該当ページへ移動。題名などの論文情報、メモ、該当ページの多い論文の順に表示 |
| バックアップ・復元 | 設定画面からライブラリ全体をZIPで保存・復元。復元前のデータは別フォルダーに保持。設定とプロンプトは、選んだときだけバックアップのものに戻す |

翻訳処理の詳細な挙動と制限は [docs/translation.md](docs/translation.md) を参照してください。OCR は試験中で既定では使わないため、文字情報のある PDF が対象です。

リーダー上部の「書き込み」で書き込みツールバーを開き、「ペン」で書き込めます（ツールバーは原文・日本語訳で共通で、最後にクリックした側に作用します）。「範囲」または投げ縄で書き込みを囲むと、移動・コピー・貼り付け・拡縮・回転ができます。「本文」に戻すとPDF本文を選択できます。書き込みは原文・日本語訳のページごとに自動保存され、再起動後も表示されます。「PDF保存」はその側の全ページを、書き込み入りの別PDFとして保存します。操作と保存形式は [docs/annotations.md](docs/annotations.md) を参照してください。

## 構成

```text
papeer/        翻訳・PDF 処理・ライブラリ管理のコア (Python)
  core/           設定、ストレージ、サービス層、プロンプト、フォント
  providers/      AI 接続（Codex / Claude Code / Antigravity / OpenAI 互換 API）。1 接続 1 モジュール
  layout/         読み順・数式・表・図・参考文献のレイアウト解析
  pdf/            PDF の抽出と生成 (PyMuPDF)
  translation/    翻訳バッチ処理とプレビュー
sidecar/          papeer を HTTP/WebSocket で公開する FastAPI サーバー
  routes/         API のルート。入力を解釈して papeer を呼ぶだけにし、処理の中身は papeer/core に置く
  schemas/        API のリクエスト・レスポンスのモデル（ルーターごと。ジョブの結果とイベントは job_types.py）
frontend/         デスクトップ UI (Tauri 2 + React 19 + Tailwind v4)
  src/            React アプリ
  tests/          node:test によるフロントエンドのテスト
  src-tauri/      Tauri (Rust)。本番では sidecar を子プロセスとして起動
tests/            pytest によるバックエンドのテスト
tools/            開発用スクリプト (翻訳レイアウトの検証・比較・反映、掃除、版の更新など)。exe には含めない
docs/             仕様ドキュメント
.github/          GitHub Actions (タグでインストーラーを作るリリース)
```

フロントエンドは sidecar の REST API と WebSocket でバックエンドと通信します。本番ビルドでは Tauri が空きポートと起動ごとの認証トークンを決め、PyInstaller で単一 exe 化した sidecar を起動します。翻訳・書き込み・同期などの仕様は [docs/](docs/) にあります。

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

### テストと lint

```bash
just test   # pytest、TypeScript の型チェック、フロントエンドのテスト (node:test)
just lint   # ruff, pyright, ESLint, tsc
```

静的チェックの範囲と約束は次のとおりです。

- ruff: `papeer`・`sidecar`・`tests`・`tools` に `ruff check` だけを使います（`pyproject.toml` の `[tool.ruff.lint]`）。E/F/W に加え、`except` 内の `raise` に原因を付ける B904、何でも受け止める `except Exception` を理由付きに限る BLE001・S110、ループ内で作った関数がループ変数を使う B023（`papeer`・`sidecar` のみ）を検査します。すべての例外を握りつぶすのが意図どおりの箇所（UI を止めない、後始末はベストエフォート、など）は `# noqa: BLE001 - 理由` と書きます。`ruff format` は全体には適用しません（手で揃えた書式を保ち、履歴を追いやすくするため）。
- pyright: `papeer` と `sidecar` を検査します（`[tool.pyright]`）。PyMuPDF・fontTools の型情報が実際と合わない行が多い 4 ファイル（`math_layout.py` 16 件、`table_layout.py` 13 件、`pdf_engine.py` 13 件、`pdf_fonts.py` 10 件。2026-09 時点）だけは対象外で、一覧と件数は `pyproject.toml` にあります。
- ESLint: React のフックの規則（`react-hooks/rules-of-hooks` と `react-hooks/exhaustive-deps`）だけを検査します（`frontend/eslint.config.js`、`pnpm lint`）。型は tsc が見ます。依存配列を足すと effect の走り方が変わる箇所は、理由を添えた `// eslint-disable-next-line react-hooks/exhaustive-deps -- 理由` にしています。

pytest は `tests/conftest.py` で `LOCALAPPDATA` と `PAPEER_DATA_DIR` をテストごとの一時フォルダーに向けます。実際のデータフォルダー（`%LOCALAPPDATA%\Papeer`、`PaperDesk`、`PapeerSync`）でファイルを開いたり書き込んだりすると、そのテストは失敗します。同梱フォントの変換結果（約30秒かけて作る）だけは `PAPEER_FONT_CACHE_DIR` で `.pytest_cache` 内に置き、次回以降の実行でも使い回します。

CI（`.github/workflows/ci.yml`）は push ごとに Windows で、`just lint`・`just test` と同じ検査に加えて `frontend/openapi.json` とライセンス台帳が最新か（`--check`）、`pnpm build`、Rust の `cargo fmt --check`・`cargo clippy --release --all-targets -- -D warnings`・`cargo test --release`（`lib.rs` の単体テスト）を実行します。同じリポジトリのブランチからの pull request は push したときの結果を使い、pull request として検査するのは fork からのものだけです。実際の AI は呼びません。

clippy は手元では `just clippy` で CI と同じように実行できます。sidecar の exe なしで通るよう、このコマンドの間だけ `TAURI_CONFIG` で `externalBin` を外します。PowerShell で直接実行するなら `$env:TAURI_CONFIG='{"bundle":{"externalBin":[]}}'; cargo clippy --release --all-targets -- -D warnings; Remove-Item Env:TAURI_CONFIG` のように、終わったら必ず外してください（付けたまま `just build` すると sidecar の入っていないインストーラーができます）。

### API の型

sidecar の API の形（ルートと、`sidecar/schemas/`・`sidecar/job_types.py` の Pydantic モデル）が、フロントエンドの型の元です。モデルやルートを変えたら `just gen-api` を実行し、次の 2 つを作り直してコミットします（食い違いは `tests/test_openapi_schema.py` が検出します）。

- `frontend/openapi.json`: `tools/export_openapi.py` が `app.openapi()` から書き出します（sidecar は `/openapi.json` を配信しません）。
- `frontend/src/api/schema.d.ts`: その JSON を openapi-typescript（`frontend/package.json` の `gen-api`）で変換したものです。`--default-non-nullable false` を付け、TypeScript の省略可能なキー（`?:`）はスキーマの `required` のとおりにします。既定値があっても必ず送る応答モデルは `json_schema_serialization_defaults_required=True`（`sidecar/job_types.py` の `Sent` など）で必須にします。

フロントエンドは `api.GET(...)` などの型付きクライアントを `unwrap()` で読みます（`frontend/src/api/client.ts`。失敗は `apiRequest` と同じ `ApiError`）。型の名前は `components["schemas"]["モデル名"]` で、`hooks.ts`・`jobTypes.ts` の型はその別名です。型なしの `apiRequest` が残るのは、ジョブのルートを文字列で受け取る `startJob`（`frontend/src/features/jobs/jobEvents.ts`）だけです。応答モデルのないルートは `unwrap(...) as 型` で読みます。

データを変えたときに読み直すクエリは `frontend/src/api/invalidation.ts` の対応表に一か所でまとめ、`frontend/src/api/mutations.ts` の `useMutation` フックと `invalidate()` がそれを使います（クエリキーは `frontend/src/lib/queryKeys.ts` の `QK` を通します）。`PATCH /api/papers/{id}` の後は論文そのものだけを読み直し、一覧の行は sidecar の `paper.changed` で更新します。

応答モデル（`response_model`）は、モデルにないキーを捨て、型の違う値を 500 にします。そのため、応答の形を変えずに付けること（`tests/test_response_models.py` でルートの返す値と比べています）。以前の版が書いたファイル（翻訳レポートなど）や外部のサービスから来る値は `Stored[...]`（`sidecar/schemas/common.py`）にして、形だけを型に書き、検証せずにそのまま返します。一覧の行のようにキーが欠けうる応答は `response_model_exclude_unset=True` で、渡されたキーだけを返します。

### データベースの変更

`library.sqlite3` の版は `PRAGMA user_version` で管理します。列・テーブル・索引の追加や保存値の変換は、`papeer/core/storage.py` の `MIGRATIONS` に関数を 1 つ追加して行います（約束事は同ファイルのコメント、テストは `tests/test_schema_migration.py`）。バックアップの `papeer-backup.json` と同期の世代の `revision.json` には `schema_version` と `app_version` を記録し、自分より新しい版のライブラリ・バックアップ・同期データは開かずに Papeer の更新を促します。新しい版で開いた（移行済みの）ライブラリのまま Papeer を古い版に戻すと、復元を含むすべての操作がこのエラーになるため、最新版を入れ直してください。

## ビルド

```bash
just build
```

次の処理を順に行います。

1. `code-version.txt`（抽出・PDF 生成コードの識別値）と、同梱ソースと依存関係の内容ハッシュを生成する
2. PyInstaller で `sidecar.spec` から `dist/sidecar-x86_64-pc-windows-msvc.exe` を作る
3. その exe を `just smoke-sidecar` と同じ手順で試す（次節）。失敗したらここで止まる
4. 試した exe を `frontend/src-tauri/` へコピーし、成功したら 1 の内容ハッシュを `sidecar-sources.txt` に記録する
5. `code-version.txt` と sidecar が現在のソースから作られたことを確かめ（`just check-sidecar`）、`pnpm tauri build` でインストーラーを作る

インストーラーは `frontend/src-tauri/target/release/bundle/` に出力されます。

PyInstaller は依存グループ `build` にあり、`just build-sidecar` が `uv run --group build` で使います。

### sidecar のスモークテスト

`just smoke-sidecar`（`tools/smoke_sidecar.py`）は、`just build-sidecar` で作った exe を Tauri と同じように乱数のトークンと空きポートで起動し、次を確かめます。PyInstaller の `hiddenimports`・`datas` の漏れ（同梱し忘れたモジュール・プロンプト・フォント）は、ここで起動や翻訳の失敗として見つかります。

1. `/health` が応答し、`version` がソースの版（`MAJOR.MINOR.PATCH`）、`code_version` がソースの抽出・PDF 生成コードの識別値（`code-version.txt` と同じ値）と一致する（版か抽出・PDF 生成のコードが変わった後に exe を作り直していなければ失敗する。それ以外のコードの変更はどちらの値にも表れないため、ここでは見つからない。同梱ソース全体の一致は `just check-sidecar` が確かめる）
2. トークンなし・誤ったトークンは 401、正しいトークン（`Authorization` ヘッダーと `token` クエリ）は 200 になる
3. 同梱のプロンプトが `papeer/core/prompts` と一致し、設定を保存できる
4. `tests/fixtures/sample.pdf` を取り込み、テキストを抽出・検索できる
5. その論文を翻訳し、同梱の日本語フォント（源ノ明朝）を埋め込んだ `translated.pdf` ができる。翻訳の依頼先は、スクリプトが `127.0.0.1` で動かす OpenAI 互換の代役サーバーで、実際の AI は呼ばず、PC の外にも通信しない。翻訳の指示に共通部分（`papeer/core/prompts/_*.txt`）が差し込まれていることも確かめる
6. `/shutdown` でプロセスが終了コード 0 で終わり、`_MEI*`（onefile の展開フォルダー）が残らない

データフォルダー・`LOCALAPPDATA`・`TEMP` は毎回新しい一時フォルダーに向けるため、実際のライブラリや PC ごとの設定には触れません（`_MEI*` もその中に作られ、終了後に残っていないかを正確に確かめられます）。失敗すると、失敗した確認と sidecar のログの末尾を表示して終了コード 1 で終わります。どの場合も sidecar は止め（応答しなければ強制終了）、一時フォルダーは消します。`--keep` で一時フォルダー（データとログ）を残し、`--source` で exe の代わりに `python -m sidecar` を同じ手順で試せます（`tests/test_smoke_sidecar.py` はこちらを使い、exe なしでスクリプト自体を検査します）。`just build-sidecar`（`just build` とリリースのワークフローも使う）は exe を作った直後にこのテストを実行し、通った exe だけを `frontend/src-tauri/` へコピーします。

`just clean` はリポジトリ直下の `build/`・`dist/`・`output/`・`tmp/` とその容量を一覧表示するだけで、`just clean yes` で削除します。それ以外のフォルダーは消しません。

## リリース

アプリの版は `MAJOR.MINOR.PATCH`（数字のみ）で、`pyproject.toml`・`papeer/__init__.py`・`frontend/package.json`・`frontend/src-tauri/tauri.conf.json`・`frontend/src-tauri/Cargo.toml` と、ロックファイル（`uv.lock`・`Cargo.lock`）の自パッケージの項目、`frontend/openapi.json` に同じ値を書きます。手で書き換えず `just bump` を使ってください（一致は `tests/test_version.py` で検査します）。`-beta` などの接尾辞は MSI が受け付けないため使えません。sidecar の `/health` は `version` にこの版を、`code_version` に抽出・PDF 生成コードの識別値（`code-version.txt` と同じ。翻訳キャッシュの識別には使わない）を返し、ステータスバーには前者を表示します。

1. 変更点を `CHANGELOG.md` の `[Unreleased]` に書く（日々の変更のたびに追記しておく。ブランチごとの追記は `.gitattributes` の `merge=union` で両方残るので、マージ後に重複と順序を確かめる）
2. `just bump 0.3.0` で全ファイルの版を書き換え、`[Unreleased]` の内容を `[0.3.0] - 日付` の節に移す（版を下げる・`[Unreleased]` が空のときは何も変更せずに止まる）
3. 差分を確認してコミットし、`git tag v0.3.0` を付けて、コミットとタグを push する

タグ `v*` の push で `.github/workflows/release.yml` が動き、windows-latest 上で `just build`（sidecar の exe を含む）を実行して、NSIS のセットアップ（`.exe`）と MSI を下書きの GitHub Release に添付します。リリースノートは `CHANGELOG.md` の該当する節です。タグと全ファイルの版が一致しないときはビルドしません。内容を確かめてから GitHub 上で下書きを公開してください。ビルドするジョブはリポジトリの読み取り権限だけで動き、Release を作る後続のジョブだけが書き込み権限を持ちます。依存のキャッシュは使わず、毎回まっさらな状態からビルドします。

MSI は Tauri が WiX Toolset v3 で作り、WiX v3 は Windows の VBScript（オプション機能）に依存します。GitHub のランナーや手元の PC で VBScript が無効・削除されていると MSI の作成に失敗するため、最初のリリースでは実機（または Actions の実行結果）で MSI と NSIS の両方ができ、インストールと起動ができることを確認してください。

このワークフローは自動で発行される `GITHUB_TOKEN` だけを使い、追加のシークレットは不要です。インストーラーはコード署名をしていないため、初回の実行時に Windows SmartScreen の警告が出ます（署名する場合は証明書をシークレットに登録し、`tauri.conf.json` の `bundle.windows` に署名の設定を加えます）。自動更新は未対応です。

## 依存ライブラリ

### ライセンス台帳

[docs/dependency-license-inventory.json](docs/dependency-license-inventory.json) に、ロックファイル（`uv.lock`・`frontend/pnpm-lock.yaml`・`frontend/src-tauri/Cargo.lock`）にあるすべての依存の版・宣言されたライセンス・本番/開発の区別と、同梱のフォント・PDFium などを記録しています。依存を追加・更新したら `just licenses`（`tools/license_inventory.py`）で作り直し、台帳もコミットしてください。

- ネットワークは使いません。依存関係はロックファイルから、ライセンスは手元にインストール済みの情報（`.venv` の METADATA、`frontend/node_modules` の `package.json`、`cargo metadata --offline` で読む Cargo のキャッシュ）から読みます。先に `just setup` を実行し、Rust の crate は一度ビルドするか `frontend/src-tauri` で `cargo fetch` を実行して取得しておいてください。対象が Windows x64 なので Windows で実行します。
- 台帳には元にしたロックファイルの sha256（`sourceFiles`）を記録します。直接依存もロックファイルに記録されるので、依存を変えればロックファイルが変わり、台帳を作り直すまで `tests/test_license_inventory.py` が失敗します（ツールの設定や scripts だけの変更では失敗しません）。`just licenses check` はこの一致だけを確かめます。
- 並列のブランチで台帳がマージ時に衝突したら、どちらか片方を採ってから `just licenses` で作り直してください。
- `just bump` は自パッケージの版しか変えないため、台帳が最新なら同時にハッシュを書き換えます（最新でなければ `just licenses` を促します）。
- 他の OS/CPU 向けの optional バイナリなど、手元にインストールされないパッケージのライセンスは `unknown` になります。Windows で使うパッケージに `unknown` がないことはテストで確かめます。

### 更新の通知（Dependabot）

`.github/dependabot.yml` で、uv・npm（pnpm）・Cargo・GitHub Actions（SHA で固定したアクション）の更新を毎週月曜にまとめて Pull Request にします。まとめ方は次のとおりで、どのグループにも入らない major の更新は 1 つずつ出ます。

| エコシステム | グループ |
| --- | --- |
| uv | `python`: すべての minor・patch |
| npm（pnpm） | `tauri`: `@tauri-apps/*`（major も含む）、`frontend-production`: 本番依存の minor・patch、`frontend-development`: 開発依存の minor・patch |
| Cargo | `tauri`: `tauri`・`tauri-*`（major も含む）、`rust`: すべての minor・patch |
| GitHub Actions | `actions`: すべて（major も含む） |

公開から 7 日たった版だけを提案します（脆弱性を直すセキュリティ更新はこの設定とは別で、GitHub のリポジトリ設定で有効にすると待たずに届きます）。Dependabot は台帳を作り直せないため、Pull Request のブランチで `just setup` と `just licenses` を実行して台帳をコミットしてください。tauri の crate と `@tauri-apps/*` は同じ minor にそろえる必要があるので、両方の「tauri」の Pull Request を一緒にマージします。

### 脆弱性の確認

```bash
just audit              # Python・JavaScript・Rust をすべて確認
just audit python rust  # 一部だけ確認
```

`tools/audit_dependencies.py` が次の 3 つを順に実行し、最後に結果をまとめます。すべて実行できて脆弱性がなければ終了コード 0、脆弱性が見つかった・実行に失敗した（ネットワークがないなど）・ツールがないときは 1 です。

| 対象 | ツール | 外部との通信 |
| --- | --- | --- |
| Python（`uv.lock` の全グループ） | `uv export` の結果を `uvx pip-audit@2.10.1` で確認（版は `tools/audit_dependencies.py` の `PIP_AUDIT` で固定し、初回に uv が自動で取得） | 各依存の名前と版を PyPI の JSON API に問い合わせる |
| JavaScript（`pnpm-lock.yaml`） | `pnpm audit` | 依存の名前と版の一覧を npm レジストリの監査 API に送る |
| Rust（`Cargo.lock`） | `cargo audit`（`cargo install cargo-audit --locked` で導入。無ければ導入方法を表示して、ほかの確認は続ける） | RustSec のアドバイザリ DB を取得して手元で照合する（取り下げ済みの版を調べるため、crates.io のインデックスから各 crate の情報も取得する） |

外部のアドバイザリ DB に送るのは依存の名前と版だけで、ライブラリ・論文・メモ・設定・API キーなどのユーザーデータは読みも送りもしません。Rust は他の OS 向けの crate も含めて `Cargo.lock` 全体を確認するため、Windows では使わない crate の指摘が出ることがあります。

mermaid が使う chevrotain は脆弱性のある `lodash-es` 4.17.23 に固定しているため、`frontend/pnpm-workspace.yaml` の `overrides` で 4.18.1 以上に上げています（pnpm 12 は `package.json` の `pnpm` フィールドを読みません）。chevrotain が `lodash-es` の固定を 4.18.1 以上に上げたら、この上書きを外してください。

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
3. `papeer/core/code_version.py` の `RENDER_EXCLUDED` に新しいファイルを追加する（`tests/test_code_version.py` が未分類のファイルを検出する）。

設定画面の選択肢と入力欄は `GET /api/providers` から作られるため、フロントエンドの変更は不要です。接続先ごとの設定のうち、最後に選んだモデルと effort はライブラリの `settings.json` の `provider_options` に、CLI のパスと API URL（`config.DEVICE_OPTION_KEYS`）は PC ごとの `%LOCALAPPDATA%\PapeerSync\device-settings.json` に保存されます。後者は同期・バックアップに含めず、別の PC から届いた `settings.json` や復元したバックアップに書かれていても使いません（以前の版の `settings.json` にあった値は、初回の読み込み時に一度だけ PC ごとの保存先へ移します）。モデル名は半角英数字と `. : / @ [ ] + - _` だけ（先頭の `-` は不可）を受け付けます。保存済みのモデル名が不正な場合は、接続先の既定のモデルを使います。`settings.json` にこの版が知らない項目（別の PC の新しい版の Papeer が書いたもの）があると、`GET /api/settings` の `unknown_keys` で返し、フロントエンドが起動時に知らせます（「今後表示しない」は PC ごとにブラウザーの保存領域に記憶します）。それらの項目はこの版では使わず、設定を保存すると消えます（sidecar のログに記録します。消えた状態は同期で新しい版の PC にも届きます）。

翻訳キャッシュはコードではなく接続先・モデル・プロンプト・原文で区別するため、`papeer/providers/` を編集しても既存の訳文は訳し直しません。依頼の送り方や応答の検証を変えて訳し直すべきときは、`papeer/translation/translation.py` の `TRANSLATION_PROTOCOL` を上げます（[翻訳](docs/translation.md#翻訳キャッシュの識別値)）。

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
    document.json             抽出結果（アプリだけが読むのでインデントなし）
    translated.pdf
    interleaved.pdf           原文と訳文の交互ページ（「原文・日本語訳（交互）を外部で開く」で作成し、訳文が変わるまで再利用）
    translation-pages/        翻訳途中のページ（翻訳の完了時と起動時に不要なものを削除）
    translation.md
    translation-cache.json    訳文と再翻訳の回数の記録（インデントなし）
    translation-report.json
    glossary.json               旧辞書の移行元（共通辞書はlibrary.sqlite3に保存）
    article.md                解説
    note.md                   メモ

Papeer-sync-backups/          フォルダー同期の選択で選ばなかったライブラリ（バックアップ形式のZIP、最新3件。同期・バックアップの対象外）

PapeerSync/                   このPCだけの設定（同期・バックアップの対象外）
  device-settings.json        CLI のパスと API URL
  <ハッシュ>.json             同期フォルダーの保存先と最終同期の基準
  <ハッシュ>.review-pages.json  論文ごとの翻訳が必要なページ（ライブラリ一覧と閲覧画面用。document.json とコードが変わると作り直す）
  <ハッシュ>.opened.json      このPCで論文を最後に開いた日時（ライブラリの「最近開いた順」と「続きから読む」用。消すと開いた記録がなくなるだけ）
  <ハッシュ>.search.sqlite3   横断検索用の全文索引（原文と訳文。大きさは本文の約1.6倍で、試験用の300本で約50MB。検索のたびに変わった論文だけ作り直し、
                              消しても作り直す。壊れていれば消して作り直す。データフォルダーを移した後に残る元の場所の索引は消してよく、
                              Papeer も起動後最初の検索で、ライブラリが見当たらない場所の索引を消す）
  font-cache/                 同梱フォントを TrueType に変換したもの（最初の翻訳で約30秒かけて作り、以後はページごとに必要な字だけ切り出す。消しても作り直す）
  logs/sidecar.log            想定外のエラーの記録（traceback。約1MB×3世代。要求のクエリ文字列・ヘッダー・設定は書かない）
```

## 環境変数

| 変数 | 用途 |
| --- | --- |
| `PAPEER_DATA_DIR` | データの保存先を変更する |
| `PAPEER_PORT` | sidecar の待ち受けポート（既定 8000） |
| `PAPEER_TOKEN` | sidecar の認証トークン。必須で、未設定なら sidecar は起動しない（本番は Tauri が起動ごとに生成、開発は `just dev-sidecar` が `dev_token` を設定） |
| `PAPEER_FONT_CACHE_DIR` | 同梱フォントの変換結果の置き場所（既定 `%LOCALAPPDATA%\PapeerSync\font-cache`。pytest は `.pytest_cache` 内を使う） |
| `PAPEER_DEV_NO_AUTH` | `1` のとき、`PAPEER_TOKEN` なしで認証なしの sidecar を起動する（開発専用。PyInstaller で作った sidecar では無視） |
| `PAPEER_API_KEY` | API 接続で使う API キーの初期値（未設定なら `OPENAI_API_KEY`、次に `GEMINI_API_KEY`） |

## キーボードショートカット

| キー | 操作 |
| --- | --- |
| `Ctrl+O` | PDF を追加 |
| `Ctrl+F` | 開いている論文を検索（閲覧画面以外ではライブラリを検索） |
| `Ctrl+Shift+F` | ライブラリを検索 |
| `Ctrl+L` | ライブラリの一覧へ移動（前にいた行、なければ閲覧中の論文） |
| `↑` / `↓`、`Home` / `End`（ライブラリの一覧） | 行を移動・最初・最後の行へ |
| `→` / `←`（ライブラリの一覧） | フォルダーを開く・閉じる。開いたフォルダーの `→` は最初の行へ、それ以外の `←` は親フォルダーへ |
| `Enter`・文字キー（ライブラリの一覧） | 論文を開く・フォルダーを追加先に選ぶ。文字キーは名前がその文字で始まる行へ |
| `Space`（ライブラリの一覧） | 論文を持ち上げ、`↑` / `↓` で移動先のフォルダーを選び、もう一度 `Space` で移動（`Esc` で取り消し）。選択中の論文はまとめて移動 |
| `Ctrl+クリック` / `Ctrl+Space`（ライブラリの一覧） | 論文を複数選択に加える・外す |
| `Shift+クリック` / `Shift+↑` / `Shift+↓`（ライブラリの一覧） | 基準の行からその行までの論文を選択（`Ctrl+Shift+クリック` で今の選択に追加） |
| `Ctrl+A` / `Esc`（ライブラリの一覧） | 見えている論文をすべて選択・複数選択を解除 |
| `Ctrl+G` | ページ番号を指定して移動 |
| `Ctrl+T` | 翻訳を開始 |
| `Ctrl+B` | サイドバーの表示切り替え |
| `←` / `→` | 前後のページへ移動 |
| `PageDown` / `Space`、`PageUp` / `Shift+Space` | 1 画面ずつ移動し、ページの末尾・先頭では次・前のページへ（ホイールも末尾・先頭でさらに回すと次・前のページへ） |
| `Home` / `End` | 最初・最後のページへ移動 |
| `Alt+←` / `Alt+→` | PDF 内リンク・目次・論文内検索で移動する前の場所に戻る・進む |
| `Enter` / `Shift+Enter`、`F3` / `Shift+F3` | 論文内検索の次・前の結果へ移動 |
| `F2` | フォルダー・論文の名前を変更（ライブラリの一覧ではカーソルのある行） |
| `Delete` | ライブラリの一覧でカーソルのあるフォルダー・論文を削除（確認あり） |
| `Ctrl+Shift+N` | フォルダーを作成 |
| `F11` | 集中表示 |
| `Ctrl+1`〜`Ctrl+5` | PDFを読む・サマリー・チャット・メモ・付箋のタブを開く（集中表示では Ctrl+2〜4 が PDF の右に開閉、Ctrl+1 が閉じる） |

## ライセンス

Papeer のコードは AGPL-3.0-or-later で提供します。ライセンス本文は [LICENSE](LICENSE) です。

同梱の源ノ明朝・源ノ角ゴシックは SIL Open Font License 1.1 です。出典は [papeer/core/assets/fonts/README.md](papeer/core/assets/fonts/README.md) を参照してください。PyMuPDF は AGPL または商用ライセンスで提供されています。その他の依存ライブラリはそれぞれのライセンスに従います。依存ごとのライセンスは[ライセンス台帳](docs/dependency-license-inventory.json)（「依存ライブラリ」を参照）にまとめています。

### 旧名称との互換性

環境変数は `PAPEER_*` を優先し、未設定なら旧 `PAPERDESK_*` も受け付けます。既存の辞書・バックアップ・`paperdesk://` 引用リンクも読み込めます。画面設定と手書きの未保存データは、新しい保存キーへ初回起動時に引き継ぎます。インストール済みアプリと WebView のデータを引き継ぐため、Tauri の内部識別子 `local.paperdesk` は維持しています。ソースのルートディレクトリ名は変更不要です。

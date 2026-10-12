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
| 左右表示 | 原文と訳文を並べて表示。スクロールと倍率を同期。サマリー・チャット・メモを PDF の右に開ける（通常表示ではツールバーの「右パネル」プルダウン、集中表示では個別のボタン）。ほかのタブから戻っても読んでいた位置のまま、論文を開き直すと前回のページのその位置から |
| 解説・チャット | 論文の解説記事を Markdown で生成（作り直すときは、今の解説を置き換える前に確認）。本文のページを引用して回答。PDF で選んだ箇所を添付して聞ける（右クリックの「説明してもらう」「チャットに添付」「メモに引用」は PDF の右に開き、添付をクリックで PDF のその箇所へ移動） |
| ライブラリ | 入れ子フォルダーでの整理、ドラッグ＆ドロップ、検索、Markdown メモ。Ctrl・Shift+クリックで複数の論文を選び、右クリックやドラッグでまとめて移動・タグ付け・読書状態の変更・削除 |
| AIでフォルダー分け | フォルダー・未分類・選んだ論文・追加直後の論文を AI が内容で振り分ける案を作り、除外・移動先の変更・新しいフォルダー名の修正・作り直しをしてから適用。1 回の操作として元に戻せる（PDF ファイルは動かさない。300 件まで。詳細は [docs/organize.md](docs/organize.md)） |
| コマンドライン | `papeer-cli` で PDF の取り込み・一覧・フォルダー操作・AI のフォルダー分け・翻訳・ジョブの確認をスクリプトから実行。Papeer のウィンドウが開いていればその sidecar に、なければヘッドレスの sidecar を自動で起動して接続（詳細は [docs/cli.md](docs/cli.md)） |
| 論文内検索・付箋・ハイライト | PDFの文章や図のそばに付箋を貼り、小さなダイアログでメモを入力。文章を選ぶと出るツールバーで色を付けてハイライト。「付箋」タブで一覧・検索・編集、p.N リンク付きでメモに書き出し |
| 手書きノート | A4・B5・A5・Letter・16:9の縦横、無地・横罫・方眼・ドット・コーネル、白・クリーム・ダークの用紙。ページ追加・複製・削除・並べ替えと自動保存。独立ノートや論文の専用ノートを作れます。独立した論文とノートは置き場所を変えずに多対多で紐づけられます（[使い方](docs/notebooks.md)） |
| PDFの書き込み・編集 | ペン・蛍光ペン・図形・テキスト、範囲選択／投げ縄、移動・コピー・拡縮・回転、部分消しゴム、自動保存、書き込み付きPDFの保存 |
| 図・数式のコピー | PDFの範囲をPNG画像としてコピー、出典ページ付きで読書メモに追加 |
| 用語辞書・チャット範囲 | 訳語を論文の文脈に合わせて自動で統一。読書中に気になる語を確認して一括置換し、この論文・今後の同じ分野の翻訳にも保存可能。学術・公的な日本語用例を出典付きでWeb調査。チャットの参照対象を現在の論文、選んだ論文、フォルダーから指定 |
| チャットのWeb検索 | 入力欄でWeb検索をON/OFF（既定はOFF、Codex CLI・Claude Code・Antigravityで利用可能）。本文とWebの根拠を分け、出典リンク・検索時の状態・関連文献を履歴に保存 |
| 参考文献の調査・取り込み | 文献の内容と入手先を調べ、抄録と本文のどちらを確認したかを表示。公開PDFの版・保存先を選んで取り込み、手元のPDFも選択可能。取り込み後のサマリー作成、元の論文との比較、論文マップへの復帰に対応 |
| 書き出し | 日本語訳 PDF、原文と訳文の交互 PDF、左右対訳 PDF、Markdown、BibTeX（論文の右クリックでコピー、複数選択中は選んだ全論文。フォルダーの右クリックで .bib に保存）。BibTeX の掲載誌・DOI・arXiv ID は追加時に PDF から読み取り（インターネットでは調べない）、「論文情報・整理」で修正できる |
| 読書状態・タグ | 未読・読書中・読了・再読したいを管理（開いた論文は未読から読書中に）。自由な名前のタグを複数付け（名前を入力して新しいタグもその場で作成、右クリックからも）、ライブラリを絞り込み。出版年・筆頭著者・最近開いた順でも並べ替え |
| メモと論文の整理 | 論文ごとに複数の Markdown メモを作成・名前変更・並べ替え・削除し、自動保存。見出しの色分け、リストの継続、検索・置換、プレビュー、.md の取り込みに対応。左の論文行を開くと持ち物を選べる。ヘッダーや右クリックの「論文情報・整理」でタグ・フォルダー・書誌情報を変更 |
| HTML 資料 | 論文や独立ノートに、自分で用意した .html（UTF-8）を資料として持たせ、CSS・埋め込み画像のまま読み取り専用で表示。右パネルの「メモ」「資料」で切り替え、「大きく開く」でメイン画面へ広げられる。名前変更・並べ替え・削除、.html のドロップ取り込みに対応。資料内のスクリプトは既定で止め、資料ごとに許可（この PC だけ・内容が変わると無効）。外部の通信・CDN は使えない。本文は横断検索と AI チャットの参照対象（[詳細](docs/html-documents.md)） |
| 読書メモのテンプレート | 標準の読書メモを挿入。見出しを自由に変更した自分用テンプレートを保存・編集 |
| 翻訳の確認・修正 | 要確認ページの一覧、段落の手動修正・AI修正案、変更前後の比較、PDFへの反映と取り消し |
| 専門用語辞書 | 分野辞書の語は原文の使われ方をAIが確認し、論文の意味に合う訳語だけを適用。新しい確認候補は定訳と論文独自の語を除外して最大5件。選んだ語だけを論文限定で保存し、選ばなかった候補は再提示しない。共用辞書は一括移動・改名・統合・AI分割案の確認と保存が可能。JSONでエクスポート・読み込み可能 |
| 横断検索 | 論文情報・タグ・原文・訳文を検索し、抜粋から該当ページへ移動。題名などの論文情報、該当ページの多い論文の順に表示。HTML 資料の本文も検索でき、クリックでその資料を開く（OCR 不要）。複数メモの本文検索には未対応 |
| 論文マップ | 「論文マップ」タブ（Ctrl+6）で直接引用・被引用・近い論文・先行研究・後続研究を探索。登録済みと未登録を同じ図・一覧に表示し、PDF閲覧・取り込み・比較につなげる |
| バックアップ・復元 | 設定画面からライブラリ全体をZIPで保存・復元。復元前のデータはこのPCの履歴に「戻す前」として保持。設定とプロンプトは、選んだときだけバックアップのものに戻す。フォルダー同期で残したこのPCの履歴（同期した時点・選ばなかった側）から、違いを見てその時点に戻すこともできる |

翻訳は「翻訳する…」からページを選んで開始できます。訳語や辞書の設定は任意で、「訳語を指定する（任意）」または「その他 → 訳語・辞書」から開きます。訳語画面では「訳語を追加」から原語と使いたい日本語訳を入力します。辞書の確認やAIの提案は必要なときに開きます。辞書のAI処理はボタンを押したときだけ実行します。

翻訳処理の詳細な挙動と制限は [docs/translation.md](docs/translation.md) を参照してください。スキャンした PDF や文字化けした PDF の「要OCR」のページは、OCR（試験中）で読むと翻訳できます。既定では、論文を追加したときに読むかを確かめます（「設定 → OCR」、[docs/translation.md](docs/translation.md#ocr試験中)）。

リーダー上部の「書き込み」で書き込みツールバーを開き、「ペン」で書き込めます（ツールバーは原文・日本語訳で共通で、最後にクリックした側に作用します）。「範囲」または投げ縄で書き込みを囲むと、移動・コピー・貼り付け・拡縮・回転ができます。「本文」に戻すとPDF本文を選択できます。書き込みは原文・日本語訳のページごとに自動保存され、再起動後も表示されます。「PDF保存」はその側の全ページを、書き込み入りの別PDFとして保存します。操作と保存形式は [docs/annotations.md](docs/annotations.md) を参照してください。

「論文マップ」はDOIからSemantic Scholarの参考文献一覧を取得し、CrossrefとPDFの参考文献欄で補います。API取得が成功してもPDFの抽出結果を照合し、欠落・文献番号・掲載ページと各文献の取得元を残します。識別子の不一致や曖昧なタイトルは自動統合しません。

論文マップの「構築時間の内訳」で、参考文献の取得、候補の照合、類似度の計算、保存にかかった時間と回数を確認できます。取得元ごとの通信・取得間隔の待機・同時処理の順番待ちと、画面での図の配置時間を分けて表示します。

引用のつながりが密なグループを色と輪郭で囲み、グループ同士と円の間隔を広げて表示します。初期表示は広い画面で30件、狭い画面で20件で、最大60件に変更できます。円の大きさは被引用数で変わり、取得元と未取得の扱いを凡例に示します。「論文情報の取得にAIを使う」がONなら、情報取得用の接続先・モデルでグループ名と共通点を生成し、根拠論文も確認できます。説明は7日間再利用し、待機・失敗時も図を使えます。

近い論文は、直接の参考文献をさらにたどり、複数の参考文献が共通して引用する文献を優先して発見します。共通参考文献・共引用も使い、タイトル・保存済み抄録の語句とSemantic Scholarのテーマ推薦は補助にします。起点以外の文献同士の引用も実線で結び、つながる文献を近くに配置します。実線の矢印は実際の引用、点線は類似・推薦を示します。「この論文を中心に見る」と「戻る」で未登録論文も探索できます。図は最大60件、一覧は全候補を検索でき、候補追加で既存の配置や表示位置はリセットしません。外部探索はSemantic Scholarを使い、独立設定（初期値ON）で制御して成功結果を7日間再利用します。設定には任意のSemantic Scholar APIキーを入力できます（終了時に破棄）。OpenAlexへの通信は行いません。概要補完は既存のAI設定に従います。操作と保存の仕様は [docs/web-research.md](docs/web-research.md) を参照してください。

## 構成

```text
papeer/        翻訳・PDF 処理・ライブラリ管理のコア (Python)
  core/           設定、ストレージ、サービス層、プロンプト、フォント
  providers/      AI 接続（Codex / Claude Code / Antigravity / OpenAI 互換 API）。1 接続 1 モジュール
  layout/         読み順・数式・表・図・参考文献のレイアウト解析
  pdf/            PDF の抽出と生成 (PyMuPDF)
  translation/    翻訳バッチ処理とプレビュー
  cli/            papeer-cli（コマンドライン）。標準ライブラリだけで sidecar に HTTP で接続する（docs/cli.md）
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

フロントエンドは sidecar の REST API と WebSocket でバックエンドと通信します。本番ビルドでは Tauri が空きポートと起動ごとの認証トークンを決め、PyInstaller でフォルダー形式（onedir）にまとめた sidecar を起動します。翻訳・書き込み・同期などの仕様は [docs/](docs/) にあります。

論文ごとの複数メモは「メモ」で切り替えます。左の論文行の矢印を開くと先頭5件を表示し、「ほか n件」から全件を選べます。.md は論文行かメモ欄へのドロップでも取り込めます。引用・付箋・切り抜きの追加先は選択中のメモです。従来のメモは初回に新形式へ変換し、以後は新形式だけを読み書きします。独立した PDF 論文と独立ノートは、フォルダーや持ち物を変えずに多対多で紐づけられます。論文（複数選択可）を左パネルの独立ノートへドラッグするか、右クリックから選びます。論文行とノート行には「↗n」で件数を表示し、開くと持ち物の次に紐づけ先を ↗ 付きの行で表示します（5件まで、残りは「ほか n件」から全件を選択）。↗ の行はそれ以上開かず、右クリックの「フォルダー内で表示」「紐づけを外す」を使えます。ノートの画面には折りたたみの関連論文、論文の詳細には関連ノートがあります。ノートを含む選択や専用ノートは紐づけられません。設定「表示」の「左パネルの紐づけ行を隠す」はこの PC だけの設定です。HTML 資料は右パネルの「資料」から取り込み、.html は論文行・メモ欄・資料欄へのドロップでも追加できます。資料は隔離して読み取り専用で表示し、スクリプトは資料ごとの許可がない限り動きません。資料の本文は HTML を静的に読んで取り出し（スクリプト・スタイル・隠した要素は含まず、実行も外部取得もしません）、横断検索と AI チャットの参照に使います。チャットでは資料を `[持ち主ID:html:資料ID]` の出典として PDF のページとは別に扱い、回答内のボタンからその資料を開けます。独立ノートでも資料があれば OCR なしでチャットを使えます（[docs/html-documents.md](docs/html-documents.md)）。項目ごとの操作は `frontend/src/lib/itemKinds.ts` の「できること」で決めます。保存先は「データの保存場所」、同期の件数は [docs/google-drive-sync.md](docs/google-drive-sync.md) を参照してください。

## 開発環境のセットアップ

Windows 11 x64 を対象にしています。macOS（13.3 以上、Apple Silicon・Intel）と Linux（Ubuntu 22.04 以降、x86_64 の `.deb`）向けのビルドと検査も CI で行っていますが、実機では確かめていません（「リリース」）。次のツールを用意してください。

- [uv](https://docs.astral.sh/uv/)（Python 3.12 は uv が自動で導入します）
- [Node.js](https://nodejs.org/) 22.18 以上と [pnpm](https://pnpm.io/)（フロントエンドのテストは Node が `.ts` を直接実行します）
- [Rust](https://www.rust-lang.org/tools/install) と [Tauri の前提条件](https://tauri.app/start/prerequisites/)
- [just](https://github.com/casey/just) 1.47 以上（`winget install Casey.Just`。レシピの環境変数を `[env(...)]` で付けるため）

```bash
just setup
```

### 開発時の起動

開発時は sidecar とフロントエンドを別々のターミナルで起動します。デバッグビルドの Tauri は sidecar を起動せず、`127.0.0.1:8000` に接続します。そのため `just dev-frontend` は `TAURI_CONFIG` で `bundle.resources` を外し、同梱用の sidecar のフォルダー（`frontend/src-tauri/sidecar`、`just build-sidecar` で作るもの）がなくても起動できます。

```bash
just dev-sidecar    # ターミナル 1: FastAPI サーバー (ポート 8000)
just dev-frontend   # ターミナル 2: Tauri + Vite
```

コマンドライン（`papeer-cli`）は `just cli <コマンド>`（例: `just cli status`、`just cli add paper.pdf --folder 試験`）でソースから実行できます。`just dev-sidecar` を動かしていれば（同じライブラリなら）その sidecar に、なければヘッドレスの sidecar を自動で起動して接続します。使い方は [docs/cli.md](docs/cli.md) を参照してください。

sidecar は `/health` 以外のすべての API と WebSocket に認証トークンを求め、`PAPEER_TOKEN` が未設定なら起動しません。`just dev-sidecar` は開発用の固定トークン `dev_token` で起動し、デバッグビルドの Tauri も同じ値をフロントエンドへ渡します。Tauri を使わずブラウザーで Vite を開く場合も、開発サーバーでは同じ値を既定で使います（別の値にするときは `VITE_PAPEER_TOKEN` を指定）。本番ビルドでは Tauri が起動ごとに OS の乱数生成器で 256 bit のトークンを作ります。API ドキュメント（`/docs`、`/openapi.json`）は配信しません。例外は HTML 資料の表示経路 `/html-view/<チケット>` だけで、起動トークンではなく資料1件・10分限りの読み取り専用チケットで開きます（[docs/html-documents.md](docs/html-documents.md)）。

### テストと lint

```bash
just test   # pytest、TypeScript の型チェック、フロントエンドのテスト (node:test)
just lint   # ruff, pyright, ESLint, tsc
uv run pytest -m slow   # 時間のかかる性質のテスト（フォルダー同期の乱数テストの種を増やしたもの、厳しい届き方）だけ
```

pytest は既定で `slow` の印のテストを外します（`pyproject.toml` の `addopts`。`just test` と CI も同じ）。フォルダー同期の新しい形式を変えたときは `uv run pytest -m slow` も実行してください。

静的チェックの範囲と約束は次のとおりです。

- ruff: `papeer`・`sidecar`・`tests`・`tools` に `ruff check` だけを使います（`pyproject.toml` の `[tool.ruff.lint]`）。E/F/W に加え、`except` 内の `raise` に原因を付ける B904、何でも受け止める `except Exception` を理由付きに限る BLE001・S110、ループ内で作った関数がループ変数を使う B023（`papeer`・`sidecar` のみ）を検査します。すべての例外を握りつぶすのが意図どおりの箇所（UI を止めない、後始末はベストエフォート、など）は `# noqa: BLE001 - 理由` と書きます。`ruff format` は全体には適用しません（手で揃えた書式を保ち、履歴を追いやすくするため）。
- pyright: `papeer` と `sidecar` を検査します（`[tool.pyright]`）。PyMuPDF・fontTools の型情報が実際と合わない行が多い 4 ファイル（`math_layout.py` 16 件、`table_layout.py` 13 件、`pdf_engine.py` 13 件、`pdf_fonts.py` 10 件。2026-09 時点）だけは対象外で、一覧と件数は `pyproject.toml` にあります。
- ESLint: React のフックの規則（`react-hooks/rules-of-hooks` と `react-hooks/exhaustive-deps`）だけを検査します（`frontend/eslint.config.js`、`pnpm lint`）。型は tsc が見ます。依存配列を足すと effect の走り方が変わる箇所は、理由を添えた `// eslint-disable-next-line react-hooks/exhaustive-deps -- 理由` にしています。

pytest は `tests/conftest.py` で `LOCALAPPDATA`・`XDG_DATA_HOME`・`XDG_STATE_HOME`・`XDG_CACHE_HOME`（Windows 以外では `HOME` も）と `PAPEER_DATA_DIR` をテストごとの一時フォルダーに向けます（`tests/_isolation.py` の `point_pc_folders`）。実際のデータフォルダー（`%LOCALAPPDATA%\Papeer`、`PaperDesk`、`PapeerSync`、macOS・Linux で同じ役目のフォルダー）でファイルを開いたり書き込んだりすると、そのテストは失敗します。同梱フォントの変換結果（約30秒かけて作る）だけは `PAPEER_FONT_CACHE_DIR` で `.pytest_cache` 内に置き、次回以降の実行でも使い回します。

CI（`.github/workflows/ci.yml`）は push ごとに Windows と Linux（ubuntu-22.04）で、`just lint`・`just test` と同じ検査に加えて `frontend/openapi.json` とライセンス台帳が最新か（`--check`）、Rust の `cargo fmt --check`・`cargo clippy --release --all-targets -- -D warnings`・`cargo test --release`（`lib.rs`・`sidecar.rs` の単体テスト）を実行します。フロントエンドの検査（tsc・ESLint・node:test・`pnpm build`）は OS に依存しないため Windows だけで行います。同じリポジトリのブランチからの pull request は push したときの結果を使い、pull request として検査するのは fork からのものだけです。実際の AI は呼びません。

GitHub の Actions の画面から手動で実行（Run workflow）すると、macOS（Apple Silicon）での同じ検査と、各 OS で sidecar を `just build-sidecar` で作ってスモークテストし、`sidecar.rs` の `#[ignore]` のテスト（作った sidecar をアプリと同じように起動し、`/shutdown` と、標準入力のパイプが閉じたときに自分で終わること）を通すジョブ、Linux と macOS のライセンス台帳を作るジョブ（`licenses`。「依存ライブラリ」）も選べます。非公開のリポジトリでは Actions の実行時間が無料枠から引かれ、Linux の 1 分は 1 分、Windows は 2 分、macOS は 10 分として数えられるため、macOS と sidecar のビルドは push では動かしません。

### E2E テスト

```bash
just e2e              # すべてのシナリオ（例: just e2e library で名前に library を含むファイルだけ、just e2e --repeat 3 で 3 回続けて）
```

実際のアプリの画面（デバッグ版の `papeer.exe` と WebView2）を、playwright-core の `connectOverCDP` で操作して確かめます（`frontend/e2e`、node:test）。Windows 11 と WebView2 ランタイムが前提で、所要時間は約 5 分です（シナリオごとにライブラリ・sidecar・アプリを起動し直すため、1 本あたり 15〜40 秒。初回だけ、同梱フォントの変換に約 30 秒余計にかかります。変換結果は pytest と同じ `.pytest_cache` 内に置いて使い回します）。`just e2e` はまず `cargo build`（デバッグ版。変更がなければすぐ終わる）を行い、次に `frontend/e2e/run.ts` が共通の準備をして、シナリオごとに新しいライブラリ・sidecar・アプリを起動します。この `cargo build` は sidecar のフォルダーなしで通るよう `just clippy` と同じく `TAURI_CONFIG` で `bundle.resources` を外します（`just dev-frontend` も同じ設定なので、交互に使っても作り直しません）。

- デバッグ版のアプリは sidecar を `127.0.0.1:8000`、画面を Vite の `1420` から読むため、`just dev-sidecar`・`just dev-frontend` を止めてから実行します（使われていれば始める前に止まります）。CDP のポートは毎回空いているものを選びます。
- 実際のデータには触れません。守り方は次の 3 段です。
  - 予防（アプリ側）: Tauri は `LOCALAPPDATA`・`APPDATA`・`USERPROFILE` などの環境変数を見ず、Windows の既知フォルダー（`%LOCALAPPDATA%\local.paperdesk` の WebView2 のプロファイル、`%APPDATA%\local.paperdesk\.window-state.json` のウィンドウの位置）を直接使います。そこでデバッグ版に限り、環境変数 `PAPEER_E2E_DIR` があれば、メインウィンドウの WebView2 のプロファイルをそのフォルダーに作り、ウィンドウの位置を覚えるプラグイン（window-state）を登録しません（`frontend/src-tauri/src/lib.rs`。リリース版にはこの分岐自体が入りません）。E2E はこれに実行ごとの一時フォルダーを渡すので、アプリは実際の `local.paperdesk` を読みも書きもしません。
  - 隔離（環境変数）: ライブラリ（`PAPEER_DATA_DIR`）、`LOCALAPPDATA`・`APPDATA`・`TEMP`/`TMP`、`WEBVIEW2_USER_DATA_FOLDER`、sidecar のホームフォルダー（`USERPROFILE`・`CODEX_HOME`）はすべて実行ごとの一時フォルダーに向け、終われば消します。アプリ本体だけは `USERPROFILE` を変えません（変えると WebView2 がデバッグ用のポートを開かないためです。Tauri はホームフォルダーを使わず、アプリ自身もそこのファイルを読みません）。
  - 検出（二重の守り）: 起動直後に WebView2 のプロセスのコマンドラインの `--user-data-dir` が一時フォルダーの中かを確かめ、違えばすぐにアプリを止めて失敗にします。起動ごとに、既知フォルダーの `local.paperdesk` の `.window-state.json` と `EBWebView\Local State` の更新時刻を比べ、変わっていれば失敗にします（テストの間に本物の Papeer を使うと、これで失敗することがあります）。アプリは必ず強制終了で止め、アプリが自分で終了する IPC（`plugin:process|exit` など）もテスト側で受け止めます。
- 後始末: シナリオの終わりに、その一時フォルダーを名指しするプロセス（WebView2 など）がなくなるまで待ちます（20 秒を超えると残っているプロセスを表示し、180 秒を超えると失敗。強制終了した WebView2 の親プロセスは、PC が混んでいると 1 分以上残ることがあります）。次のシナリオも、前のシナリオのプロセスがなくなってから起動します。実行の最後には、この実行で起動したアプリ・sidecar・代役 API とその子プロセスを止めます。中断などで前回の実行の残り（`%TEMP%\papeer-e2e-*` を名指しするプロセスと、そのフォルダー）があれば、次の実行の始めに片付けます。
- 実際の AI は呼びません。翻訳と用語抽出は `tools/e2e_stub_ai.py`（`tools/smoke_sidecar.py` と同じ代役 API）が `127.0.0.1` で答えます。PATH から claude・codex・agy のあるフォルダーを外し、API キーの環境変数も消します。
- 論文は `tools/e2e_pdfs.py` が PyMuPDF で作る 2 段組の PDF（と `tests/fixtures/sample.pdf`）を、シナリオごとに API で取り込みます。
- 失敗したシナリオの画面・ページのコンソールのエラー・sidecar とアプリのログの末尾は `tmp/e2e-results/` に残ります。
- CI では実行しません（Windows の実機の画面が要り、時間もかかるため）。UI を変えたときや、リリースの前に手元で実行してください。

シナリオ（`frontend/e2e/tests`）は、起動とライブラリの表示、右クリックでのタグの付け外し（本文付きのリクエストと論文ごとの順番待ち）、フォルダーへの移動で行がすぐ移ること、行の多いライブラリで見えている行だけを描き End で画面外の最後の論文へ移って開けること、文字の大きさ 150% で 200 行の境目を越えても画面より上で行が移っても見ている行が動かず行のボタンのフォーカスも残ること、付箋の作成・編集でダイアログがすぐ閉じること、986px の窓で右パネルを開いてもページの右が欠けないこと、拡大表示で右パネルを開け閉めしても読む位置が保たれること、sidecar を止めても同期の失敗が出ず接続切れのバナーが題名に重ならないこと、代役 API での翻訳と訳文 PDF、用語抽出を閉じて開き直したときの引き継ぎ、設定の版の違いの通知と「今後表示しない」、× で閉じたときの保存できない入力の確認です。待ち合わせは画面や API の状態を待つ形にし、固定の待ち時間は「出ないこと」を確かめる短い間だけに使います。「すぐ閉じる」「すぐ移る」の時間は、CDP でのやり取りの遅れが入らないよう、ページの中の時計（クリック・通信の応答から画面が変わるまで）で測ります。

clippy は手元では `just clippy` で CI と同じように実行できます。tauri-build はビルドのたびに `bundle.resources` の sidecar のフォルダー（`frontend/src-tauri/sidecar`）を写すため、フォルダーなしで通るよう、このコマンドの間だけ `TAURI_CONFIG` で `bundle.resources` を外します。PowerShell で直接実行するなら `$env:TAURI_CONFIG='{"bundle":{"resources":[]}}'; cargo clippy --release --all-targets -- -D warnings; Remove-Item Env:TAURI_CONFIG` のように、終わったら必ず外してください（付けたまま `just build` すると sidecar の入っていないインストーラーができます）。`just build-sidecar` の後なら、外さなくても通ります。

### API の型

sidecar の API の形（ルートと、`sidecar/schemas/`・`sidecar/job_types.py` の Pydantic モデル）が、フロントエンドの型の元です。モデルやルートを変えたら `just gen-api` を実行し、次の 2 つを作り直してコミットします（食い違いは `tests/test_openapi_schema.py` が検出します）。

- `frontend/openapi.json`: `tools/export_openapi.py` が `app.openapi()` から書き出します（sidecar は `/openapi.json` を配信しません）。
- `frontend/src/api/schema.d.ts`: その JSON を openapi-typescript（`frontend/package.json` の `gen-api`）で変換したものです。`--default-non-nullable false` を付け、TypeScript の省略可能なキー（`?:`）はスキーマの `required` のとおりにします。既定値があっても必ず送る応答モデルは `json_schema_serialization_defaults_required=True`（`sidecar/job_types.py` の `Sent` など）で必須にします。

フロントエンドは `api.GET(...)` などの型付きクライアントを `unwrap()` で読みます（`frontend/src/api/client.ts`。失敗は `apiRequest` と同じ `ApiError`）。型の名前は `components["schemas"]["モデル名"]` で、`hooks.ts`・`jobTypes.ts` の型はその別名です。型なしの `apiRequest` が残るのは、ジョブのルートを文字列で受け取る `startJob`（`frontend/src/features/jobs/jobEvents.ts`）だけです。応答モデルのないルートは `unwrap(...) as 型` で読みます。

データを変えたときに読み直すクエリは `frontend/src/api/invalidation.ts` の対応表に一か所でまとめ、`frontend/src/api/mutations.ts` の `useMutation` フックと `invalidate()` がそれを使います（クエリキーは `frontend/src/lib/queryKeys.ts` の `QK` を通します）。`PATCH /api/papers/{id}` の後は論文そのものだけを読み直し、一覧の行は sidecar の `paper.changed` で更新します。

応答モデル（`response_model`）は、モデルにないキーを捨て、型の違う値を 500 にします。そのため、応答の形を変えずに付けること（`tests/test_response_models.py` でルートの返す値と比べています）。以前の版が書いたファイル（翻訳レポートなど）や外部のサービスから来る値は `Stored[...]`（`sidecar/schemas/common.py`）にして、形だけを型に書き、検証せずにそのまま返します。一覧の行のようにキーが欠けうる応答は `response_model_exclude_unset=True` で、渡されたキーだけを返します。

### データベースの変更

`library.sqlite3` の版は `PRAGMA user_version` で管理します。列・テーブル・索引の追加や保存値の変換は、関数を `papeer/core/library_schema.py` に書き、`papeer/core/storage.py` の `MIGRATIONS` に加えて行います（約束事は `storage.py` の `MIGRATIONS` の上のコメント、テストは `tests/test_schema_migration.py`）。バックアップの `papeer-backup.json` と同期の世代の `revision.json` には `schema_version` と `app_version` を記録し、自分より新しい版のライブラリ・バックアップ・同期データは開かずに Papeer の更新を促します。新しい版で開いた（移行済みの）ライブラリのまま Papeer を古い版に戻すと、復元を含むすべての操作がこのエラーになるため、最新版を入れ直してください。

## ビルド

```bash
just build
```

次の処理を順に行います。

1. `code-version.txt`（抽出・PDF 生成コードの識別値）と、同梱ソースと依存関係の内容ハッシュを生成する
2. PyInstaller で `sidecar.spec` から sidecar をフォルダー形式（onedir）で作る。`dist/sidecar/` に起動用の `papeer-sidecar.exe`（macOS・Linux では `papeer-sidecar`）、コマンドラインの `papeer-cli.exe`（同じく `papeer-cli`）、Python・ライブラリ・同梱データの入った `_internal/`（2 つの exe で共有）ができる。`papeer-cli` は標準ライブラリだけで動く小さな exe で、重いライブラリと同梱データ（プロンプト・フォント）は持たない。`papeer.exe`（アプリ本体）とは別の名前にしている
3. macOS では、その中の Mach-O ファイル（2 つの起動用のプログラムと、Python・拡張モジュール・`.dylib`）すべてに ad-hoc 署名して確かめる（`tools/sign_sidecar.py`。ほかの OS では何もしない）
4. そのフォルダーを `just smoke-sidecar` と同じ手順で試す（次節）。失敗したらここで止まる
5. 試したフォルダーを `frontend/src-tauri/sidecar/` に置き（`tools/place_sidecar.py`。隣にコピーしてから名前の変更で入れ替えるので、途中で失敗しても中途半端なフォルダーは残らない）、成功したら 1 の内容ハッシュを `sidecar-sources.txt` に記録する
6. `code-version.txt` と sidecar が現在のソースから作られたこと（と `frontend/src-tauri/sidecar/papeer-sidecar(.exe)`・`papeer-cli(.exe)` があること）を確かめ（`just check-sidecar`）、`pnpm tauri build` でインストーラーを作る（Windows は NSIS と MSI、macOS は `.app` と `.dmg`（`tauri.macos.conf.json`）、Linux は `.deb`（`tauri.linux.conf.json`））

インストーラーは `frontend/src-tauri/target/release/bundle/` に出力されます。sidecar のフォルダーは `tauri.conf.json` の `bundle.resources` でそのまま同梱され、インストール先では `papeer.exe` の隣の `sidecar\` に入ります。アプリはリソースフォルダーの中の `sidecar\papeer-sidecar.exe` を起動し（`frontend/src-tauri/src/sidecar.rs`）、ジョブオブジェクトに入れて、終了時は `/shutdown` で自分で終わるのを待ちます（30 秒で終わらなければジョブごと止める）。以前の onefile の exe と違い、起動のたびに `%TEMP%\_MEI*` へ展開しないため、起動が速く、強制終了しても何も残りません。

アプリがどう終わっても（異常終了・強制終了を含む）sidecar と、それが動かしている CLI が残らないよう、次を組み合わせています（`sidecar.rs`）。

- どの OS でも、sidecar の標準入力はアプリが何も書き込まないパイプで、アプリのプロセスが終わると閉じます。アプリは `PAPEER_WATCH_STDIN=1` を付けて起動し、sidecar はパイプが閉じたら `/shutdown` と同じようにジョブ（と CLI）を止めて終わります（`sidecar/routes/system.py` の `watch_stdin`）。
- Windows では、上のジョブオブジェクトがアプリの終了と一緒に sidecar と CLI を止めます。
- macOS・Linux では、sidecar を専用のプロセスグループで起動し、`/shutdown` で終わらなければグループに SIGTERM を、15 秒たっても残っていれば SIGKILL を送ります。AI の CLI は、sidecar がそれぞれを止められるように別のセッションで動かしているため、このグループには入っていません。sidecar は動いている CLI を覚えておき、SIGTERM を受けたとき・標準入力のパイプが閉じたときは、ジョブを取り消してすぐ、それぞれのグループに SIGTERM を、2 秒後に SIGKILL を送ってから終わります（終了する直前にも、残っている CLI を止めます）。Linux では、アプリのプロセスが終わると sidecar に SIGTERM が届くようにもしています（`PR_SET_PDEATHSIG`）。
- macOS・Linux では、Finder や Dock から開いたアプリの PATH は最小限（`/usr/bin:/bin:/usr/sbin:/sbin`）なので、ログインシェル（`$SHELL`、なければユーザーの設定のシェル）から PATH を読み、先頭に足して sidecar を起動します。読むのはアプリの起動の初めから別のスレッドで行い、5 秒で答えなければ使いません。端末から起動したときは読みません。絶対パスの項目だけを使います。

NSIS のインストーラーは、ファイルを置く前にインストール先の古い `sidecar\` と 0.2.0 以前の `sidecar.exe` を消します（`frontend/src-tauri/windows/hooks.nsh`）。ただし Papeer か sidecar、`papeer-cli.exe` が動いている間は `sidecar\` を消しません（このフックはアプリを閉じるよう求める確認より前に動くため、そこで取り消されても起動できなくならないように）。MSI は置き換える版のファイルを自分で消します。インストーラーは PATH を編集しません（長い PATH を切らないため）。`papeer-cli` を名前だけで呼べるようにするには、インストール後に `papeer-cli setup-path` を実行します（macOS・Linux ではシンボリックリンクの作り方を表示します。[docs/cli.md](docs/cli.md)）。

`target/release/papeer.exe` をインストールせずにそのまま起動するときは、`target/release/sidecar/` を使います。tauri-build はビルドのたびにこのフォルダーへ上書きでコピーするだけなので、前のビルドにしかないファイルが残ることがあります。おかしいときは `target/release/sidecar/` を消してからビルドし直してください（インストーラーには `frontend/src-tauri/sidecar/` の中身だけが入ります）。

PyInstaller は依存グループ `build` にあり、`just build-sidecar` が `uv run --group build` で使います。

### sidecar のスモークテスト

`just smoke-sidecar`（`tools/smoke_sidecar.py`）は、`just build-sidecar` で作った `dist/sidecar/papeer-sidecar(.exe)` を Tauri と同じように乱数のトークンと空きポートで起動し、次を確かめます。PyInstaller の `hiddenimports`・`datas` の漏れ（同梱し忘れたモジュール・プロンプト・フォント）は、ここで起動や翻訳の失敗として見つかります。

1. `/health` が応答し、`version` がソースの版（`MAJOR.MINOR.PATCH`）、`code_version` がソースの抽出・PDF 生成コードの識別値（`code-version.txt` と同じ値）と一致する（版か抽出・PDF 生成のコードが変わった後に exe を作り直していなければ失敗する。それ以外のコードの変更はどちらの値にも表れないため、ここでは見つからない。同梱ソース全体の一致は `just check-sidecar` が確かめる）
2. トークンなし・誤ったトークンは 401、正しいトークン（`Authorization` ヘッダーと `token` クエリ）は 200 になる
3. 同梱のプロンプトが `papeer/core/prompts` と一致し、設定を保存できる
4. `tests/fixtures/sample.pdf` を取り込み、テキストを抽出・検索できる
5. その論文を翻訳し、同梱の日本語フォント（源ノ明朝）を埋め込んだ `translated.pdf` ができる。翻訳の依頼先は、スクリプトが `127.0.0.1` で動かす OpenAI 互換の代役サーバーで、実際の AI は呼ばず、PC の外にも通信しない。翻訳の指示に共通部分（`papeer/core/prompts/_*.txt`）が差し込まれていることも確かめる
6. 同じフォルダーの `papeer-cli(.exe)` を、`--url` と環境変数 `PAPEER_TOKEN` でこの sidecar に接続して実行し、`--json status`・`folder list`・`ls` が手順 4 で取り込んだ論文と合った結果を返す（`--source` では `python -m papeer.cli`。ヘッドレスの sidecar は起動しない）
7. `/shutdown` でプロセスが終了コード 0 で終わる。起動してから終わるまで、一時フォルダーに `_MEI*`（onefile の展開フォルダー）が作られない（作られたら onefile の exe を試している）
8. アプリと同じように（`PAPEER_WATCH_STDIN=1`、標準入力をパイプにして）起動し直し、パイプを閉じると（アプリが異常終了したときと同じ）終了コード 0 で終わる
9. macOS・Linux では、もう一度起動し直し、SIGTERM で終了コード 0 で終わる

データフォルダー、この PC のフォルダーの元になる変数（Windows の `LOCALAPPDATA`、macOS・Linux の `HOME` と `XDG_DATA_HOME`・`XDG_STATE_HOME`・`XDG_CACHE_HOME`・`XDG_CONFIG_HOME`）、一時フォルダー（`TEMP`・`TMP`・`TMPDIR`）は毎回新しい一時フォルダーに向けるため、実際のライブラリや PC ごとの設定には触れません（一時フォルダーに何も展開されないことも、そこで正確に確かめられます）。PC ごとの設定が保存される場所は、`papeer.core.paths.device_directory()` と同じ規則で確かめます。失敗すると、失敗した確認と sidecar のログの末尾を表示して終了コード 1 で終わります。どの場合も sidecar は止め（応答しなければ強制終了）、一時フォルダーは消します。`--keep` で一時フォルダー（データとログ）を残し、`--exe` で別の場所の exe（インストーラーを展開したフォルダーの `sidecar\papeer-sidecar.exe` など）を、`--source` で exe の代わりに `python -m sidecar` を同じ手順で試せます（`tests/test_smoke_sidecar.py` はこちらを使い、exe なしでスクリプト自体を検査します）。`just build-sidecar`（`just build` とリリースのワークフローも使う）は sidecar を作った直後にこのテストを実行し、通ったフォルダーだけを `frontend/src-tauri/sidecar/` に置きます。

`just clean` はリポジトリ直下の `build/`・`dist/`・`output/`・`tmp/` とその容量を一覧表示するだけで、`just clean yes` で削除します。それ以外のフォルダーは消しません。

## リリース

アプリの版は `MAJOR.MINOR.PATCH`（数字のみ）で、`pyproject.toml`・`papeer/__init__.py`・`frontend/package.json`・`frontend/src-tauri/tauri.conf.json`・`frontend/src-tauri/Cargo.toml` と、ロックファイル（`uv.lock`・`Cargo.lock`）の自パッケージの項目、`frontend/openapi.json` に同じ値を書きます。手で書き換えず `just bump` を使ってください（一致は `tests/test_version.py` で検査します）。`-beta` などの接尾辞は MSI が受け付けないため使えません。sidecar の `/health` は `version` にこの版を、`code_version` に抽出・PDF 生成コードの識別値（`code-version.txt` と同じ。翻訳キャッシュの識別には使わない）を返し、ステータスバーには前者を表示します。

1. 変更点を `CHANGELOG.md` の `[Unreleased]` に書く（日々の変更のたびに追記しておく。ブランチごとの追記は `.gitattributes` の `merge=union` で両方残るので、マージ後に重複と順序を確かめる）
2. `just bump 0.3.0` で全ファイルの版を書き換え、`[Unreleased]` の内容を `[0.3.0] - 日付` の節に移す（版を下げる・`[Unreleased]` が空のときは何も変更せずに止まる）
3. 差分を確認してコミットし、`git tag v0.3.0` を付けて、コミットとタグを push する

タグ `v*` の push で `.github/workflows/release.yml` が動き、OS ごとのランナーで `just build`（sidecar を含む）を実行して、次のインストーラーを下書きの GitHub Release に添付します。

| OS | ランナー | インストーラー |
| --- | --- | --- |
| Windows x64 | windows-latest | NSIS のセットアップ（`.exe`）と MSI |
| macOS（Apple Silicon） | macos-latest | `Papeer_<版>_aarch64.dmg` |
| macOS（Intel） | macos-15-intel | `Papeer_<版>_x64.dmg` |
| Linux x64 | ubuntu-22.04 | `Papeer_<版>_amd64.deb`（glibc 2.35 でビルドするので Ubuntu 22.04・Debian 12 以降） |

PyInstaller は両方のアーキテクチャを含む sidecar（universal2）を作れないため、Mac は 2 つのディスクイメージに分けています。リリースノートは `CHANGELOG.md` の該当する節です。タグと全ファイルの版が一致しないときはビルドしません。内容を確かめてから GitHub 上で下書きを公開してください。ビルドするジョブはリポジトリの読み取り権限だけで動き、Release を作る後続のジョブだけが書き込み権限を持ちます。依存のキャッシュは使わず、毎回まっさらな状態からビルドします。

MSI は Tauri が WiX Toolset v3 で作り、WiX v3 は Windows の VBScript（オプション機能）に依存します。GitHub のランナーや手元の PC で VBScript が無効・削除されていると MSI の作成に失敗するため、最初のリリースでは実機（または Actions の実行結果）で MSI と NSIS の両方ができ、インストールと起動ができることを確認してください。

このワークフローは自動で発行される `GITHUB_TOKEN` だけを使い、追加のシークレットは不要です。インストーラーはコード署名をしていないため、初回の実行時に Windows SmartScreen の警告が出ます（署名する場合は証明書をシークレットに登録し、`tauri.conf.json` の `bundle.windows` に署名の設定を加えます）。自動更新は未対応です。

Actions の画面から手動で実行（Run workflow）すると、選んだブランチのインストーラーを同じ手順で作り、Release は作らずに実行結果の成果物（Artifacts）として残します。タグを付ける前の試しに使えます。

非公開のリポジトリでは、Actions の実行時間が無料枠から引かれます（Linux の 1 分は 1 分、Windows は 2 分、macOS は 10 分として数える）。見積もりは次のとおりです（実測ではありません）。

- CI の push 1 回：Windows の 2 倍を中心に、約 60〜80 分相当
- リリース（タグ 1 回、または手動の試し 1 回）：Mac 2 つのビルドの 10 倍が大半で、約 750〜1100 分相当

Intel の Mac の `macos-15-intel` は、GitHub が用意する最後の Intel のイメージです。提供が終わったら、Intel 版の行を外すか、Apple Silicon のランナーで Rosetta を使って作る方法に切り替えます。

### macOS・Linux 版

Apple の開発者登録をしていないため、Mac 版は Developer ID で署名しておらず、公証（notarization）もしていません。アプリ全体（`tauri.macos.conf.json` の `signingIdentity: "-"`）と、同梱の sidecar の中のプログラムとライブラリ一つひとつ（`tools/sign_sidecar.py`）に ad-hoc 署名だけをしています（Apple Silicon は署名のないプログラムを実行しないため）。リリースのワークフローは `codesign --verify` でこれを確かめます。動作の条件は macOS 13.3 以上（Safari を 16.4 以上に更新した 13.x を含む。PDF の表示に使う pdf.js の legacy 版が Safari 16.4 の WebKit を必要とするため）です（`tauri.macos.conf.json` の `minimumSystemVersion` は 13.0）。初めて開くときは次の手順が必要です。

1. ディスクイメージから「アプリケーション」フォルダーにコピーする（ダウンロードフォルダーのまま開くと、読み取り専用の仮の場所から動いてしまう）
2. 開くと「“Papeer”は開いていません」と出るので「完了」を押し、「システム設定」→「プライバシーとセキュリティ」の下にある「このまま開く」を押す
3. 「壊れているため開けません」と出る場合は、ターミナルで `xattr -dr com.apple.quarantine /Applications/Papeer.app` を実行してから開く

ad-hoc 署名は版ごとに変わるため、更新するたびに書類フォルダーなどへのアクセスの許可を聞き直されることがあります。

Mac 版で保存・確認・同期を通して終わるのは、⌘Q とメニュー、ウィンドウを閉じる操作です。Dock の「終了」とログアウト、Apple Event による終了は、その処理を通らずにすぐ終わります。ライブラリへの書き込みは sidecar の終了処理で守られます。

Mac 版はメニューバーにアプリのメニュー（「Papeer」「編集」「ウインドウ」）と、白黒のアイコンを出します。アイコンは左クリックでウィンドウの表示・非表示、右クリックでメニューです（キーの違いは「キーボードショートカット」）。

Linux 版は `.deb` だけで、WebKitGTK 4.1 と GTK 3 に依存します。タスクトレイのアイコンは `libayatana-appindicator3-1` があるときだけ表示し（推奨パッケージ。ないときはトレイなしで動きます）、日本語の表示には `fonts-noto-cjk` を推奨します。NVIDIA のドライバー（`/proc/driver/nvidia/version` があるとき）では、WebKitGTK の画面が真っ白になる既知の問題を避けるため、`WEBKIT_DISABLE_DMABUF_RENDERER=1` を付けて起動します（自分で設定した値があればそれを使います）。

どちらも、CI でのビルドとテスト（sidecar のスモークテストを含む）までしか確かめていません。

## 依存ライブラリ

### ライセンス台帳

[docs/dependency-license-inventory.json](docs/dependency-license-inventory.json)（Windows。ほかの OS は下記）に、ロックファイル（`uv.lock`・`frontend/pnpm-lock.yaml`・`frontend/src-tauri/Cargo.lock`）にあるすべての依存の版・宣言されたライセンス・本番/開発の区別と、同梱のフォント・PDFium などを記録しています。依存を追加・更新したら `just licenses`（`tools/license_inventory.py`）で作り直し、台帳もコミットしてください。

- ネットワークは使いません。依存関係はロックファイルから、ライセンスは手元にインストール済みの情報（`.venv` の METADATA、`frontend/node_modules` の `package.json`、`cargo metadata --offline` で読む Cargo のキャッシュ）から読みます。先に `just setup` を実行し、Rust の crate は一度ビルドするか `frontend/src-tauri` で `cargo fetch` を実行して取得しておいてください。
- 台帳は配布する OS ごとに作ります。Windows x64 のものが `docs/dependency-license-inventory.json`、macOS（Apple Silicon・Intel）と Linux x64 のものが `docs/dependency-license-inventory.macos-arm64.json`・`.macos-x64.json`・`.linux-x64.json` です。OS ごとに使う依存（Python の環境マーカー、npm の `os`・`cpu`・`libc`、Rust の target）と、インストールされたライセンスの情報が違うため、それぞれの OS の上で作ります。Windows のものは Windows で `just licenses`、macOS と Linux のものは CI を手動で実行して `licenses` を選ぶ（Mac は `macos` も選ぶ）と作られるので、成果物をダウンロードして `docs/` にコミットしてください。まだ作っていない OS の台帳は `--check` で確かめません。作った macOS・Linux の台帳がロックファイルより古くなったときは、`--check` は標準エラーに警告を出すだけで失敗にしません（Windows の台帳が古いときだけ失敗です）。これらの台帳は各 OS でしか作れず、Mac の実行時間は 10 倍で数えられるため、依存を更新するたびに CI を落とさないようにしています。作り直すには CI を手動で実行して `licenses` を選び、成果物を `docs/` にコミットします。
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

CLI は PATH と既定のインストール先から自動検出します（macOS・Linux では `~/.local/bin`、Homebrew（`/opt/homebrew/bin`・`/usr/local/bin`）、nvm・fnm・Volta・`~/.npm-global` など npm の置き場所も探し、CLI を起動するときの PATH にもそのフォルダーを足します。npm 版の CLI は Node.js で動くため）。見つからない場合は設定画面でパスを指定してください。npm・pnpm 版の `.cmd` は cmd.exe を経由するためそのまま実行せず、`.cmd` と同じフォルダー配下にある本体（npm の既定の配置、なければ `.cmd` が起動するもの）を直接起動します（JavaScript なら Node.js で、`.exe` ならそのまま）。本体が見つからない `.cmd`・`.bat`・`.ps1` は使えないので、yarn などで入れた場合は `.exe` か npm 版のパスを指定してください。macOS・Linux の npm 版（`#!/usr/bin/env node` で始まるスクリプト）は、1 行目が指す node、なければスクリプトと同じフォルダーの node（nvm・Homebrew・Volta は CLI をそれを入れた Node.js と同じフォルダーに置く）、なければ CLI の PATH の最初の node で起動します。node が見つからないときは、何も起動せずにそう伝えます。API キーはファイルに保存せず、起動中のセッションだけで保持します。

アプリ内の「ログイン」は、Windows では新しいコンソール、macOS ではターミナル、Linux では端末（`x-terminal-emulator`、なければ GNOME 端末・Konsole・xterm など）を開いて CLI のログインを実行します（`claude auth login` と agy は端末がないと先へ進めないため）。端末は、CLI を探したときと同じ PATH で CLI を起動し、終わったら Enter キーで閉じます。端末を開けないときは、実行するコマンドを表示します。

PDF の本文は信頼できない入力として扱い、通常の翻訳・サマリー・チャットでは Web 検索やローカル操作のツールを無効にします。Claude Code は MCP サーバー・プロジェクト設定・スキルを無効にし、Web 検索を明示したときだけ `WebSearch`・`WebFetch` を有効にします。Codex は読み取り専用サンドボックスでシェル・プラグイン・アプリと `config.toml` の MCP サーバーを無効にし、Web 検索だけを要求に応じて切り替えます。Antigravity は `--sandbox` と実行ごとの専用エージェントを使い、検索時だけ検索・ページ取得ツールを有効にします。コマンド実行・ファイル操作・MCP・別エージェントの呼び出しは公開しません。本文はコマンドラインではなく標準入力で渡します（Windows のコマンドライン長の上限を超える長いチャットも送れます）。CLI には Papeer 自身の環境変数（`PAPEER_*`、sidecar の認証トークンなど）を引き継ぎません。

通常は翻訳・解説・チャットを実行したときだけ、必要なテキストが選択した AI へ送られます。「論文情報の取得にAIを使う」は初期値OFFです。ONにすると、PDF追加時に不足している筆頭著者・出版年・掲載誌・DOIなどを補います。論文冒頭のテキストをAIへ送り、タイトル・識別子でCrossrefやarXivの書誌情報を照合します。入力済みの情報は保持します。

情報取得の接続先・モデルは翻訳とは別に指定できます。たとえば翻訳はCodex、情報取得は「API / ローカルモデル（OpenAI互換）」でOllamaを使えます。ローカルOllamaのAPI URLは `http://localhost:11434/v1`、モデルにはインストール済みの名前（例: `qwen3:8b`）を入力し、APIキーは空欄にします（[OllamaのOpenAI互換API](https://docs.ollama.com/api/openai-compatibility)）。接続先を「翻訳などと同じ接続先」にすると通常の接続先を使い、情報取得モデルが空欄ならその接続先の通常モデルを使います。URL・CLIパス・APIキーは接続先の通常設定と共通です。ローカルAIを使う場合も、書誌情報の照合ではCrossrefやarXivへ通信します。

### 接続先の追加・変更（開発者向け）

接続先ごとの処理は `papeer/providers/` に 1 モジュールずつ置いています。翻訳・論文情報の取得は共通の `ProviderBackend.generate()` を使い、接続先は同じレジストリから生成します。情報取得専用の設定は `Settings.for_paper_metadata()` で解決し、翻訳の設定を変更しません。CLI のフラグや出力形式が変わったときは、その接続のモジュールだけを直します。

1. `papeer/providers/base.py` の `ProviderBackend` を継承し、`spec`（表示名・説明・設定項目）と `_generate()` を実装する。CLI なら `common.CliBackend` も継承すると、パス検出・ログイン・接続確認が付く。
2. `papeer/providers/registry.py` の `BACKENDS` に 1 行追加する。
3. `papeer/core/code_version.py` の `RENDER_EXCLUDED` に新しいファイルを追加する（`tests/test_code_version.py` が未分類のファイルを検出する）。

設定画面の選択肢と入力欄は `GET /api/providers` から作られるため、フロントエンドの変更は不要です。接続先ごとの設定のうち、最後に選んだモデルと effort はライブラリの `settings.json` の `provider_options` に、CLI のパスと API URL（`config.DEVICE_OPTION_KEYS`）は PC ごとの `%LOCALAPPDATA%\PapeerSync\device-settings.json` に保存されます。後者は同期・バックアップに含めず、別の PC から届いた `settings.json` や復元したバックアップに書かれていても使いません（以前の版の `settings.json` にあった値は、初回の読み込み時に一度だけ PC ごとの保存先へ移します）。モデル名は半角英数字と `. : / @ [ ] + - _` だけ（先頭の `-` は不可）を受け付けます。保存済みのモデル名が不正な場合は、接続先の既定のモデルを使います。`settings.json` にこの版が知らない項目（別の PC の新しい版の Papeer が書いたもの）があると、`GET /api/settings` の `unknown_keys` で返し、フロントエンドが起動時に知らせます（「今後表示しない」は PC ごとにブラウザーの保存領域に記憶します）。それらの項目はこの版では使わず、設定を保存すると消えます（sidecar のログに記録します。消えた状態は同期で新しい版の PC にも届きます）。

翻訳キャッシュはコードではなく接続先・モデル・プロンプト・原文で区別するため、`papeer/providers/` を編集しても既存の訳文は訳し直しません。依頼の送り方や応答の検証を変えて訳し直すべきときは、`papeer/translation/translation.py` の `TRANSLATION_PROTOCOL` を上げます（[翻訳](docs/translation.md#翻訳キャッシュの識別値)）。

## データの保存場所

「設定 → 保存先・同期」でPC版Google Driveのローカルフォルダーを指定すると、PDF・書き込み・サマリーを含むライブラリ全体を別PCと同期できます。Papeer内でのGoogleログインやOAuth設定は不要です。導入手順、競合時の操作、容量・転送の制限は [Google Drive同期](docs/google-drive-sync.md) を参照してください。

保存先は OS ごとの一般的な場所です（`papeer/core/paths.py`。Tauri 側の `frontend/src-tauri/src/lib.rs` も同じ規則でライブラリの場所を決めます）。

| | ライブラリ | このPCだけのファイル（下の `PapeerSync/`） | 作り直せるキャッシュ | ログ |
| --- | --- | --- | --- | --- |
| Windows | `%LOCALAPPDATA%\Papeer` | `%LOCALAPPDATA%\PapeerSync` | `PapeerSync\font-cache` | `PapeerSync\logs` |
| macOS | `~/Library/Application Support/Papeer` | `~/Library/Application Support/PapeerSync` | `~/Library/Caches/Papeer` | `~/Library/Logs/Papeer` |
| Linux | `$XDG_DATA_HOME/papeer`（既定 `~/.local/share/papeer`） | `$XDG_STATE_HOME/papeer`（既定 `~/.local/state/papeer`） | `$XDG_CACHE_HOME/papeer`（既定 `~/.cache/papeer`） | このPCだけのファイルの `logs` |

このPCだけのファイルには同期の状態と履歴（消すと次の同期で変更と競合を区別できず、戻す先もなくなる）も入るので、macOS ではキャッシュ（`Caches`）ではなく `Application Support` に、Linux では XDG の state に置きます。キャッシュの場所に置くのは、同梱フォントから作り直せる変換結果だけです。

以前の版（PaperDesk）が使っていた `%LOCALAPPDATA%\PaperDesk` は読みません（ライブラリは `Papeer` へ移してある前提です）。「設定 → バックアップ」からライブラリ全体を保存・復元できます。新しいバージョンのPapeerで作成したバックアップは復元できません（更新を促すメッセージを表示します）。手動でコピーする場合は、アプリを閉じてからフォルダー全体をコピーしてください。

```text
Papeer/
  settings.json
  ui-state.json
  library.sqlite3
  prompts/                    カスタマイズしたプロンプト
  papers/<論文ID>/
    original.pdf
    document.json             抽出結果（アプリだけが読むのでインデントなし）
    ocr-text.json             要OCRのページを OCR（または AI）で読んだ結果。抽出し直すときはページを読み直さずにこれを使う
    translated.pdf
    interleaved.pdf           原文と訳文の交互ページ（「原文・日本語訳（交互）を外部で開く」で作成し、訳文が変わるまで再利用）
    translation-pages/        翻訳途中のページ（翻訳の完了時と起動時に不要なものを削除）
    translation.md
    translation-cache.json    訳文と再翻訳の回数の記録（インデントなし）
    translation-report.json
    glossary.json               旧辞書の移行元（用語辞書はlibrary.sqlite3に保存）
    article.md                解説
    notebook.json             手書きノートのページの構成（ノートの項目だけ。original.pdf はこれから作る）
    attachments/<ID>.md|.html 論文・ノートが持つメモ（md）・資料（html）。ID は library.sqlite3 の attachments の行

Papeer-sync-backups/          以前のバージョンが残した、フォルダー同期で選ばなかったライブラリのZIP（今は PapeerSync/history/ に残す。
                              設定のバックアップの「以前のデータ」から削除できる）
Papeer-before-restore-*/      以前のバージョンが残した、復元・取り込み前のライブラリ（同上）

PapeerSync/                   このPCだけの設定（同期・バックアップの対象外。macOS・Linux の場所は上の表）
  device-settings.json        CLI のパスと API URL
  ocr-settings.json           OCR の使い方・エンジン・言語（このPCの設定）
  tessdata/fast/              Tesseract の言語データ（「設定 → OCR」で確認してからダウンロード。消すと次に読むときにまた確認する）
  history-settings.json       このPCの履歴に残す記録の数（直近 N 件・日ごと D 日分）
  history/<ハッシュ>/          このPCの履歴（同期した時点・選ばなかった側・復元の直前）。entries/ に各時点の一覧、blobs/ に
                              中身の SHA-256 を名前にしたファイル（同じ内容は1つだけ）。library.json に元のライブラリの場所
  instances/                  ライブラリを今開いている sidecar の起動情報（<ハッシュ>.lock と <ハッシュ>.json。ポート・トークン・pid。papeer-cli が接続先を見つけるのに使い、終了すると消える。同期・バックアップの対象外）
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
| `PAPEER_FONT_CACHE_DIR` | 同梱フォントの変換結果の置き場所（既定は Windows `%LOCALAPPDATA%\PapeerSync\font-cache`、macOS `~/Library/Caches/Papeer/font-cache`、Linux `~/.cache/papeer/font-cache`。pytest は `.pytest_cache` 内を使う） |
| `PAPEER_DEV_NO_AUTH` | `1` のとき、`PAPEER_TOKEN` なしで認証なしの sidecar を起動する（開発専用。PyInstaller で作った sidecar では無視） |
| `PAPEER_API_KEY` | API 接続で使う API キーの初期値（未設定なら `OPENAI_API_KEY`、次に `GEMINI_API_KEY`） |
| `PAPEER_LAUNCHER` | sidecar を起動した主体（`app`・`dev`・`cli`）。未設定なら配布版は `app`、ソースからは `dev`。`cli` は papeer-cli が起動したヘッドレスの sidecar で、ウィンドウの sidecar が引き継ぐ相手になる |
| `PAPEER_IDLE_EXIT` | 秒数。`PAPEER_LAUNCHER=cli` の sidecar が、ジョブ・リクエスト・接続がなくなってからこの秒数で自分で終了する（papeer-cli が `--idle`、既定 10 秒で設定する）。ほかの起動主体では無視 |
| `PAPEER_CLI_URL` | papeer-cli の接続先の sidecar の URL（`--url` が優先。認証は `PAPEER_TOKEN`）。使い方は [docs/cli.md](docs/cli.md) |
| `PAPEER_WATCH_STDIN` | `1` のとき、標準入力が閉じたら（パイプの向こうのアプリが終わったら）ジョブを止めて終了する。本番のアプリが sidecar に付ける |
| `PAPEER_E2E_DIR` | E2E テスト専用（デバッグ版のアプリだけが読む）。メインウィンドウの WebView2 のプロファイルをこのフォルダーに作り、ウィンドウの位置を保存・復元しない（README「E2E テスト」） |

sidecar は、ポートが使用中なら終了コード 3、ライブラリを別の Papeer（ウィンドウや、papeer-cli が起動したヘッドレスの sidecar）が使用中なら終了コード 4 で終わります。1 つのライブラリを扱う sidecar は 1 つだけで、ウィンドウの sidecar はヘッドレスの sidecar から引き継げますが、ウィンドウどうしでは引き継ぎません（終了コード 4 のとき、アプリは「このライブラリは別の Papeer が使用中です」と表示して終わります）。

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
| `Ctrl+,` | 接続・設定を開く |

タッチ画面では、PDF上を1本指で横に滑らせて離すと前後のページへ移動します（左へ滑らせると次、右へ滑らせると前）。拡大中はページ内の移動を優先し、左右の端から外向きに滑らせるとページを切り替えます。2本指のピンチで連続的に拡大・縮小できます。2本指の中点を基準に拡大し、倍率は原文と日本語訳で連動します。

タッチパッドでは、PDF上で横スライドすると前後のページへ移動できます。拡大中は横スクロールを優先し、左右の端に着いてからもう一度外向きにスライドするとページを切り替えます。1回のスライドで移動するのは1ページです。

macOS では `Ctrl` の代わりに `⌘` を使います（表示も `⌘` になります）。ほかに次のキーが Mac の慣習に合わせて違います。

- 集中表示は `⌃⌘F`（`F11` は macOS がデスクトップの表示に使うため）
- 移動する前の場所に戻る・進むは `⌘[` / `⌘]`（`⌥←` / `⌥→` も使えます）
- 削除は `delete`（`⌫`）キー
- タッチパッドのピンチで拡大・縮小
- メニューバーの「Papeer を終了」（`⌘Q`）と「閉じる」（`⌘W`）は、ウィンドウを閉じるときと同じく、保存していない入力の保存・実行中の処理の確認・終了時の同期をしてから終わります。「設定…」（`⌘,`）で接続・設定を開き、Dock のアイコンで隠したウィンドウを出します。Dock のメニューの「終了」やログアウトでは、この確認をせずに終わります（ライブラリへの書き込みは終えてから終わります）

日本語入力の変換を確定する `Enter` では、チャットの送信やページ番号・論文情報の確定をしません（macOS の WebKit は確定の `Enter` を入力中として印を付けないため、`keyCode` 229 でも見分けます）。

## ライセンス

Papeer のコードは AGPL-3.0-or-later で提供します。ライセンス本文は [LICENSE](LICENSE) です。

同梱の源ノ明朝・源ノ角ゴシックは SIL Open Font License 1.1 です。出典は [papeer/core/assets/fonts/README.md](papeer/core/assets/fonts/README.md) を参照してください。PyMuPDF は AGPL または商用ライセンスで提供されています。その他の依存ライブラリはそれぞれのライセンスに従います。依存ごとのライセンスは[ライセンス台帳](docs/dependency-license-inventory.json)（「依存ライブラリ」を参照）にまとめています。

### 旧名称との互換性

環境変数は `PAPEER_*` を優先し、未設定なら旧 `PAPERDESK_*` も受け付けます。既存の辞書・バックアップ・`paperdesk://` 引用リンクも読み込めます。画面設定と手書きの未保存データは、新しい保存キーへ初回起動時に引き継ぎます。インストール済みアプリと WebView のデータを引き継ぐため、Tauri の内部識別子 `local.paperdesk` は維持しています。ソースのルートディレクトリ名は変更不要です。

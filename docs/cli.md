# コマンドライン（papeer-cli）

`papeer-cli` は、Papeer をターミナルやスクリプトから操作するコマンドです。PDF の取り込み、フォルダーの整理、翻訳の開始、ジョブの確認ができます。ライブラリのデータベースやファイルは直接触らず、Papeer 本体と同じバックエンド（sidecar）に HTTP で依頼するため、ジョブの排他やスナップショットの保護はウィンドウで操作したときと同じです。

## 入手とインストール

インストーラーで入れた Papeer には、`sidecar` フォルダーの中に `papeer-cli`（Windows は `papeer-cli.exe`）が入っています。`papeer.exe`（アプリ本体）とは別のファイルです。

| OS | 場所 |
| --- | --- |
| Windows | インストール先の `sidecar\papeer-cli.exe`（`papeer.exe` の隣の `sidecar` フォルダー。ユーザー単位の NSIS インストーラーの既定は `%LOCALAPPDATA%\Papeer\sidecar\`） |
| macOS | `/Applications/Papeer.app/Contents/Resources/sidecar/papeer-cli` |
| Linux（.deb） | `/usr/lib/Papeer/sidecar/papeer-cli` |

ソースからは `just cli <コマンド>`（`uv run python -m papeer.cli` と同じ）で実行できます。空白を含むパスは `just` が空白で分けてしまうため、そのときは `uv run python -m papeer.cli add "C:\papers\a b.pdf"` のように直接実行してください。Windows の `just` は失敗の終了コードを 1 にまとめるため、終了コードで分岐するスクリプトも `uv run python -m papeer.cli` を使ってください。

### 名前だけで呼べるようにする

**Windows**：インストールしたフォルダーの `papeer-cli.exe` を一度実行します。

```text
"<インストール先>\sidecar\papeer-cli.exe" setup-path
```

そのフォルダーをユーザーの `Path`（`HKCU\Environment`）に追加します。管理者権限は要りません。すでに入っている項目は並び順も書き方もそのまま残し、同じフォルダーを重ねて入れることもありません。新しく開いたターミナルから `papeer-cli` で呼べます（すでに開いているターミナルには反映されません）。

元に戻すには `papeer-cli setup-path --remove` を実行します。追加したフォルダーだけを取り除きます。アンインストールしても PATH の項目は残る（インストーラーは PATH を編集しません）ので、アンインストールの前に `--remove` を実行してください。

**macOS・Linux**：シェルの設定ファイルは書き換えません。`setup-path` が、その場所に合わせたリンクの作り方を表示します。

```sh
mkdir -p ~/.local/bin && ln -s "/Applications/Papeer.app/Contents/Resources/sidecar/papeer-cli" ~/.local/bin/papeer-cli
```

`~/.local/bin` が PATH に入っていなければ、`~/.profile` などに `export PATH="$HOME/.local/bin:$PATH"` を足してください。外すときは `rm ~/.local/bin/papeer-cli` です（`setup-path --remove` はこのコマンドを表示します）。

## どこに接続するか

`papeer-cli` は、次の順で接続先を決めます。

1. `--url`（と `--token`）、または環境変数 `PAPEER_CLI_URL`（と `PAPEER_TOKEN`）で指定した sidecar。
2. このライブラリを開いている Papeer（ウィンドウ）の sidecar。ウィンドウが開いていれば、その sidecar に接続します。ウィンドウには、CLI が始めたジョブの進み具合もそのまま表示されます。
3. どちらもなければ、ヘッドレス（ウィンドウなし）の sidecar を自動で起動して接続します。`--no-spawn` を付けると起動せず、終了コード 3 で終わります。

- ヘッドレスの sidecar は、何も依頼がなくなって `--idle` の秒数（既定 10 秒）がたつと自分で終了します。続けて実行するコマンドは、同じ sidecar を使い回します。止めたいときは `papeer-cli server stop` です（ウィンドウの sidecar は止めません）。
- 1 つのライブラリを扱う sidecar は 1 つだけです。ヘッドレスの sidecar が動いている間に Papeer のウィンドウを開くと、ウィンドウが引き継ぎます。ヘッドレス側の実行中のジョブは止まりますが（途中までの訳文とキャッシュは残ります）、CLI は引き継いだ sidecar に同じ依頼を出し直します（最大 2 回。翻訳はキャッシュが効き、取り込みは重複を飛ばすので、やり直しても結果は変わりません。`--no-resume` で出し直さずに失敗として終われます）。
- ウィンドウでジョブを中止したときは、依頼が中止されたものとして終了コード 1 で終わります。
- ライブラリの場所は `--data-dir`、なければ環境変数 `PAPEER_DATA_DIR`、なければ標準の場所です（README「データの保存場所」）。別のライブラリを指定すれば、そのライブラリを扱う別の sidecar が使われます。

接続先の情報（ポートとトークン）は、このPCだけのフォルダー（`PapeerSync\instances\`）に、ライブラリごとのファイルとして置かれます。同期やバックアップの対象には入りません。

## コマンド

```text
papeer-cli [共通のオプション] コマンド [引数]
```

| コマンド | 内容 |
| --- | --- |
| `status` | 接続先（ウィンドウ／ヘッドレス）・版・ライブラリの場所・実行中のジョブ。起動していなければ終了コード 3（sidecar は起動しません） |
| `add PATH... [-f FOLDER] [-r] [--no-wait]` | PDF の取り込み |
| `ls [FOLDER] [-q QUERY] [--all]` | 論文の一覧 |
| `folder list / create / rename / delete / restore` | フォルダーの操作 |
| `mv PAPER... --to FOLDER` | 論文の移動 |
| `organize [FOLDER] [--papers ID...] [...]` | AI にフォルダー分けの案を作らせて適用 |
| `translate PAPER [-p PAGES] [...]` | 翻訳 |
| `job list / show / cancel` | ジョブの確認・中止 |
| `server stop` | CLI が起動したヘッドレスの sidecar を停止 |
| `setup-path [--remove]` | PATH の設定（上の「名前だけで呼べるようにする」） |

論文は ID の先頭 6 文字以上で指定できます（一意に決まらないときは候補を表示して終了コード 1）。ID は `ls` で確認します。フォルダーは `親 / 子` の形で階層を書きます。`""`（空）は未分類です。

### add：取り込み

```text
papeer-cli add paper.pdf
papeer-cli add "C:\papers\*.pdf" --folder 試験
papeer-cli add C:\papers -r -f "強化学習 / 方策勾配"
```

`*` などのパターンは CLI が展開します（Windows のシェルは展開しません）。フォルダーを渡すときは `-r` が必要で、サブフォルダーまで PDF を探します。`--folder` のフォルダーがなければ作ります。ライブラリにすでにある PDF（同じ内容）は「重複」と表示し、追加しません。既定では取り込みが終わるまで進み具合を表示して待ちます。

### ls：一覧

```text
papeer-cli ls
papeer-cli ls "強化学習" -q policy
papeer-cli ls ""
```

`FOLDER` を指定するとそのフォルダーに直接入っている論文だけ（`""` で未分類）、`--all` でサブフォルダーの論文も含めます。`-q` はタイトルなどの検索です。

### folder：フォルダー

```text
papeer-cli folder list
papeer-cli folder create "強化学習 / 方策勾配"
papeer-cli folder rename "強化学習" "RL"
papeer-cli folder delete "古い分類" --yes
papeer-cli folder restore <トークン>
```

削除すると、中の論文は未分類に移り（論文は消えません）、元に戻すための `folder restore` のコマンドを表示します。対話できない環境（パイプ・`--json`）では `--yes` が必要です。フォルダーは仮想的なもので、PDF ファイルが動くことはありません。

### mv：移動

```text
papeer-cli mv a1b2c3 d4e5f6 --to "制御 / 強化学習"
```

複数の論文を 1 回の操作としてまとめて移動します（一部だけ失敗することはありません）。移動先がなければ作ります。

### organize：AI でフォルダー分け

```text
papeer-cli organize "" --instruction "研究分野別に"
papeer-cli organize "" --dry-run --save proposal.json
papeer-cli organize --papers a1b2c3 d4e5f6 --yes
papeer-cli organize "制御" --previous proposal.json --feedback "もっと粗く"
```

ウィンドウの「AIでフォルダーに分ける」（[docs/organize.md](organize.md)）と同じ機能です。AI が作った案を表にして表示し、`[y/N]` で確認してから適用します。

- `FOLDER` を省略すると未分類を対象にします（`FOLDER` の直下の論文だけ。子フォルダーは含みません）。`--papers` で論文を直接指定すると、フォルダーの代わりにそれらを対象にします。
- 対象は 300 件までです。
- `--yes` は確認せずに適用します。`--dry-run` は案を表示するだけです。端末ではなく `--yes` も付けていないときは、案を表示して終了コード 1 で終わります（適用しません）。
- `--save FILE` は案を JSON で保存します。`--previous FILE --feedback TEXT` で、保存した案を土台に作り直せます。
- `--model`・`--effort` はこの実行だけのモデルと推論の強さです。

> **AI を呼びます。** 設定している AI 接続を使うため、API 接続では料金がかかり、CLI 接続では利用枠を使います。`--dry-run` でも AI は呼びます（適用しないだけです）。

### translate：翻訳

```text
papeer-cli translate a1b2c3
papeer-cli translate a1b2c3 --pages 1-3,5
papeer-cli translate a1b2c3 --plan
```

`--plan` は翻訳せず、どのページを AI に送り、どのページは保存済みの訳を再利用するかだけを表示します（AI は呼びません）。指定がなければ全ページが対象です。翻訳は AI を呼びます。完了すると翻訳したページ・使ったモデル・使用量を表示します。

### job：ジョブ

```text
papeer-cli job list
papeer-cli job show <ジョブ ID> --wait
papeer-cli job cancel <ジョブ ID>
```

起動している sidecar にだけ問い合わせます（なければ終了コード 3。ここでは sidecar を起動しません）。`job show --wait` はジョブが終わるまで待ち、成功以外なら終了コード 1 です。

## 共通のオプション

どのコマンドでも、コマンド名の前後どちらにも書けます。

| オプション | 内容 |
| --- | --- |
| `--json` | 結果を標準出力に JSON で出す（進捗・注意・エラーは標準エラー出力）。確認の質問はしない |
| `--quiet` | 進捗と補足のメッセージを出さない |
| `--data-dir DIR` | ライブラリのフォルダー（環境変数 `PAPEER_DATA_DIR`） |
| `--no-spawn` | ヘッドレスの sidecar を起動しない（終了コード 3） |
| `--no-resume` | sidecar が終了・引き継ぎされても、同じ依頼を出し直さずに失敗として終わる |
| `--idle SEC` | 起動したヘッドレスの sidecar が、何もなければ終了するまでの秒数（既定 10） |
| `--url URL`・`--token TOKEN` | 接続先の sidecar を直接指定する（環境変数 `PAPEER_CLI_URL`・`PAPEER_TOKEN`） |

`--json` を付けると、標準出力には JSON だけが出ます。スクリプトからは終了コードと標準出力の JSON を使ってください。

```sh
papeer-cli --json ls | jq -r '.[].id'
```

## 終了コード

| コード | 意味 |
| --- | --- |
| 0 | 成功 |
| 1 | 失敗（ジョブの失敗・中止、対象が見つからない、確認できない環境で適用しなかったなど） |
| 2 | 使い方の誤り（引数の不足・不正など） |
| 3 | 接続先がない（`--no-spawn`、`status`・`job` で sidecar が起動していない、ヘッドレスの sidecar を起動できなかった、`--url` に接続できない） |
| 130 | Ctrl+C による中断 |

## 環境変数

| 変数 | 用途 |
| --- | --- |
| `PAPEER_DATA_DIR` | ライブラリのフォルダー（`--data-dir` が優先） |
| `PAPEER_CLI_URL` | 接続先の sidecar の URL（`--url` が優先）。`http://127.0.0.1:ポート` の形 |
| `PAPEER_TOKEN` | `--url` で接続するときの認証トークン |

トークンは、コマンドライン引数（`--token`）よりも環境変数で渡してください。引数はプロセスの一覧から他のプログラムにも見えます。

## 注意

- **設定画面で入力しただけの API キーは、ヘッドレスの sidecar では使えません。** 設定ダイアログで入力して保存していないキーは、ウィンドウの sidecar のメモリーにしかありません。CLI でヘッドレスの sidecar を使うときは、設定を保存するか、ウィンドウを開いておいてください（ウィンドウが開いていれば、その sidecar に接続します）。
- **`--no-wait` とヘッドレスの sidecar**：`add --no-wait`・`translate --no-wait` はジョブを始めてすぐ終わりますが、ヘッドレスの sidecar はそのジョブを終えてから終了します。終了した後に `job show` を実行しても、ジョブは見つかりません（ジョブは sidecar のメモリーにあるため）。結果を知りたいときは、既定の待つ実行を使うか、`ls` などでライブラリを確かめてください。ウィンドウが開いていれば、ジョブはウィンドウに表示されます。
- `--idle` は、すでに動いている sidecar に接続するときは無視されます（起動するときだけ効きます）。
- **Ctrl+C**：CLI が始めたジョブ（`add`・`translate`・`organize`）は、Ctrl+C で中止の依頼を出し、終了コード 130 で終わります。`job show --wait` の Ctrl+C は待つのをやめるだけで、ジョブは中止しません。
- ヘッドレスの sidecar のログは、このPCだけのフォルダーの `logs\sidecar.log`（Windows は `%LOCALAPPDATA%\PapeerSync\logs\`）に書かれます。起動できなかったときは、ここを確認してください。
- 同じライブラリを開ける Papeer は 1 つだけです。ウィンドウを 2 つ開こうとすると、あとから開いた方が「このライブラリは別の Papeer が使用中です」と表示して終了します。

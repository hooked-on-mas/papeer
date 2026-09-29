# Papeer 公開前のライセンス・AI 利用条件・知的財産調査

調査日: 2026-09-25。**今回の公開対象は Git リポジトリのソースコードのみ**。作者による Windows インストーラー・実行ファイルの配布、ホスト型翻訳サービスの提供は予定しない。この作業ツリーとロックファイル、Git の追跡対象、公式規約・公的資料を調べた予備調査である。個別契約の解釈、各国での特許侵害予防調査（FTO）、利用者が持ち込む論文の権利調査を完了したものではない。規約と権利状態は公開直前に再確認する。

## 結論と優先順位

| 優先 | ソース公開での論点 | 現時点の判断 | 対応 |
| --- | --- | --- | --- |
| 高 | Git に同梱した素材 | アプリのバイナリはないが、Source Han OTF、PDF.js CMap、Foxit/Liberation フォント、アイコン、テスト PDF は実際に再配布される。Source Han/CMap/Foxit のライセンス文は隣接配置済み。Liberation の GPLv2 対応ソースと、アイコン・テスト PDF の作成来歴を確認する。 | 同梱物ごとのライセンス・著作権表示・来歴を確定し、必要な元データまたは入手方法を整える。 |
| 高 | Antigravity の説明 | コードを公開するだけで作者が Antigravity を利用したことにはならない。一方、[個人向け追加規約 §6](https://antigravity.google/terms)は第三者ソフトからのアクセスを禁止しており、README の接続案内をそのまま「利用可能」と読ませるのは不正確。 | 対応可否を README に明示する。個人向け `agy` 接続は削除または非推奨の説明を検討する。 |
| 中 | 本体ライセンスの明確さ | README は `AGPL-3.0-or-later`、ルートに AGPLv3 本文がある。各ファイル・パッケージメタデータには表記がない。 | 著作権者、`or later` の選択、SPDX 表記を整える。既存の第三者素材を本体 AGPL と誤認させない。 |
| 中 | 特許と公開時期 | OSS のソース公開は特許の一律免除ではない。プログラムのネット提供も権利範囲に入る場合があるが、今回の候補文献について有効権利と全要件の一致は確認できていない。公開は自らの発明の新規性にも影響する。 | 自分の特許出願の意向を先に決める。懸念する国・機能があれば個別の請求項調査を行う。 |
| 将来の配布時 | `elkjs` の互換性・PDFium の通知 | EPL の `elkjs` や PDFium バイナリは今回の Git 追跡対象に含まれない。現ビルド成果物の課題は残るが、ソース公開の直ちの配布義務ではない。 | 第三者が結合ビルドを再配布できる状態にする際に対応する。 |

`git ls-files` で、アプリの `.exe`、インストーラー、`frontend/dist`、`node_modules`、Rust `target`、PyInstaller の `dist` は追跡されていないことを確認した。したがって **作者が現在のリポジトリを公開するだけなら、実行ファイルに対する AGPL §6 の対応ソース案内、PDFium 同梱バイナリの 16 ライセンス文書、完成アプリ内の第三者通知画面は今回の条件ではない**。ただしリポジトリ内のフォント等はそれ自体がバイナリ素材なので、その再配布条件は残る。[AGPLv3 原文](https://www.gnu.org/licenses/agpl-3.0.html)。

## 実装とデータの流れ

Papeer は Tauri/React の Windows アプリと、PyInstaller でフォルダー形式（onedir）の実行ファイルにする Python/FastAPI の sidecar から成る（2026-09 に単一実行ファイル形式から変更）。PDF を追加すると `%LOCALAPPDATA%\Papeer` に原本、抽出結果、SQLite の索引が置かれる。追加だけでは AI へ送らない。[README](../README.md)。翻訳では PDF の文字ブロックを抽出し、チャンクと文脈を選択された接続先へ送る。解説生成では論文のページ本文を広く送り、質問応答では全文が短ければ全文、長ければ関連ページ最大 10 ページと直近の会話を送る。図の切り抜き画像は現在の解説生成ではローカル処理であり、画像バイナリをモデルへ送る実装ではない。送信データは「選択した短い引用だけ」と説明してはいけない。[providers/](../papeer/providers/)、[service.py](../papeer/core/service.py)。

翻訳結果は、原 PDF の数式・表・図・参考文献等を残しつつ訳文を重ねた PDF、原文と訳文を交互に並べる PDF、左右対訳 PDF、Markdown として書き出せる。[PDF 生成](../papeer/pdf/pdf_engine.py)、[README](../README.md)。利用者の原稿に未公開情報、個人データ、査読中原稿、出版社契約上の制限がある場合、外部 AI への送信そのものを確認すべきである。

## 1. ソフトウェアと素材のライセンス

### 本体と主要な直接依存

README は本体を `AGPL-3.0-or-later` と記載し、ルートの `LICENSE` には AGPLv3 の本文がある。各ソースファイルの著作権者と「or later」の表示は統一されておらず、公開前に SPDX 表示と `pyproject.toml` 等のパッケージメタデータをそろえると解釈が明確になる。[GNU の表記指針](https://www.gnu.org/licenses/identify-licenses-clearly.html)。PyMuPDF は AGPL または Artifex の商用ライセンスによる提供だが、PyMuPDF のコード・wheel は今回の Git 追跡対象にない。利用者が自分で取得する依存として記録する。[PyMuPDF のライセンス説明](https://pymupdf.readthedocs.io/en/latest/about.html)。

| 領域 | ロックされた主要直接依存とライセンス |
| --- | --- |
| Python 本番 14 件 | `PyMuPDF 1.28.2` AGPL-3.0/商用（OCR に使う Tesseract を内蔵）、`pypdfium2 5.13.0` BSD-3-Clause/Apache-2.0 と内蔵依存、`fonttools 4.65.0` MIT、`Pillow 12.3.0` MIT-CMU、`FastAPI 0.141.1` MIT、`uvicorn 0.53.0` BSD-3-Clause、`pydantic 2.13.5` MIT。Windows だけで入る pywinrt（Windows.Media.Ocr を呼ぶ）の `winrt-runtime` と `winrt-Windows.Foundation`・`.Foundation.Collections`・`.Globalization`・`.Graphics.Imaging`・`.Media.Ocr`・`.Storage.Streams`（いずれも 3.2.1）の 7 件はすべて MIT。macOS だけで入る `pyobjc-framework-Vision` と、それが引く `pyobjc-core`・`pyobjc-framework-Cocoa`・`-Quartz`・`-CoreML`（12.2.2、MIT）は Windows の配布物には入らない（台帳では other-platform-in-lock）。 |
| JavaScript 本番 27 件 | React/React DOM、Mermaid、KaTeX、React PDF、React Markdown、TanStack Query・TanStack Virtual、Zustand などの多くが MIT。`pdfjs-dist` と `class-variance-authority` は Apache-2.0、`lucide-react` は ISC、`@fontsource-variable/geist` は OFL-1.1、Tauri JS パッケージ群は MIT/Apache-2.0 の選択。正確な版と 27 件すべては別紙一覧を参照。 |
| Rust 直接依存 | Tauri 2 と各プラグイン、Serde 系は主に MIT/Apache-2.0 の選択。Windows 向け間接依存には MPL-2.0 の 5 crate がある。 |
| フォント・PDF 表示データ | 源ノ明朝・源ノ角ゴシックと Geist は OFL-1.1。PDF.js の CMap は同梱 LICENSE、Foxit フォントは BSD 系、Liberation フォントは GPLv2 とフォント埋込み例外の条件がある。 |

JavaScript の直接依存を固定版でさらに示すと、MIT は `@base-ui/react 1.8.0`、`@dnd-kit/core 6.3.1`、`@tanstack/react-query 5.103.2`、`@tanstack/react-virtual 3.14.13`、`cn 0.4.0`、`katex 0.18.7`、`mermaid 12.0.0`、`openapi-fetch 0.17.0`、`react 19.3.0`、`react-dom 19.3.0`、`react-hotkeys-hook 5.3.3`、`react-markdown 10.1.0`、`react-pdf 11.0.0`、`react-resizable-panels 4.13.2`、`rehype-katex 7.0.1`、`remark-gfm 4.0.1`、`remark-math 6.0.0`、`zustand 5.0.15` の 18 件。Apache-2.0 は `class-variance-authority 0.7.1` と `pdfjs-dist 6.3.289`、ISC は `lucide-react 1.47.0`、OFL-1.1 は `@fontsource-variable/geist 5.3.0`。`@tauri-apps/api 2.11.1`、`plugin-dialog 2.7.3`、`plugin-notification 2.4.0`、`plugin-opener 2.5.5`、`plugin-process 2.3.1` は Apache-2.0/MIT の選択である。開発専用依存と間接依存は別紙に分けている。

ロックファイル上の Python 外部依存は開発・ビルド込み **55 件**（Windows 実行時 **29 件**、macOS だけで入る Vision 関連 5 件を含む）、JavaScript 本番依存閉包は **297 個の name@version**（うち **287 個**が Windows x64 に該当して手元にインストール、残り 10 個は他 OS/CPU 向け optional バイナリ）、Windows 対象の Rust 外部 crate は **256 件**である。Windows x64 に該当する一覧行にはライセンス不明がない。全件の固定版・ライセンスは[依存ライセンス一覧](dependency-license-inventory.json)を参照する。これは**利用者がインストールする依存と、将来ビルドを再配布する場合の調査資料**であり、一覧の全パッケージを作者がソースリポジトリに同梱するという意味ではない。対象 OS やロックを変えた場合、`just licenses` で再生成する（台帳に記録したロックファイルの sha256 との一致をテストで検査する）。

### 特に検討が必要な依存

1. **Mermaid と ELK は下流のビルド課題。** `mermaid@12.0.0` の間接依存 `elkjs@0.9.3` は EPL-2.0。該当版の[ライセンス原文](https://github.com/kieler/elkjs/blob/0.9.3/LICENSE.md)に GPL 二次ライセンス指定は見当たらず、[FSF](https://www.gnu.org/licenses/license-list.html#EPL2)は無指定の EPL-2.0 を GPL 非互換と扱う。手元の `frontend/dist` には `elk-*.js` があるが、**この `dist` も elkjs 本体も Git に追跡されていない**。したがって、現時点のソース公開を EPL 違反と断定する根拠にはならない。後に結合成果物を再配布できるようにするなら、ELK をビルドから除くか許諾方法を法的に確認する。[Mermaid のレイアウト説明](https://mermaid.js.org/config/layouts)。
2. **MPL-2.0 crate も同様に未同梱。** ロック内に `cssparser`、`cssparser-macros`、`dtoa-short`、`option-ext`、`selectors` があるが、ソースリポジトリでこれらの crate は再配布していない。ビルド成果物を再配布する場合に元ファイルの MPL 条件を確認する。[MPL-2.0 原文](https://www.mozilla.org/en-US/MPL/2.0/)。
3. **PyMuPDF、PDFium、PyInstaller は未同梱。** 手元の PyInstaller 成果物では PDFium の `BUILD_LICENSES` 16 ファイル等の通知が不足しているが、その実行ファイルは Git 追跡外であり、**今回のソース公開の修正条件ではない**。作者が後日バイナリ配布する場合は、[pypdfium2 の説明](https://github.com/pypdfium2-team/pypdfium2/blob/5.13.0/README.md#licensing)に従って再点検する。PyInstaller の[bootloader 例外](https://github.com/pyinstaller/pyinstaller/blob/v6.22.3/COPYING.txt)は生成実行ファイルとの結合を許す。
4. **Git に含む素材。** Adobe の Source Han OTF 2 件と OFL 文、PDF.js の CMap `.bcmap` 168 件とライセンス文、Foxit `.pfb` 10 件とライセンス文、Liberation `.ttf` 4 件とライセンス文が追跡されている。Source Han の出典・ハッシュは[同梱フォントの README](../papeer/core/assets/fonts/README.md)に記録済み。[OFL 公式 FAQ](https://openfontlicense.org/ofl-faq/)は著作権・ライセンス文を伴うフォント再配布を認める。[PDF.js v6.3.289 の説明](https://github.com/mozilla/pdf.js/blob/v6.3.289/external/standard_fonts/README.md)によると、現 Liberation は 1.07.4 で GPLv2 とフォント例外の適用対象。`LICENSE_LIBERATION` はあるが、`.ttf` 以外の編集用元データは Git で確認できず、GPLv2 の対応ソースの扱いを確認すべきである。新版の OFL フォントとの混同に注意する。
5. **その他の実ファイル。** Tauri/Papeer のアイコン画像と `tests/fixtures/sample.pdf` も Git で配布される。PDF は「synthetic test document」と書かれた 2 ページの合成例で、実論文の混入は見えないが、作成者と画像・文章の来歴はファイルだけでは確定できない。アイコンも作成来歴を確認する。
6. **OCR のテスト画像。** `tests/fixtures/ocr/` の PNG 3 件（計約 300KB）は、自作の文章・図・数式の合成ページを 300 dpi で画像にしたもので、実論文は含まない。作成は `tools/make_ocr_fixtures.py`。ただし文字は Windows 付属のフォント（Times New Roman、Arial、Cambria、游明朝、游明朝 Demibold（yumindb.ttf））の字形を画像にしたもので、フォントのファイルそのものは含まない。フォントで組んだ文書の画像を配布することは通常フォントの再配布には当たらないが、Microsoft のフォント利用条件を公開前に確認する。気になる場合は、再配布の条件が明確なフォント（同梱の Source Han や Liberation）で作り直せる。
7. **OCR の言語データ（実行時に取得）。** OCR（試験中。既定では論文を追加したときに読むかを確かめる）は Tesseract の言語データ tessdata_fast 4.1.0（`eng`・`jpn`、Apache-2.0、[tesseract-ocr/tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast/tree/4.1.0)）を使う。Git には含めず、利用者の確認を取ってから `raw.githubusercontent.com` から取得し、SHA-256 を確かめて各 PC の `%LOCALAPPDATA%\PapeerSync\tessdata\fast` に置く（`papeer/layout/ocr_engines.py`）。取得時に GitHub へ送られるのはファイル名の要求と通常の HTTP 情報だけで、論文やページの画像は送らない。OCR 自体は PC の中で行う（Tesseract、Windows.Media.Ocr、macOS の Vision）。例外は利用者が 1 ページずつ選ぶ「AI で読み直す」で、そのページの本文の領域の画像を、確認の文で伝えたうえで今の AI 接続（Claude Code・Codex・API）に送る。後日インストーラーに言語データを同梱するなら Apache-2.0 の通知を付ける。CI と開発者のテストは、明示したときだけ同じデータを取得する（`PAPEER_TEST_DOWNLOAD_TESSDATA=1`）。

### 今回のソースリポジトリで整えるもの

本体の AGPL 本文、著作権者、無保証と `or later` の選択を明確にする。Git に同梱する第三者素材の元の著作権・免責・ライセンス文はそれぞれ維持する。[AGPLv3 §4–5](https://www.gnu.org/licenses/agpl-3.0.html)と[GNU のライセンス表示指針](https://www.gnu.org/licenses/identify-licenses-clearly.html)。依存を `uv`、`pnpm`、`cargo` が後から取得する場合、作者がその全パッケージのコピーを今回再配布するわけではないので、インストーラー向け `THIRD_PARTY_NOTICES` を先に作る必要はない。

Liberation フォント 1.07.4 の上流には[編集用 SFD ソースへの案内](https://github.com/liberationfonts/liberation-1.7-fonts)がある。Git に含む 4 つの TTF と正確に対応する版・元データを確認し、GPLv2 のソース提供方法を整理する。対応が煩雑なら、フォント実体を Git から外してビルド時に元パッケージから取得する方法も考えられる。この場合はクローンからのビルド手順とライセンス表示を維持する。

後日インストーラーやホスト型サービスを作者が提供するなら、AGPL §6/§13、PyMuPDF・PDFium 等の通知、Mermaid/ELK の結合ライセンス、利用者データの取扱いを改めて評価する。**今回はその形態を予定していない**。なお AGPL が適用されるのはプログラムであり、利用者が作った訳文 PDF が自動的に AGPL になるわけではない（AGPL §2）。

## 2. Codex、Claude Code、Antigravity を使う条件

**リポジトリの公開と、公開後に誰かが CLI にログインして実行する行為は別**。今回の Git 追跡対象に三つの CLI のバイナリ・認証情報はない。ソースを置くだけで作者が各 AI サービスを利用した、あるいは規約に違反したとは言えない。一方、README は利用者に接続を案内しているため、実行する本人に適用される規約を正確に説明する必要がある。現コードは端末の `codex exec`、`claude -p`、`agy --print`（本文は標準入力）を呼び、API 接続は利用者指定の `/chat/completions` に送る。[providers/](../papeer/providers/)、[README](../README.md)。開発者がコーディング補助に使った際の規約・生成コードの権利も、利用者が翻訳に使う際の規約とは分けて扱う。

| 接続 | 技術的な公式機能 | ローカルで実行する人への注意 |
| --- | --- | --- |
| Codex | [`codex exec` の非対話実行](https://learn.chatgpt.com/docs/non-interactive-mode)が公式に文書化されている。 | CLI 実行自体は公式機能。[個人向け利用規約](https://openai.com/policies/row-terms-of-use/)の自動的な Output 抽出禁止と、一般論文翻訳を個人枠で継続実行する場合の関係は明示されていない。本人のプラン条件を確認する。作者によるソース公開そのものの禁止と読み替えない。 |
| Claude Code | [`claude -p`](https://code.claude.com/docs/en/headless)は公式の非対話機能。 | [法務文書](https://code.claude.com/docs/en/legal-and-compliance)は本人が未改変 CLI にログインする形を認める一方、第三者アプリによる Free/Pro/Max 認証の代理利用を制限する。Papeer のローカル自動起動がどちらに該当するかは明確でない。本人が利用条件を確認し、不明なら Anthropic に照会する。 |
| 個人向け Antigravity | [`agy -p`](https://antigravity.google/docs/cli/headless/)は文書化されている。 | [追加規約 §6](https://antigravity.google/terms)は第三者製品との連携と第三者ソフトによるアクセスを明文で禁じる。Papeer 経由のローカル実行には強い規約上の懸念がある。作者がソースを公開する行為とは区別しつつ、README の「対応済み」案内を改める。[企業向け経路](https://antigravity.google/docs/enterprise)には別規約がある。 |
| OpenAI 互換 API | 現コードは利用者が設定した URL へ HTTP リクエストを送る。 | 接続先ごとに規約、データ保持、学習設定が違う。設定する本人が確認する。 |

現在の API 実装は `/chat/completions` 形式である。[Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create)や[Google Gemini API](https://ai.google.dev/gemini-api/docs)とは形式が異なるので、将来これらを正式に直接サポートするなら別の実装が必要になる。

**データと生成物。** [OpenAI 個人向け規約](https://openai.com/policies/row-terms-of-use/)は入力の権利を利用者に残し、利用者と OpenAI の間で出力の権利を利用者に譲渡するが、入力する権利を利用者が持つことを求め、出力の非侵害・正確性を保証しない。個人プランでは学習利用のオプトアウト設定がある。OpenAI API では[データ管理文書](https://developers.openai.com/api/docs/guides/your-data)により原則として明示的な同意なしに学習へ使わず、通常の不正利用ログは最長 30 日などの条件がある。Codex の `--ephemeral` はローカルのセッション記録に関する指定で、サーバー側のゼロ保持ではない。[OpenAI Service Terms](https://openai.com/policies/service-terms/)の知財補償には入力権利欠如、出力の改変・組合せ等の除外がある。

[Anthropic の商用規約](https://www.anthropic.com/legal/commercial-terms)は入力権利の維持、出力の権利移転、原則として顧客コンテンツを学習に使わないこと、条件付き知財補償を定める。[消費者規約](https://www.anthropic.com/legal/consumer-terms)は別条件であり、同じ知財補償を前提にできない。`--no-session-persistence` はローカル保存の抑制である。`--tools ""` は組込みツールだけを止める指定なので、`--strict-mcp-config` と空の `--mcp-config` で MCP サーバーを読み込まず、`--setting-sources user` でプロジェクト・ローカル設定を、`--disable-slash-commands` でスキルを外している（2026-09）。利用者本人のユーザー設定（hooks を含む）は読み込むため、信頼できない PDF 本文がプロンプトに入る以上、送信先と利用可能なツールの境界は CLI の更新ごとに監査する。今後の候補として、Claude Code 2.1.283 にある `--safe-mode`（CLAUDE.md・スキル・プラグイン・hooks・MCP サーバーなどの利用者設定をまとめて無効化）への切り替えを検討する。Antigravity（`agy`）は実行ごとに MCP サーバーやプラグインを止める指定がなく、`--sandbox` 以外の制限をかけていない点も今後の課題である。[Claude CLI リファレンス](https://code.claude.com/docs/en/cli-reference)、[headless 説明](https://code.claude.com/docs/en/headless)。

[個人向け Antigravity 規約](https://antigravity.google/terms) §3、§5 は Interaction の保存、製品・モデル改善、人による閲覧の可能性を明示する。設定で改善利用を抑える項目はあるが、処理に必要な送信がなくなるわけではない。開発時に AI が生成したコードも「AI 出力だから自由に配布できる」とは扱わず、既存 OSS からの実質的な転載と依存ライセンスを確認する。[OpenAI Service Terms](https://openai.com/policies/service-terms/) §4 は Codex 生成コードに第三者 OSS ライセンスがかかり得ると明記する。

## 3. 論文・翻訳結果の著作権と個人情報

今回の Git 追跡対象には、利用者の論文原本や翻訳出力はなく、`tests/fixtures/sample.pdf` が 1 件ある。利用者がクローン後にアプリをローカル実行する場合、作者が当然にその人の論文や会話を受け取るわけでもない。以下は**利用者が PDF を処理・共有する際の注意点と、README で説明すべき動作**である。

日本法では翻訳・翻案は原著作者の権利で、翻訳後も元の著作物に関する権利が残る。Papeer の**ソースコードを配布**することと、出版社等の権利がある論文の**翻訳 PDF や図表入りの対訳 PDF を公開**することは違う。[文化庁 FAQ](https://www.bunka.go.jp/seisaku/bunka_gyosei/kibankyoka/faq/index.html)。個人的な読書の例外を、翻訳文の一般公開や、事業者が受け取って処理するサービスへそのまま広げられない。AI 学習・情報解析に関する著作権法 30 条の 4 も、閲覧目的の翻訳と共有を一律に許可する規定ではない。[文化庁の AI と著作権資料](https://www.bunka.go.jp/seisaku/chosakuken/aiandcopyright.html)。

オープンアクセスは自由な再配布の同義語ではない。論文ごとに版・出版社契約・ライセンスを確認する。例えば [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) は出典・変更表示等の条件で翻案共有を許し、[CC BY-ND 4.0](https://creativecommons.org/licenses/by-nd/4.0/) は翻案物の共有を許さない。[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) は非営利の範囲に制限し、[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) は同種ライセンスの条件が加わる。訳文のみでも原文の翻案に当たり得るし、原文ページ・図表入りの出力では複製の問題も強くなる。デモやスクリーンショットには権利確認済み、または自作の論文を使う。リポジトリの `tests/fixtures/sample.pdf` も作成者・素材の来歴を確認する。

利用者向け説明には、①取込時はローカル、②どの操作で本文・質問履歴をどの AI へ送るか、③ローカルで保存する原本・抽出テキスト・訳文・会話の場所と削除方法、④各社の学習・保存設定はアカウントと契約に依存すること、⑤論文の入力・翻訳共有の権利確認、⑥翻訳の誤りと学術利用時の原文確認、を明記する。[個人情報保護委員会の生成 AI 利用注意喚起](https://www.ppc.go.jp/files/pdf/230602_alert_generative_AI_service.pdf)は個人データの利用目的、入力先での学習利用の確認を求める。サーバー型へ移行する場合、開発者自身が原本・個人データを受領するため、契約・プライバシー対応を再設計する。

## 4. 翻訳方式の特許、公開時期、商標

「PDF のレイアウトを保って AI 翻訳する」という題目や実装の類似だけでは侵害は判断できない。**有効な国別権利の請求項の全要件**を、実際のコードと行為に照合する。日本の特許法はプログラム等とそのネットワーク提供も想定するため、「実行ファイルや製品を売らず、ソースだけ」という事実が特許の全面免除になるわけではない。[JPO の説明](https://www.jpo.go.jp/system/laws/rule/hokaisei/tokkyo/houkaisei_h140417/houkaisei_gaiyou.html)。他方、今回の検索では具体的な有効権利への該当を示せていない。公開公報の「A」は審査後の権利範囲を示すものではない。[JPO の特許検索案内](https://www.jpo.go.jp/support/startup/tokkyo_search.html)、[権利状態・原簿の説明](https://www.jpo.go.jp/system/process/toroku/genbo_about.html)。今回の検索は網羅的 FTO ではなく、出願経過・年金・同族出願の確認も残る。

| 候補文献 | 実装との関連と未確認点 |
| --- | --- |
| 中国 `CN122197914A` | 外部の特許索引で見つけた**調査候補**。**CNIPA 個別公報の原文・審査経過を取得できておらず、番号に対応する請求項・日付・現在の状態は一次資料で未検証**。この候補だけから実装との一致や有効な権利の存在を判断しない。中国での頒布・利用が重要になるなら[CNIPA が案内する公報と審査情報](https://www.cnipa.gov.cn/jact/front/mailpubdetail.do?sysid=6&transactId=528968)で原本を照合する。 |
| 日本 `JP2025086623A` | [日本国特許庁発行の公開公報 PDF の複製](https://patentimages.storage.googleapis.com/39/be/42/ae7a6be8a301df/JP2025086623A.pdf)で、2025-06-09 公開、出願 `JP2023-200719` と請求項を確認。請求項 1 はレイアウト済みの文字データから抽出すべきテキストを**推定**し、翻訳に供する装置。Papeer の文字抽出・整形・翻訳との関係は「推定」の解釈を含め専門判断が必要。請求項 2 は生成 AI に抽出対象の推定をさせる限定で、Papeer の主な選別はローカル処理だが、これだけで非侵害とは言えない。公報発行時は審査請求「未請求」。**現在の審査・登録状態は未確認**。[J-PlatPat](https://www.j-platpat.inpit.go.jp/)。 |
| 米国 OpenText 系 `US11227101B2`、`US11720743B2`、`US12159098B2` | USPTO に[11227101](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11227101)、[11720743](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11720743)、[12159098](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/12159098)の登録公報がある。形式に依存しないビューア用の中間表現での翻訳表示を中心とする系列で、PDF 専用・訳文 PDF 生成型の Papeer と違いがある。ただし請求項の正式な全要件照合、存続と継続出願の調査は未了。米国での利用・頒布が重要になる場合は専門家の確認が必要。 |

中国では、公開後・登録前でも一定の条件で実施に対する費用請求の制度があり、「未登録なら常に無関係」とは言えない。[CNIPA 特許法 §13](https://www.cnipa.gov.cn/art/2020/11/23/art_97_155167.html)。ただし上記中国出願について個別の権利状態を確認したという意味ではない。Papeer の実装比較に関係する箇所は[抽出・読順](../papeer/pdf/pdf_engine.py)、[翻訳処理](../papeer/core/translation_run.py)、[PDF 生成](../papeer/pdf/pdf_engine.py)。

Papeer 固有の新技術を出願する意向があるなら、**GitHub でソースを公開する前**に弁理士へ相談する。日本の新規性喪失の例外には公開後 1 年以内、出願時の申出や証明資料の期限など条件があり、外国の制度は異なる。[JPO 手引き](https://www.jpo.go.jp/system/laws/rule/guideline/patent/document/hatumei_reigai/h30_tebiki.pdf)。また OSS プロジェクト名にも商標上の論点は残る。「Papeer」「ペーパーデスク」および類似の称呼・指定商品役務について、[JPO の商標検索案内](https://www.jpo.go.jp/support/startup/shohyo_search.html)に従う調査は未了。

## 5. ソース公開前に実施する順序

1. **公開対象を Git 追跡ファイルで固定**する。リリース添付、GitHub Actions の成果物、Web サイトのダウンロード欄にも実行ファイルを置かないことを確認する。今回の判断はリポジトリのみを対象とする。
2. **本体の権利表示を整える。** `AGPL-3.0-or-later` と著作権者を README、パッケージメタデータ、代表的なソースヘッダで矛盾なく示す。Git の既存 41 コミットには作者・コミッターの通常形式のメールアドレスが含まれる。履歴ごと公開するなら本人が公開を許容できるか確認する。追跡ファイルを主要な秘密鍵・API キー形式で検索した範囲では実値らしいものは見つからなかったが、過去 blob の網羅監査は未実施。
3. **実際に同梱する素材を確認**する。Source Han/CMap/Foxit の既存ライセンス文を維持し、Liberation 1.07.4 の GPLv2 対応ソースを確認する。アイコンの原画と合成テスト PDF の作成来歴・再配布権を記録する。
4. **README の AI 接続案内を正す。** ソース公開自体と利用者の実行を分け、Antigravity 個人規約との衝突可能性を明示する。Codex・Claude の利用可否を一律保証せず、本人の契約プラン確認を促す。翻訳・解説・質問で送る本文、関連ページ、会話履歴、ローカル保存先を具体的に記す。[個人情報保護委員会の注意喚起](https://www.ppc.go.jp/files/pdf/230602_alert_generative_AI_service.pdf)。
5. **特許出願の意向を公開前に決める。** OSS の公開は発明の新規性に影響する。第三者特許については、候補の登録・請求項と配布国を確認し、具体的懸念が残る場合に専門家へ FTO を依頼する。Papeer 名の商標検索も行う。
6. **利用者が実行するコードの安全性を別途点検**する。ローカル API トークンは起動ごとに OS の乱数生成器で作る 256 bit の値に改め、トークンなしでは sidecar が起動せず、URL クエリに載る分もアクセスログに出さないようにした（2026-09）。Tauri には CSP を設定済みで、スクリプトはアプリ自身のもののみ、通信先は IPC と起動時に決めた sidecar のポート（`127.0.0.1` の 1 ポート）に限る。Mermaid は `securityLevel: "strict"` で描画し、解説・メモの Markdown は `file:` などのリンクを表示しない。sidecar の CORS は本番では Tauri のオリジンだけを許可し、書き出し・バックアップ・辞書の保存先にライブラリ内は選べない（2026-09）。ソース公開のライセンス義務ではないが、利用者の PDF を扱うツールとして今後も点検を続ける。[Tauri の CSP 説明](https://tauri.app/security/csp/)、[OWASP のトークン指針](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)。

この文書の現状確認は Git 追跡ファイル、コード、ロックファイル、手元のビルド成果物と公開資料による。GitHub Release 等で後にバイナリを追加した場合、この結論はそのまま適用できない。

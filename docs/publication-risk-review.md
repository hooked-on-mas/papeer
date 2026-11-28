# Papeer の公開・配布レビュー

更新日: 2026-10-18。対象はソースリポジトリ、GitHub Pages、Actions の成果物、デスクトップインストーラー。以前の「ソースだけを公開する」という前提は使用しない。これは実装・配布条件の確認記録であり、個別契約や特許についての法的意見ではない。

## 公開経路

| 経路 | 配布対象・条件 |
| --- | --- |
| GitHub リポジトリ | ソース・ロック・PDF.js データとフォント・テスト素材。履歴も公開対象で、第三者素材の表示と対応ソースを維持する。 |
| GitHub Pages | Web アプリと publicDir の素材。依存監査を通してビルドし、LICENSE・SOURCE.md・licenses.md・フォント通知を同梱する。 |
| Release の通常実行 | 各 OS のビルドと検査のみ。インストーラーを Artifacts へアップロードしない。 |
| Release の明示的配布 | vタグの手動実行で publish_installers を有効にする。各 OS のインストーラーと台帳を公開配布として扱う。 |

公開リポジトリの Actions artifacts は読み取り可能な GitHub 利用者が取得でき、Release が draft でも非公開にはならない。[GitHub の説明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts?tool=webui)。既存 Release は draft も含めて置換しない。変更は新しい版で配布する。

## ライセンスと素材

本体は AGPL-3.0-or-later。ルートの LICENSE、README、Python/JavaScript のパッケージ情報で表記する。第三者素材のライセンスは維持する。配布版に対応するソース・ビルド手順は [distribution-source.md](distribution-source.md)。公式版は同じ vタグのソースを使い、改変版の配布者は自分の改変を含む対応ソースを提供する。[AGPL 原文](https://www.gnu.org/licenses/agpl-3.0.html)。

Source Han は隣接する OFL と出典、PDF.js CMap・Foxit は元の著作権・ライセンス表示を維持する。Geist の OFL は両フロントエンドへコピーする。

PDF.js 同梱の Liberation Sans 1.07.4 は GPLv2 とフォント例外の対象。新しい OFL 版へ単純に差し替えると PDF.js の字形番号・幅と一致しない。現在の TTF と編集用ソース・再生成手順・由来の記録を一緒に提供する。ソース資料も frontend/public/pdfjs/standard_fonts/ から Git・Pages・デスクトップへ配布する。詳細は同ディレクトリの README を参照する。[PDF.js の説明](https://github.com/mozilla/pdf.js/blob/v6.3.289/external/standard_fonts/README.md)。

Mermaid 経由の EPL-2.0 elkjs は、Vite の解決時にアプリ内の非対応表示へ置換し、ELK 本体がビルドのモジュールに入った場合は失敗させる。通常の Dagre 図は維持する。依存ロックに名前が残ることと完成アプリへの同梱は区別する。[ELK のライセンス](https://github.com/kieler/elkjs/blob/0.9.3/LICENSE.md)、[FSF の説明](https://www.gnu.org/licenses/license-list.html#EPL2)。

PyInstaller は tools/distribution_notices.py で Python・Rust 依存、CPython・PyInstaller・PDFium の通知を収集する。PDFium の BUILD_LICENSES 等が欠けたビルドは配布しない。インストーラー作成後も展開された sidecar の通知を検査する。台帳は各 OS で生成し、配布時にはロックとの一致と通知の根拠を検査する。[pypdfium2 の条件](https://github.com/pypdfium2-team/pypdfium2/blob/5.13.0/README.md#licensing)。

OCR fixture は合成文章の画像で、Windows フォントのファイルを配布するものではない。[Microsoft FAQ](https://learn.microsoft.com/en-us/typography/fonts/font-faq)。既存のアプリアイコンと tests/fixtures/sample.pdf は、2026-10-18 に所有者から「両方とも自作で公開可能」と確認した。元の素材を維持し、確認記録は papeer/core/assets/README.md と tests/fixtures/README.md に残す。

## AI 接続と利用者データ

Antigravity は接続一覧から除外し、以前の antigravity / gemini 設定からの起動も拒否する。[個人向け追加規約 §6](https://antigravity.google/terms) が第三者ソフトからのアクセスを禁止しているため。企業向けの例外を一律に適用可能とは扱わない。残存する旧 transport はアプリの登録・起動経路には含めない。

Claude Code は未改変の公式 CLI を利用者本人が公式フローで認証し、Papeer が認証情報を代理取得・保管してサービスを再販する構成にはしない。[Anthropic の条件](https://code.claude.com/docs/en/legal-and-compliance)。Codex・API も本人の契約とプランに従う。

PDF の追加だけでは AI へ送信しない。翻訳・サマリー・質問・明示した AI OCR では本文・文脈・画像を選択した接続先へ送る場合があり、「短い引用だけ送る」とは説明しない。利用者は原稿・未公開情報・出版社契約などの送信・翻訳・再配布条件を確認する。訳文 PDF がアプリの AGPL だけを理由に自動的に AGPL になるわけではない。

Web 版は Google と Drive API に直接接続し、トークンはメモリーとタブ単位の sessionStorage に保持する。Googleが発行した有効期限は延長せず、期限切れの検出・401応答・ログアウト時に削除する。localStorage・IndexedDB・Service Workerのキャッシュには保存しない。同一オリジンで実行するJavaScriptからは参照できるため、HTML資料のsandboxとCSPを維持する。スコープは drive.file。デスクトップの更新トークンは Windows DPAPI で保護し、ライブラリや Pages へ含めない。OAuth client ID は公開情報で、利用者の access/refresh token とは区別する。ネイティブアプリに組み込む client secret は秘密の保管手段とは扱わず、PKCE と state も使用する。

## 監査と履歴

依存監査は just audit。Python・JavaScript・Rust を対象にし、CI と配布のゲートでも実行する。不要な shadcn CLI を除外し、DOMPurify・KaTeX・source-map-js の間接依存も pnpm-workspace.yaml で修正版へ上げる。依存を変えたら台帳を再生成する。監査の成功は未知の脆弱性の不存在を保証しない。

Rust には Linux の依存経路で5件の警告が残る。glib の未修正の unsoundness も含み、cargo audit の終了コード0はこれらの解消を意味しない。Windows/macOSでは対象crateは非選択。対応状況と上流の制約は [rust-dependency-review.md](rust-dependency-review.md) を参照する。

2026-10-18に全9公開ブランチの履歴を修復し、大学メール・個人Gmail・実名・個人パスを除去した。再取得した全ブランチとPR 1〜7のhead/merge参照で確認対象は0件。対応は [history-remediation.md](history-remediation.md)。古い履歴を祖先に持つローカルブランチをmerge/pushして再混入させない。旧SHA直接アクセスのキャッシュは残っており、GitHub Supportへの削除依頼が必要。

配布形態・依存・サービス条件を変更したときは文書と実成果物を再確認する。本レビューは特許の非侵害調査、各論文の権利調査、個別契約確認を代替しない。

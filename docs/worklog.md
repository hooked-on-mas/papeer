# 作業ログ

新しいものを上に書く。1作業＝数行。**解決した失敗の詳細は消してよい。** 未解決の問題だけ「未解決」節に残す。

## 未解決

- `e2e/tests/library/composition/webDocumentConflict.browser.test.ts` は Chromium 通過、WebKit は `documentComposition.ts` の PDF 起動・同期待ちタイムアウトで未通過（`webLibraryConflict` 等は両 engine で通過）。
- `e2e/webDocumentTools.browser.test.ts` は Chromium 通過・WebKit のみ 330 行目のテキスト入力中 SVG フォーカス確認で失敗（通常入口の `webOrdinaryTextRefusals` 等は両 engine で通過）。
- 旧仮画面 UI 前提の残り `web*.browser.test.ts` と `e2e/support/ordinaryCatalog.ts` 等は未更新（主要 E2E のみ M1.5 新 UI へ追従済み、残り旧 E2E の整理・削減は未了）。

## 記録

### 2026-11-26
- M3（Web PWA 配信準備・iPad オフライン利用 UI）の実装と検証を完了（実機確認・Pages 配信待ち）。本番 Web での Service Worker 自動登録と安全時のみ更新再読み込みする通知バー・ホーム画面追加案内（`WebPwaRuntime`）、起動画面・サイドバーからのオフライン利用許可／パスフレーズ起動 UI の復元と整形、Node 24 strip-only 互換修正、および Pages CI 向け `test-web.mjs` の主要スイート整理・オフライン E2E 追従を反映し、実画面スクリーンショットと独立レビュー承認を確認。

### 2026-11-23
- `dev:web` 起動時の PDF 取込み失敗を修正：`vite.web.config.ts` の Vite 最適化キャッシュを `node_modules/.vite-web` へ分離して遅延読み込み PDF/Markdown 依存を事前最適化し（`504 Outdated Optimize Dep` 解消）、Web 側リポジトリ証跡生成での `Uint8Array` 巨大 JSON 化回避と添付／PDF 取込み失敗時の安全な警告ログ出力を追加。

### 2026-11-22
- M2 実機確認 Phase 1 で見つかった Google Drive 連携の不具合を修正：ファイル作成直後の非同期 `version` 更新・`sha256Checksum` 後追い付与を前提とした検証および新規作成直後の短期リトライ対応、ログイン・一覧取得（`list`）時の不要な記述子再検証削減・並列化による往復回数削減、未完了作成リクエスト待機中の文言修正を実施。
- M2（実 Google Drive 同期）に向けた事前実装・整備を実施（実機確認待ち）。Web 側の 4 MiB 超チャンク resumable upload、PC 側の `list_files` ページング上限引き上げとランダム multipart 境界、PC 起動時の保存済み DPAPI トークン自動再接続・終了時保持（`reconnect-saved` / `release`、オフライン編集中ガードとフォールバック時の grant 回収・スコープ限定無効化を含む）、サイドバー同期ステータス表示と F35 競合パネル整形、起動画面の `<label htmlFor>` 修正および E2E 追従を反映。
- M1.5（普段使いできる GUI の復元）を完了。`WorkspaceChrome`・`LibraryRows`・`components/ui/*` を使った左リサイズ可能サイドバー（iPad 狭幅は選択後自動で閉じるオーバーレイ）・アイコン付きツリーと行メニュー・コンパクトな 2 段リーダー＆書き込みバー・各種ダイアログへ載せ替え、実画面スクリーンショットと主要 E2E（Chromium／WebKit）の通過を確認した。
- 実機確認①で本番入口が仮画面（素の HTML ボタン縦積み）のままだったことが判明。M2 の前に M1.5（元の Papeer 風 GUI の復元）を差し込み、主要 E2E のみ追従・仮画面前提の旧 E2E は整理削減する方針と、GUI 変更時の見た目確認ルールを [plan.md](plan.md)・[AGENTS.md](../AGENTS.md) へ反映した。
- M1（編集機能の仕上げ）を実施。`LibraryCatalogPanel` の WebKit 再起動後の一覧最大高さ不具合（B1）を修正し、`sharedFeatureEntries.test.mjs` で R29 の PC・Web 共通 feature モジュール import 検査を追加した。
- 旧 P4.1／P4.3 の判断待ちを利用者確認で確定し（D2〜D7・B2・D1・G-D1 は現状維持／§5 へ整理、外部リンクのみ実機確認①で確認）、backend 旧 v1 由来テスト 2 件の整理後に M1 マイルストーン末検証（全型・lint・Python/TS unit・A区分通常 Web テスト）を通過した。
- M0 完了（片付けと進め方の切り替え）。B14-4 と v2 切替前に入った B14-5a の完了・コミット後、旧 v1 文書 12 件を `docs/archive/shared-app-v1/` へ移動し、試用版配布ツール（`tools/trial/`）の作業を停止。
- backend 全テストを 1 回実行し、上記の旧 v1 由来 2 件を除き通過したため Sidecar のディレクトリ整理を完了扱いとした。
- 計画を v2（[plan.md](plan.md)）へ作り直した。67要件をA44／B17／C6に仕分け、移行は一時スクリプト、試用版配布ツールは廃止、作業ルールを [AGENTS.md](../AGENTS.md) にまとめた。

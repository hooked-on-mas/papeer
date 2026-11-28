# M4 データ移行・バックアップ／復元手順（1枚版）

旧 PC 版のデータ（`%LOCALAPPDATA%\Papeer` 等）は**一切書き換えずに読み取り専用で変換**し、新形式（`%LOCALAPPDATA%\.Papeer-shared-app\content.sqlite3`）へ取り込みます。失敗時はバックアップからそのまま旧環境へ戻せます。

---

## 1. 事前準備（必須：旧アプリの終了とフルバックアップ）

1. 起動中の Papeer（旧版・開発版とも）をすべて閉じる。
2. 現在の旧データ内容を確認する（読み取り専用）：
   ```powershell
   uv run python tools/migrate_legacy_data.py inspect
   ```
3. 旧データフォルダーとデバイス設定（`PapeerSync`）を丸ごとバックアップする（ファイル数・総バイト数の自動照合あり）：
   ```powershell
   uv run python tools/migrate_legacy_data.py backup --backup-dir C:\Backup\papeer-legacy-20261128
   ```
   `backup-manifest.json` が作成され、エラーなく終了したことを確認する。

---

## 2. 移行の実行（おすすめ：Google Drive 同期つきで PC・iPad 共有）

> **事前に開発モードで動作確認したい場合**は、`--target-data-dir <別フォルダー>` ＋ `--title "移行テスト"` で先にローカル確認できます。

1. 新 PC アプリ（開発モード、または手順 3 で上書きインストールした本番版）を起動し、Google Drive に接続して**空の新規ライブラリ**（例：`研究ライブラリ`）を作成する。
2. **PC アプリを閉じる**（SQLite ロックを避けるため）。
3. 作成したライブラリの UUID を確認する（本番データ先を使う場合は `--target-data-dir` を省略可）：
   ```powershell
   uv run python tools/migrate_legacy_data.py targets --target-data-dir "$env:LOCALAPPDATA\Papeer"
   ```
4. 対象ライブラリの `libraryId` を指定して移行を実行する：
   ```powershell
   uv run python tools/migrate_legacy_data.py migrate `
     --target-data-dir "$env:LOCALAPPDATA\Papeer" `
     --library-id "<確認したUUID>" `
     --translations ink-only
   ```
   - `--translations ink-only`（既定）：翻訳側に書き込みがある PDF のみ `translated.pdf` を添付（容量節約）。全翻訳 PDF を含める場合は `--translations all`、原文のみなら `--translations none`。
   - 同じ `--library-id` へ再実行しても重複作成されない（冪等）。
5. PC アプリを起動して該当 Google Drive ライブラリを開く。
   - PC 上では即座に全資料・フォルダー・書き込み・Markdown・HTML 添付が閲覧できる。
   - バックグラウンド同期が自動で各 PDF・編集レコードを Google Drive へ順次アップロードする（途中中断しても再開可）。
   - アップロード完了後、iPad（https://hooked-on-mas.github.io/papeer/ ）で同じ Google Drive ライブラリを開くと全データが同期される。

---

## 3. PC 版インストーラーのビルドと上書きインストール

1. バックアップ（手順 1）が済んでいることを確認し、通常インストーラーをビルドする：
   ```powershell
   just build
   ```
2. `frontend/src-tauri/target/release/bundle/nsis/` のインストーラーを実行して上書きインストールする。

---

## 4. 失敗時の復元（ロールバック）手順

万一、新環境での移行・切り替えに問題が出た場合は、次の手順で旧環境へ戻せます：

1. Papeer を完全に終了する。
2. 新形式フォルダー（`%LOCALAPPDATA%\.Papeer-shared-app`）を別名退避または削除する。
3. 旧フォルダーが変更されている場合のみ、`C:\Backup\papeer-legacy-20261128\Papeer` と `PapeerSync` を元の場所（`%LOCALAPPDATA%\Papeer`、`%LOCALAPPDATA%\PapeerSync`）へ戻す。
4. 旧版インストーラーを再インストールすれば、元の状態で再開できる。

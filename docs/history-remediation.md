# 公開履歴の個人情報修復

2026-10-18、GitHub上の全9ブランチの履歴修復を反映した。大学メール・個人Gmail・実名・個人のWindows絶対パスを対象とし、原文や旧SHAは本書へ転載しない。

## 反映内容

- feature/notes-foundation の301コミットで大学メールのauthor/committerを公開loginとGitHub noreplyへ変更し、過去の実験コード5ファイルの個人パスを汎用化した。
- mainとDependabotの7ブランチの履歴にある個人GmailをGitHub noreplyへ変更した。
- 全ブランチの現行・過去のCargo.tomlの実名を公開loginへ変更した。現在のソース差分はこの作者表記のみで、実行コード・依存の内容は維持した。
- 各ブランチの更新前先端が一致することを検査し、9ブランチを明示したforce-with-leaseとatomic pushで反映した。無条件のforce、mirror push、all pushは使用していない。
- 変更されたDependabotコミットの旧署名は無効になるため除去した。署名を再作成したという意味ではない。

## 再取得による検証

GitHubから隔離cloneへ取り直し、全9ブランチおよびPR 1〜7のhead/merge参照、合計23 refs、328コミット、4,332 blobsを検査した。確認対象の実名・個人メール・個人パスは0件。全コミットのメッセージ・日時・親の順番を維持し、Gitの整合性検査も成功した。公開タグ・Release・forkは確認時点で0件。

## 残るキャッシュとローカルコピー

旧コミットのSHA直接アクセスは反映後もHTTP 200で参照できた。GitHub側のキャッシュ・旧参照の完全削除には[GitHub Supportへの依頼](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)が必要で、対応可否はGitHubが判断する。依頼文と詳細なローカル検証記録は公開しないtmp配下に保存した。依頼は未送信。

元の作業treeと隔離レビュー用cloneには古い履歴を保持している。未コミット変更は維持した。これらの古いブランチを直接merge/pushすると個人情報が再混入するため、公開用変更は修復後mainを土台にした別checkoutから反映する。作業リポジトリの今後のコミット作者は公開loginとGitHub noreplyに設定した。グローバルGit設定は変更していない。

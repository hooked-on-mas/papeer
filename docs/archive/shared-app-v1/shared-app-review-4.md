# PC・Web共通化設計・計画の最終Solレビュー

実施日: 2026-10-24

対象: [設計書](shared-app-design.md)、[計画書](shared-app-plan.md)、[初回記録](shared-app-review.md)、[第2回記録](shared-app-review-2.md)、[第3回記録](shared-app-review-3.md)

結果: **別の5名が独立レビューし、全員が新規P1/P2なしと回答。採用設計・工程・受入条件の追加変更なし。**

## 1. 方法と対象版

5名のSol subagent（全員`gpt-6.1-sol`、reasoning high）が同じ版の5文書を静的確認し、担当領域の関連コード・仕様・テスト構成と照合した。重大な設計矛盾、データ消失、操作不能、達成不能な保証を具体的な反例で探し、表現・好みだけで指摘数を埋めない方針とした。既存RV01〜RV29の解消済み内容も単純再掲しない。

全員の結果が揃うまで対象文書を変更していない。今回の変更は、この記録の追加と既存文書からの参照追加のみ。アプリコード変更・試験実行は行っていない。

レビュー開始時のSHA-256:

```text
shared-app-design.md    2584f31d0d85e709e381049d5fe9152fa04a1f7eb17d75dbe6d30da490d6807a
shared-app-plan.md      ae1c62a5e1ab835c4bed7cde4ca1ae49a59e68751d4c0541d04a758473cb8de4
shared-app-review.md    0fdface202edd604697e9c559dd5dc07e840851a757bb03290dd2d71926e50c7
shared-app-review-2.md  305b2fbaada74d0ac7c4d6116eb06a022a4a9615560eaf41e8607a47ada90c0d
shared-app-review-3.md  e65468f49352d47494a13c1890ee10f36bcc4ae7f180584d068e0045a28891e8
```

## 2. 5名の結果

| 担当 | 主な確認・反例 | 結果 |
| --- | --- | --- |
| 保存・同期・競合 | 文書DAG、親待ち、全親を持つ解決batch、結果不明時の冪等確定/逆batch、checkpoint、全領域backup/epoch切替 | 新規P1/P2なし |
| Reader・入力 | 左右異寸法の倍率/resize/active側切替、mapping更新中の編集、本文選択/handle→pinch/取消、遅延描画とrestore | 新規P1/P2なし |
| 編集・Workspace | geometry、全tool、選択変形、履歴、NoteSession/append、clipboard、export、二重mount、保存中追加編集、remote更新、panel/中央移動 | 新規P1/P2なし |
| Library・削除回復 | owner削除対後着編集/子追加、循環移動、削除後Undoと新本文、回復一覧/検索/本文への到達、内容を巻き戻さない復元 | 新規P1/P2なし |
| 工程・検証 | M1〜M5の前提と出口、共通entryへの両本番graph/実行trace、port内独立実装の撤去、TS/Python適合fixture、移行/中断/rollback/両build/実機記録 | 新規P1/P2なし |

検討したが新規指摘にしなかった例:

- 複数選択の非等方拡縮がshearを必要とするケースは、現行PCの等方scaleと目標の非shear範囲を超えており、採用仕様の矛盾とは扱わなかった。
- exportは未耐久の確定編集を含むsnapshotを明示しており、移動用guardの耐久化条件でexport退避を禁止する仕様とは読まなかった。
- 結果不明時の保留Undoは取消完了を表示しない。未完了操作のprocess停止だけを、既存RV20を超える新規指摘にはしなかった。
- Libraryの非採用枝を含む比較済みheadsへの明示採用は、無断のデータ消失とは区別した。

## 3. 最終判断と未検証事項

今回確認した範囲では、これまでの指摘を覆す新たな具体的反例は出なかった。**静的な設計レビューは一区切りとし、計画のM0/M1から実装・検証へ進める段階**と判断する。指摘ゼロは、設計全体の無欠陥やアプリの動作保証を意味しない。

実装段階で確認するもの:

- 両repositoryの耐久境界、commit応答消失、Undo補償、親待ち/競合/checkpoint復元の障害試験。
- Drive実サービスでの送受信・初期公開待ちと、実データ変換・中断再開・rollback。
- native本文選択handle、Safari/Pencil、全入力の倍率下限、描画完了後のanchor復元。
- CodeMirror履歴のsession移管、部分消去後geometry、export workerの文字/図形再現。
- 回復query/検索index更新、再起動後と実画面からの削除子noteへの到達性。
- 共通entryのmodule graph/実行traceを実装し、両hostで受入経路を実行すること。

これらは[計画書](shared-app-plan.md)の既存工程・F01〜F38・R01〜R29に従って判定する。今回、新たなRV ID・受入機能・回帰行は追加しない。

主担当は文書のlocalリンク/見出し参照、table列数、fence、末尾空白、既存の機能・回帰・レビューIDの整合性を確認した。アプリの型検査・build・自動/実機試験は実行していない。

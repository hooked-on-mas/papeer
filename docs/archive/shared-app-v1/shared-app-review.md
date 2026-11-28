# PC・Web共通化設計・計画のSolレビュー記録

実施日: 2026-10-24

対象: [設計書](shared-app-design.md)、[計画書](shared-app-plan.md)

本書は初回5名のレビューと、その時点の改訂記録。追加3名による再レビュー・後続改訂は[第2回レビュー記録](shared-app-review-2.md)を参照する。以下の対応節番号は初回改訂時点のもの。

状態: **5名の独立レビューを完了し、指摘を文書へ反映済み。実装による解消・受入試験は未実施。**

## 1. レビュー方法

5名のSol subagent（いずれも`gpt-6.1-sol`、reasoning high）が、同じ改訂前の2文書を読み、担当領域の現行コード・仕様・テスト構成と照合した。レビュー中の文書変更・アプリコード変更・試験実行は行わず、結果を揃えてから主担当が文書を改訂した。

| 担当 | 主な確認範囲 | 指摘数 |
| --- | --- | --- |
| 設計・依存関係 | 層の責務、共通featureの完結性、保存境界、旧責務の置換 | 5 |
| データモデル・保存・競合 | version、受信順、枝の継続編集、outbox、変換・rollback | 7 |
| PDF閲覧・入力 | ページidentity、原訳対応、座標、gesture、着地、export snapshot | 7 |
| 編集・Workspace・Library | 構成変更、Undo所有者、scope遷移、用紙変更、通常の整理操作 | 5 |
| 工程・受入条件 | 工程間依存、達成可能性、保存契約、競合解決UI、変換試験 | 6 |

元の指摘は計30件。重複を統合して下表の18論点として管理する。P1は実装前に契約・計画を修正すべき問題、P2は挙動差や受入漏れを防ぐために具体化すべき問題とする。

改訂前文書のSHA-256（UTF-8のファイルbytes）:

```text
shared-app-design.md  846ed027b4a3a1fbd5c2ae5f99e421a2230595e93e8b220fcb07074678dcc5aa
shared-app-plan.md    c267cc2abccc119edb8ae4c6537ae57b646e392e59f435b59816cfaa0aed2091
```

## 2. 指摘と設計上の対応

すべての行の対応状態は「文書反映済み・実装未着手」。節番号は改訂後文書を指す。

| ID | 優先度 | 問題・失敗例 | 採用した修正 | 対応箇所・検証 |
| --- | --- | --- | --- | --- |
| RV01 | P1 | 最初の受信枝を本流とすると、端末ごとに受信順が違うだけで採用版が分かれる | 不変version DAGと末端head集合を正とする。表示枝選択を採用/解決と区別 | 設計8.3、M1、R11 |
| RV02 | P1 | PCの投影commit後に停止すると、送信すべきbatchが残らない | SQLiteも完全batch・outbox・投影・履歴・受理記録を同じtransactionで耐久化 | 設計8.1、M1、R12 |
| RV03 | P1 | 競合枝の子や、比較中の新編集、二端末の同時採用が失われる。解決UIも工程にない | 親から枝を再構成。比較head集合を条件とする解決batchと共通ConflictSessionを導入し、未確認の後着枝を保持 | 設計8.3、M1/M2/M4/M5、F35/R11 |
| RV04 | P1 | ページ構成と注釈を別々に保存すると、空の複製や内容の戻らない削除Undoが成立する | DocumentEditBatchが構成・背景・全annotation内容/tombstoneを原子的に確定。未耐久編集は先に保存し、失敗時は構成操作を拒否 | 設計8.1/9.1、M1/M4、F23/R13 |
| RV05 | P2 | page履歴と構成履歴が別だと、描画→複製→描画→Undoの順序が定まらない | DocumentEditHistoryを唯一の文書履歴とし、text入力focusとのUndo routerを定義 | 設計5/7、M2/M4、F13/F23/R13 |
| RV06 | P1 | 必須の付箋・本文highlightに共通model/session/保存経路がなく、PC API直参照が残る | PageAnnotationに両型を含め、背景版付きtext range/quadと共通編集・履歴・保存へ接続 | 設計4.2/5/8.1、M1/M3、F20、旧責務置換表 |
| RV07 | P1 | 論理ページ番号だけではPDF差替え・訳文欠落・mapping変更後に別ページへ誤移動する | ReadingLocationを安定page ID/背景版で識別。原訳mappingを版管理し、逆引き/未解決を明示 | 設計4.1/6.1、M1/M3、F17/R14 |
| RV08 | P1 | pointだけの定義ではCropBox・Rotate・UserUnit・DPRで描画/引用/exportがずれる | 左上原点のcanonicalページ座標とPDF/表示への共通変換を定義 | 設計4.2、M1/M2、R14 |
| RV09 | P1 | 耐久化できなかったメモリ上の変更を再起動復元する受入条件は達成不能 | 全耐久済みpendingの再起動復元と、未耐久の同process内保持・終了guardを分離 | 設計5/8.2、R09/R20、検証6.2 |
| RV10 | P2 | 指描画中に二指目が入ると、一筆確定/pinch/消去が二重実行され得る | 未確定previewを取消してpinchへ移譲。batch/履歴は増やさず、全離指までink/swipeを再開しない | 設計6.3、M2、R10/R15 |
| RV11 | P2 | 未耐久時のlibrary切替/logoutや旧repositoryの寿命が未定で、session破棄で消失する | 遷移別guard表、明示破棄、同account内queue保持、account別pending隔離・再入回復を定義 | 設計5、M4、R20 |
| RV12 | P1 | M1がInkだけ、M2出口のexport/設定/gestureが後続工程依存となり、工程を閉じられない | 全4保存契約をM1で検証。M2に必要なexport worker・設定永続化・Reader/gesture基礎を前倒し | 設計8.1、M1〜M5の作業と出口、F35の段階別接続 |
| RV13 | P2 | paperにsourceRevisionがなく、用紙変更後の座標・線幅・付箋位置も未定 | PDF/paper共通の背景版を追加。物理座標維持、範囲外拒否、明示等方fit、一括Undoを定義 | 設計4.1/8.1/9.1、M1/M4、F23/R16 |
| RV14 | P2 | export/captureがhost別合成のまま残り、現在内容・全page・並行編集の包含も不定 | 共通snapshotとPDF/PNG workerへ統一。開始時の確定編集、競合枝、lock/非表示、失敗条件を明示 | 設計9.5、M1/M2/M3、F21/F22/R17 |
| RV15 | P1 | tag/既読/folder/item/関連/添付等が受入表にないため、PC固有操作が残っても完了できる | 通常操作のcommand・保存・置換先を明記し、専用受入行を追加 | 設計8.1/9.3、M1/M5、F30〜F34/R19 |
| RV16 | P2 | owner削除時の子note保持/内容削除を検証せず、関連解除と内容削除が混同される | 既定は子note保持/関連解除。内容削除は明示選択とし、内容を含むtombstone/Undoを検証 | 設計9.3、M5、F33/R19 |
| RV17 | P1 | DBのみbackup/切替すると、未送信内容・Drive後着・checkpointが旧新で混在する | 全領域棚卸しと書込/sync停止、入力固定、再開可能staging、完成manifest/epoch切替、全領域rollbackを定義 | 設計10、M1/M6、R18 |
| RV18 | P2 | 「全入力で同じ結果」がPageUp/上端wheelの末尾着地と矛盾する | 入力→共通command→着地表を正とし、同じ意味のcommand間で結果を比較 | 設計6.1、M3、F15 |

## 3. 改訂後に残る確認

設計上の不足は上記の採用案で埋めたが、5名が改訂後文書を再レビューして承認したという記録ではない。主担当が指摘間の整合性、工程順、参照先を確認した。

- 共通export worker、schema生成tool、PDF本文indexの方式は、計画書の指定工程で実装検証して確定する。
- 通常のLibrary操作はM0で現行入口を棚卸しし、追加の操作が見つかれば受入行を増やす。
- 実装後に全repository契約、両hostのUI経路、変換中断/rollback、依存境界、型検査、buildを実行する。
- Chromium/WebKitの自動試験と、iPad/Safari・Pencilの実機確認は分けて記録する。

今回の変更はこのレビュー記録と設計書・計画書のみ。アプリの共通化実装や不具合修正が完了したことを示さない。

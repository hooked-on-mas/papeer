# PC・Web共通化設計・計画の追加Solレビュー

実施日: 2026-10-24

対象: [設計書](shared-app-design.md)、[計画書](shared-app-plan.md)、[初回レビュー記録](shared-app-review.md)

後続の追加レビュー・改訂は[第3回レビュー記録](shared-app-review-3.md)を参照する。本書の節・行番号と再確認結果は第2回改訂時点の記録。

状態: **追加3名の独立レビューと、改訂箇所の限定再確認を完了。7論点は設計上解消。アプリの実装・実動作検証は未実施。**

## 1. 方法と対象版

初回とは別の3名のSol subagent（`gpt-6.1-sol`、reasoning high）が同じ改訂後文書をread-onlyで確認し、関連する実装・既存仕様・テスト構成と照合した。全員の初回結果が揃ってから主担当が文書を改訂した。アプリコード変更・試験実行は行っていない。

| 担当 | 確認範囲 | 指摘数 |
| --- | --- | --- |
| 保存・整合性 | 文書/ページDAG、atomic commit、outbox、応答消失、変換手順 | 2（P1） |
| Reader・編集 | 入力/座標/zoom、Undo、原訳mapping、翻訳filter、遷移guard | 2（P1 1件、P2 1件） |
| 工程・受入 | 機能一覧、通常操作の漏れ、工程順、共通化の実証 | 4（P2） |

計8件のうち保存中Undoの重複を統合し、**7論点（P1 2件、P2 5件）**として以下に記録する。IDは初回のRV18から連番にした。

レビュー開始時のSHA-256:

```text
shared-app-design.md  48cd617b287d4fb1f69e5e10527357a189ba9b60d9ac8d454026adceffbe040f
shared-app-plan.md    b200aefac3713db44ec8b5477170fe672932ec5b53373f65bd2b1f91a5df9f82
shared-app-review.md  4412badb1046da05d41b7e922a53f8a1d81b375f3df9590c37ea4d7e7b078d28
```

## 2. 新規指摘と採用した修正

| ID | 優先度 | 問題と失敗例 | 採用した修正 | 反映先 |
| --- | --- | --- | --- | --- |
| RV19 | P1 | 構成DAGに削除head、page DAGに描画headが一つずつあると、各対象は正常なのに文書全体は矛盾する。背景変更対旧座標編集も同じ | 注釈と構成だけを文書単位の一つのDAGへ統一。専用payloadとpage差分保存は維持 | 設計4.1/8.1/8.3、M1、R22 |
| RV20 | P1 | commit成功後の応答消失を未耐久と見なしUndoでbatchを捨てると、outboxから取消済み描画が送信・復活する | 未開始/不成立確定・実行中・結果不明・耐久済みを区別。結果確定までUndo/破棄を保留し、既受理なら逆batch | 設計5/8.2、M1/M2、R21 |
| RV21 | P2 | 翻訳済み1/3/7のみのfilter中、Webが1→2でも受入表を通る。Home/Endや明示jumpのfilter解除も未定 | ReaderSessionにfilterと対象集合を追加。guard付きfilter変更・端移動・解除・翻訳状態更新・空集合を定義 | 設計5/6.1、M3、F15/R23 |
| RV22 | P2 | Library検索/filter/並び順が受入表にないため、PC本文検索とWeb metadata検索の意味の差を隠して完了できる | LibrarySessionのquery/scope/filter/sortと共通結果規則、未取得範囲表示、旧結果拒否を追加 | 設計5/9.3、M5、F36/R24 |
| RV23 | P2 | 関連の表示/解除だけ共通化し、Webから関連を作れなくてもF33を通る | 独立PDF↔独立noteの単一/複数追加をdialog/dropから共通commandへ接続。重複/不正対象と一操作保存/Undoを検証 | 設計9.3、M5、F33/R24 |
| RV24 | P2 | ページ上の付箋編集だけで完了でき、横断検索/filter/並替/絞込結果のメモ書出しがPC限定で残る | AnnotationBrowserSessionと共通queryを定義。条件/scroll保持、場所への移動、宛先選択、idempotentなメモ追記を追加 | 設計5/9.3.1、M3、F37/R25 |
| RV25 | P2 | M3のメモ出力、M4の引用/配置/guardが、M5のWorkspace/ContentTarget/port接続待ちになる | Workspace基礎とguardをM2、navigationと最小NoteSession appendをM3へ前倒し。M4で同じsessionを拡張し、M5は残る全入口統合と旧経路撤去 | M2〜M5の作業/出口、F21/F25/F37 |

RV19の採用案には、**同じ文書の異page同時編集も競合になる**という代償がある。前版の「別pageは独立受理」を撤回した。全アプリ用multi-target DAGを作らず、削除/背景変更と注釈の整合性を一つの規則で保証するための選択であり、データは双方の枝として保持する。競合の自動mergeは初期範囲に入れない。

RV20では、一時的な受理照会の「なし」を不成立確定と見なさない。先行requestが実行中かもしれないため、確定できなければ同じpayloadを再送して受理を確定し、その後に逆batchを保存する。補償が未完了なら完了表示しない。

関連する現行実装・仕様の確認先:

- 保存後に応答する境界: [ink API](../sidecar/routes/ink.py)、[API client](../frontend/src/api/client.ts)、[InkPage](../frontend/src/features/reader/inkStore.ts)。
- 構成と内容の変更: [notebook処理](../papeer/core/notebook.py)。
- 翻訳filter: [ReaderToolbar](../frontend/src/features/reader/ReaderToolbar.tsx)、[navigation](../frontend/src/features/reader/navigation.ts)。
- Library通常操作: [LibrarySidebar](../frontend/src/features/library/LibrarySidebar.tsx)、[WebLibrarySidebar](../frontend/src/web/WebLibrarySidebar.tsx)、[itemLinks](../frontend/src/features/library/itemLinks.ts)。
- 付箋一覧: [StickyNotesTab](../frontend/src/features/reader/StickyNotesTab.tsx)、[付箋の利用仕様](annotations.md)。

## 3. 確認範囲と残る検証

前回の座標定義、二指へのpreview取消/移譲、文書Undoの単一所有、未耐久変更の復元保証の分離は具体化されており、同じ指摘は再掲していない。ただし保存/構成の原子性はRV19/RV20の追加修正が必要だった。

レビューは静的確認であり、Drive実サービス、実データ変換、保存失敗の実画面、PDF描画、実機入力、Library全操作の参照整合性を実証していない。各指摘の実装による解消は計画書の回帰・受入試験で判定する。

改訂後、同じ3名へ今回の指摘と修正が直接生む矛盾に限定した再確認を依頼し、全員から設計上解消しているとの回答を得た。設計全体の無欠陥や、実装の成功を保証する再確認ではない。

| 再確認担当 | 対象 | 結果 |
| --- | --- | --- |
| 保存・整合性 | RV19/RV20 | 共通文書DAGと保存結果不明時のUndoは設計上解消。直接生じる新たな矛盾なし |
| Reader・編集 | RV20/RV21 | 保存中Undoと翻訳filterは設計上解消。直接生じる新たな矛盾なし |
| 工程・受入 | RV22〜RV25 | 検索・関連追加・付箋一覧・Workspace工程順は設計上解消。直接生じる工程矛盾なし |

主担当は文書間の工程順、localリンク/見出し参照、table列数、fence、末尾空白、F01〜F37・R01〜R25・RV01〜RV25のID整合性を確認した。アプリの型検査・build・自動/実機試験は今回実行していない。

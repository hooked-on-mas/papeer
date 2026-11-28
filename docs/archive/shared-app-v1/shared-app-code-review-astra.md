# PC・Web共通化 実装のAstraレビュー

実施日: 2026-10-25

この文書は初回調査時の所見を保存している。以後の修正・再レビュー・検証状態は[修正と再レビュー](shared-app-review-cycles.md)を参照。

## 結論

**指摘は些細なものへ収束していない。現行画面に保存済み内容を失う経路があり、新基盤にも本番接続前に修正すべき認証・性能・整合性の問題がある。**

Astra 3名が保存・同期・移行、PDF／ノートの本番操作、構造・host境界・検証を独立にレビューした。別のAstraが結果を踏まえて今後の方針を検討する。今回のレビュー中に製品コードの追加・修正は行っていない。

対象は現在のworktree。変更・未追跡156項目があり、tracked差分だけでなく新規実装も確認した。[設計書](shared-app-design.md)・[計画書](shared-app-plan.md)・[実装記録](shared-app-implementation.md)との比較も行った。

受入台帳は67項目中、accepted 0、partial 27、unverified 40。登録共通entryは5件がconnected、18件がstagedである。既存の試験成功やfixtureでの接続を、本番全機能の共通化完了とは扱わない。

## 現行の本番経路にある不具合

### C01 — P1: 中央／右ノートの別writerが保存済み筆跡を消す

- 主箇所: [inkStore.ts](../frontend/src/features/reader/inkStore.ts):43,106。
- 中央は`app/ReaderArea → NotebookView → PdfPane → InkPage`、右は`NotesPane → NoteDocumentEditor → NoteEditSession`を通る。
- 再現: 同じ付属手書きノートを中央で開く → 親資料へ戻り、右側で線Aを追加・保存 → 中央へ戻り線Bを描く、またはUndoする。
- 中央の`InkPage`はmodule-level cacheを再利用し、`ready`なら再読込しない。右保存はこのcacheを更新しない。中央のPUTはrevisionなしでページを全置換するため、Aを含まない古い内容で上書きする。
- **限定実行で確認:** 本番`InkPage`クラスをNodeのTS transformで読み込み、API/storageだけfixtureへ置換。server内容が`[initial, right-stroke]`から`[initial, central-stroke]`へ変わった。実画面・実DBでの再現は未実施。
- 修正方向: 中央も同じ文書session・編集所有・履歴へ接続する。単なるcache invalidateでは未保存内容とUndoの競合を解消できない。

### C02 — P2: Markdownのremote反映がローカルUndoへ混ざる

- 主箇所: [MarkdownEditor.tsx](../frontend/src/features/notes/MarkdownEditor.tsx):40、[noteEditSession.ts](../frontend/src/features/notes/noteEditSession.ts):60。
- 再現: 自分の編集を保存 → 別端末の新revisionを受信 → Ctrl+Z。
- 外部`value`を通常のCodeMirror transactionで全文置換し、受信時もCodeMirror履歴を破棄／rebaseしない。Undoで戻った旧本文を新remote revisionに対する編集としてautosaveする。短時間では直前の自分の編集と同じUndo groupにもなる。
- **実CodeMirror state/historyと本番sessionで確認:** `remote-v2`受信後のUndoが`revision=remote-v2, content=initial`を保存した。DOM操作は未実施。
- 修正方向: remote反映とローカル挿入を区別し、外部反映はUndo対象外とする。revision変更時の履歴の扱いも明示する。

### C03 — P2: 端への文字配置が保存できないノートを作る

- 主箇所: [HandwrittenNote.tsx](../frontend/src/features/notes/HandwrittenNote.tsx):53。
- `textPoints`を境界調整せず保存する。A4の`(.99,.99)`へ`hello`を配置すると最大座標が`(1.065, 1.012979…)`となり、`validateNoteDocument`が拒否する。無効な文字を含む文書がsessionへ残り、以後も保存に失敗する。
- **実関数で確認:** 同じ内容を`fitInk`へ通すと受理された。PC右ノートとWebの共通部品に該当する。
- 修正方向: PDF側と同じ文字draftの確定・境界調整を通す。失敗する入力を先にsessionへ入れない。

### C04 — P2: Webの一回の消去が部分保存・複数Undoになる

- 主箇所: [web/PdfReader.tsx](../frontend/src/web/PdfReader.tsx):202–204、[annotations.ts](../frontend/src/web/annotations.ts):164。
- 一gestureの削除集合をstrokeごとに保存し、履歴も分割する。二つ目の書込で容量不足になると、一つ目だけ削除済みとなる。失敗した削除集合を保持しないため、再試行でも元の操作を完遂できない。
- **本番AnnotationStoreとfixture storageで確認:** 二つ目のremoveだけを失敗させ、2本中1本が削除済み・Undo履歴1件となった。UIイベント部分は静的確認。
- 修正方向: 削除集合を一batch・一履歴・一再試行単位で共通sessionへ渡す。

### C05 — P2: 用紙の向き変更が筆跡・文字を非等方に変形する

- 主箇所: [HandwrittenNote.tsx](../frontend/src/features/notes/HandwrittenNote.tsx):78。
- A4縦から横へ変更しても正規化ink座標と幅を維持するため、横は`297/210`倍、縦は`210/297`倍に見える。円が楕円になり、文字も変形する。
- **静的確認:** 新しい共通`resizePaper`の物理位置・線幅維持／overflow拒否／明示等方fitは、この本番経路で使われていない。実画面未検証。
- 修正方向: 用紙と全annotationを共通のgeometry変換付き文書操作で一括保存し、同じ操作をUndoできるようにする。

### C06 — P2: 起動状態の照会が応答しないと再試行もできない

- 主箇所: [startup.ts](../frontend/src/app/startup.ts):21–24、[main.tsx](../frontend/src/main.tsx):13–15。
- `readHold()`がsettleしないと、retryなしのloading状態で全アプリの起動が止まる。native側fetchにtimeout／AbortSignalがない。
- **静的確認:** 接続受理後に応答しないsidecarで成立する。browserによるhang再現は未実施。
- 修正方向: 期限付き照会、取消・再試行可能なunavailable状態、古いattemptの応答で後から起動しない世代検査を追加する。確認不能時に起動許可する必要はない。

## 新基盤を有効化する前の問題

以下は原則stagedの新protocolの問題である。現在の旧UIで漏洩や性能障害が起きたという報告ではない。

### S01 — P1: データのaccount scopeが実際の認証主体へ束縛されていない

- 主箇所: [edit_drive.py](../papeer/core/edit_drive.py):33–36、[editTransfer.ts](../frontend/src/adapters/drive/editTransfer.ts):25–27。
- `accountId`をnamespaceへ変換するだけで、認証中Google accountとの一致を検証しない。native [cloud_drive.py](../papeer/core/cloud_drive.py):53–55,103は各request／upload chunkで最新のglobal credentialを取得する。
- 新edit転送はJobManager外にあり、接続変更／解除のidle guardにも数えられない。Aのtransferを保持したままBへ認証変更し、Bがアクセス可能な共有folderへ送れば、AのpayloadをBのcredentialで送れる。
- **mockで実行確認:** `scope.accountId=A`の`DriveEditStorage`がmock認証Bへのuploadを拒否しなかった。実ネットワーク・実account未使用。
- 修正方向: 実account IDとauth generationを固定する転送leaseを持ち、request開始・chunk・結果受理で照合する。認証変更時は旧leaseを失効させ、転送をdrain／cancelする。

### S02 — P1相当の有効化阻止: Pythonの履歴再構成が二次的に増大する

- 主箇所: [edit_model.py](../papeer/core/edit_model.py):205,384,397、[edit_repository.py](../papeer/core/edit_repository.py):398–408。
- 各版で親文書全体を`deepcopy`し、全版を`states`へ保持する。通常commitは`_graph`と続く`receive([batch])`で全DAGを2回再構成し、SQLiteの`BEGIN IMMEDIATE`中で実行する。
- **合成fixtureで実測:** 各20点の筆跡を累積追加したDAG構築単体は80／160／320筆で0.411／1.625／6.854秒。別のtracemalloc計測では40／80／160筆のpeakが4.02／15.15／58.82MiBだった。通常commit/read全体の時間を測った値ではない。
- 320筆・6,400点でも数秒を要するため、現在のsessionをそのまま実画面へ接続できる性能ではない。TSのページ共有とPythonの全文deepcopyにも実装差がある。
- 修正方向: 未変更ページ／annotationを不変共有し、既存状態と親versionから差分構築する。履歴受信で既存状態を再利用する。累積データでnative commit/read・再起動の時間と容量を検証する。

### S03 — P2: 既存resourceの本文破損を見逃してactiveにできる

- 主箇所: [datasetPublication.ts](../frontend/src/runtime/edits/datasetPublication.ts):71–74、[edit_repository.py](../papeer/core/edit_repository.py):121–124。TS repositoryにも存在確認だけの経路がある。
- **一時SQLiteで実行確認:** 正常保存したPDFのbytesだけを同じ長さの`x`列に変更しても、`prepared → install_dataset → published → activated`が全て成功した。後の`read_resource()`で初めて`resource-hash`になった。
- 共通importも既存metadata一致で本文取得をskipする。保存時に一度検証したことを、切替時の全依存body検証の代用にしている。
- 修正方向: 取込・有効化では既存bodyもhash照合し、検証とmarker／pointer更新を整合させる。通常の一筆ごとに全resourceを検証する必要はない。

### S04 — P2: 不正履歴の耐久受理と、合法な部分到着を区別できない

- 主箇所: [editRecord.ts](../frontend/src/runtime/edits/editRecord.ts):10–11、[edit_records.py](../papeer/core/edit_records.py):12–14。
- **TS repository／本番DocumentEditSessionと一時SQLiteで確認:** redoの`history.action.operationId`を無関係なUUIDへ変えても受理され、その後は`history-action-order`でUndo／Redoが無効になる。正しい同ID履歴の再送は`history-id-reused`で拒否される。本文自体は開ける。
- 一方、bare normal batch → 完全undo recordという合法な部分到着も同じエラーになり、元historyの補充で回復した。欠落参照を一律即拒否する修正では正しい到着順まで壊す。
- 修正方向: 履歴依存の未到着と不正な因果参照を区別し、保留・検証・復元を設計する。不正なimmutable recordで全履歴を継続的に無効化しない。

### S05 — P2: 通常同期が無関係の過去checkpointまで毎回読む

- 主箇所: [replication.ts](../frontend/src/runtime/edits/replication.ts):36、[editTransfer.ts](../frontend/src/adapters/drive/editTransfer.ts):36–37。
- `pull()`がscope内の全immutable fileを逐次取得・検証し、通常同期が採用しないcheckpoint／manifestも本文ごと読む。公開checkpointと履歴が増えるほど、一編集を送る前の通信量と待ち時間が増える。
- **静的確認のみ:** 大規模通信量の計測は未実施。
- 修正方向: 通常recordの増分取得と、明示したdatasetの発見／importを別経路にする。通常pollでcheckpoint本文を読まない。

### S06 — P2: raw backupがlibrary全本文をRAMへ集める

- 主箇所: [legacyDrive.ts](../frontend/src/migrations/legacyDrive.ts):135–150、[storedLegacyBackup.ts](../frontend/src/migrations/storedLegacyBackup.ts):20,30–33、[legacyIndexedDb.ts](../frontend/src/adapters/browser/legacyIndexedDb.ts):70以降。
- `inventory()`でも全本文を`Map<string, Uint8Array>`へ集め、その後捨てる。`capture()`で再び全収集し終わってからartifactへ保存するため、必要RAMは最大fileでなくlibrary総量に比例する。PCも同じTS collectorを使う。
- **静的確認のみ:** OOMや大容量browser試験は未実施。数GB入力への影響は構造からの推定である。
- 修正方向: metadata／hashのinventoryと個別body取得を分け、固定planに対して逐次検証・耐久保存する。IndexedDBでは原子的snapshotと容量を両立する方式を別途決める。

## 検証の盲点と残る機能差

### V01 — P2: 推移依存検査が禁止package／globalを検出しない

- 主箇所: [sharedEntries.test.mjs](../frontend/tests/sharedEntries.test.mjs):21–25,56–57。
- 相対pathと`@/`以外をgraphから除外し、残ったlocal pathのprefixだけを検査する。新domainへの`@tauri-apps/api/core` importや`window.localStorage`／`fetch`直参照は検出できない。
- **検査コードの静的確認:** 違反をworktreeへ挿入する試験はしていない。staged経路はWeb buildの到達graphにもないため、buildだけでは補えない。
- 修正方向: layerごとのpackage／global制限をASTまたはlintで検査し、意図した違反fixtureが失敗することも確かめる。DOMを使うviewとdomainは分ける。

### G01 — 未統合の機能差: Webの消去が作成元IDに制限される

- 箇所: [web/PdfReader.tsx](../frontend/src/web/PdfReader.tsx):201、[annotations.ts](../frontend/src/web/annotations.ts):27。
- PC作成の図形・筆跡をUIの`web-` prefix判定で除外し、保存validatorもremoveを拒否する。静的確認で、実Drive試験は未実施。
- これは旧方式の既知制限と、設計書の共通annotation identityが未接続であることに対応する。今回の変更による新しい退行とは区別する。ただし現計画の完成形には残せない。
- UIのprefix判定だけ外すのでなく、同じ権限・ID・編集batchへ保存入口も接続して撤去する。

## 不具合と区別する既知の未実装

- 起動holdは既存request・job・Web tab・他端末の停止完了ではない。解除・canonical起動・全域変換も未実装である。
- canonical DB・raw backup・bootstrapのsibling領域は通常backup／restore／保存先移動の対象にまだ含まれない。本番切替前の必須条件である。
- 共通editor／Reader／Library／Workspace全体の置換、全変換・rollback復元は未完了である。
- 既存の共通ノート実行traceはfixtureの証拠であり、本番Workspace遷移の証拠ではない。現在の文書と台帳はこの差を明記しており、虚偽のacceptedとは判断していない。

## レビューの限界

限定した合成fixture・mock・一時DB・本番クラス／関数で反例を確認した。全suite／buildの再実行、実Google Drive、実account、実ユーザーLibrary、iPad／Safari／Apple Pencilの実機確認は行っていない。実測と静的推定は各指摘に区別した。

レビュー前の848単体・Python718成功／POSIX専用1skip・関連結合22成功は、上記の反例を含む検証ではない。全Web63成功もinput-set／artifact v3追加前の記録である。件数の多さから今回の指摘を否定しない。

## 今後の方針

別Astraの再検討結果は[実装方針の追補](shared-app-next-steps-astra.md)へ記録した。

既存のschema／DAG／journalを作り直さず、現行の内容消失を先に修正する。その後、隔離libraryを両本番compositionへ注入し、PDF一文書の全操作・保存・再起動・相互反映を閉じる。paper／Reader、Markdown、Libraryへ順に広げ、各経路の旧writerを撤去する。実データの全領域変換は、停止・認証・保存footprint・完全なresource検証・復元条件が揃ったlibrary単位で行う。

元計画の全機能・保全・受入は維持する。基盤の横展開と試験数を進捗目標にせず、本番操作が一つ完成し旧責務が一つ消える単位を優先する。

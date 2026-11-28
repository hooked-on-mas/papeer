# PC・Web共通化 実装記録

> 2026-10-29追記: 本書はcheckpointごとの実施履歴。各節の「現在」「次工程」はその時点の記録であり、現在地は[引継ぎ書](shared-app-handover.md)、作業TODOは[計画書第3節](shared-app-plan.md#3-実行todo大分類小分類)を参照する。

更新日: 2026-10-27

## 引継ぎ時checkpoint：共通RuntimeIoGate統合（144項目）

ユーザーの依頼で検証済みcheckpointにて実装を区切り、[引継ぎ書](shared-app-handover.md)を更新した。旧引継ぎ全文は[履歴](shared-app-handover-history-2026-10-27.md)へ保全した。

Terraが共通 `runtime/lifecycle/RuntimeIoGate.ts` と純unitだけを正式統合し、browser固有のauthority／helperは入れていない。handoff検証をgate所有signalで取消・追跡し、closeは通常operationと候補I/O双方のsettlementを待つ。Sol source再確認後、unit7件・型4project・lint・境界45・全frontend1,430成功／benchmark1 skip・両buildを通過した。144項目manifest SHA256 `acdaf6d30fc522b1fc25774a297c76e255055b43c2fef7aca536a7a97e06f5f3`、registry `1d4228ce675f632cef42f75027022e1fbd723eca073e41a18178a7407aed46ec`。要約は `output/shared-app-runtime-io-gate-{quick-summary-r1,standard-summary-r1}.json`。全144hash・golden不変、所有process／PTY残存0。gateはstagedで、productionから未到達。

新しいCore snapshot／memory plan／exact CASのT1はsource review後、隔離コピーで型と6 suite60/60成功。T1＋T2協調overlayも型・同じ60件・実IndexedDBのChromium1/WebKit1が成功した。要約は `output/shared-app-repository-plan-validation-summary-r2.json` と `output/shared-app-indexeddb-plan-validation-summary-r2.json`。本番worktreeやfactoryへは未統合で、fullApp・実host全体の証明ではない。

T3全browser接続案は2名の分担source review済みだが型・runtime未実行。NativeのD1b／D2／physical identity案もsource reviewのみ。Native physicalは別ID payloadの非公開に加え、metadata-only resourceとincoming versionの破損projectionの無断補修を拒否した。Desktop driver案は未レビュー・共通gateへのrebase待ち。既定起動はlegacyのまま、全67要件の完了を意味しない。

## 先行checkpoint：共通起動画面の統合（source142）

TerraがBootstrapConnectionと共通Session.resumePageを統合した。古い取消済みflightへpageshowが合流しても新しいadmissionを取り直し、同じ保持subtreeと入力要素へ復帰する。Solのsource再確認後、型4project・lint・関連62件・境界45件を通過。runnerの監視不足を実行前に検出し、監視とhidden／inert／aria／focus／入力保全の直接検証、両engineへ有限修正した。Chromium／WebKit UI2/2成功（13.98秒）、全142hash・registry・golden不変、所有process／PTY残存0。

現在manifest SHA256は `fed28edf4939cf24a5bbd5d1068a073f08d30a718e99292d1cfdd92b749ebd9f`、原本は `output/shared-app-bootstrap-connection-ui-{install-checkpoint,runner-fix-checkpoint}/`。全frontend1,423成功／benchmark1 skip・両buildも成功した。要約は `output/shared-app-bootstrap-connection-ui-{quick-summary-r1,runner-quick-summary-r1,browser-summary-r1,standard-summary-r1}.json`。実DOMのfake-host UIであり、実認可driver／引数なし通常entryは未接続である。次工程は共通repositoryのsnapshot→plan→exactCASとshared I/O gateを作り、実driverへ接続する。

## 先行checkpoint：共通BootstrapSessionの統合（source138）

Terraが共通host port、固定初期化要求builder、BootstrapSessionと既存registry／navigationの寿命guardを正式統合した。Sol2名の独立レビューで、host loss後の遅い回復、旧leaseの保持資源再認可、closeとsignal寿命、peer alias、未確定要求の別ID解除、終了後cancelの計6P2を修正・再確認した。取得signalとadmit済みI/O寿命を分離し、保持資源の再認可はhostの明示handoffだけを許す。

138項目manifest SHA256は `cedba34a8abd84414c8b006ec0031d47c957e4ac49540af7b4a3d0a298927540`、原本は `output/shared-app-bootstrap-session-install-checkpoint/`。型4project・lint・関連94件・境界45件・既存Chromium citation/navigation／空Library回帰2case、全frontend1,423成功／benchmark1 skip・両buildが成功。全138hash・registry・golden不変、所有process／PTY残存0。要約は `output/shared-app-bootstrap-session-{quick-summary-r1,browser-summary-r1,standard-summary-r1}.json`。共通sessionはfake driver unit、画面は既存明示binding mountの証拠であり、実host／通常entryの完了とはしない。

## 先行checkpoint：空Libraryとlocal grant保存の統合（source134）

TerraがB2のscope binding／nullable初回navigation／空Library shell／既存registryのform guardと、B1aのlocal grantモデル／SQLite・同一IDB保存を正式統合した。Solレビューで外部navigationのscope未照合とTSの末尾改行ID受理を修正し、限定再確認は新P1/P2なし。B1aの共通契約を生成し、旧schema定義は同じままgrant型／validatorだけ追加した。IDBは既存DBのversion8にgrant storeを加え、read-only discoveryで初期化・upgradeしない。

memo依存lint1件を有限修正後、現在134項目manifest SHA256は `bdeb5483216a4b2ad40c3d09b09bd679d056da1a440135156675292783a12338`。B2原本は `output/shared-app-library-scope-install-checkpoint/`、B1aは `output/shared-app-local-grant-install-checkpoint/`。型・lint・関連TS103／Python47、境界45、browser13case、全frontend1,409成功／benchmark1 skip・両build・backend17file164/164を通過。要約は `output/shared-app-local-grant-scope-{quick-summary-r2,browser-summary-r1,standard-summary-r1}.json`、全134hash不変・所有process／PTY残存0。grant／既存IDBは両engine、空LibraryはChromiumのPC/Web明示scope mountの証拠である。実host lease・通常entryの完了とはせず、次は実host認可／driverと共通BootstrapSessionを実装する。

## 先行checkpoint：Web IndexedDB providerの正式統合（source113）

Terraが同一DB schema／peer／readonly proof・prepare／execute／ackとpublic facade、正常／fault fixtureの計21fileを正式統合した。既存overwriteは `indexedDbEdits.ts` のみでbaseline一致、20新規fileと既存registryをcheckpointへ保存した。shared read-proof entryはstagedとし、通常起動の接続済みとはしていない。113項目manifest SHA256は `3a4d2a03a396edc3644f572ff18edc7d397cc0cc99c4c963f1bdaa1bba96065a`、checkpointは `output/shared-app-bootstrap-indexeddb-install-checkpoint/install.json`。

Sol2名がcollector／transaction境界とexecute／ack／enqueueを分担レビューした。全表bytes取得とlate-open接続漏れのP2を修正し、再確認は新P1/P2なし。fixture型5件の有限修正後、app/node/tests型r1＋E2E型r2、lint・関連53/53・境界45/45・契約／台帳、正常／faultの両engine計10/10（59.81秒）、全unit1,406成功／benchmark1 skip・両buildを通過した。現在までの確定要約は `output/shared-app-bootstrap-indexeddb-{quick-summary-r2,browser-summary-r1,standard-summary-r1}.json`。全113hash不変・所有process／PTY残存0。OWNER fake lease／注入quota／同page2connectionsに限定し、認可adapter・通常entry・実機のgateは別に残す。

## 最新checkpoint：Core・SQLite初期化の正式統合（source92）

Terraが共通初期化モデル、durable account intent、SQLite初期化providerを正式統合した。元のReader source74からmanifestは92項目へ増え、SHA256は `b7d24a537b0e3af44dc3ac78569703e96b08c9b9f7bf87d1d846abffbb016499`。既定起動は引き続きlegacyで、実認証・Web provider・通常entry・空Library shellへの接続は未完了である。

TS/Pythonが同じ初期requestの1,466 UTF-8 bytesとSHA256 `1cb79fd993e82df613211e72ff0cea654e893c4ca9f5b6e2906bd1f9e653de59`、checkpoint hash `5b31ef46ccce60605c79ef780222eeb1964bfec4bd0afc965866858779c0f9a2` を独立に再現する。共通fixture `tests/fixtures/canonical-bootstrap.json` と両言語の恒久testへ固定した。accepted cacheを単独authorityにせず、profile origin、実checkpoint／manifest／物理row、現control identityを照合する。

SQLiteはprepareで固定intentを耐久化し、executeでそのrequestだけをatomicに確定する。恒久readback testは通常の `SqliteEditRepository` をreadonly接続し、root／checkpoint／heads／history／receiptsとDB bytes不変、ack後の別store再open、同accountで独立した2Libraryの読出しとwrong-scope拒否を確認する。これは順次2scopeとfake OWNER leaseの証拠で、並列create・実authの証拠ではない。

Solの最新標準検証は型4project・lint・全frontend単体1,406成功／benchmark1 skip・PC/Web build・境界45/45・generator／台帳／diffcheckが成功。Pythonは明示した16fileで160/160、SQLite focusedは16/16。要約は `output/shared-app-bootstrap-storage-standard-summary-r1.json`、Python実commandは `output/shared-app-bootstrap-storage-python-canonical-scope-r2.log`。全92hash一致、所有process／PTY残存0。

その後の独立Solレビューで、SQLite snapshotが無関係なresource bytesを全表取得するP2を検出した。TerraがSQLでaccount/libraryに絞り、対象の全epoch footprintは保持した。Sol再レビュー後、focused17/17・同じbackend16file161/161とgenerator／台帳／diffcheckを通過。要約は `output/shared-app-bootstrap-sqlite-scope-summary-r1.json`、現在の92項目manifest SHA256は `4e671eee7ab0a899863ad1302f73a6a4a8e6ecbc90c8ac996ccc961350dfd8c6`。frontend標準は直前版の証拠であり、このPython限定修正後は再実行していない。

Webは `output/shared-app-bootstrap-indexeddb-draft/` に同一DB schema／peer／readonly proof・prepare／execute／ack・public facadeを実装した隔離案。全store bytes取得の同型P2をscope indexとkey-only occupancyへ修正し、Solが独立source review中、全未実行。fault／並列の追加fixtureは別隔離案を作成中。r5のlocal grant、Drive descriptor、Library単位capabilityは別の未実装gateであり、OWNER限定namespace listをprovider権限へ流用しない。最新TODOは[引継ぎ書](shared-app-handover.md)を参照する。

## 先行checkpoint：固定参照・paper入力と通常起動の準備（source74）

実装はGPT 6.1 Terra、debug・検証・コードレビューはSol、設計はAstra。既定起動はlegacyのままで、共通処理は明示bindingによる両本番mountで検証した。全M0–M6／67要件の完了を意味しない。

同文書の固定readonly参照をReaderSessionへ追加し、mainの編集sessionと現在モデルを共有した。参照の対象・zoom・位置は独立したephemeral stateとし、別writerや保存形式を追加していない。旧shallow clone／main-reference位置結合を置換し、実測layoutとraw contact lease、開始時の描画proofとadmit済みgesture継続を分離した。pin/置換/解除・保存待ち中の配置変更・削除復元・旧cleanup・terminal swipeの具体P2を反復修正した。

実touch試験で、paperの読むmodeがUAに操作を許してpointercancelになる経路を検出した。canonical main/reference paperの実managed scrollerへ`touch-action: none`を追加し、同じtrusted操作が正常up・一ページ移動・先頭着地になることを両hostで確認した。legacy/global CSSと真のcancel処理は変更していない。無効なpaper translation fixtureは、通常publicationしたmixed Notebook＋通常UIの参照固定へ置換した。

| source / 条件 | 検証結果 | 証拠 |
| --- | --- | --- |
| 71 / 別focused | 参照UI Chromium1/1・WebKit1/1、各PC/Web | `output/shared-reader-reference-browser-{chromium,webkit}-summary-r3.json` |
| 72 / Chromium focused | trusted main paper→PDF→paper、先頭着地、固定参照・編集履歴保持1/1、両host | `output/shared-reader-main-swipe-browser-summary-r4.json` |
| 73 / 別focused | cross-pane paper1/1、Ink contact paper1/1、各両host／PC保存版をWeb採用 | `output/shared-reader-mixed-{cross-pane-paper,ink-paper}-summary-r1.json` |
| 73 / prepared | geometry単一6/6、別のresource単一6/6、元15/25/180秒、calibrationなし | `output/shared-reader-reference-{prepared-geometry,resource}-summary-r1.json` |
| 73 / 別run | quote同一2/2、legacy touch1/1／wheel1/1 | `output/shared-reader-reference-quote-summary-r1.json`、`output/shared-reader-reference-legacy-{touch,wheel}-summary-r1.json` |
| 74 / 診断追加後 | highlight同一2/2、4hostのselection admission／draft作成成功記録 | `output/shared-reader-highlight-diagnostic-full-summary-r2.json`、`output/shared-reader-highlight-diagnostic-positive-r2.json` |
| 74 / 最終標準 | 型4project・lint・単体1,399成功／benchmark1 skip・両build・境界45・契約／台帳 | `output/shared-reader-highlight-final-standard-summary-r1.json` |

各runのhash不変と所有process/PTY/profile終端を確認した。source73の一度のWebKit highlight form未表示は原因未確定として保持。actual key／capture／admissionのscalar結果をprivate readonly診断口へ記録し、capture→admissionへ追加await/layout/readSelectionを入れず、同じ一回の操作を再検証した。診断付き成功を原因修復とは称さない。cold geometry5/6とprepared6/6も別条件である。

このsource74時点では、通常起動のCore型／admission／共有fixtureとSQLite・account intentは隔離draftのみだった。その後の実source統合・unit／DB検証は冒頭source92 checkpointを参照する。IndexedDB／auth／空Library shellは引き続き未完了。

Sol証拠監査でR28をpartialへ更新し、台帳はaccepted0／partial47／unverified20。実機・完全入力matrix・通常起動・M6のgateは残る。最新TODOは[引継ぎ書](shared-app-handover.md)を参照する。以下は各時点の履歴であり、このcheckpointより古い件数を現在の結果へ流用しない。

**全計画は未完了。M0/M1の基盤、M2の文書session・履歴、既存ノート経路・図形生成の共通化を実装した段階である。** PDFの共通editor・Reader全体への置換、既存データ全体の変換と本番有効化、Library/Workspace全体の置換はまだ行っていない。設計上の完了条件は[計画書](shared-app-plan.md)から縮小しない。

2026-10-25にAstra 3名が[実装コードをレビュー](shared-app-code-review-astra.md)し、別Astraが[今後の方針](shared-app-next-steps-astra.md)を再検討した。その後は内容消失・認証束縛・履歴／resource検証・計算量を修正し、独立レビューを反復している。追加の重大所見と現時点の検証結果は[修正と再レビュー](shared-app-review-cycles.md)に記録する。以下の未完了項目はこの修正によって完了扱いにしない。

## 現在の実行経路

| 対象 | 実装・接続 | 残る作業 |
| --- | --- | --- |
| 共通wire契約 | [JSON Schema](../schema/edit-contracts.json)からTS/Python型・構造validator・上限/競合suffixを生成。図形/付箋/本文highlight、4種のbatch、history、作成bundle、checkpointを定義。[OpenAPI](../sidecar/edit_schema.py)にも同じ定義を参照させ、Pydanticでpayloadを変換・欠落させない | 安定IDの既存データ変換、実データとの照合 |
| 業務規則 | 同一[fixture](../tests/fixtures/shared-edits.json)を両言語で検証。Unicode code point、座標・非退化・上限、所有・循環・論理削除の観測履歴を確認 | 全R01〜R29の現行再現と実画面受入 |
| 文書版・競合 | Page/Documentが同じ文書DAG。親待ち、分岐の子、順序非依存head、同時解決・後着枝、同ID異payload拒否。2,000変更の逆順再構成も反復処理で確認 | 競合比較UI、ページ/Markdown/metadataへの全接続 |
| SQLite/API | [repository](../papeer/core/edit_repository.py)と認証付き[API](../sidecar/routes/edits.py)。projection、完全batch、history参照、outbox/receiptを一transactionへ保存。未変更pageは不変参照を再利用 | 有効なdataset/権限/resourceへの接続、PC Drive importer/publisherの切替 |
| native保存先 | [新接続](../papeer/core/edit_storage.py)を`deps.get_edit_connection`へ注入し、旧Libraryを開かず`.<旧root名>-shared-app/content.sqlite3`へ保存。新しいstaging・再起動・Undo/Redoで、旧DB/fileのraw観測値も変えない | 新保存先/backupの全footprintを保存先変更・通常backup/restore・bootstrapへ接続する。旧backupはこの新DBを自動では含まないため、本番切替前の必須作業 |
| IndexedDB | [adapter](../frontend/src/adapters/browser/indexedDbEdits.ts)を実ブラウザで確認。全4契約、transaction abort、再起動、送信待ち、account分離、初回open失敗後の同一repositoryでの再試行 | Web本番compositionの旧AnnotationStore/NoteStore保存経路の置換 |
| 作成・resource | [共通作成契約](../frontend/src/runtime/edits/contentPublication.ts)とSQLite/IndexedDBへ、初期文書・項目・履歴・完全な作成outboxの原子的公開を実装。背景bytesをhash検証して先に耐久化し、PDF.js/PyMuPDFの実解析で頁寸法・版を検証。失敗時は本文/項目/receiptを全rollback | 作成UIの新portへの接続、datasetの権限・有効epochの検証、全領域変換・有効化 |
| 保存結果 | [BatchCommitSession](../frontend/src/runtime/edits/batchCommitSession.ts)は結果不明時の同ID再送→受理確定→逆batchを保持。送信前intent・応答待ち中のUndo・逆batch固定も共通journalへ耐久化。PCの実HTTP応答消失→sidecar再起動を確認。upload受理とpeer取込receiptを区別 | 新履歴・guard UIへの接続と、文書以外の新sessionへのjournal接続 |
| 転送 | [共通送受信](../frontend/src/runtime/edits/replication.ts)と[共通Drive envelope](../frontend/src/adapters/drive/editTransfer.ts)を両host用に実装。PCは[HTTP adapter](../frontend/src/adapters/desktop/editTransfer.ts)と[Pythonの認証・転送](../papeer/core/edit_drive.py)、WebはDriveSessionへ接続。通常編集・作成を`EditRecord`へ統一し、Undo/Redo履歴も通常outboxから転送。完成datasetはresource→checkpoint→manifestの順に公開 | 保存先に基づく権限/公開状態の照合、両本番composition接続と旧publisher撤去。実Google Driveでは未実行 |
| 初回取り込み | [完成manifest公開・取込](../frontend/src/runtime/edits/datasetPublication.ts)と[内容検証](../frontend/src/runtime/edits/datasetManifest.ts)を実装。通常pollはcheckpointを自動公開せず、明示したmanifestのscope/digest・全resource・本文参照を検証。SQLite/IndexedDBでroot・枝・projection・receipt・取込完了markerを一transactionでmergeし、既存の未送信/親待ち/journalを維持 | 全領域backup/変換、旧形式のsource停止、両本番compositionへの接続。取込完了markerはactive datasetではない |
| 新datasetの切替 | [共通control規則](../frontend/src/runtime/edits/datasetControl.ts)と[切替session](../frontend/src/runtime/edits/DatasetTransitionSession.ts)をSQLite/API・IndexedDBへ接続。固定planと段階の耐久化、CAS、canonical source凍結、公開/参加、原子的active pointer/outbox引継ぎ、rollback時の新epoch隔離を実装。通常書込は小さなnative access headで判定 | 旧DB/ローカルjournal/Drive全領域の棚卸し・backup/変換・停止確認・rollback復元、本番Workspace/認証への接続。旧保存APIはまだこのgateへ置換されていない |
| 旧注釈の変換 | [ページ単位の一回変換](../frontend/src/migrations/legacyAnnotations.ts)に[全7種の筆跡](../frontend/src/migrations/legacyInk.ts)と[付箋・本文highlight](../frontend/src/migrations/legacyBookmarks.ts)を接続。安定したsource keyからIDを固定し、元payloadのhashと対応を返す。引用・コメント・分類・日時・anchor・quadを保ち、未知のtext offsetはunindexedとする。不明field・重複ID・表現不能な図形はページ全体を未変換として報告。PC実HTTP/SQLiteとChromium/WebKitの実IndexedDBで保存・再起動・Undo/Redoを確認 | 全データ収集・backup/manifest、旧Web operation/削除/適用済みledgerの統合、ノート/Markdown/Library全体の変換と本番有効化。単独のconverter成功を移行完了としない |
| 旧入力の退避 | [共通plan/manifest](../frontend/src/migrations/legacyBackup.ts)、[native raw file退避](../papeer/core/migrations/legacy_backup.py)・[端末記録の選択収集](../papeer/core/migrations/legacy_device.py)、[browser localStorage](../frontend/src/adapters/browser/legacyLocalStorage.ts)・[旧IndexedDB収集](../frontend/src/adapters/browser/legacyIndexedDb.ts)・[共通Drive収集](../frontend/src/migrations/legacyDrive.ts)と[専用artifact store](../frontend/src/adapters/browser/legacyBackupStore.ts)を実装。[確定・回復手順](../frontend/src/migrations/storedLegacyBackup.ts)をsource readerと保存先から分離。固定plan→body→検証済みmanifest、入力変化の拒否、同ID再開、応答消失/容量不足/破損検出を確認 | 指定したnative/device領域・localStorage・旧offline IndexedDB・指定Drive libraryの部分sourceである。Drive内容/ledgerの変換、実行中処理・別tab/端末の停止、全source coverage、入力のSQL/JSON解析と変換、backupからの全域復元、移行controllerへの接続は残る |
| 起動時の保留 | [共通起動処理](../frontend/src/app/startup.ts)を両本番entryへ接続。durableな`LegacyMigrationHold`を確認してから[PC](../frontend/src/DesktopApp.tsx)・[Web](../frontend/src/web/WebApp.tsx)をdynamic importする。recordがある/読めない場合は旧storeをimportしない。[native guard](../papeer/core/migrations/legacy_startup.py)は旧Libraryのschema/journal回復・起動時cleanup/保存先移動を止め、HTTP middlewareは旧設定API等の新規操作も拒否 | これは起動/新規HTTPのadmissionであり、受理済み処理・実行中job・起動済みWeb tab・他端末の停止完了ではない。全peerの停止確認、hostの全source棚卸し/登録、再開/変換UI、active datasetへの起動、検証済み復元を経た解除は残る |
| editor公開契約 | [InkEditor](../frontend/src/features/reader/inkEditor.ts)をPC hookのReturnTypeから独立させた。描画surfaceと旧保存toolbarの契約を分け、InkOverlayの推移依存からPC navigation wrapperを除去 | 新PageEditSession・文書Undo・共通toolbarへの置換とWeb接続。現在の旧保存toolbar用adapterは移行中のもの |
| 文書編集session・履歴 | [DocumentEditSession](../frontend/src/features/reader/DocumentEditSession.ts)と[DocumentEditHistory](../frontend/src/features/reader/documentHistory.ts)を実装。原文/訳文/ページ構成の保存・逆batch・50操作の参照履歴・失敗保持・同ID再送・所有者token・入力/遷移guardを共通化。共通intent journalと[scope registry](../frontend/src/features/reader/DocumentEditSessions.ts)へ接続し、未表示文書の回復も列挙 | 本番editor接続、PageEditSession/InkSessionとtoolbar、Workspaceへのscope guard接続。現段階は1操作ずつ保存し、保存中の新編集を保留する |
| 回復journal | [共通journal](../frontend/src/runtime/edits/intentJournal.ts)とSQLite/API・IndexedDBへ、完全要求・送信可能性・Undo要求・固定した逆batchの耐久化を実装。revision CAS・応答消失時の同mutation再送・古いtabの更新拒否を共有。native abortと画面再読込／sidecar再起動からの回復を確認 | 全featureと本番compositionへの接続、全領域移行時の棚卸し・backup/rollbackへ組み込む作業。端末内のintentをDriveへ採用済みbatchとして送信しない |
| ノート編集 | PC NoteDocumentEditorとWebNotesが同じNoteEditSessionとHandwrittenNoteを使用。表示面の二重所有を防ぎ、手書きUndo/Redoをsessionへ移動 | 旧NotebookViewを含む全ノートの新DocumentEditHistory/DocumentEditBatchへの置換 |
| Markdown | 両版が同じ[編集view](../frontend/src/features/notes/MarkdownSessionEditor.tsx)とNoteEditSessionを使用。dirtyの元revisionとremoteを分離。600ms autosave、失敗保持/別ノートへの回復保存、preview/remount時のCodeMirror履歴を共有。遅れたreadは編集/保存世代と要求tokenで拒否 | 新MarkdownEditBatch/ConflictSession接続、全scope遷移・テンプレートサービス統合、追記IDの新形式での耐久保存 |
| 旧Markdown下書き | 文字のみの旧journalは一回の[回復処理](../frontend/src/adapters/browser/markdownDrafts.ts)で元revision不明の回復欄へ保存。保存成功前に旧journalを消さず、現在のremote版へ自動で載せ替えない | 全dataset移行とは別の限定的なscratch回復であり、全領域移行の完了とは扱わない |
| 座標・対応 | canonical PDF座標、CropBox/UserUnit/Rotateの逆変換、用紙resize/等方fitに加え、訳文を別page collectionと版付きmappingで保存。対応欠落・曖昧・削除・背景差替えを明示。旧訳文はannotation付きでtombstoneに保持。両collectionを同じ文書DAG/保存/転送へ接続 | PdfSurface/export・旧読書経路への接続、全annotation/異寸法の実画面確認 |
| 図形生成 | [共通draft](../frontend/src/features/reader/inkDraft.ts)をPC PDF・Web PDF・手書きノートへ接続。選択肢も[共通view](../frontend/src/features/reader/DrawingKindSelect.tsx)へ移動。Webの「描画の種類」から直線・矢印・四角・丸を作成できる。Shift制約、点数上限、退化図形の拒否、境界への収め方を共有 | 図形の再編集・選択・変形・消去・文書Undoまでを所有する共通editorへの置換は未完了。旧Web操作保存への接続を完成形とはしない |
| 共通実装の証明 | [entry登録](../frontend/src/runtime/sharedEntries.json)、両本番entryからの静的依存graph検査、ノート両host部品のブラウザ実行traceを追加。未接続基盤は`staged`と記録 | 全F行の本番composition操作traceと旧責務撤去。fixture部品の成功だけでF23/F24全体を合格にしない |

既存ノートUIの保存接続は、PCのrevision APIとWebの既存operation保存を引き続き使用している。新repositoryへの切替は未実施であり、旧方式への互換分岐・二重書込を完成形として採用したものではない。

### レビュー収束後のPDF縦接続の再開

2026-10-26、実装済み範囲の重大指摘が独立した連続レビューで出なくなったため、PDF一文書の両host接続を再開した。接続前に`DocumentEditSession.refresh()`を入力所有のguardへ通し、描画・文字入力中の読込を拒否する。開始済みreadも入力開始時に世代を無効化し、入力終了後に届いた古いreadがgestureのbaseを差し替えない。直接拒否・in-flight・入力終了後の明示refreshを回帰確認した。

`useInkSurfaceEditor`へ選択・変形・clipboard・hotkeyの操作計算を移し、旧`useInkEditor`は保存接続・設定・通知を注入する薄いadapterへ変更した。旧計算は撤去し、PCの実画面も新hookを使う。これはcanonical geometryを旧strokeへ往復させて全置換するadapterではなく、新しい文書sessionへ接続する表示操作層である。

本番の表示componentは`AppShell`・`ReaderArea`・`ReaderTab`、Webの`WebLibrary`・`WebAppView`として、layout値とchildren／slotだけを受け取る。従来のquery・store・hotkeys・起動処理は`LegacyDesktopConnection`・`LegacyReaderAreaConnection`・`LegacyWebConnection`・`LegacyWebLibraryConnection`へ移した。job handler登録はlegacy接続の開始effectへ移し、イベント購読より先に実行する。WebのDriveSession／OfflineLibraryStoreはmodule評価時に生成せず、production mountで生成して接続componentへ渡す。表示部品と操作hookから旧API／store／認証／storageへ戻らない境界検査も追加した。

新工程の検証は全単体929件、全型検査・lint・両版build、関連境界40件、分離後の関連browser20件が成功（`output/shared-app-connections-*.log`）。ブラウザはPCの中央／右編集、描画取消、resize、Webの認証復元・幅変更・階層選択・共通toolbarを含む。追加Astraは表示分離と操作抽出に起因する新規の具体的P1／P2を発見しなかった。

### 両本番mountを通すcanonical PDFの接続

`Reader`・`PdfPane`、Webの`DocumentReader`・`PdfReader`から旧query／保存／履歴／認証を外し、それぞれの`Legacy*Connection`へ移した。同じ表示componentを新旧の接続が使用し、旧API応答を偽装する試験専用editorは作らない。

[DocumentLibraryConnection](../frontend/src/features/reader/DocumentLibraryConnection.tsx)が、注入されたscope／repository／文書session／replicationだけを参照してページ選択・倍率・入力・保存表示を所有する。PCとWebのhost viewは既存layoutとPDF面を接続する。両方の`mountDesktopApp`／`mountWebApp`へ同じbindingを渡せるようにした。Webもcanonical経路ではPCと同じ`usePdfPointerInput`を使い、旧Webの別入力listenerは動かさない。

`useDocumentInkEditor`はcanonical値を表示／hit-test用に投影する。最初は新規ペンと削除集合を接続し、その後、下記の意味別操作へ拡張した。既存inkのgeometry／font／opacity／transformを投影値から作り直さず、非ink annotationも保持する。元のcanonical描画を使い、保存待ち・owner不在でも筆跡が消えない。文書で一つのtoolbarからUndo／Redo・保存再試行を操作し、pending中のUndoキーも同じ入口を使う。

初期読み込みは端末保存を先に開き、同期はsingleflightにする。ページ選択は配列indexだけでなく論理page IDを維持する。保存完了後の希望版はpoll競合／読み取り失敗でも保持し、明示checkoutは旧読込を失効させる。pagehide／unmount後はviewに属する追加読込を始めず、BFCache復帰では未完了loadを再開する。保存を所有するsessionはviewより長く維持する。

[実画面の結合試験](../frontend/e2e/webDocumentComposition.browser.test.ts)は、PCの実HTTP／一時SQLiteとWebの実IndexedDBを使用する。Webは空library rootから通常record／resource同期で内容を受信する。PCの旧SQLiteを不正なsentinelにして未アクセスを確認し、両版で旧module／旧API／旧storageの接続がないことも検査する。実Library／Driveへは書き込まない。

最終のChromium／WebKitは2件成功・失敗0（`output/document-composition-acceptance-20261026.log`）。両版の実描画→2本の集合消去→Undo／Redo→通常同期→reload、native commit応答喪失→同ID再試行、同物理頁を参照する別論理頁へ移動後のheld pointer→実root unmount→保存→reload→相手反映を含む。最終文書の完全一致、旧保存域の不変、browser／sidecar終了も確認した。

同段階の全単体946件・依存境界検査、全4 project型検査、lint、PC／Web buildが成功。旧経路の入力・表示回帰も11件成功し、ピンチの連続拡大縮小と400%上限、横スワイプとpan、resize／回転と遅延render、描画中command、ページ全体下限、破損PDF修復、位置復元、共通toolbarを含む。証跡は`output/shared-app-canonical-{unit,typecheck,lint,build-desktop,build-web,pdf-regression}.log`。Python全suiteとWeb全browser suiteは先行工程の記録を維持し、この段階で再実行したものとはしない。

Windows WebKitでは、reload中にtry/catch済みfetchをpageerrorとして報告するengine診断を[アプリ非依存の再現script](../frontend/e2e/support/webkitCaughtFetch.mjs)で切り分けた。結合試験ではengine・reload段階・同origin・特定のread URL・既知stackを全て満たす診断だけを別記録し、それ以外のpageerrorと独立したunhandledrejectionは失敗にする。最終実行はこの診断も両engineとも0件、未処理rejectionも0件だった。診断を隠すbeforeunloadの復帰timerは追加していない。

原訳左右表示・永続Reader状態・付箋／本文highlightの作成・編集・paperノート等の接続は残る。現在のcanonical注釈表示は非inkの保全・参照を扱い、非inkの作者UIまで完成したものではない。既定起動のactive pointerはまだlegacy経路であり、全領域切替は未実施。隔離bindingの成功を全F行の受入や実データ切替の完了へ読み替えない。

### 意味別操作・文字draft・部分消去の接続

`InkEditor.operations`で作成・削除・transform・style・paste・reshape・erase・textを渡し、`canonicalInkOperations`が元のannotationへ適用する。canonical経路で投影配列からupdateを推測する入口は撤去した。toolbarとpointer gestureが同じ操作と文書historyを使う。previewも元canonicalを描き、font／opacity／非等方scale／両矢印／希望矢頭長を保持する。

`DocumentEditSession.surfaces`にページ別選択と文字draftを保持する。draftは入力開始版と物理位置を持ち、owner解放後も残る。再表示時はdraftページへ戻り、新ownerが入力を引き継ぐ。`commitPageInput`は入力終了とpending開始を一つの通知で行う。文字draft中は同一ID・同じ本文の文字確定だけを受理し、Delete／移動／paste／空変更で下書きを暗黙に消さない。保存失敗後はcanonical pending内容と同じcommandを保持する。

clipboardはscope所有の`DocumentInkSettings`へ元annotationとsource幅をコピーし、文書viewの再作成で作り直さない。bindingはrepository／sessions／replication／clipboardのaccount・library・epoch一致を確認する。選択ボタンは常時配置し、有効／無効で表示する。選択によるtoolbarの段数変更がfit-page寸法を変え、gesture中の座標を動かす経路を除いた。Web固有の旧44px固定ボタン指定をこの共通toolbarへ適用しない。

消去はgestureの`CanonicalEraseCursor`へ新しいcircleだけを適用する。fragmentは元local pathから補間し、style／transformと重なり順を保持する。IDは最終fragment順と固定seedから決定し、preview回数に依存させない。prefix／非有限値は変更前に拒否し、取消・確定・unmountでcacheを破棄する。旧cut／erase実装は削除した。320本×20点、120位置の独立した幾何比較では、全prefix再計算24,735.8ms、差分cursor142.9msで同一結果だった（`output/shared-app-erase-cursor-benchmark.log`）。描画・通信・保存時間は含まない。

同段階の全単体は965件成功・benchmark 1件skip、全4 project型検査とlintも成功。専用browser試験は最新sourceでChromium／WebKitとも成功（各1件、`output/document-tools-acceptance-20261026.log`）。実SQLite／IndexedDBの両hostで全7tool、既存属性保持、選択・変形・clipboard、部分消去、文字draftの再表示とremote受信、文字保存応答喪失を確認した。元のcomposition試験も両engineで2件成功（`output/document-composition-regression-20261026.log`）。全4 runの未処理rejection・navigation診断は0件で、browser／sidecar終了と所有temp削除も確認した。受入台帳のaccepted数はまだ増やさない。

結合fixtureの通常転送は、実portと同じ`acknowledgePull`へ接続した。実repositoryへの耐久受信後だけpeer別ledgerを進め、再poll時に既読record／resource／receiptを送らない。全immutable転送logは保持する。全履歴を毎poll再配送する旧fixtureでのWebKit同期timeoutを、この通常同期の接続で解消した。待機上限は変更していない。

既存note session・中央／右配置・保存失敗・描画中command・共有toolbarの関連browser 6件も成功（`output/shared-app-semantic-legacy-regression.log`）。両版buildは`output/shared-app-semantic-build-{desktop,web}.log`。同期状態の文言でPDF表示領域が縮む追加問題も、固定status欄へ修正した。17幅×両host×両engine×4文言の272測定が成功し、toolbar／scroll containerの高さが一定であることを確認した（`output/document-layout-acceptance-20261026.log`）。

### M1の作成・取り込み境界の追加

PDF・手書きノート・Markdown・添付の新規作成に`ContentPublication`を用いる。resourceのbytes/metadataは同一native transactionで保存し、SHA-256、PDF物理頁、page count/寸法を確認してから参照可能とする。異parserの微小な浮動小数差は0.001pt以内を独立検証し、公開元のcanonical metadataを保持する。PDFを一筆ごとのpayloadやprojectionへ含めない。

本文の初期root、項目を追加するLibraryEditBatch、projection、履歴、receiptと完全な作成bundleを同一transactionへ保存する。作成bundleを単なるmetadata batchへ落として送信しない。受信時も作成と最初の編集を同じtransactionで適用でき、初期rootより先に届いた編集は非公開の親待ちとして耐久保存する。作成・親metadataが届くまで項目を一覧へ露出せず、再起動後にも同じ枝を復元する。

`BatchCommitSession`は作成bundleの結果不明も扱う。同ID・同payloadの作成を再送して受理を確定してから逆LibraryEditBatchを保存するため、Undoをmetadataのみの再送や初期本文の破棄に変換しない。これらは新保存portとAPIの実装であり、旧UIの書込が新方式へ切替済みという意味ではない。

検証には[共通publication corpus](../tests/fixtures/shared-edits.json)、[TS契約/障害](../frontend/tests/contentPublication.test.ts)、[Python SQLite/API](../tests/test_content_publication.py)、[実IndexedDB](../frontend/e2e/editRepository.browser.test.ts)、[共通送受信](../frontend/tests/editReplication.test.ts)、[Drive HTTP framing](../frontend/tests/driveEdits.test.ts)を使用する。

### M1のPC転送・checkpoint境界の追加

PCでも`EditReplication`とDrive envelopeを使い、Pythonは認証とファイルI/Oだけを実装する。別account/library/epochのnamespace、resourceのheader/hash、破損body、送信直後の応答消失を検証する。checkpointには元の不変rootと完全なbatchを保持し、projectionだけを転送しない。初回取込の途中で失敗した場合はカタログも公開されず、取込を再実行しても端末のoutboxや履歴を置き換えない。既に受理したcheckpointのhashも同じnative transactionへ保存する。

[TS bootstrap/公開試験](../frontend/tests/editCheckpoint.test.ts)、[PC接続口からの共通sender試験](../frontend/tests/desktopEditTransfer.test.ts)、[Python実SQLite/API](../tests/test_edit_checkpoint.py)、[native Drive I/O](../tests/test_edit_drive.py)、[OpenAPI一致試験](../tests/test_openapi_schema.py)を追加した。SQLiteのtrigger abortとChromium/WebKitの実IndexedDB abort・再起動を用いる。このcheckpoint段階の後に、以下の完成manifest経路を実装した。移行backup、端末ごとのactive epoch切替、旧clientとの併存を完成形として認めるものではない。

### 完成manifestと原子的取込

公開planは全root・完全batch・history・作成bundleと依存resourceのID/hashを固定し、背景bytesは一つずつ取得する。sourceでその後に編集しても公開内容を混在させない。全依存・checkpointの送信成功後に`dataset-manifest`を公開し、応答消失時には同じID/payloadで再送する。取込はmanifest IDを指定し、欠落したcheckpoint、異scope、同ID異manifest、不足/余分なresource、壊れたbytes、localにだけ存在する本文への依存、不正な枝を拒否する。単独checkpointを通常`EditReplication`で自動取込していた経路は削除した。

PythonとJavaScriptのJSON数値表記が同じdigestにならない問題を検出し、内容hash用の[共通encoding](../frontend/src/runtime/edits/editContentHash.ts)と[Python側](../papeer/core/edit_content_hash.py)を実装した。binary64の上下限、整数/小数、±0、Unicode key順序・型境界を同じfixtureで照合する。既存のpayload比較用JSON serializerを内容hashに流用しない。

[TS障害試験](../frontend/tests/datasetPublication.test.ts)、[SQLite/API](../tests/test_edit_datasets.py)、[実IndexedDB](../frontend/e2e/webDatasetPublication.browser.test.ts)、[実HTTP](../frontend/e2e/desktopIntent.integration.test.mjs)でmanifest-last、保存容量不足、途中取消、native abort、再起動、完了応答消失後の再試行、未送信/未表示intent保持を検証する。IndexedDBのv4→v6も既存journal/outboxを消さずに新storeを追加する。ここで保存する取込完了markerはactive pointerとは区別し、下記control経路へ接続する。旧形式全体の停止・backup・一回の変換・本番接続は残る。

### 耐久化した切替planとactive pointer

account/library単位のcontrol recordへ公開plan・run/revision ID・使用済みepoch・段階・active manifestを保存する。端末は取込完了markerから勝手にactiveを選ばず、`activeDatasetScope`でpointerとfrozen状態を確認する。公開前・公開後・有効化後の応答消失でも、再起動後に同じplanを再開する。既存remote datasetへ参加する経路は、背景/checkpoint/manifestを再uploadしない。

sourceの未解決intentとplan外の内容がある場合はprepareを拒否する。prepare/published中はcanonical repositoryのsource書込を停止し、activationでは完了済みtargetと全内容を再検証する。sourceの未送信義務/取込確認とactive pointerを一つのnative transactionで更新する。切替後の旧scopeへのcommit・journal更新・受信・resource/初期内容の書込・receipt更新を拒否し、通常syncもネットワーク開始前に拒否する。guard待機中の別controllerによる切替もCASで検出する。

rollbackは新targetの編集/outboxを別epochへ残してsourceへ戻す。新側の未解決intentがある間は拒否する。DBの全領域backup復元ではなく、新protocolのnamespace保全とpointer復帰である。大きなplanとaccess headは同時保存し、通常の一筆ごとにplan全体を読み直さない。

[同じcontrol corpus](../tests/fixtures/shared-edits.json)を[TS](../frontend/tests/datasetControl.test.ts)と[SQLite/API](../tests/test_edit_dataset_control.py)で検証する。[実HTTP](../frontend/e2e/desktopIntent.integration.test.mjs)では3段階の応答消失とsidecar再起動、[Chromium/WebKit](../frontend/e2e/webDatasetControl.browser.test.ts)ではpointer更新後のnative abort・再起動・outbox同時引継ぎ・rollback隔離・v5→v6のjournal/完了marker保持を確認する。shared document registryとreplicationの停止接続もfixtureで検証した。本番の旧PC/Web保存経路、全領域の停止・backup・変換・端末間確認へ接続したことにはしない。

### 通常同期の履歴転送

`pendingRecords/receiveRecords`で変更本体・履歴action・作成bundleを一つの`EditRecord`として出し入れする。Driveでは作成も通常編集も`edit-record` envelopeを使い、旧bare batch／作成専用envelopeの送信経路を削除した。checkpoint内の記録も同じ型・意味検証を使用する。同IDの異なる履歴を黙って無視せず拒否し、既にあるreceiptや未送信義務を受信時に消さない。ローカルcommitの再試行で送信payloadを変更せず、受信で欠けた履歴を補う場合は同じnative transactionで保存する。PCの通常受信APIだけにあった1,000件制限も除き、1,001件の親待ちから本文到着後の全枝復元まで確認する。

[TSの通常同期回帰](../frontend/tests/editRecords.test.ts)は、別pageで行ったremote編集を最新操作としてUndoし、Undo/Redoを通常同期してsession再作成後も復元する。応答消失時の完全な記録の保持、逆順到着、履歴の補充、異なるmetadataの一括拒否、作成内容と履歴の同時転送も検証する。[SQLite/API](../tests/test_edit_records.py)と[実IndexedDB](../frontend/e2e/editRepository.browser.test.ts)ではnative abort・再起動を確認し、[実HTTP結合試験](../frontend/e2e/desktopIntent.integration.test.mjs)ではTS session→SQLite取込→process再起動→Undoの逆方向同期→Redoを確認する。checkpointを介さない復元経路である。本番のReader/compositionが新repositoryへ切替済みという意味ではない。

### raw入力の退避とnative stagingの分離

`LegacyBackupManifest`はsourceの種類/identity、階層key、bodyのSHA-256とbyte数、空container、inventory digestを持つ。key順はUnicode scalar順に固定し、区切り文字やTSのUTF-16順へ依存させない。共通entryは固定planと返却manifestの一致、読込bodyのhashを確認する。host callbackへ渡す値もcopyして、保存中に要求が書き換わらないようにした。

nativeはsourceのSQLiteを接続せず、全regular fileをstreamで退避する。WAL/SHM、notebook journal、未完了の`.tmp`も省かず、空directoryも記録する。source fileのhash/サイズ/更新情報とdirectoryの集合を前後で照合し、変化時は完了manifestを公開しない。リンク/junctionや特殊fileは黙って辿らず拒否する。planを先に保存し、内容hashでbodyを共用する。OSのprocess間lockとatomic renameでIDの上書きを防ぎ、応答消失後も同じplan/bodyを読める。hard link対応を前提にしない。Windowsでlstat/fstatのctimeが異なる実例を確認したため、その差だけをnativeのhandle比較へ閉じ込め、path同士の観測とcontent hashの確認は維持した。

解析には`NativeLegacyBackup.analysis_copy`で検証済みbodyから専用の一時treeを組み立てる。全componentのnative path安全性とcopy後のhashを確認してからparserへ渡す。不変bodyをhard linkせず、WAL回復・SQL解析や作業中の書込が元source/backup objectへ伝播しない。空directoryも再現し、通常終了/解析失敗では解決済みpathを専用領域内と確認して一時treeだけを削除する。実WAL/SHMで回復と追加書込を行い、元sourceと退避bodyの不変性を確認した。これは作業用copyであり、旧sourceへのrollback復元やprocess強制停止後の一時tree回収ではない。

認証付きの`/api/edits/legacy-backup/*`を[desktop port](../frontend/src/adapters/desktop/legacyBackup.ts)へ接続した。`legacy`/`canonical`の指定領域を選べるが、任意のfilesystem pathは受け取らない。metadata/readbackも旧Libraryを初期化しない。未完了plan・完了manifestの読込を区別し、完了artifactはsourceが後から変わっても保持する。bodyの破損や欠落は完了markerで隠さず失敗とする。backup保存域自体は入力の外に置く。

browserは旧runtimeの起動前に、Papeer/paperdeskのlocalStorageと旧`paper-desk-storage`をそのまま読む。適用済みack、壊れたJSON、未送信内容、壊れたUTF-16値/keyもJSONのescapingと不透明なkey hashで保全する。sessionStorageを読まず、既知のGoogle session credentialも除外する。元のlocalStorageは書き換え・削除しない。専用IndexedDBに固定planと不変bodyを保存し、全bodyの存在確認とmanifest追加を同じnative transactionへ入れる。Source変化・quota・native abortではplan/bodyを残して再試行できる。

旧offline IndexedDBはorigin内の`papeer-documents:*`を列挙し、存在するDBだけをversion指定なしで開く。存在しなければ生成transactionをabortし、DB列挙機能がなければ空集合で成功扱いしない。全storeを一つのreadonly transactionで読み、DB名/version、store/index/keyPath、空store、全primary key/valueを記録する。PDFのArrayBuffer/Blob、送信済みlocal operation、未送信注釈も除外しない。structured valueは[専用codec](../frontend/src/adapters/browser/legacyStructuredValue.ts)でUTF-16、undefined、NaN/-0、疎配列、循環/共用参照、Date/Map/Set、buffer/view、Blob/Fileを保持し、binaryをhash参照へ分離する。未対応のplatform objectは黙って消さずcaptureを拒否する。localStorageと同じ共通手順で、入力を再照合してからmanifestを確定する。

Driveも[同じsource collector](../frontend/src/migrations/legacyDrive.ts)を両hostで使う。公開manifestの元bytes、全参照file、公開folderの全file/旧blob・入れ子/空folderのmetadataを収集する。folder外にある`ink-v1`/`notes-v1`/`note-blob-v1`もlibrary属性で列挙し、適用済み操作・削除操作・不正JSONをrawのまま残す。構文を読めるnote操作ではblob参照も辿り、folder外や属性がなくなった本文もSHA-256/サイズで検証して退避する。不正JSONの解釈・ledgerとの統合はこの処理で行わず、後の変換で失敗を報告する。

source identityは期待するaccountとlibraryから固定し、取得前後に[DriveのpermissionId](https://developers.google.com/workspace/drive/api/reference/rest/v3/User)を照合する。[file version](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)はint64のdecimal stringのまま保持し、Numberへ丸めない。bodyのSHA-256/byte数、manifestとnoteの参照hash、読込前後のmetadataと列挙集合を照合する。既存fileの版更新・後着操作・別accountを、固定したplanへ混ぜない。[incompleteSearch](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list)や繰返すpage tokenは空の結果や完了扱いにせず失敗とする。Googleのtoken/headerはartifactに含めない。この前後観測は全writer停止やDrive全体の原子的snapshotの証明ではない。

認証とGET I/Oは[PC](../papeer/core/migrations/legacy_drive.py)・[Web](../frontend/src/adapters/browser/legacyDrive.ts)へ閉じ込める。Webは既存DriveSessionの期限・logout/generation guardを使い、PCはsidecarのcredentialを使う。sourceの解析・退避確定・採用方針をPythonへ複製しない。artifactの保存先は[PC port](../frontend/src/adapters/desktop/legacyBackupStore.ts)または既存のIndexedDB storeから注入する。PCの`FileLegacyBackupStore`をnative raw backupにも共用し、固定plan、bodyの不変性/照合、manifest-last、同ID再開・source隔離を一箇所で扱う。新しい認証付き`backup-artifacts/*`/`legacy-drive/*`は旧Libraryを開かず、任意の保存先pathやtokenをclientから受け取らない。

新APIが旧`library.sqlite3`にstagingを書いていた接続も分離した。repositoryは注入したconnectionだけを使い、production用接続は旧rootの外の専用SQLiteを開く。旧Sourceのraw観測値がstaging/再起動/編集/Undo/Redo後も一致する結合試験を追加した。この保存先はまだ本番compositionに未接続であり、保存先変更・通常backup/restoreが全footprintを扱うまで有効化しない。

[Python/native障害試験](../tests/legacy/test_legacy_backup.py)では、実WAL/SHMを含む退避コピーを別SQLiteで回復し、元bytesが変わらないことを確認する。コピー途中の容量不足、後着入力、固定planの再開、完了応答消失、同ID競合、並行capture、object破損、path注入、実Windows junction、認証を試験する。[新保存先の試験](../tests/test_edit_storage.py)は旧DBを開けない内容にしても新APIを使えることと、旧入力/新保存域それぞれの退避を確認する。[共通/localStorage試験](../frontend/tests/legacyBackup.test.ts)、[実HTTP/SQLite](../frontend/e2e/desktopIntent.integration.test.mjs)、[Chromium/WebKitの実IndexedDB](../frontend/e2e/webLegacyBackup.browser.test.ts)も使用する。

旧IndexedDBは[両engineの実storage試験](../frontend/e2e/webLegacyIndexedDbBackup.browser.test.ts)で、旧`OfflineLibraryStore`が保存した実PDF/注釈、追加store/index/複合primary key/循環参照を収集し、native abort、reload、応答消失、収集中の追記、容量不足と同ID再試行を確認する。収集元DBを削除しても完成artifactを検証・読込できる。fixtureの最初の試行では追加storeを作るためDBをv2へ上げ、旧adapterのv1固定openが失敗した。fixtureをv1作成時に追加storeも生成する形へ直し、旧adapterによる元データの再読込・追記の検証を維持した。

未完了の境界は明確に残す。明示した参加端末とsourceのcoverage・固定planの耐久参照は以下の共通処理へ追加したが、全端末/全領域の自動棚卸しと停止controllerは未実装である。Driveのsnapshot/操作/本文/ledgerはraw fileとして保持するが、旧Webの適用済みledger・pendingとPC状態の意味上の統合は残る。IndexedDBのautoIncrement属性は記録するが、APIでは読めないkey generatorの内部状態を復元済みとはしない。現在の旧offline storeはautoIncrementを使わない。前後照合はwriterを止めた証明ではない。起動admissionを以下のように実装したが、受理済みの処理・実行中job・他tab/端末の停止確認、変換・切替状態との接続、全域restoreは必要である。単体のbackup完了や起動holdからactive datasetを推測しない。実ユーザーのデータへのcapture/移行・Drive書込はしていない。

### 全入力計画の固定と部分失敗からの再開

[共通入力制御](../frontend/src/migrations/legacyInputs.ts)は`LegacyMigrationCatalog/InputSet`でaccount/library/run、明示した参加端末、各sourceのidentity、固定backup planを一対一に結ぶ。宣言されたsourceの欠落・余分・重複・順序違反、run/backup IDの再使用、同一Driveを見た端末間の内容不一致をTS/Pythonの同一corpusで拒否する。source列挙と収集のI/Oは注入し、共通処理は旧ストアやDrive APIを直接参照しない。

全planをbody収集前に、holdと同じrunの不変recordとして保存する。nativeは入力外のbootstrap領域へOS lockとatomic publish、browserはartifact DB v3の`inputs` storeへhold確認と同一transactionで保存する。応答消失/再起動後は保存済みの同じID/planを読み、完成済みbackupを再利用し、未完成sourceだけを続ける。全bodyのhashを確認した後、先にコピーしたsourceを含めて全入力とsource集合を再照合する。後着source/記録のあるplanを成功扱いしない。検証結果からactive datasetや全writer停止済みを推測するmarkerは作らない。

[共通試験](../frontend/tests/legacyInputs.test.ts)と[Python試験](../tests/legacy/test_legacy_inputs.py)、[PC実HTTP](../frontend/e2e/desktopIntent.integration.test.mjs)、[Chromium/WebKit](../frontend/e2e/webLegacyInputs.browser.test.ts)で、計画保存transactionのabort、応答消失、部分captureの失敗、process/document再起動、同一IDでの再開、欠落/後着入力、元データの不変性、v2のhold/artifactを保つv3 upgradeを確認する。catalogにまだ宣言されていないoffline端末を発見した証拠にはしない。各hostの全領域を列挙するcompositionと参加端末の確認、稼働中writerの停止、変換・rollbackへの接続は残る。

### 端末の永続記録

[NativeLegacyDeviceBackup](../papeer/core/migrations/legacy_device.py)は旧Settings/Libraryを初期化せず、device-settings、保存先、history/OCR設定と、現在のlibrary keyを持つ同期状態・first-seen・Drive接続先・閲覧履歴・review/search記録をraw bytesで退避する。未知のkey付き記録、SQLite WAL/SHM、未完了atomic outputも残す。通常は現在のlibraryと保存先変更前のhistory keyだけを収集し、壊れた保存先設定では元bytesと候補historyをすべて保持する。Google credential、process lock/discovery、log、再取得できるOCR model、通常時の他library記録は開かない。

選択した階層は、directory identity・選択対象の全name集合・fileのhash/観測値を前後で照合する。対象外のcredential更新や別libraryの記録だけでは入力変更としない。保存先設定の元bytesも前後照合し、走査ごとにhistory対象を解決し直す。端末folderがない場合は空の入力として記録し、入力folderを新規作成しない。APIの`area: device`はserver側のfootprintを選び、clientの任意pathは受け取らない。

[Python試験](../tests/legacy/test_legacy_device.py)は対象外fileを開こうとすると失敗するようにして、選択範囲・history alias・不正JSON・不明なkey付きfile・WAL/SHM・一時file、対象外更新/後着対象記録、欠落folderの保持を確認する。PCの実HTTPでは[共通desktop port](../frontend/src/adapters/desktop/legacyBackup.ts)から退避し、応答消失・process再起動後のplan/body読込を確認する。library外の旧side backupや外部folder-sync領域など、必要なsource全体の確定は上位のcatalogに残す。

### 旧runtimeの起動保留

`LegacyMigrationHold`はrun IDを持つ不変recordで、TS/Pythonの同じschemaで検証する。nativeでは入力外のbackup領域、browserではartifact IndexedDBの`holds` store（v2で追加、現在はv3）へ耐久化する。別runによる置換、未知のauto-release field、booleanのversion、壊れたUUIDを拒否する。期限で自動解除せず、検証なしに解除するAPIも設けていない。recordの作成自体は全writerの停止完了を表さない。

PC/Web本番entryは[共通起動処理](../frontend/src/app/startup.ts)を先に実行する。PCのbackend port/token設定はstoreを読まない[接続情報](../frontend/src/api/connection.ts)へ分離した。holdの不存在を確認してから従来のcompositionをdynamic importする。holdがある/読めない場合は待機/再試行を表示し、`migrateStorage`・uiScale・Zustand等の旧storeやWebのDriveSession/OfflineLibraryをimportしない。browserのv1→v3 upgradeで既存plan/body/markerを保ち、hold追加transactionのabort・再読込・別run拒否を実IndexedDBで確認した。

nativeのLibraryもschema移行・journal回復より前に同じrecordを確認する。sidecarはhold中の起動時translation cleanupと予約された保存先移動を行わず、新規の旧HTTP操作は設定APIを含めて拒否する。認証前に移行状態を漏らさず、canonical/退避API、job状態・取消、終了は残す。起動確認のmetadata APIは通常snapshot中も旧Libraryを開かず応答する。record破損も旧形式の起動許可へ読み替えない。

[起動契約/native試験](../tests/legacy/test_legacy_startup.py)、[両本番entryのChromium/WebKit試験](../frontend/e2e/webLegacyStartup.browser.test.ts)、[PC実HTTP/再起動](../frontend/e2e/desktopIntent.integration.test.mjs)で旧storeの未import、旧localStorage/無効session grant/元DB/journalの不変性を確認する。native fixtureはapp import前にdata/device領域を検証済みの一時folderへ限定する。起動済みWeb tabのdispose/未完了write、nativeの受理済みrequest/job、他端末の旧writerを停止・確認するcontrollerはまだない。起動holdだけでfreeze完了・変換・公開・active切替を行う経路は作っていない。

### 既存筆跡の一回変換とgeometry保全

変換元のnormalized点列・ページ幅基準の線幅をpointへ移す。自由線・蛍光線・直線・矢印・四角・楕円・文字のすべてを対象にし、回転・拡縮・文字の横方向stretch・改行を保つ。旧蛍光線のopacityは0.3。旧矢印の実際の矢頭と編集用の希望サイズを共通Schemaへ明記し、SQLite/APIでも欠落させず保持する。converterには旧editor・ストア・保存先をimportさせず、通常の共通runtime/editorからconverterへの依存も禁止した。

入力は非同期処理の前に固定し、IDはlibrary・種類・区切り曖昧性のないsource key配列から生成する。run IDやtarget epoch、列挙順へ依存せず、同じsourceの本文が変わった場合は同ID・異なるfingerprintとなる。原文/訳文/pageのkeyを混在させず、PDFのsourceRevisionが合わなければ停止する。未知のmetadataや非直交frame・壊れた矢頭などを黙ってpathへ置き換えず、元keyと理由を報告し、部分的に変換したpageを返さない。変換元自体は変更・削除しない。これはbackup実装の代用ではない。

[変換試験](../frontend/tests/legacyInkMigration.test.ts)は旧生成・handle変形関数から作った点列と共通geometryの全点を照合する。縦長・横長・極端な縦長、短軸/端の矢頭、Unicode/複数行の文字枠、ID/入力固定/不正値/上限を検証する。[geometry試験](../frontend/tests/annotationGeometry.test.ts)と[Python側](../tests/test_edit_geometry.py)は、回転・非等方scale後の楕円極値、矢頭のoverflow・非有限値を確認する。[PC実HTTP](../frontend/e2e/desktopIntent.integration.test.mjs)ではSQLite保存後にsidecarを再起動し、[Web実IndexedDB](../frontend/e2e/webLegacyInkMigration.browser.test.ts)ではnative transaction abort、document再読込、Undo/Redoとoutbox保持を確認する。新suiteは`test:web`の自動探索対象である。描画UIの本番切替・実機確認とは区別する。

付箋・本文highlightには分類label・UTC作成日時を追加し、引用とコメント本文を別々に保存する。highlightのtext rangeはindexed/unindexedのunionに変更し、旧記録にないoffsetを補わない。移動先anchorとquadも区別し、resizeでは双方へ同じ物理変換を適用する。日時は実在するGregorian日付をTS/Pythonで検証し、秒の小数を最大6桁まで保持する。未知の日時はnull、付箋の明示色未指定もnullであり、任意の時刻や色を捏造しない。旧SQLiteのUTC日時はtimezone推測を使わず正規化する。固定長ID/色/hashには長さも検証し、正規表現の`$`が末尾改行を許す抜け道を防いだ。

[注釈変換試験](../frontend/tests/legacyBookmarksMigration.test.ts)と共通fixtureの`annotations`で、全5色、Unicode/複数行、分類、日付境界、64bit bookmark ID、原訳/ページの分離、元payloadのhash、両familyを合算したページ上限を確認する。fixtureのrectsはAPIでdecode済みの配列ではなく、元のSQLite JSON文字列として取り込む。不明field・壊れたJSON・不正な日時/ID/範囲は未変換として残す。

[native fixture](../frontend/e2e/fixtures/legacyAnnotations.py)は、旧Libraryの作成・用紙変更・保存APIでLetter縦/A4横の2pageと全注釈を一時libraryへ作る。readbackはLibrary初期化を通さないread-only SQLで、安定page ID、実際のmm寸法、全bookmark列・全筆跡を読み、共通converter→実HTTP/SQLite保存へ渡す。再起動・Undo/Redo後も全旧table行と全fileのhashが一致することを確認する。nativeのint64 IDはJSONへ文字列で出し、JS数値で丸めない。最初の試行では、試験用接続が旧size/orientationを新PaperSpecへ余分に渡して拒否された。新モデルの寸法はPageへ、背景にはtemplate/colorだけを渡すよう修正した。実ユーザーのlibraryの棚卸し・backupを実行した証跡ではない。

全領域変換には旧Webの削除・適用済み操作・未送信操作、ノート/Markdownの競合・回復journal、Library構造・添付・resourceの変換が残る。旧DB/file/Driveを含む棚卸し・watermark固定・backup・停止gate・全内容照合を実装するまで、本番active pointerを切り替えない。新annotation契約のtoolbar/作成/一覧/exportも本番接続前である。

source収集は旧runtimeの起動前に行う必要がある。旧Webの`NoteStore.start`は適用済みlocalStorage操作を削除し、nativeのLibrary初期化・ノートreadはschema/回復fileを更新する。既存のsnapshot/backupも未完了atomic fileを通常公開から除外するため、そのまま全journal保全の証明にはしない。収集adapterは生の記録を先に固定し、変換処理から旧runtimeの更新副作用を呼ばない。

### 文書session・原訳identityの追加

`translation.pages`を原文と異なる安定IDの編集対象とし、対応表を保存するschemaへ移した。原文1/3だけに訳文物理4/5があるfixtureで、原文2を別の訳文へ対応付けない。両collectionの上限は各500。差替えの前後に届いた旧訳文編集は別の文書headとして保持し、旧注釈を新背景へ転用しない。SQLite/IndexedDBの不変page投影・resource検証・checkpoint送信も訳文を列挙する。

文書historyはIDと版の参照だけを持ち、逆batchを同じrepositoryへ保存する。ページを越えた「描画→複製→別page描画」、訳文差替え、注釈の重なり順、背景を戻す際の本文highlight／原訳参照、複数pageの移動・削除・挿入を検証した。履歴actionも保存し、耐久済みのUndo/Redoを再読込で復元する。文書sessionは保存失敗・結果不明の内容を保持し、保存の再試行後に逆操作を確定する。保存成功の通知中にUndoが要求される競合も`BatchCommitSession`で修正した。

これは新しいsession/保存契約の段階であり、旧PC `activeEditor`・page別stack・旧Web editorを撤去済みとはしない。新sessionとregistryは本番接続前の`staged` entryとして登録した。

証跡は[文書session](../frontend/tests/documentEditSession.test.ts)、[文書履歴](../frontend/tests/documentHistory.test.ts)、[原訳mapping](../frontend/tests/translationDocument.test.ts)、[Python保存/共通逆batch受入](../tests/test_translation_document.py)、[実IndexedDB](../frontend/e2e/editRepository.browser.test.ts)に記録する。実IndexedDB試験はDOM上の描画・toolbar操作の受入とは区別する。

### 送信前intent・保留Undoの回復

`EditIntentRecord`を共通Schemaへ追加し、要求全体・送信した可能性・Undo要求・生成済みの逆batchを保存する。SQLiteとIndexedDBは同じscope/対象の期待revisionを検証し、更新自体の応答を失った場合も同じmutation IDを再送して確認する。requestの差替え、Undoの取消、固定済みinverseの変更を拒否する。journal書込が確認できるまで元のbatchを送信せず、削除確認に失敗した場合も遷移guardを解除しない。

文書sessionはnative journalから元のpreviewと保留Undoを復元する。scope registryは一文書一sessionを保持し、未表示文書のintentも列挙する。停止後の旧callbackを拒否し、対応外のfeatureのintentは未処理一覧と離脱guardに残す。文書以外のfeatureへの実接続とWorkspace/logoutの画面接続は残る。

[共通journal試験](../frontend/tests/editIntent.test.ts)、[SQLite/API・backup](../tests/test_edit_intents.py)、[Chromium/WebKitのdocument再読込](../frontend/e2e/editIntent.browser.test.ts)、[PCの実HTTPとsidecar停止・再起動](../frontend/e2e/desktopIntent.integration.test.mjs)を追加した。PC試験は実FastAPI・SQLiteと共通desktop adapter/registryを使い、journal・元batch・逆batchの応答消失を検証する。認証・libraryは専用fixture processと一時DBへ隔離し、起動時job/cleanupを無効化する。実ユーザーのlibrary・Driveへの試験書込は行わない。新たな2結合suiteは`test:web`の探索対象へ登録し、backend/schemaのみの変更にもCIを適用した。

最初の並列実行ではWindowsの一時DB削除が`EBUSY`となった。fixtureのSQLite接続を明示closeし、子processのcloseを待ち、削除の標準retryを使うように修正した。Python環境を必要とする実HTTP試験はe2eへ配置し、Nodeだけのfrontend単体CIの依存関係を維持した。回復内容・ID・batch件数の検証は省略していない。

全検証の同時実行中にはnative APIの起動待ちが20秒でtimeoutした。結合suiteを単独で再実行し、実HTTP2件とChromium/WebKit4件の全6件成功を確認した。起動待ち・親testの制限時間は変更していない。

## 回帰の補足

- R01: 同一sessionの右表示→中央表示への所有権移動、A→B編集後のUndo、古いview callback拒否を単体試験。両host部品のremount/二重表示もブラウザ試験した。旧実装を再実行した現行再現記録は未取得。
- R02: dirty Markdownにremote通知→保存しても元baseを保持する。復元した構造付きdraftも元revisionを保持する。元版不明の文字だけのdraftは別の回復欄とする。
- R05/R06: 新wire契約の共通fixtureで文字数、0寸法、不正座標・変換等を検証。非有限値・巨大整数・単独surrogateも拒否する。稼働中の旧NoteDocumentでも200 code pointのtitleと競合suffixを補正し、Python側と一致させた。旧すべての保存validatorの撤去は未完了。
- R11/R12/R21/R22/R26: 新契約のDAG、native transaction、結果不明、文書単位競合、削除後の内容queryを試験。旧本番保存経路まで移行したと解釈しない。
- F26: 既存PCの持ち物一覧で、添付・関連を含む合計5件の規則と「ほか」の件数を修正。旧`memoChildren.test.ts`の混在6ノート＋1添付の期待値を「ほか2件」へ変更した。Web tree全体の統合は未完了。
- 全Web試験で見つかった終了座標を持たないsynthetic TouchEventは、スワイプを取消しつつピンチを終了させる。入力正規化境界で存在しないrelease座標を補わない。
- 指描画ONでピンチまで無効にしていた接続を修正した。ピンチは有効のままとし、描画中の一指swipeだけを抑止する。Chromiumの実touch入力で倍率変更と余分な筆跡が増えないことを確認した。全gesture所有の新sessionへの置換はまだ残る。
- 低い横長画面では、書き込み中もtitleと読書controlsを同じ行へ配置し、共有toolbarとPDFを別の行に配置する。左右のcaptionと44pxの操作対象を維持する。
- 図形作成をWebだけへ複製せず、PC PDFと手書きノートの生成処理も共通draftへ置換した。pointerupの終点を反映し、タップや面積0の四角/丸を保存しない。点数上限で古い点列を削るノート処理も廃止し、起点を保持する。狭幅Webでは「書き込み設定」内の「描画の種類」から選ぶ。
- 全Web試験でWebKitの連続pinchが400%から下限へ確定しないケースを検出した。倍率callbackの参照変更だけでlistenerを解除/再登録しないようにし、最新callbackを参照する。初回listenerもlayout effectで描画前に設置する。400%↔ページ全体を4往復する回帰試験を加え、WebKit/Chromiumで成功した。実機検証の代わりにはしない。

### 既存browser期待値の修正理由

F01の共有toolbarに合わせ、PDF pane内のbutton/popover参照を文書の1本のtoolbarへ移した。toolbarの横位置も文書領域に対して検証する。既存UIの「ノート」という表示名へtab/menuの期待値を合わせ、保存・本文・履歴・引用・回復の検証を削除していない。

F17の連続倍率では整数CSS幅への丸めを1px以内として検証し、アンカー・viewport倍率・縮小下限の条件は維持する。Drive fixtureはuploadしたimmutable operationをlist/readへ戻すようにし、reload後にserver側変更が消える不正なmockを修正した。WebKit offline fixtureは旧documentにもoffline状態を反映してからネットワークを停止する。PWA状態試験はcold Vite起動のdocument読込待ちを明示し、workerの更新・置換・適用の検証は維持する。

PWAの実worker更新試験で、更新前workerの`activated`だけを見て、新workerがまだwaitingでも次のclientを開ける待機条件を検出した。waiting/installingがなくなるまで待ち、最終cache確認でもactivationを確認するように修正した。更新後の単独試験は成功。失敗時のfixture serverの接続も明示終了し、teardownが残らないようにした。更新を即時適用する等の本体側の仕様緩和は行っていない。

## 検証

検証ログは`output/shared-app-*.log`に保存する。実行途中や再検証中の結果を完了扱いしない。

| 検証 | 結果 |
| --- | --- |
| frontend型検査 | `pnpm typecheck`成功。src/node/test/e2eを確認 |
| frontend lint | `pnpm lint`成功 |
| frontend単体試験 | `pnpm test` 848件成功。入力集合のcoverage/不変plan/部分失敗からの再開とhold、raw backupの固定plan/入力保持、structured valueの循環/共用/binary/UTF-16保全も含む。全annotationの一回変換、indexed/unindexed、分類/コメント/UTC日時、64bit source ID、全7種のgeometry・安定IDの固定golden値・楕円極値/矢頭範囲・移行境界を確認。control/CAS/凍結/切替/rollback・完成manifest/内容hash/段階公開・原子的取込、通常同期の完全record/履歴復元、intent/CAS/registry・文書session/参照履歴/原訳mapping、作成/resource/送受信・checkpoint、contract/session/依存境界・図形生成を含む |
| Python関連試験 | 共通契約/全annotation/SQLite/API/原子的保存/同期/intent/作成/resource/checkpoint/backupに加え、device/起動gate/input set、既存cloud annotations/notes/PDF ink/capture/bookmark/sticky、sidecar認証/停止、保存先変更、Library/config/OpenAPI/CIを含め718件成功・1件skip（`output/shared-app-python-tests.log`）。skipはWindowsで実行しないPOSIX SIGTERM試験（Windowsはjob objectで終了）。受入台帳checkは別途成功 |
| Python新規module/変更箇所のruff/pyright | 新規device/起動gate/input setと関連試験を含め成功。既存moduleの未解消baselineは以下に区別 |
| 既存PDF inkテストへの追加静的検査 | `tests/test_pdf_ink.py`を単独でpyright対象へ広げると20件の既存エラー。HEADの同fileを一時保存して比較し、診断のseverity/messageがすべて同じことを確認（`output/shared-app-pdf-ink-type-baseline.json`）。今回の新geometry/model/testのpyrightは成功。この20件を解消済みとはしない |
| PC/Web build | `pnpm build` / `pnpm build:web`両版成功 |
| 実IndexedDB | Chromium・WebKitの両方で成功。4編集契約、4作成経路、checkpointに加え、通常recordの逆順到着・容量不足rollback・履歴復元、文書sessionの容量不足保持/再試行・所有者guard・訳文差替え・Undo/Redoを確認。実PDFのCropBox/全Rotate/UserUnit/小数boxをPDF.jsとPyMuPDFで照合 |
| 保存・通常同期・dataset切替結合試験 | Chromium/WebKitでjournal・完成manifestに加え、pointer/outbox同時更新のnative abort・再起動・scope凍結・rollback隔離・v5→v6の完了marker/回復情報保持を検証。実HTTPではprepared/published/activatedの各応答消失→process再起動→同一plan再開も成功。5 suite計15件は`output/shared-app-control-acceptance.log` |
| 既存筆跡の変換・保存結合試験 | 変換済み全7種をPC実HTTP/SQLite・Chromium/WebKitの実IndexedDBへ渡し、保存・native abort・再起動/再読込・Undo/Redo後もgeometry/希望矢頭サイズとoutboxを保持。既存PC障害試験も含む2 suite計10件成功（`output/shared-app-migration-acceptance.log`） |
| 全annotation変換・保存結合試験 | 付箋・全5色の本文highlight・全7種の筆跡を一緒に変換し、metadata/UTC日時/quote/コメント/anchor/未索引状態を保持。実旧Library/SQLite/Notebook source→共通変換→実HTTP/SQLiteのprocess再起動/Undo/Redoと旧sourceの全table行/file hash照合、実IndexedDBのnative abort/reload/Undo/Redoを確認。2 suite計10件成功（`output/shared-app-annotations-acceptance.log`） |
| raw入力退避・保存域分離・annotation結合試験 | PC実HTTP・file/SQLiteとChromium/WebKitで以前の5 suite計17件成功（`output/shared-app-backup-acceptance.log`）。nativeの固定plan/応答消失/旧source不変、localStorageの不正JSON/UTF-16/ack保全、旧offline IndexedDBの全store/schema/複合key/PDF/循環参照、native abort/reload/容量不足/追記拒否、共通annotation変換とUndo/Redoを確認。Driveの両host同一collector、GET pagination、manifest/operation/本文blob/移動先の参照、raw ledgerとbyte照合、sourceへの書込なし、artifact確定の応答消失とprocess/document再起動、後着操作・account変更の拒否も確認。PCの変換は検証済みbackupの専用copyから旧SQL/Notebookを読み、移行元DBを開かずに実行する。全source coverageや本番起動gateの完了とはしない |
| 全入力計画・端末記録・起動gateの結合試験 | PC実HTTP/SQLiteとChromium/WebKitの5 suite計22件成功（`output/shared-app-inputs-acceptance.log`）。固定input setのhold確認・耐久保存abort/応答消失・部分capture・再起動/同一ID再開・欠落/後着sourceの拒否、artifact v2からv3の保持と、両本番entryの旧store未importを確認。既存native同期/切替/rollback/annotation/Driveとraw localStorage/IndexedDBの障害経路も含む |
| ノート両host部品のブラウザ試験 | Chromiumで成功。共通entryの実行、Markdown Undo/Redo、手書きremount、二重編集防止を確認 |
| 既存ノート作成・容量不足・再試行 | Chromiumで成功 |
| 全Web browser suite | 端末入力・両本番起動gate段階の`pnpm test:web`は63件成功・失敗0・取消0（`output/shared-app-browser-tests-current.log`）。annotation/Drive/旧IndexedDBのraw収集、通常同期/保存/完成manifest/control、旧PDF/ノート/Library、左右同期/pinch/縮小下限、位置復元、PWA/offline、ログイン回復、共有toolbarを確認。その後の複数source入力集合とartifact DB v3では、下記の関連22件、全単体848件、型/lint/両buildを実行。全63件をv3追加後の全suite再実行とはしない。実機Safari/Apple Pencilとは区別する |
| 図形生成の最終回帰 | PC図形command・pointercancel・両hostノート、Webで全4種作成→Undo/Redo→reload→Python PC取込が成功。シナリオ拡張で旧180秒上限を超えたため親試験を300秒に変更した。連続pinchの4往復、PWA実worker更新を含め、全Web suiteと両buildも成功 |
| editor公開型分離後のPC操作 | `inkCommands.browser.test.ts`成功。図形drag中のDelete/Undoとpointercancelを確認。両build等との同時実行ではtimeoutし、単独再実行で成功した。今回は試験の制限時間を変更していない |
| iPad/Safari/Pencil実機 | 未実施。WebKit自動試験で代用しない |
| 全領域変換/中断/rollback | 未実施。実ユーザーのlibraryやDriveへ変換・試験書込はしていない |

保存する証跡は`output/shared-app-module-graph.json`（両本番entryの依存edge・実行日・source SHA256）、`output/shared-app-notes-trace.json`（fixtureのbrowser/OS/入力・共通session/render実行・source SHA256）、`output/shared-app-unit-tests.log`、`output/shared-app-browser-tests-current.log`、`output/shared-app-notes-final.log`、`output/shared-app-shapes-browser.log`、`output/shared-app-desktop-ink.log`、`output/shared-app-pinch-final.log`、`output/shared-app-pwa-final.log`、`output/shared-app-build-{desktop,web}.log`。以前の失敗を含む試行ログも残しているが、最終の全Web結果は`browser-tests-current`を参照する。外部サービスとデータはfixtureで置換し、実機・実データ移行の証跡とは区別する。

作成/resource/checkpoint/文書session拡張時の実IndexedDBは`output/shared-app-publication-browser.log`、通常record/intent段階は`output/shared-app-intent-acceptance.log`、完成manifest段階は`output/shared-app-dataset-acceptance.log`、controlの合同試験は`output/shared-app-control-acceptance.log`、既存筆跡の変換は`output/shared-app-migration-acceptance.log`、全annotation変換・保存の結合試験は`output/shared-app-annotations-acceptance.log`、raw backup/解析copyと全annotationの合同試験は`output/shared-app-backup-acceptance.log`、旧IndexedDB収集の単独試験は`output/shared-app-idb-backup-acceptance.log`、Python関連の最終718件・POSIX専用1件skipは`output/shared-app-python-tests.log`、input set/端末/起動gateの合同22件は`output/shared-app-inputs-acceptance.log`に記録する。PDF ink/captureまで広げた最初の実行では、旧テストがノート内画像の所有者prefixを見込まず1件失敗した。保存直後の正しい本文と画像bytesを明示し、サマリー再生成後に両方が保たれる検証へ修正した。関連42件と当時の164件の再実行で成功し、その後の関連224件にも含めている。

## 次に完了させる境界

paperノートとReaderの隔離接続は下記の実装記録へ進んだ。次はMarkdown、Libraryの順に、両本番mountからの操作・耐久保存・再起動・相手反映を揃える。紙は同じeditor/sessionとPaperBackgroundを使用し、用紙変更はhighlightの背景revisionと同じbatch IDで行う。詳細な順序と具体的な接続先は[Astra追補](shared-app-next-steps-astra.md#paper接続の具体化追加astra調査)を使う。

M1の残件である保存先に基づく権限/版の検証、全端末のwriter停止、全領域の棚卸し/backup、一回変換、通常backup/move/restore、rollback復元、active pointerからの既定起動、共通exportは実データ切替の必須条件として維持する。公開plan耐久化・凍結・有効epoch切替・隔離rollbackの成功だけで切替を許可しない。新形式へ切替える際に旧PDF全置換と旧単stroke保存を残さない。

**隔離PDFのペン・消去接続や図形生成だけで、共通editor全体、Reader/PdfSurface全置換、全Library/Workspace機能を解決済みにしない。** 全受入行は[台帳](shared-app-acceptance.json)で未検証部分を保持する。accepted 0件のままであり、iPad/Safari/Pencil実機は引き続き未実施である。


## 紙ノートの本番composition接続（2026-10-26）

隔離libraryのnotebook publicationを、PDFと同じ`DocumentLibraryConnection`／`DocumentEditSession`／`InkOverlay`へ接続した。PC・Webは同じ物理ptのSVG背景、全7tool、ページ追加・全annotation複製・移動・削除、用紙設定を使用する。用紙変更は同じbatch IDでhighlightの背景revisionを更新し、物理位置と線幅の維持、overflow拒否、明示等方fit、Undoを通す。紙のためのPDF resource生成・保存・転送経路は作っていない。

中央と右は`DocumentWorkspace`のplacementだけを変更し、文書session、履歴、clipboard、input ownerを作り直さない。参照側はwriterをclaimせず、focus時は旧active editorを解除する。文字draft・保存失敗時の移動拒否、描画finalize→保存確認→移動の順を共通化した。

紙の実PC・Web mount試験はChromium 36.28秒、WebKit 62.35秒で成功した。実SQLite／IndexedDB／通常incremental transferを使用し、全annotationの物理保全、ページ操作、用紙変更、保存応答消失の同ID再試行、同期・reload、参照側からのDelete／paste拒否、PDF resource API呼出し0件を確認した。ログは`output/document-notebook-{chromium,webkit}-20261026.log`。未処理rejectionとnavigation診断はいずれも0件。

紙接続の検査時点は全単体979件成功・benchmark1件skip、全4 project型検査、lint成功。背景は巨大寸法でも定数サイズのSVG patternだけを生成する専用6試験を含む。この段階の両build・PDF回帰は後続Reader接続と合わせて再検証する。既定起動の旧Notebook writerを全libraryで撤去したという記録ではない。

続くReader工程ではpage ID、typed zoom、位置、top/end landing、履歴、placementの共通`ReaderSession`とscope別保存portを接続している。独立レビューで検出した末尾intentの保存漏れ、PC側の二重landing、Web旧viewportの誤報、背景revision変更後のlistener再接続を修正中であり、この追記時点ではReader全体の実画面受入・レビュー収束は未確定。元の計画とaccepted 0件は維持する。


## 共通Readerの実画面検証（2026-10-26）

`ReaderSession`が論理page ID、typed zoom（fit-page／scale）、現在位置と履歴、top/end landing、中央／右placementを保持し、同じscope付きUI状態portを両hostで使用する。数値0への変換は既存surfaceへ渡す境界だけに限定した。表示寸法が確定した後にfit下限を計算し、下限未満の保存値をfitへ補正する。10%固定下限は撤去し、縦長ページのfit倍率からキー・wheel・Safari gestureで連続拡大する。

位置処理は`useDocumentReadingPlace`へ集約した。各surfaceの論理ID／背景版／DOMのreadyを確認してから、編集側・参照側それぞれの位置を復元する。遅い参照renderを待ち、同寸法ページや同じphysical PDFを共有する論理ページ間も通知する。各paneのzoom anchorを自分の座標系で採り、完了・取消・新入力で解放する。旧PC／Webの倍率正規化・位置復元はcanonical branchでは停止し、寸法観測・描画と入力normalizerだけを再利用する。

最新sourceで次の4実行が成功した。いずれも実PC／Web mountを同じテスト内で操作し、SQLite／IndexedDB／通常転送を使用する。

| 試験 | Chromium | WebKit |
| --- | --- | --- |
| PDF Reader | 27.18秒 | 46.36秒 |
| paper Reader | 22.29秒 | 32.49秒 |

PDFは保存・同期・選択の再renderで位置が戻らないこと、reloadと履歴移動、同じphysical PDFの別論理page、参照を含むnext先頭／PageUp末尾、幅600pxの非表示参照による倍率上書きの防止を確認。paperは異寸法ページ、fit起点の連続倍率、400%上限、旧保存値補正、位置・配置のreload、wheel・synthetic Safari event・参照上wheelの両pane anchorを確認した。anchor誤差の許容はCSS丸め1.1px、iPad／Pencil実機の代替にはしない。ログは`output/document-pdf-reading-{chromium,webkit}-20261026.log`と`output/document-reading-{chromium,webkit}-20261026.log`。全runの未処理rejection／navigation診断／残存processは0件だった。

修正後の独立Astraレビューは新規P1/P2が出ない巡回を続けて確認した。この段階の全単体995件・benchmark1件skip、全4 project型検査、lint、PC／Web buildは成功。さらに旧canonical composition／全7tool／paper操作の回帰は、新しい位置復元に合わせた試験前提を修正して再実行中であり、この追記では成功済みに含めない。

## Markdown縦接続の着手（2026-10-26）

元の計画へ戻り、canonical `MarkdownEditSession`、scope付きscratch portとbrowser adapter、registry起動回復／離脱制御、共有`MarkdownEditorPanel`抽出に着手した。本文のedit-start base、同ID再試行、保存中の追加入力、append ID、CodeMirror baseline、耐久操作のUndo/Redoを同じsessionへ集める。下書きscratchにはdispatched flightも残し、journalが消えた直後にscratch更新が失敗しても追加入力を回復する。

独立レビューで、遅延readがローカル保存完了後に旧本文を表示する経路を再現し、編集・append・history・保存開始でread世代を失効させた。保存完了前後の2順序の回帰を含むcore10件、scope／未表示draft回復／離脱拒否3件、adapterと既存draft5件が成功。新adapter追加で既存`loadMarkdownDraft`を上書きした問題も復元し、canonical adapterを`canonicalMarkdownDrafts.ts`へ分離した。

Markdownの新sessionを両本番mountへ表示する接続、画像resource、引用、scratchの通常backup footprint統合はこの追記時点で未完了。core単体や旧panel抽出の成功をMarkdown全体の受入として扱わない。全計画accepted 0件と、既定起動がまだlegacyである点は維持する。


### paper／Reader工程の最終チェック

後続の固定source検証は全件成功した。

- canonical実画面回帰6/6: composition Chromium36.49秒／WebKit67.29秒、paper notebook34.11秒／58.86秒、全7tool69.46秒／191.24秒。合計459.24秒。`output/shared-app-paper-reader-canonical-regression.log`。
- 旧Markdown panel抽出の実画面回帰2/2: sharedNoteSessions9.06秒、unifiedNotes30.22秒。`output/shared-app-markdown-panel-legacy-regression.log`。
- 全frontend単体1,015件成功、benchmark1件skip、失敗0。新Markdown core／scope回復／scratch／配置sessionを含む。`output/shared-app-paper-reader-final-unit.log`。
- 全4 project型検査、lint、PC／Web build成功。`output/shared-app-paper-reader-final-{typecheck,lint,build-desktop,build-web}.log`。
- Python側のrepository／content publication／intent／history record受入36件成功。Markdown batchと原子的publicationを含む。`output/shared-app-paper-reader-final-python.log`。全Python suiteの再実行ではない。

回帰の初回失敗は新しい位置復元と旧fixture前提の不一致も含んでいた。compositionはpage2でのheld pointer unmount後にreloadしてもpage2を保持するため、visible1件を確認してから明示page1移動で4件を検証する。paperの参照クリックは復元後paperboxの左端が画面外（x=-91、旧クリックx=-61）となっていたため、可視scroller内を選びelementFromPointで参照面への命中を確認してからDelete／paste／矢印を実行する。どちらも文書・履歴・耐久保存・同期・owner解除の検証は維持した。初回と診断logは削除していない。

全最終browser runの未処理rejection／navigation診断と残存processは0件。修正後の独立Astra複数名の再点検でも新P1/P2なしを続けて確認し、今回の実装済み範囲のレビューは収束と判断した。元の計画のMarkdown本番画面接続を次に続ける。原訳mapping／全Library／通常backup・move・restore／全領域切替／既定起動／実機の未完了部分は残し、accepted 0件を維持する。


## Markdown本文の両本番mount接続（2026-10-26）

`LibraryContentConnection`が保存されたroot kindを先に確認し、Doc／Markdownのhost compositionを選ぶ。種類確認前に不適合なsessionを作らず、Markdownで未readyのDocumentEditSessionが残ってscope離脱を拒否することを防ぐ。共通`MarkdownLibraryConnection`はregistryの唯一のMarkdown sessionへ本文、autosave、blur保存、Undo／Redo、同期、再試行、版選択を接続した。

PC／Webの`ReaderFrame`を独立した純粋moduleへ分け、`ReaderWorkspace`と同じMarkdownEditorPanel／MarkdownContentを両版で使用する。配置はページを持たない`ReaderPlacementSession`、保存先はpaged Readerとのunionを扱う同じscope付きUI portを使う。中央⇔右の移動は同じ保存Promiseを待ってcanLeaveを確認し、ownerとCodeMirror stateを保持する。初回multi-headは勝手に採用せず、編集面をmountする前に版を明示選択する。

実画面では、blurによる保存開始が配置buttonをdisabledにし、clickが届かなくなる競合を再現した。配置buttonは保存中も操作を受け付け、controllerのawait flush／canLeaveへ判断を集めた。dirtyな本文と選択状態から直接clickする同じ回帰を両engineで通した。内部errorはmodelに保持し、画面では読み込み・保存・設定・同期の日本語案内を表示する。

画面を静的importした中間buildではWebApp moduleが2,306.97kBとなったため、種別ごとのbound composition全体をlazy読込する構成へ整理した。Viewだけを遅らせるとcontrollerがrootRef=nullで先にeffectをcommitし得るため、controller＋viewが同時にcommitする境界にしている。最終WebApp moduleは222.70kB。この値はmoduleファイルのサイズであり、全依存や実測起動時間の比較ではない。実Markdown runではPDF固有UI3moduleと旧writerのrequestが0件だった。

### 最終検証の対応関係

- 全frontend単体1,017件成功、benchmark1件skip、失敗0。全4 project型検査、lint、PC／Web build成功。`output/shared-app-markdown-composition-{unit,typecheck,lint,build-desktop,build-web}.log`。
- source固定の4suite／両engine、計8対象を検証。最初のbatchは7成功・1失敗をそのまま保存し、失敗したMarkdown WebKitだけをfixtureの限定診断分類更新後に補足実行して成功した。production sourceは補足時に変更していない。

| 対象 | Chromium | WebKit |
| --- | --- | --- |
| PDF composition／消去／履歴／応答消失 | 37.04秒 | 69.87秒 |
| Markdown本文／保存／配置／分岐 | 26.72秒 | 72.30秒（補足） |
| paper notebook／用紙／ページ操作 | 40.11秒 | 63.50秒 |
| PDF Reader／位置／隠れた参照の倍率 | 29.21秒 | 40.01秒 |

Markdownでは本文・preview・耐久Undo／Redo、配置をまたぐ選択、保存中追加入力、実SQLite受理後の応答喪失と同ID retry、実localStorage quota失敗時の保持と同binding remount、reload、remote反映後のCtrl+Z、prepareLeave allowedを確認した。さらに実repositoryへ履歴なしの外部分岐2件を投入し通常同期で届け、fresh registryの未選択状態からPCでA／WebでBを明示採用し、両headと両本文が残ることを確認した。

元の8対象logは`output/shared-app-markdown-composition-regression.log`、補足は`output/shared-app-markdown-composition-regression-webkit-followup.log`。元batchで失敗したのは再読込中のcaught fetchに対するWindows WebKit診断であり、既知native pending-recordsとは別にwebのreadonly pullでも発生した。アプリ非依存のnested POST最小再現でもpageerror 10、outer catch 2、unhandled 0を確認した（`output/webkit-nested-post-caught-fetch-20261026.log`）。oracleはengine・host・reload境界・同一originの正確なreadonly endpoint・fixture／controllerまたはreplication stackに限定し、他pageerrorと独立したunhandled検査は維持した。補足実行はcaught診断も0件、全対象の終了後processは0件だった。

修正後の独立Astraレビューも新P1/P2なしを継続確認した。最新fixtureの型は`output/shared-app-markdown-final-e2e-typecheck.log`、最小再現mjsのlintは`output/shared-app-markdown-final-e2e-lint.log`で確認した。e2eのTSは現行ESLint設定の対象外であり、型検査と実行で確認した（明示lint時のignored警告も`output/shared-app-markdown-final-e2e-lint-ignored-ts.log`へ保持）。全Python再実行や実機検証をこの段階で追加したという記録にはしない。

この工程で接続したのはMarkdown本文である。画像resource／引用／テンプレート取得／競合比較と両方保持／scratchの通常backup footprint／全Library／既定起動への切替は残っている。元の全計画とaccepted 0件を維持し、次は画像・引用を同じresource／navigation境界へ接続する。

## Markdown画像の共通保存・表示と引用の基礎（2026-10-26）

両本番mountで同じ「画像を末尾に追加」を使い、`MarkdownEditSession`が画像登録、本文追記、保存、再試行を所有する。file取得は共通controllerから渡す。resource IDとappend IDを開始時に固定し、bytesの保存・再読込・SHA256確認後に、その時点の最新本文へ追記する。途中の文字入力を失わず、画像登録失敗時は元本文を変更しない。同bindingの再mountでもsessionが保留を保持し、取消後は遅延完了から追記せず、I/Oをdrainするまで離脱を拒否する。

契約に必須`imageResources`を追加した。本文・manifest・append snapshot・scratch・履歴の逆操作を同じ意味で保存する。URIは`papeer://resource/<uuid>?sha256=<hash>`で、rendererと同じnormalize／Markdown／GFM／math設定から実際の画像だけを抽出する。コード・数式・未使用definition・通常リンクをresourceと誤認しない。入力途中の不正URIは修正可能なrawとして保持し、未知assetを手入力した場合もimmutable request作成前の検証で止める。

PythonとTSのmetadata検証・resource列挙を更新し、通常同期の画像先行転送へ接続した。checkpoint／datasetは過去版・Undo前・競合branchの画像を保全する。公開APIのOpenAPIとTS型も正規scriptで再生成した。parser依存は既存lock内の`unified`／`remark-parse`を直接宣言し、境界検査ではこの1moduleの4つの純粋parser importだけを許可する。他module、subpath、DOM・storage・networkの禁止は維持する。

previewはmanifestに許可されたID／hashだけをrepositoryへ問い合わせ、metadata・実bytes・画像MIMEを確認してBlob URLを生成する。scope／参照切替の旧完了を拒否してURLを解放する。SVGも`img`として表示し、HTMLやinline SVGへ挿入しない。初回SVG実画面試験ではNativeの実file inputから追加し、両hostの自然寸法・同期・reload・script非実行を確認した。Webの実file inputによるauthoringはPNGの2本目で検証している。

反復レビューで、scratchとjournal-onlyの本文／manifest不一致、順序の違う有効manifestのUndo拒否、非owner表示面からの取消を修正した。回帰はraw保全、同ID・同payload再送、画像と後続文字入力の再起動回復、逆順manifestのUndo／Redo、取消後の遅延完了、別ownerからの取消拒否を検証する。修正後は3名の独立Astraが新P1/P2なしを確認した。

元タスクの次工程としてstrictな`markdownCitations`、collection／背景版／pt範囲を確認する`citationLocation`、共通Readerの`jumpTo`を追加した。古い位置を消して新しいanchorへ着地し、同じページ内の履歴も保持する。URI／resolverは相互レビュー、Readerは別Astraのレビューを通した。この段階では引用リンク・宛先選択・capture・資料間navigationのUIは未接続であり、完成扱いにしない。

最終の単体1,049件成功・benchmark1件skip、型検査4project・lint・PC／Web build成功。Python関連49件、境界39件も成功した。ログは`output/shared-app-markdown-images-*-post-review.log`、`output/shared-app-markdown-images-python-final.log`、`output/shared-app-markdown-images-boundaries-final.log`。境界root追加後の対象検査も別記録で成功している。TSのe2eは既存ESLint対象外なので、型検査と実行で確認する。

### 実画面回帰と画像identityの補足

owner／manifest修正後のsource固定回帰8件が全件成功した。`output/shared-app-markdown-images-regression.log`へcommand、terminal exit 0、各対象時間とcleanupを保存している。

| 対象 | Chromium | WebKit |
| --- | --- | --- |
| Markdown本文・配置・quota・応答喪失・版選択 | 31.34秒 | 65.32秒 |
| PNG追加・paired履歴・同期・reload | 20.55秒 | 51.41秒 |
| SVG画像表示・同期・reload・script非実行 | 18.51秒 | 26.14秒 |
| PDF Reader・anchor・隠れた参照面の倍率 | 30.50秒 | 46.71秒 |

その後の点検で、previewのinline画像componentがstatus更新ごとに別typeとなり、通常pollだけで画像を再mountするP2を確認した。画像component／components／URL変換をmodule scopeへ固定し、表示用contextにはmanifestとresource portだけを渡した。独立Astraの再確認で新P1/P2なし。最新UIで単体1,049件、型4project、lint、両buildを再実行して成功した（`output/shared-app-markdown-images-*-stable-renderer.log`）。未使用の純粋append helperも既存prefixをtrimせず保持するよう統一し、変更後の画像parser／session／境界19件を`output/shared-app-markdown-images-prefix-and-boundaries.log`へ記録した。

追加PNG／SVG 4件も成功した（PNG Chromium21.07秒／WebKit40.21秒、SVG Chromium19.27秒／WebKit27.66秒）。両hostで実repositoryの読出しを透過計数し、画像を実際に読み込み・同期を完了した後、実UIから同期を2回実行して同じDOM要素・Blob URL・自然寸法・読出し回数が維持されることを検証した。偽のrenderer用portへ置き換えていない。logは`output/shared-app-markdown-images-stable-renderer-browser.log`。先行8件は修正前UIの成功baseline、補足4件は最新画像UIの追加検証として区別し、全12件が同じsourceだったとは記載しない。

最終の8件・補足4件はいずれもcaught navigation診断、他pageerror、unhandled rejection、禁止された旧経路のrequestが0件。終了後のfixture sidecar／browser／runner processも0件。初期fixture失敗3本は`output/shared-app-markdown-images-browser-{initial,preview-readiness,retry-timing}.log`へ保持した。iPad／Safari／Pencil実機を追加実施したという記録にはしない。

F25は画像の共通経路についてpartialへ更新し、全台帳は**accepted 0／partial 28／unverified 39**。lightbox、引用とcaptureの接続、旧画像の一回変換、通常backup footprint、Library、既定起動・全領域切替、実機は引き続き未完了である。

## 引用リンク・同scope資料切替の共通接続（2026-10-26）

`LibraryContentConnection`の上に小さな`ContentNavigationSession`を接続し、両本番mountで選択資料IDと資料間の戻る履歴を共有した。repository／編集registry／replication／設定portは同じinstanceを保持する。Markdown previewのstrictな引用URIを共通portへ渡し、現在controllerのprepareClose／canClose、catalogと対象rootの検証、await後のguard identity・request世代・active・入力状態の再確認を通して切り替える。対象を検証する前にtarget sessionを作らない。

資料内の移動は引き続き`ReaderSession`が所有する。引用は最新選択版でstable page ID、collection、背景版、pt範囲を検証してjump／jumpToへ渡す。位置・履歴・landingにも背景版を保持し、異版や版不明の古い座標を新背景へ復元しない。historyで拒否した項目は消費しない。hookのready通知は通知元のexpectedSurfaceKeyと最新surfaceを照合し、旧背景の遅い完了から着地しない。

通常stepもjump経由で戻る履歴へ積んでいた設計との差を修正した。明示jump／引用jumpは履歴へ積み、通常stepはbackを維持する。新しいstepが成功したときだけforwardを消去し、拒否・端の変化なしではsnapshotを変更しない。単体と実UIの両方で通常stepと明示jumpを分けて検証する。

同scopeのopeningには全scopeのprepareLeave／suspendを使わない。未表示のdirty draftがあっても復旧先を開けることを実repository＋registryで確認した。targetのdirty／pendingや複数headはopening自体の拒否条件にせず、既存authorityを借りる。現在表示中の保存失敗・gesture・文字draftはそのcontrollerが移動を拒否する。scope退出用のbeforeunloadはneedsExitConfirmationへ統一し、未表示authorityとscratch列挙も確認する。native終了、全dataset切替、復旧UI全体をこの変更で完成扱いにはしない。

新しい引用試験は実SQLite／IndexedDBの通常publicationでPDF＋Markdownを用意し、最初はMarkdownを両entryから開く。実controllerが取得したauthorityだけを透過観測し、Markdown IDでphantom DocumentEditSessionを作らない。引用からPDFを開く操作までPDF固有UI moduleを禁止し、その後だけ正当に許可する。旧store／APIへの依存禁止と全seed targetのhistorical resource集合・実bytes／hash・先行転送検証は維持する。

Chromium24.78秒、WebKit補足41.34秒で両hostの同pageの異なるpt anchorへの実scroll、倍率2の保持、資料へ戻る、missing／deleted／背景不一致／未対応訳文の拒否、元Markdownのquota失敗時の本文保持と再試行が成功した。最初のWebKit失敗はquota解除後のautosave成功でretrybuttonが消えた試験操作の競合であり、解除と実DOM button clickを同じtaskへまとめて補足した。`output/shared-app-citations-browser.log`、`output/shared-app-citations-browser-webkit-followup.log`、失敗baseline `output/shared-app-citations-browser-retry-timing.log`を保存した。

独立Astra 2名が相互の実装とroot接続を再点検し、新P1/P2なし。最新単体1,062件成功・benchmark1件skip、型検査4project、lint、両build成功（`output/shared-app-citations-*-verified.log`）。新しいcommon controller／preview 4 moduleも、許可したparser import以外にhost package・storage・networkを直接持たない境界検査を追加した。新規wire保存形式やPython側の受入仕様は変更していない。

navigationとcanonical Markdownを共有entry台帳にも登録した。既定起動はまだlegacyであるためconnectionはstagedのままにし、隔離bindingからの両本番mount試験と既定切替を区別する。登録後の5 entry／境界検査は`output/shared-app-citations-final-entries.log`で成功した。

F17／F19は確認した原文引用・背景版付き位置管理についてpartialへ更新し、全台帳は**accepted 0／partial 30／unverified 37**。引用作成、宛先選択、PDF領域capture、訳文collection表示・mapping、PDF内部link、scope切替UI、全Library、通常backup footprint、既定起動・全領域切替、実機は未完了として残す。

### 最終12対象の検証対応

production sourceを固定し、新規引用と既存4suiteの両engineを実行した。初回は9成功／3失敗で終了し、失敗3対象だけをfixture更新後に補足して成功した。productionの変更は補足時に行っていない。

| 対象 | Chromium | WebKit |
| --- | --- | --- |
| 引用リンク・原文anchor・資料に戻る・quota | 24.66秒 | 41.72秒 |
| Markdown本文・保存flight・配置・複数head | 27.14秒 | 59.16秒（補足） |
| PNG画像・manifest履歴・同期・表示identity | 20.48秒 | 45.05秒 |
| SVG画像・script非実行・表示identity | 18.15秒 | 28.12秒 |
| paperノート・用紙寸法・ページ・履歴 | 38.01秒 | 60.33秒 |
| PDF Reader・位置・隠れた参照面の倍率 | 29.62秒（補足） | 42.15秒（補足） |

PDF Readerの旧testは初回stepで作られた履歴をAltLeftで戻る前提だった。新testはstep後のreloadでもback／forwardが空、AltLeftでもpage2と位置が変わらないことを確認する。その後、実ページ番号入力でpage1へjumpし、AltLeftでpage2の旧位置、AltRightでpage1先頭、AltLeftでpage2の旧位置を確認する。参照面の着地・PageUp末尾・fit下限・倍率anchor・reloadの後続assertも維持した。

もう1件はWindows WebKitのreload-nativeで発生したcatch済みreadonly `/api/edits/dataset-control` fetch診断だった。sidecarがread-onlyで、変更は別endpointであることと、replicationのtry／catch内から呼ばれることを確認した。appをimportしない最小再現でも10reloadでpageerror 10、outer catch 3、unhandled 0を確認した（`output/webkit-dataset-control-caught-fetch-20261026.log`）。oracleはWebKit・native・実reload境界・同一originのこの正確なendpoint・fixture request／desktop adapter／replication stackをすべて要求する。既存2case以外へ一般化せず、他pageerrorと独立したunhandled検査は維持する。最小再現mjsのlintも成功した。

初回logは`output/shared-app-citations-regression.log`と保持copy `output/shared-app-citations-regression-initial.log`、補足は`output/shared-app-citations-regression-followup.log`。初回exit 1を書き換えず、9成功＋補足3成功の対応を記録した。補足のcaught診断・他error・unhandled・禁止経路は0件、全実行の終了後process auditも0件。実機確認や全Python再実行を追加したという記録にはしない。

## PDF選択引用・領域画像を既存ノートへ追加（2026-10-26）

両本番mountに同じ引用先chooserとcapture操作を接続した。引用元ごとの`NoteAppendSession`は要求・宛先・固定append IDを保持し、既存の宛先`MarkdownEditSession`だけへ書込みを委譲する。catalogと実rootを確認してから宛先authorityを取得し、画像と出典suffixを同じ本文／manifest・履歴操作へ含める。保存応答消失時も同じID・payloadを再送し、受理済みappend IDから重複を防ぐ。引用元のview再mountで保留を失わず、scope退出では未表示要求も確認する。

文章は接続中の実textLayer内の選択範囲から取得する。captureは選択時のpage・背景版・resource・physical page・pt矩形を固定し、resourceの実bytes／hash／寸法を検証する。画面と同じPDF.js worker・font・CMap設定を使い、144dpi・最大4MPのcrop寸法canvasへ直接描画する。「手書き・図形を含める」はcanonical InkObjectsが対象であり、canonical付箋・本文highlightは対象外。用紙capture、全注釈export、clipboard／download fallbackはこの工程の完成範囲に含めない。

反復レビュー中に、宛先Markdown画面で保留画像を取り消すと引用元だけが失敗・退出保留のまま残る問題を確認した。自分のexact append IDの画像準備を観測した場合だけ取消へ遷移させ、遅い完了を失効させた。別要求・本文保存待ち・受理後Undoから取消を推測しない。修正後は別Astraの再レビューでも新P1/P2なし。読込失敗でcontrollerが一度も登録されなかった資料からの「戻る」も限定回復し、過去に登録したguardの解除を無条件許可にしない。

新規実画面はChromium34.20秒／WebKit74.95秒で成功した。実PDFの文章選択、引用先chooser、応答消失と同payload再試行、出典への復帰、実pen線の保存、同じcropのink有無、画像と出典のUndo／Redo、通常同期と明示ノート再openを両hostで確認した。PNGは約358×253pxで、inkありの赤画素2,032〜2,613に対しinkなしは0、PDFの黒画素は維持された。明示再openはfixtureの既知IDから初期bindingを与え直す操作であり、Workspaceの自動選択復元ではない。ログは`output/shared-app-quote-append-browser.log`。

固定production sourceの14対象回帰は、初回13成功／1失敗とWebKit補足1成功で確認した。初回の失敗はPDF→Markdown移動後のreload診断をfixture初期kindで分類していたためで、離脱前DOMの既知資料IDから実kindを確認するよう限定修正した。engine・host・reload境界・正確なreadonly endpoint・controller stackの条件、他error・unhandledの独立検査は維持する。初回`output/shared-app-quote-append-regression-initial.log`と補足`output/shared-app-quote-append-regression-followup.log`を保持する。単一runで14/14成功したという記録にはしない。

試験oracleも点検した。インストール済みPlaywrightのasync `waitForFunction`がfalseを解決するPromiseでも通過する現象をアプリ非依存で再現した（`output/playwright-async-predicate-diagnostic.log`）。引用試験はNode側でsnapshot読取りをawaitして同一観測の本文・manifest・耐久・同期状態を確認する。既存iPhone clipboard／PWAの3箇所も、読取り自体をdeadline付きでawaitする共通helperへ変更した。helper単体2件とiPhone両engine・PWA計3件が成功した（62.02秒、`output/shared-app-quote-append-oracle-legacy-browser.log`）。

最新全単体1,085件成功・benchmark1件skip（`output/shared-app-quote-append-unit-final.log`）。本番source固定時の型4project・lint・PC／Web build成功は`output/shared-app-quote-append-*-reviewed.log`、試験helper追加後の型検査は`output/shared-app-quote-append-typecheck-final.log`。wire保存形式やPython受入仕様の変更はなく、全Python再実行やiPad／Safari／Pencil実機の追加確認は行っていない。

共有entryは既定起動がlegacyのためstagedを維持する。F21を確認範囲についてpartialへ更新し、台帳は**accepted 0／partial 31／unverified 36**。次はLibrary一覧・一件作成・原子的初期公開・開く操作を接続する。テンプレート、lightbox、訳文collection、全Library、通常backup footprint、既定起動・全領域切替、実機は未完了である。

## Library一覧・ノート作成・復旧の共通接続（2026-10-26）

種別別viewの外側へ同じ`LibraryCatalogPanel`を接続し、scope registryが一つの`LibrarySession`を保持する。catalogのlive項目をposition順で表示し、空Markdown／A4白紙ノートを初期contentと原子的に公開する。新しい保存portを作らず、libraryIdのjournalと既存`BatchCommitSession`で初回のID・親head・本文を固定する。registry起動時はpublication intentを読み取り専用で復旧し、再試行で受理を確認してからjournalを消す。

保存とopeningは別の結果である。現在の本文・描画・保存guardに移動を拒否されても、作成済み項目と「作成した資料を開く」を残す。同scopeの資料切替で別の保留を捨てない。scope退出はlibrary authorityの未ready・保存・結果不明も検査し、回復済みlibraryIdだけunhandledから解除する。他targetのraw保留は変更しない。

catalog多頭では表示版を選択し、自動同期でもなおheadに存在する選択を維持する。明示版はnavigation・binding・両controllerのmetadata読取へ渡し、戻る履歴・引用でも版を保持して再検証する。単一headの通常openは版を固定せず、作成等でcatalogが進んでも戻れる。同一資料を通常選択し直して古い固定を解除する場合も、guardと最新readを通す。表示版選択を競合解決として保存せず、多頭の新規作成は拒否する。

反復Astraレビューとroot点検で、回復後の`recoveryBlocked`／unhandled解除漏れ、自動同期による表示版選択の解除、戻る／引用への明示版伝播漏れ、単一headまで固定するため通常の作成後に戻れなくなる問題と同資料で固定を解除できない問題を修正した。各回帰を追加し、最新の独立2名の再レビューで新P1/P2なしを確認した。

最新全単体1,100件成功・benchmark1件skip、型4project・lint・PC／Web build成功。`output/shared-app-library-{unit,typecheck,lint,build-desktop,build-web}-final.log`。LibrarySession・registry・navigationと依存境界を含む全検査で、新しいcommon pathからhost storage／API／Driveを参照しないことを確認した。

Library実画面はWebKit70.04秒とChromium補足27.03秒で成功した。両host計4件のMarkdown／白紙作成と編集、通常同期、catalog進行後の戻る、元の初期bindingでのreload後に一覧から再open、exact item IDs／重複なしを確認した。Nativeのpublication受理後の応答喪失はreloadでjournalから回復し、同一ID・要求全体の内容を再送する。Webのscratch quota失敗中も、新規作成の成功と現在本文による移動拒否を区別し、元本文と作成済み項目を保持して実再試行から開く。

元失敗は`output/shared-app-library-browser-initial.log`、診断`output/shared-app-library-browser-diagnostic.log`、最終readiness失敗は`output/shared-app-library-browser-final-readiness-baseline.log`へ保持した。reload直後の資料ID wrapperだけではcontrollerが登録済みとは限らないため、操作前に実PDF layer／toolbarとready・idleを待つ。SQLiteを経たJSONのobject key順は変わるため、再送要求はparse後の全構造をdeepEqualで比較し、配列順やfieldを緩めない。WebKit成功は`output/shared-app-library-browser-final.log`、Chromium補足は`output/shared-app-library-browser-chromium-followup.log`。単一runの両engine成功とは記載しない。成功runのapp error／unhandled／禁止request／既知caught診断は0件、終了後の関連processも0件。

新browser suiteは既存`test-web.mjs`の自動検出に入り、release gateから漏れない。F27とF28の確認範囲をpartialとして更新し、現台帳は**accepted 0／partial 32／unverified 35**。階層・改名・tag／既読・所有／関連・削除／復旧・Library Undo／競合解決、選択の自動復元、全backup／変換、既定起動切替、実機は未完了。次は一件改名・同ID再試行・Undo／Redo・再読込を、同じLibrary authorityに追加する。

### Library追加後の固定source回帰

既存4suiteの両engine、計8件が単一runで全件成功した。`output/shared-app-library-regression.log`に正確なcommand・terminal exit 0・時間・cleanupを保存した。実行中にproductionを変更していない。

| 対象 | Chromium | WebKit |
| --- | --- | --- |
| 引用・位置・現在本文guard | 19.60秒 | 40.22秒 |
| Markdown本文・保存flight・scratch・履歴・配置 | 27.34秒 | 72.13秒 |
| PDF Reader・位置・参照面・倍率下限 | 28.98秒 | 45.24秒 |
| PDF文章／画像追記・PNG実画素・同ID再試行 | 35.75秒 | 74.55秒 |

総346.17秒。全app error／unhandled／禁止request／caught navigation診断は0件、終了後の関連processと今回のtemp残存も0件。以前から存在する無関係tempは削除していない。Library本体は先述のWebKit成功＋Chromium補足成功として別に対応付け、8回帰に混ぜて単一10/10 runとはしない。台帳の要件・証跡存在checkも`output/shared-app-library-acceptance-check.log`で成功した。

保存接続のPython受入は`uv run pytest tests/test_content_publication.py -q`の11件が成功した（2.10秒、`output/shared-app-library-python-publication.log`）。原子的公開・abort／retry／restart・outbox・API・resource検証・親待ちと作成前到着編集を含む既存契約を確認した。全Python suiteを実行したという記録にはしない。

## Library改名・Undo／Redoと本文を保持する見出し更新（2026-10-26）

改名とそのUndo／Redoを、作成と同じLibrarySession・libraryId journal・BatchCommitSessionへ接続した。root registryはlibrary batchのpendingも唯一のauthorityへ回復する。改名は入力開始時の名前と最新itemを照合し、名前の競合時は入力を保持して拒否する。他属性を最新値のまま保持し、同名は新batch／履歴を作らない。

履歴はHistoryRecordのoperation IDとexecution IDを分け、有限のtitle逆操作を新batchとして保存する。本文・注釈・resource・他itemを過去snapshotで巻き戻さない。再起動後も選択した祖先上の履歴を復元し、bare batch／未対応操作／resolutionは境界にする。現在要求の復旧ではこれと区別して対応操作本体とUndo／Redo参照を証明し、不正・未証明な要求をraw保持したまま送信しない。新規作成のUndoや他metadata編集をこのtitle専用履歴で代用しない。

共通フォームと履歴buttonを両版で使い、一覧内のCtrl／Meta+Z・Shift+Zを同じlibrary操作へ接続する。名前入力欄の通常Undoを奪わず、PDF／Markdown文書の履歴を二重に実行しない。pending kindで作成と編集の再試行を分け、編集retry成功後に以前作成した資料を勝手に開かない。

`useLibraryItemTitle`がcatalogから見出しだけを更新する。本文のbinding／session／ownerを作り直さず、明示版では一致するcatalogだけを採用する。dirty Markdownの本文と同じeditor DOMを保ったまま、名前変更・Undo／Redo・同期後の見出しを更新できる。

反復レビューで、未対応要求の再送と、不正なhistory参照を単なる過去gapとして扱う2系統のP2を再現・修正した。folder／削除／新item／metadata要求、Undo／Redoそれぞれのrandom／旧operation／history gapは送信0・raw不変で拒否する。修正後の複数Astraの独立再レビューは新P1/P2なし。

全単体1,113件成功・benchmark1件skip、型4project・lint・PC／Web build成功（`output/shared-app-library-editing-{unit,typecheck,lint,build-desktop,build-web}-reviewed.log`）。追加e2eの型も確認した。新規実画面4件は同一の固定production sourceで単一run成功、総142.54秒（`output/shared-app-library-editing-browser.log`）。

| 対象 | Chromium | WebKit |
| --- | --- | --- |
| 改名・応答喪失・journal再起動・同ID全要求内容の再試行・履歴・キー | 26.74秒 | 56.93秒 |
| quota失敗中Markdown・同じeditor DOM・本文保持・見出し・履歴の分離 | 19.63秒 | 38.20秒 |

SQLite／IndexedDBの実repositoryと通常同期を使い、相手hostの見出し・本文・履歴も検証した。キー一回でlibrary逆batch一件、PDF本文／注釈checkpointと履歴の不変、Markdownの実再試行でだけ本文履歴が一件増えることを確認した。app error／unhandled／禁止request／caught navigation診断は0件、終了後の関連process・今回のtemp残存も0件。実Safari／iPad／Pencil、native OS終了確認は実施していない。

F32は確認した改名の範囲についてpartialへ更新し、台帳は**accepted 0／partial 33／unverified 34**。タグ・既読、階層、関連、書誌metadata・権限、削除／復旧、作成Undo、競合比較／保存、空Library／選択復元、通常backup・変換・既定切替等は引き続き残る。

### 改名追加後の既存10対象の回帰

固定production sourceで既存4suite／両engineの10件が、単一runで全件成功した。`output/shared-app-library-editing-regression.log`にexact command・terminal exit 0・各時間・cleanupを記録した。新規4件の成功runとは別の実行として対応付ける。

| 対象 | Chromium | WebKit |
| --- | --- | --- |
| 作成・応答喪失・再起動・移動guard・一覧再open | 26.96秒 | 70.79秒 |
| Markdown本文・保存flight・scratch・配置・履歴 | 25.66秒 | 68.61秒 |
| PNG・manifest履歴・同期・表示identity | 21.81秒 | 42.57秒 |
| SVG・script非実行・表示identity | 15.94秒 | 27.21秒 |
| PDF Reader・位置・参照面・倍率下限 | 27.34秒 | 41.79秒 |

総370.86秒。全app error／unhandled／禁止request／caught navigation診断は0件、関連processと今回temp残存も0件。既存assertを縮小していない。追加e2eの最終型検査も成功し、`output/shared-app-library-editing-e2e-typecheck-final.log`へ記録した。

Python保存／intent受入は`uv run pytest tests/test_edit_intents.py tests/test_edit_repository.py -q`の14件が成功した（2.85秒、`output/shared-app-library-editing-python.log`）。新しいwire/schemaやPython保存実装は追加せず、実画面のSQLite/API接続と既存受入契約を確認した。全Python suiteの成功や実機確認とは区別する。

## Libraryタグ・既読の単一／複数変更（2026-10-26）

同じLibrarySessionへタグ追加・削除・置換と既読／未読の明示bool操作を追加した。単一も複数も同じAPIを使い、対象ID・タグ・expected配列を入口でコピーする。全対象の存在・非削除を検証してから変更を作り、一件でも不適格なら全体を拒否する。変更しない項目はbatchから除き、全無変化ならID・history・commitを増やさない。

追加は既存順序を維持して新規値だけ末尾へ、削除は既存文字列の完全一致、置換は入力順を使う。新規入力だけPython互換stripと先勝ち重複除去を行い、契約のUnicode1〜200文字を扱う。旧UIの80文字／100件制限や大小文字変換を持ち込まない。未編集置換でも現在値をexpectedTagsと照合し、raw完全一致の場合だけ正規化せず無変化にする。

history/admissionを既存itemのtitle／tags／readだけへ広げた。複数put-itemを一操作として保存・Undoし、変わったfieldの現在値だけをexecution後値と照合して以前値へ戻す。tagsは配列全体・順序込みで復元する。resource／kind／owner／folder／position／書誌metadataなどの偽装変更は、タグ変更に混ぜても現在requestとして再送しない。既存のstrict action参照証明・raw保持・同ID再試行を維持する。

共通一覧のチェック選択とCtrl／Meta+Aを追加し、通常poll・自身の保存・Undoでも選択を保持する。消えたIDは除き、明示版切替やscopeの再mountで解除する。タグ本文・初期値・削除チェック・固定対象は親draftが保持し、一覧を閉じたり作成済み資料を開いても消さない。入力欄の通常Ctrl+A／Undoは奪わない。reloadを跨ぐチェック選択復元はこの工程の対象外である。

レビューで折畳み時の入力消失と、未編集置換の期待値検証抜けを修正した。独立した複数Astraの再レビューでは新P1/P2なし。全単体1,121件成功・benchmark1件skip、型4project・lint・PC／Web build成功は`output/shared-app-library-tags-{unit,typecheck,lint,build-desktop,build-web}-final.log`。F30の共有entry登録後も依存検査5件が成功した（`output/shared-app-library-tags-entry-check.log`）。

新規実画面はChromium44.02秒／WebKit181.50秒、単一run2/2成功、総226.06秒（`output/shared-app-library-tags-browser.log`）。両hostで2資料への一括追加・削除・既読変更、単一置換／空置換、Undo／Redo／reload、同ID・全要求内容の再試行、正常保存後の選択、無変化のrequest不増、追加／削除／置換入力のcollapse保持を確認した。外部の実repository更新後、入力を変えずApplyしても競合を検出し、入力・外部値を保持して追加commit 0になることも確認した。元の全item属性と両contentのcheckpoint／historyは厳密に比較した。

続く既存8回帰も固定sourceの単一runで8/8成功、総320.39秒（`output/shared-app-library-tags-regression.log`）。

| 対象 | Chromium | WebKit |
| --- | --- | --- |
| 作成・復旧・資料切替 | 29.93秒 | 74.94秒 |
| 改名・履歴・キー・再起動 | 28.74秒 | 57.56秒 |
| dirty Markdownの見出し・同じeditor・本文保持 | 18.65秒 | 39.16秒 |
| PDF Reader・位置・参照面・倍率下限 | 27.95秒 | 41.30秒 |

両runともapp error／unhandled／禁止request／caught navigation診断0、関連processと今回temp残存0。timeoutや既存assertは変更していない。追加e2eの最終型検査も`output/shared-app-library-tags-e2e-typecheck-final.log`で成功した。Pythonは`uv run pytest tests/test_edit_contracts.py tests/test_edit_intents.py tests/test_edit_repository.py -q`の33件が成功した（3.14秒、`output/shared-app-library-tags-python.log`）。全Python suiteや実Safari／iPad／Pencilを実施したという記録にはしない。

F30は確認範囲についてpartialへ更新し、台帳は**accepted 0／partial 34／unverified 33**。台帳要件・証跡存在checkは`output/shared-app-library-tags-acceptance-check.log`で成功した。次は所有itemの配置不変条件をTS／Pythonで固め、folder作成・移動・階層操作・内容保持削除・Undoを同じauthorityへ接続する。既定切替・旧責務撤去・全領域保存／変換・実機等の残件は維持する。

## フォルダー階層・共通退出guardの実装と実画面検証（2026-10-26）

所有itemのfolder排他条件（`ownerId !== null`のitemは`folderId === null`）、folder作成・改名・移動・内容保持削除・有限inverse、IDベースの階層表示／開閉／キー移動／focus復帰、選択folderへのnote作成、および`LibraryContentConnection`への`beforeunload`集約を実装・検証した。

### 独立Astraレビューでの修正点

- `LibraryFolderEditor`: 外部同期で対象folderが消失した場合や対象itemが消失・所有化された場合に`targetsAvailable`でsubmitを無効化し、`移動先や対象のフォルダー・資料を確認してください。入力は保持しています。`を表示するよう修正。
- `LibraryCatalogPanel`:
  - `library-folder-title-changed`も改名競合文言へ接続。
  - 新規作成form開閉中も`一覧の版`切替を有効化し、版切替時に`renaming`／`tagDraft`／`folderDraft`をリセット。
  - キー移動や外部削除によるfocus fallback（`setFocusedKey`）と明示的なfolder選択（`selectedFolderId`）を分離し、意図しない作成先folder変更を防止。
  - `createdFolderId`の自動展開は親経路のみ（`includeSelf = false`）とし、空の新規folderを事前展開済みにしないよう修正。作成／移動のawait前に親経路を展開して即時描画と整合。
  - WebKitの`reload`中に進行中`replication.flush()`が中断された直後、`finally`の`running: false`通知で第2の`fetch`（`library.refresh()`）が発火してWebKit固有のcaught-fetch pageerrorになる問題を、`!replication.error && active.current`（`pagehide`/`pageshow`追跡）で抑止。初回失敗ログは`output/shared-app-library-folders-browser-initial-failure.log`に保存。

### 検証結果（固定source）

- 型検査・lint・両build: `output/shared-app-library-folders-{typecheck,lint,build-desktop,build-web}.log`で全て成功。
- 新規フォルダー実画面（`e2e/webDocumentLibraryFolders.browser.test.ts`）: 単一run **2/2成功**（Chromium 38.03秒／WebKit 110.21秒、総148.91秒、`output/shared-app-library-folders-browser.log`）。
  - 階層作成・子folder移動・2資料一括移動・cycle/owned拒否・改名競合保持・内容保持削除・Undo/Redo・reload・同ID再試行・peer同期を確認。
  - 選択folder（`parent`）へのMarkdownノート実作成、自動open、`前の資料に戻る`、末尾`position`採番、`ownerId: null`を確認。
  - `資料一覧`の折畳み／再展開を跨ぐ`folderDraft`保持を確認。
  - 本文PDF読込を503で保留し子controller（`DocumentLibraryConnection`）未mountの状態を含む、metadata保留時の`beforeunload`抑止と再試行後の解除を確認。
- 既存実画面回帰（作成・改名・タグ・dirty Markdown見出し・PDF Readerの5 suite）: 単一run **10/10成功**（総601.84秒、`output/shared-app-library-folders-regression.log`）。
- 全frontend単体: **1,134成功、benchmark 1 skip、失敗0**（`output/shared-app-library-folders-unit.log`）。
- Python関連: `tests/test_edit_contracts.py tests/test_edit_intents.py tests/test_edit_repository.py tests/test_content_publication.py`の**48件成功**（`output/shared-app-library-folders-python.log`）。
- 受入台帳・依存境界: `F31`を`partial`へ更新し、`F28`にfolder/beforeunload実画面証跡を追加。台帳は**accepted 0／partial 35／unverified 32**。`uv run python tools/shared_app_acceptance.py --check`と`node --test tests/sharedEntries.test.mjs`が成功。
- drag/drop・複数folder操作・並べ替え、関連／owner削除／note独立化、論理削除／回復、既定起動切替等は残件として維持する。

## 資料関連・note独立化・owner削除モード・観測heads付き論理削除の実装と実画面検証（2026-10-26）

独立PDFと独立Markdown／手書きノートの双方向関連（dialogおよび単一／複数PDFのdrag/drop追加、重複no-op、所有note・不正種別・削除済み対象の拒否、関連解除、双方向`↗`リンク行表示と対象資料open）、owner配下への付属ノート作成（`ownerId !== null, folderId === null`）、owned noteのowner所属フォルダー末尾への独立化（`detachNotes`）、対象資料や子ノートに未保存／送信待ち編集がある場合の削除前共通guard（`prepareDeleteTargets`／`canDeleteTargetsSync`）、およびowner削除時の既定`detach`（子ノートを残して関連を解除）と明示`delete`（内容も削除：子ノートも論理削除）の2モードと各対象contentの`observed` heads記録・有限Undo／Redo・応答消失時の同ID再試行を実装・検証した。

### 独立Astraレビューでの修正点

- `useLibraryItemDeleted`（`useLibraryItemTitle.ts`）／`MarkdownLibraryConnection`／`CanonicalMarkdownView`／`DocumentLibraryConnection`／`ContentNavigationSession`:
  - 表示中のactive資料（またはowner削除の`delete`で同時に論理削除された子ノート）が論理削除された場合、保存済み／進行中の`flush`・`retry`・`sync`を維持したまま`editable: false`（読み取り専用：`この資料は削除されています。新しい編集はできません。`／`この資料は削除されています（閲覧のみ）`）へ遷移し、Undoで論理削除が解除されると再び編集可能へ戻るよう接続（設計書 §9.3.2）。
  - `ContentNavigationSession`で現在表示中の`source`資料が論理削除済みの場合は`state.back`へ積まないよう保護。
- `libraryHistory.ts`:
  - `ownerChangePatch`で常に`['ownerId', 'folderId', 'position']`を検査対象に含め、`inverseLibraryEdit`でnoteの再結合／再分離を行う前にownerの生存および`owner.folderId`との一致を検証。
  - `deletionEdit`で空の`itemIds`を拒否し、`active: true`時は`deletedBefore`に含まれる項目の二重削除を拒否。
- `DocumentEditSessions.ts`:
  - `heldTargets()`で未完了の`NoteAppendSession`について`sourceId`だけでなく`destinationId`も保護対象に含め、追記先のノートや追記元のPDFが未確定追記中に論理削除されないよう保護。

### 検証結果（固定source）

- 型検査・lint・両build: `output/shared-app-library-relations-{typecheck,lint,build-desktop,build-web}.log`で全て成功。
- 新規関連・削除実画面（`e2e/webDocumentLibraryRelations.browser.test.ts`）: 単一run **2/2成功**（Chromium 59.87秒／WebKit 210.75秒、総271.30秒、`output/shared-app-library-relations-browser.log`）。初期失敗ログは`output/shared-app-library-relations-browser-{initial,second,third,fourth}-failure.log`に全て保存。
  - owner配下への付属ノート作成、独立ノート作成、dialogによる関連追加、双方向`↗`リンク行表示とクリック移動、重複関連のno-op、関連解除とUndo／Redo、複数PDF選択からのHTML5 drag/drop一括関連追加を確認。
  - owned noteの`独立させる`によるowner所属フォルダー末尾への移動とUndoによる再付属を確認。
  - 子ノートに未確定編集がある状態でのowner削除拒否（`未保存または送信待ちの編集があるため削除できません`・追加commit 0）と、解消後の削除成功を確認。
  - owner削除の既定`detach`（子ノートをownerフォルダーへ独立化・関連除去・ownerの`observed` heads記録・nativeでの応答消失reloadと同ID再試行・削除中PDFの読み取り専用化）とUndoによるowner・関連・子ノート所有関係の完全復元を確認。
  - owner削除の明示`delete`（ownerと子ノートの両方を論理削除し両方の`observed` headsを記録・基礎content履歴の保持・開いている子ノートの読み取り専用状態表示）とUndo／reload後Redo／最終Undo・peer同期を確認。
- 既存実画面回帰（作成・改名・タグ・フォルダー・dirty Markdown見出し・PDF Readerの6 suite）: 単一run **12/12成功**（総738.83秒、`output/shared-app-library-relations-regression.log`）。
- 全frontend単体: **1,138成功、benchmark 1 skip、失敗0**（31.22秒、`output/shared-app-library-relations-unit.log`）。
- Python関連: `tests/test_edit*.py`・`tests/test_content*.py`の**137件成功**（13.91秒、`output/shared-app-library-relations-python.log`）。
- 受入台帳・依存境界: `F33`を`partial`へ更新し、`F32`・`F38`に今回の実装・実画面証跡を追加。台帳は**accepted 0／partial 36／unverified 31**。`uv run python tools/shared_app_acceptance.py --check`と`node --test tests/sharedEntries.test.mjs`が成功。
- この時点の残件は削除済み項目の回復一覧・後着未確認編集一覧・保持／比較／復元UI（`F38`）、添付（`F34`）、書誌metadata編集・権限判定（`F32`）、検索（`F36`）等。次節の後続作業と区別する。

## 削除資料の回復・作成取消・書誌情報編集の引継ぎ確認（2026-10-26）

ユーザー側で進めた差分と終了ログを照合した。削除資料一覧、観測履歴外の後着編集検出、削除資料への読み取り専用navigation、削除recordのactive解除による復元、復元のUndo/Redo時のlocal編集guard、結果不明の作成に対する同publication確認後の固定inverseによる取消、およびPDF書誌情報の許可field限定編集・期待値検証・有限inverseが入っている。

新規実画面は2/2成功（Chromium69.45秒／WebKit143.75秒、総214.10秒）、関連回帰は14/14成功（総1220.58秒）。全frontend単体1,140成功・benchmark1 skip、Pythonは編集／content受入と書誌情報を含む143成功。`output/shared-app-library-recovery-metadata-{browser,regression,unit,python}.log`を確認した。初回失敗ログも保持する。これらを検索追加後のrunとして扱わない。

引継ぎ後のAstra 2名による独立再点検は新P1/P2なし。書誌入力の保持と他metadata保全、journalの同一要求・inverse検証、後着headの保持、削除済みsourceと戻る履歴、復元Undo/Redo時のguardを確認した。削除時点との専用比較UI・通常の成功済み作成のUndo・機能判定全体・既定起動切替を含むF32/F38全体の完了は宣言しない。

## Library検索・表示条件の共通接続（2026-10-26）

LibrarySessionが所有するLibraryQuerySessionへ検索語・metadata/本文/両方の範囲・tag/read条件・position/title/year/authorの昇降順・結果・取得状態をまとめた。大小文字／全半角を共通正規化し、複数語はANDで照合する。ID tie-breakまで共有し、並び替えで保存positionを書き換えない。

LibraryCorpusPortの共通repository接続は保存済みMarkdownの全head、document生存pageと訳文pageのPDF文字・注釈文字を読み、deleted pageやdirty draftを混ぜない。PDFはresource ID/hash/bytesを確認し、同じPDF.js worker/policyで物理pageから抽出する。編集authorityを生成せず、history/journalへ書き込まない。未取得・一部取得・attachment未対応を明示する。OCR・画像文字は対象外と画面に表示する。

条件なしのtreeと、条件付きの平坦なhit一覧を共有UIで切り替える。付属noteの親資料とfolderを添え、linkを重複hitにしない。通常のopenKeysとチェックIDを保持し、bulkは現在見えるitemだけを対象とする。条件解除／現在資料のrevealはquery commandを通して祖先展開とfocusへ接続し、検索欄や編集中フォームの入力をpollで再生成しない。

4 cycleの独立Astraレビューで、通常pollによる遅い本文検索のstarvation、中断後の再開、初回revision取得失敗、同revisionの一時的PDF取得失敗からのretryを修正。最後の2 cycleは新P1/P2なし。軽量revisionはheads/waiting/resource metadataを比較し、変化がない限りinflight・確定結果を保持する。明示更新だけは同revisionでも再走査する。

新規実画面は単一run2/2成功、Chromium35.60秒／WebKit71.85秒、総109.32秒（output/shared-app-library-search-browser.log）。両本番mountの同一PDF/Markdown/owned corpus、metadata/real PDF本文/Markdown、tag/read AND、各sort、collapse/資料open後の条件保持、hidden checkedとvisible-only bulk draft、revealとfocus、catalog/content/history不変を確認した。依存境界をstage登録し、F36とR24をpartialへ更新、台帳はaccepted 0／partial 38／unverified 29。残る既定起動切替・旧検索責務撤去・外部index・大規模corpus性能・条件reload復元・実機は完了扱いにしない。既存回帰と最終標準検査は別runとして追記する。

### 検索追加後の最終検査

- 既存の作成・folder・tag・Markdownの4suite／両engineは8件成功。元の5suite runは回復試験2件のselector／同期前提の問題を含むためexit 1（総761.71秒）のままoutput/shared-app-library-search-regression.logへ保持した。
- 回復試験はタイトルを両hostのframe h1.border-bへ限定し、peer未同期の区間をpullの空deltaで固定してから別runで2/2成功（Chromium37.35秒／WebKit127.55秒、総165.46秒）。output/shared-app-library-search-recovery-regression.log。実編集・保存・readonly・復元・履歴のassertは削除せず、production保存処理は変更していない。
- 固定production sourceの全単体は1,150成功・benchmark1 skip・失敗0（43.98秒）。型4project・lint・PC/Web buildは成功。output/shared-app-library-search-{unit,typecheck,lint,build-desktop,build-web}.log。
- Pythonの契約・intent・repository・content publication受入は48成功（10.49秒）。output/shared-app-library-search-python.log。引継いだ広い143件runと区別する。
- resource到着による軽量revision変化と再検索も実repositoryを使う追加unitで確認し、同revisionの通常pollで再抽出せずcheckpoint/journalを書き換えないことを検証した。
- 台帳checkと依存境界は成功。共有entryのstagedは維持し、既定起動はlegacy、実機・全release試験・大規模corpusは未完了と記録する。

## 添付・通常作成Undo・初期kind解決（2026-10-26）

LibrarySessionへFile等の環境型に依存しないreader portを追加し、読取開始時にowner/名前/MIMEとitem/resource/publication IDを固定する。読取中からsourceを退出guardへ含め、hash・resource耐久化・読戻し検証・最新owner検証の順でcontentなしpublicationを公開する。失敗は同processにbytes/IDsを保持し、公開前取消は世代失効で遅い完了を拒否する。公開結果不明後は既存journalの同一要求で確認・取消する。共通UIはowner行からファイル選択し、失敗再試行・取消・自動openへ接続した。

AttachmentLibraryViewは両hostで同じexact attachment IDを扱い、content rootやMD editorを取得しない。hash/length/metadataを確認して元ファイルdownloadとescaped text/HTML/Markdown sourceを表示する。削除中のreadonly閲覧、scope/ページ寿命、Blob URL解放、定期/手動同期のcatch・世代確認を共有する。

RepositoryStateへ軽量publicationOriginsを追加した。TS/Pythonとも保存済みpublicationから投影し、ack後も残ることを既存publication受入へ追加assertした。catalog pollへ初期本文全体は返さない。LibraryHistoryは実originを持つ通常note/notebook/attachment作成のUndoを許可し、初回Undoの最新content headsをguard後に固定する。Undoは論理削除、Redoは同じ削除recordの解除で、本文/resource/IDを保持する。追加child/linkなどに有限inverseを適用できなければ拒否する。復元後の新内容に対する再削除は元observedを維持する。

独立Astraレビューでdurable historyのhead未着、normal pageshow、同期失敗を修正。実画面で初回Webのcatalogのみ到着時の起動停止を検出し、kind解決全体をordinary sync一回で再試行する。initial multiheadで実controllerが無い状態からも明示版選択できるよう、loader/error/Suspense fallbackだけreadonly closeguardを登録し、実controller表示前に解除する。unknown sourceを無条件に迂回しない。実repository回帰と独立再点検で確認した。

### 実画面・標準検査

- 添付の新規実画面は単一run2/2成功、Chromium43.99秒／WebKit109.02秒、総153.59秒（output/shared-app-library-attachments-browser.log）。両hostのresource保存失敗／quota、元入力からretry、正確な添付と子MDの分離、相手側open、bytes/hash、同期503からの保持、rename/delete/import Undo/Redo、reload、公開応答消失の全attempt同ID/全payload、HTML非実行、URL解放、元document/MD checkpoint不変を確認した。
- 初回0/2の起動失敗はoutput/shared-app-library-attachments-browser-initial-failure.logに保持する。
- 既存作成・回復・Markdownの元runは5成功／WebKit reload診断1失敗・exit1（総382.04秒）としてoutput/shared-app-library-attachments-regression-initial-failure.logへ保持。独立最小再現で同じcatalog内catch構造のpageerror10・innerCaught20・completed10・unhandled0を確認し、engine/host/reload/exact read endpoint/fixture/catalog stackだけを診断分類へ追加した。通常error/unhandled/禁止requestのassertは維持し、独立レビュー済み。
- 回復suiteは別run2/2成功（Chromium37.35秒／WebKit145.30秒、総183.21秒、output/shared-app-library-attachments-recovery-regression.log）。元runが単一6件成功だったとは書かない。修正後runの診断は0件。
- 全frontend単体1,170成功・benchmark1 skip・失敗0（44.09秒）。型4project・lint・依存境界が成功。Python編集/content/bibliographyの143件成功（33.20秒）。output/shared-app-library-attachments-{unit,typecheck,lint,python}.log。
- F34/R04を確認範囲についてpartialへ更新し、台帳はaccepted 0／partial 40／unverified 27。全計画・既定起動・旧責務撤去・実機完了とは区別する。

最終sourceのPC/Web buildも成功（output/shared-app-library-attachments-{build-desktop,build-web}.log）。台帳check・git diff --checkはexit0。共通module graphとsource hashをoutput/shared-app-library-attachments-module-graph.jsonへ保全。今回のbrowser/sidecarと一時fixture残存は0件。元の全計画は未完了で、既定起動はlegacy。次はM3訳文surface→F37一覧/一操作書出しを進める。

## 原訳の表示・入力・Reader状態の共通接続（2026-10-26）

ReaderSessionが原文の論理順と訳文の実編集対象を分離して所有する。原文／訳文／左右、翻訳済みfilter、active面、actual page UUIDと背景版付きの位置・履歴・landingを保存する。1件の訳文を複数原文へ対応付けた場合は通常render/filterと引用逆引きの双方で曖昧とし、別ページへ代用しない。未翻訳はplaceholderを表示する。

DocumentLibraryConnectionは同じDocumentEditSessionへ原訳2面を接続し、独立writerやtool設定を作らない。DocumentWorkspaceのtoolbarは一つ、非操作面への最初のpointer操作は選択として全指が離れるまで消費する。文字draft・描画・未確定保存は共通guardで面変更と移動を拒否する。参照面は描画所有権を持たない。

共通倍率はactive面の利用可能寸法とPDF実寸から下限を再計算し、非操作面は自分のfit下限で描画する。fit選択は各面の寸法に追従する。通常の前後・Home/Endは先頭着地、PageUpは末尾。翻訳済みfilterの集合更新は保留候補を保持し、guard解除だけでは自動移動せず明示retry等で適用する。数値入力は現在pageを指定した場合もfilterを解除する。

Primaryとcompanionの位置hookは実page/背景版・pane寸法・描画完了を照合する。左右同期は利用者scrollだけに追従し、pollや倍率復元で別面の保存位置とzoom anchorを上書きしない。capture/引用もactiveの実page tupleを固定する。

初回の新規実画面は両engine2/2成功（output/shared-app-reader-surfaces-browser.log、Chromium36.46秒／WebKit63.44秒）。初回ゲートは全単体1,186成功・benchmark1 skip、関連63成功、Python143成功。後続の位置復元修正とF37部品13テストを含む最新ゲートは全単体1,199成功・benchmark1 skip、型4project・lint・両build・依存境界が成功（output/shared-app-reader-surfaces-{unit,targeted,python,typecheck,lint,build-desktop,build-web}.log、unit等は最新runへ更新）。Python143と関連63は同工程の先行run。強化した実画面と既存読書回帰は別runへ記録する。全M3・全67要件・既定起動／旧経路撤去・実機の完了は未宣言。

### 強化試験後の実不具合修正と検証

独立した原訳位置を作って左右表示へ戻す試験で、active面の保存済み正規化位置に対し、旧ピクセルscrollTopが残る不具合を再現した。Primary hookは旧fit metricsで一度復元した後、新fitWidth／fitPageWidthが確定した際にも再復元する。scale-only変更は再復元条件へ含めず、pinch側のanchor所有権を維持する。Companionも新描画完了までzoom anchorを保持し、restore／captureのpane寸法を照合する。最新修正はAstra 2名が独立確認して新P1/P2なし。

- 原訳強化＋既存PDF読書＋読書状態の最終runは6/6成功（293.76秒、output/shared-app-reader-surfaces-reader-final.log）。原訳はChromium43.03秒／WebKit75.82秒。両hostの独立位置・左右復帰・reload・3回のCtrl+wheel anchor、Chromiumの実touch pointerによる中心移動／離指後の再描画を確認した。
- 有効訳文引用・既存引用・ノートは別の4suite run内で6件成功。元runは原訳強化2件の失敗を含む6成功／2失敗・exit1のままoutput/shared-app-reader-surfaces-browser-final.logに保持し、単一8件成功とは記録しない。有効訳文引用はlogical3→physical2とし、orphan／多対一の拒否・履歴不変・実DOM anchor／reloadを確認した。
- 最初の既存6suite runは9成功／3失敗・exit1（output/shared-app-reader-surfaces-regression.log）。引用の旧メッセージ期待と、既存textを新規作成のつもりで編集した試験位置を修正した。各失敗と位置診断のlogは保持する。
- 共通entry graph／source hashesはoutput/shared-app-reader-surfaces-module-graph.jsonへ保全。台帳はaccepted 0／partial 44／unverified 23。実iPad／Safari／Pencilの確認と既定切替は未実施。
- 最後に横方向も含めて、単面で保存した原訳それぞれの位置を左右表示とreload後の実DOMへ照合した。2/2成功、Chromium61.71秒／WebKit71.03秒、総135.13秒（output/shared-app-reader-surfaces-position-xy.log）。倍率下限・wheel・Chromium touchのassertも同じsuite内で維持する。production sourceは上記6件runから変更していない。
- 最後のE2E assertion変更後、E2E用tscも成功（output/shared-app-reader-surfaces-e2e-typecheck.log）。E2E fileへの個別ESLint実行は既存config対象外のwarningでexit1（同e2e-lint.logへ保持）。通常のproject lintとは区別する。

## F37注釈一覧・exact版移動・固定一操作追記（2026-10-27）

scope registryから一つのAnnotationBrowserSessionを提供し、LibraryContentConnectionの共通一覧へ接続した。corpusはdurable文書のheadを直接読み、閲覧のために編集sessionを作らない。同じ注釈payloadのheadは一行にまとめ、異なるpayloadは別variantとする。原訳は実page UUIDと背景版を保ち、未対応の訳文へ代用しない。NFKC複数語AND・分類・種類・原訳・日時microsecondを共通処理で適用し、選択・一覧位置を保持する。

場所移動はcatalog版とsource文書版を分離する。一覧のfresh read、ContentNavigationSession、表示controllerのguarded refreshで選択headと注釈全体を照合し、取消された要求はモデル採用前に拒否する。catalog未準備時やsource読取失敗時は旧行をstaleとして保持し、移動と新規exportを停止する。通常の無変更pollは場所検証を妨げず、head／payload／取得状態／条件の変更や強制更新だけが失効させる。

絞込結果は一度固定した全行Markdownを一つのappend IDで追記する。scope別scratchに要求・宛先・新規作成ID・handoff開始markerを保存し、再起動後はMarkdown authorityでunseen／pending／acceptedを確認する。宛先が削除されてもpendingの既存要求だけを回復でき、応答消失による二重追記や二重作成を防ぐ。取消後に既に作成した空ノートを消す別操作は発行しない。容量不足・raw破損・整理失敗では内容とguardを残す。quote／imageのhandoff前memory要求まで永続化したとはしない。

- 独立Astraの反復レビューで保存／取消／scope／catalog pin／採用前guardを修正し、最新再レビューは新P1/P2なし。
- 型4project・lint・全単体1,227成功／benchmark1 skip・PC/Web両buildが成功。Python143成功は同工程の保存接続変更時の先行run。`output/shared-app-annotation-browser-{typecheck,lint,unit,python,build-desktop,build-web}.log`へ記録。
- 新規2suiteは両engineの4/4成功、194.86秒（`output/shared-app-annotation-browser-final-browser.log`）。原訳anchor、固定結果、宛先作成、容量不足、commit/publication応答消失、同ID再送、reload、Undo/Redo、peer本文一致、sourceの無変更、複数source/catalog headの明示選択、一覧scroll、実read失敗、親待ち拒否を確認した。
- 初回label不一致、観測準備待ち、未登録rootのfixture、通常poll競合の失敗logは保持する。詳細は`shared-app-review-cycles.md`。遅延read／取消／背景版競合は単体証拠と実画面証拠を分ける。
- 台帳F37／R25をpartialへ更新し、accepted 0／partial 46／unverified 21。source graphは`output/shared-app-annotation-browser-module-graph.json`。既定起動はlegacyのままで、登録entryはstagedを維持する。

関連既存4suiteは7成功／1失敗、462.08秒（`output/shared-app-annotation-browser-regression-initial-failure.log`）。WebKit引用追記の失敗は操作前の初期heading待ちで、同source単独再実行は1/1成功、82.06秒（`output/shared-app-annotation-browser-quote-webkit-diagnostic.log`）。timeout延長・ignore追加・推測修正は行っていない。初期表示の未再現失敗を残し、単一8件成功とは記録しない。

残件は選択中Workspaceノートを初期宛先とする接続、全領域backup／move／restoreへの`paper-desk.annotation-append.v1:`登録、旧一覧責務の撤去、実機を含む最終受入。

## F38削除Markdownの専用比較（2026-10-27）

既存の回復一覧にMarkdownの「削除時点と比較」を追加した。DeletedMarkdownComparisonSessionはrepository readだけを使い、削除recordのobserved headと最新content headの全文snapshotを別々に保持する。複数版は明示選択し、後着版・退役した表示版・欠けた版・親待ち・読取失敗を区別する。選択した本文・manifest・左右scrollはpollで置換しない。catalog／scope／lifetime変更後の古いreadは採用しない。

通常MarkdownからCanonicalMarkdownPreviewを抽出し、各snapshotのmanifestに許可された画像だけを同じhash／MIME検証とBlob寿命で表示する。比較内の引用は資料移動へ接続せず、編集sessionも取得しない。復元は既存LibrarySession.restoreDeletedだけへ渡し、record全対象名を表示する。比較版を新本文として保存せず、全head・画像・履歴を保持する。

実装・デバッグはSolが担当し、Astraが設計と独立レビューを行った。初回reviewのready待ち／StrictMode再setupの2件を修正し、結線後は別のAstraも新P1/P2なし。モデル専用単体15/15、全単体1,242成功／benchmark1 skip、型4project・修正後lint・両build・境界40件・generator／台帳checkは成功。`output/shared-app-deleted-markdown-comparison-*`へ記録し、graphも同prefixへ保全した。

初回実画面は両engineでscroll位置の保持assertが失敗（`output/shared-app-deleted-markdown-comparison-browser.log`）。本文viewportの明示heightを`flex-1`が無効化していたため、Solが`shrink-0`へ変更し、geometry事前assertと到達waitを加えた。元の保持assertは維持した。Astra再レビューで新P1/P2なし、r3型lint・r2両build／境界40件も成功。全単体1,242成功はCSS最小修正前の同工程runとして区別する。

新規実画面の再実行は2/2成功、104.28秒（Chromium26.21秒／WebKit77.51秒、`output/shared-app-deleted-markdown-comparison-browser-r2.log`）。両本番接続で画像decode、左右版選択、後着headと旧pair／scroll固定、親待ち／到着、実read失敗回復、親子全対象の復元、応答消失時の同ID同payload再送、全target checkpoint／head／history不変を確認した。F38／R26へ確認範囲の証拠を追加しpartialを維持する。

共通preview抽出後の既存Markdown／画像2suiteは本文・PNG・SVGの計6件すべて成功、224.07秒（`output/shared-app-deleted-markdown-comparison-regression.log`）。全browser handle終端をSolが確認した。PDF／paperの専用比較・F35採用操作・既定起動・旧責務撤去・実機を含む全計画は未完了。次工程は同じSession／Panelを種類共通へ置換し、PDF／paperへ拡張する。

## F38種類共通の削除内容比較（2026-10-27）

DeletedContentComparisonSession／Panel／Connectionへ置換し、Markdown専用モデルは撤去した。左右はMarkdown／Documentの固定snapshotを共用し、Documentはoriginal／translated／deleted collectionと実page UUIDで選ぶ。版変更で同keyがなければ欠落を示し、同ordinalの別pageへ代用しない。左右・版・page別のscrollを保持する。旧Markdown成功段階のsource／testは`output/shared-app-deleted-markdown-comparison-source-checkpoint.zip`へ保全した。

CanonicalDocumentPagePreviewはpaperと全annotation、lazyなCanonicalPdfPagePreviewは実PDF背景を表示する。共通canonicalPdfResourceがscope・ID・SHA・MIME・長さ・物理page descriptorと実bytesを検証し、PDF.js実page数／viewport寸法も照合する。canonical pt枠とpixel budgetを使い、旧tupleのread／render callbackを拒否してURL／canvasを解放する。既存captureにも同じresource検証を接続して重複assertを撤去した。編集session・InkEditor・通常Readerの位置authorityは取得しない。

非active／pagehide時はassetを外す。Markdown画像はResizeObserverで目標位置へ届くまで復元pendingを保持し、placeholderによるclampを保存しない。利用者操作で取消できる。Astra2名の最終レビューは新P1/P2なし。最終r4の型／lint・全単体1,251成功／benchmark1 skip・両build・境界40件・generator／台帳／diffcheckは成功し、generic source graphも保全した。

実画面の成功証拠は同production sourceの別runへ分かれる。単一6件成功とは記録しない。

- genericMD比較2件とQuoteChromium1件は`output/shared-app-deleted-content-comparison-browser.log`内で成功。このrun全体は3成功／3失敗で保持する。
- QuoteWebKit単独は1/1成功、97.19秒（同prefixの`quote-webkit-diagnostic.log`）。初回reload-nativeのAnnotationCorpus fetch診断は未再現。source／ignore／timeoutを変更せず、errors／unhandled／forbidden検査も維持した。
- PDF／paper比較は2/2成功、157.76秒（Chromium54.37秒／WebKit102.69秒、同prefixの`pages-browser-r3.log`）。異resource／物理page、原訳／deleted pool、全annotation、紙の寸法／template、旧版scroll、同ordinal別UUID拒否、resource欠落／hash破損／遅延完了後の取消、復元前後の全graph／history／resource不変を両本番mountで確認した。

初回のPDFfixtureはtranslation command混在／背景版不整合でadmission拒否され、試験側を正規batchへ修正した。PDFpaper-r2のroute二重処理失敗も残し、handler完了→unrouteの順序と一次error保全へtest-only修正した。r5以降の型／lintも成功。遅延PNGの復元は実bytes／decodeと合成pagehide/pageshowで検証し、実履歴navigationのBFCache試験とは区別する。

F38／R26へ証拠を追加しpartialを維持、台帳はaccepted 0／partial 46／unverified 21。既定起動・legacy責務撤去・全領域backup／実機とF35の採用操作は残る。次はF20の付箋編集を既存文書writerへ接続する。

## F20付箋編集・F37明示編集（2026-10-27）

原文PDF・訳文PDF・paperの付箋作成／本文・分類・色・位置変更／削除を、同じDocumentEditSessionと文書historyへ接続した。専用annotation draftは元page・背景版・base・全payload・作成ID／UTCを固定する。既存Ink hookのprivate ownerを共有し、再取得時はdraftIdだけを更新して旧callbackを拒否する。フォーム入力を通常editPageへ流さず、fresh repository readとmayCommitによる現在権限を確認して既存pendingへ原子的に移す。保存開始後は固定pendingだけを同ID／全payloadで再送し、別writerやUndo stackを追加していない。

未確定フォームはpane再配置／一時unmount／scope復帰で保持し、close finalizerで自動保存しない。保存・navigation・Undoと入力所有を共通guardで制御する。remote更新はimmutable受信を続け、Doc採用はguard内に留める。remote論理削除後は新編集／保存を拒否し、現在ownerによる取消だけを許して退出不能を防ぐ。fresh read中にreadonly化してもpending直前のmayCommitが拒否し、draftを保持する。

F37は固定候補からの明示「この注釈を編集」でhead／全payload／page／背景を再検証する。ready登録は世代付き共通hookへ統一し、idle同page復帰後も再登録する。通常同期はflush後のlive annotation citationを確認して着地中の背景refreshを抑止し、guarded readの世代を進めない。実read結果だけを保留して普通の同期・別資料の全batch受信／ack／flush完了を通すcontrolled回帰を4caseへ追加した。

実装・debugはSol、設計・反復独立レビューはAstraが担当。Core対象44/44、SQLiteの付箋CRUD／再送／属性保全を含むPython144が成功。最終r11は型／lint、全frontend1,276成功／benchmark1 skip、PC/Web build、依存境界40、generator／台帳／diffcheckを通過した。Python144は保存Core変更時の先行証拠として区別する。graphは`output/shared-app-sticky-annotations-module-graph.json`、直前graphも保全した。最新prod／fixture／controlled suiteと監視helperはそれぞれAstra2名が再確認し、新P1/P2なし。

通常r5はPC・Web×Chromium・WebKitの4/4成功、664.04秒（Native/Webの順にChrome89.42／96.82秒、WebKit156.01／321.00秒、各case360秒）。原訳／paper CRUD・対象外属性全保全・geometry・Undo/Redo・draft再取得・F37再編集／後着拒否・保存応答消失後の固定再送／reload／peer全文一致・remote削除のform／gesture／preflightを確認した。`output/shared-app-sticky-annotations-browser-r5.log`に全観測を保存し、全caseのforbidden／errors／unhandledは空。

WebKit Nativeだけ再読込中のnavigationDiagnosticsを3件（corpus2＋既存pending-records1）保持した。実corpus／Sessionの独立診断で、catch・最終resolve済みのfetch失敗がpagehide前にWebKit pageerrorとして通知される機序をcurrent10/10で再現し、unhandled0と意図的unhandled対照で監視を検証した。既存分類へ実証済みのWebKit／Native／管理reload／離脱controller／同origin exact endpoint／対応frameの全ANDだけを追加し、独立unhandled検査と全stackを維持した。本番lifecycleやreload前の人工cancelは変更していない。元r1〜r4失敗／cancelledはそのまま残し、r5で初めて同通常経路の全観測から合否判定した。詳細は反復レビュー記録・`output/shared-app-corpus-navigation-diagnostic.log`。

関連8caseの初回は6成功／2失敗、436.23秒（`output/shared-app-sticky-annotations-regression-initial-failure.log`）。Toolsの投げ縄は最後のscroll後に古いarrow座標を使い55／56pxずれていた。続くdraft中disabledボタン待ちは仕様どおりのUI拒否へ、WebKitの旧SVG detachはcurrent paint／page／Ink確認へtest-only修正し、元points／count／idle／timeout／監視を維持した。最終Toolsは2/2成功・308.23秒（Chrome84.01／WebKit222.15秒、`output/shared-app-sticky-annotations-tools-select-browser.log`）、全audit空。先行6件＋最終2件の別runの証拠で、単一8件成功とはしない。Astra軽量確認・関連型／lint・post-tools台帳／diffcheckは成功。product／fixtureはこの回帰対応で変更していない。

新geometryは未importのcapture／text binding hook／純testを実装し、Astra2名のnode再置換／中間transformのP2を修正、再確認は新P1/P2なし。純11件は別runで11/11成功・208ms、全workspace型／lintも通過したが、実DOM／font／hookは未spike。本文highlightはまだ保存・公開へ未接続。台帳F20・F37・R25へ確認範囲の証拠を追加しpartialを維持する。accepted 0／partial 46／unverified 21、既定起動legacy／旧責務撤去／実機の残件は変えない。

次phaseはAstra2名の再設計に従い、asset検証をresource／pageで分けて既存resource validatorへ統一し、旧2rendererのcanonical使用を新PdfSurface／CanonicalDocumentSurfaceへ一括置換する。同resourceのDocument loadは保持し、Page／背景／view／DOMの描画tokenを別管理する。詳細と現在所有は引継ぎ第19節・次工程設計。新phaseのsource／gateは上記の完了証拠とは分ける。

## canonical共通PDF表示への置換（2026-10-27、回帰検証中）

PC／Webのcanonical接続は共通PdfSurface／CanonicalDocumentSurfaceを使うよう置換した。host adapterにFrameを残し、resource検証・描画・text binding・入力面の準備判定を共通へ集約した。位置・倍率・historyはReaderSession、編集・保存は従来のDocumentEditSessionを使い、authorityを増やしていない。旧PdfPane／Web PdfReaderはlegacy専用に残り、既定起動の切替と撤去はM6の残件。

useDocumentPdfAssetはresource単位の検証済bytes／URLを維持し、現在pageだけを別検証する。同resource内のpage移動や注釈更新で再読込せず、scope／hash／attempt変更では旧assetを同期的に表示対象から外す。実Document／Pageのproof後に寸法を通知し、不一致PDFによる保存倍率の誤補正を防ぐ。Astra2名の独立レビューで3指摘を修正し、最新再確認は新P1/P2なし。

r5標準検査は型／lint、全frontend1,292成功／benchmark1 skip、PC／Web build、境界40、generator／台帳／diffcheckが成功。Python144は先行保存変更時の証拠で、今回の再実行ではない。ReadingState／TranslationSurfacesの各2件と、hidden canvasの旧Web差分期待を共通化したfocused PdfReading2件は別runで成功。Notebook／Toolsは4/4成功・439.166秒。付箋は同一描画tupleと実入力可能なLayerを待つhelper修正後、通常r9が4/4成功・611.684秒。引用／注釈6件も6/6成功・315.926秒となり、別runの20case成功証拠が揃った。全最終caseの全監視集合が空、app14source r5 hash一致、全handle終端・post台帳／diffcheck成功。元失敗・診断を区別して保持する。専用geometry／asset spikeは移設・生成中で、まだ受入済みではない。詳細とログは引継ぎ第19節。

## F20本文highlightのstaged統合（2026-10-27、検証中）

最新の役割は実装GPT 6.1 Terra、debug・検証・コードレビューSol、設計方向Astra。共通rendererはr8-finalまで進み、実render／text／page factsのjoin、実FontFaceSet.readyによる描画世代付き再照合、intrinsic font倍率と逆CSS倍率による小倍率の部分Range精度を実装した。r8は型・lint・target35、全unit1,316成功／benchmark1 skip、両build、境界40等が成功。専用geometryは正常なfont失効と別task試験の競合、起動前のharness失敗を分離して記録し、最新Chrome拒否focused1/1は成功した。full geometry／resource／引用の最終同candidate受入は残る。

Terraはr8を土台に43fileをstaged統合し、本文highlight create／edit／deleteを既存DocumentEditSessionとjournal／pending／Undoへ接続した。managed本文Range、pointer／Reader key入口、copy・quote・共通フォーム・polygon hit／重複候補・F37明示編集、実mountのlife-cycle／同期・保存失敗テストsourceを反映した。旧入力はlegacy hookへ一時保全し、canonicalの全PDF／paper／inactive面はReader単位の明示bundleと同じmanaged入力を使う。owner基盤は共有し、旧hook／inventory／fallback／callerはM6撤去対象とする。

前後hashは`output/shared-app-f20-staged-integration-changes.json`、原本は`output/shared-app-f20-preintegration-checkpoint/`等。現在はSol2名による入力・描画・隔離／Core・保存・UIの独立レビューと、別Solによる型・関連テストの段階。実装報告を動作成功へ読み替えない。既定起動legacy、accepted 0／partial 46／unverified 21は維持し、通常公開・既定切替・実機を含む元計画は未完了。

統合後のSol2観点レビューは新P1/P2なし。test fixtureのresource登録／remote背景を正規化し、managed portalのglobal document fallbackを接続済Reader rootのownerDocumentへ直した。最終frontend標準は型・lint・全unit1,366成功／benchmark1 skip、PC／Web build、境界40、contract／ledgerが成功。graph／hashは`output/shared-app-f20-staged-module-graph-r5.json`等へ保全した。

PythonにはTextHighlight indexed／unindexedと既存Inkの保存・同ID再送・再起動・raw history／receipt全属性を確認する専用caseを追加。focused1/1と、明示canonical保存14fileの140/140が別runで成功した（`output/shared-app-f20-staged-python-canonical-scope-r1.log`）。過去144のscope完全一致は未確認で、新件数を145へ合わせない。44変更項目のhash不変を確認し、実PC／Web mountを含むChrome managed highlight lifecycle一件の単独検証へ進んだ。実UI／touch・pen等の入力matrixと通常公開はまだ未受入である。

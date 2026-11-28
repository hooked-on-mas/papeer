# W1b：共通repositoryの計画・snapshot・atomic適用とI/O寿命

Astra設計案。Root／Sol確認前の実装指示ではない。[B1b host driver設計](shared-app-local-host-driver-design.md)の「native transaction内でcryptoを待たない」を、実際の`DurableEditRepository`へ接続する有限契約。本書作業ではsource、tests、DB、実行環境を変更しない。全M0–M6／67要件とr5 provider境界を維持する。

## 1. 調査した矛盾と採用方針

実`runtime/edits/repository.ts`の`verifyDatasetResources`はresource bytesを読んだ後にWebCryptoをawaitし、`replaceDatasetControl`／`installDataset`からlive transaction内で呼ばれる。ほかにも`assertBindings`、graph/history構築、projection計算、checkpoint導入がasync `EditTransaction` callbackへ混在している。`adapters/browser/indexedDbEdits.ts`はdatasetControlsへの反復getでtransactionを延命している。W1a隔離案の`canonicalHostTransaction`は、IDB requestを同期enqueueし、request callbackでfinishする契約なので、このcallbackをそのまま包むことはできない。

採用するのは **対象selectorのreadonly snapshot → 共通Coreのmemory plan／async検証 → native write transactionでread setをexact再照合 → 有限mutationをenqueue → commit**。keepalive、callback内のWebCrypto、native transactionの途中でfetch/タイマーを待つ方式は採用しない。browser adapterへ`EditGraph`、history、publication、resource bindingの第二実装を移さない。

共通Coreの現在の意味は`EditPlanView`へ移し、既存algorithmをできる限り保持する。host adapterはsnapshotの取得、物理keyの比較、保存だけを行う。新しい永続journal、全app store、dataset全体のrevision counterは追加しない。既存intent/batch ID/receiptが再試行と耐久結果の正本のままである。

## 2. 新しい境界の型

新`runtime/edits/repositoryPlan.ts`に有限selector/mutationとplan view、新`repositoryExecution.ts`にcapture/retryの共通runnerを置く。`ContentRepository`の公開methodと結果型は維持する。以下は型の意味を固定する契約で、各genericの細部は型検査可能な判別unionに展開する。

```ts
type RepositoryOperation =
  | 'read' | 'read-intent' | 'pending-intents' | 'replace-intent'
  | 'checkpoint' | 'install-checkpoint' | 'initialize'
  | 'dataset-control' | 'datasets' | 'install-dataset' | 'replace-dataset-control'
  | 'store-resource' | 'read-resource' | 'resource-metadata'
  | 'commit' | 'publish' | 'receive-records'
  | 'receipt' | 'pending' | 'pending-records' | 'pending-publications'
  | 'acknowledge-upload' | 'acknowledge-import';

type ScopeRead =
  | { kind: 'control'; identity: DatasetIdentity }
  | { kind: 'roots'; scope: EditScope; targetId?: string }
  | { kind: 'edits'; scope: EditScope; targetId?: string }
  | { kind: 'intents'; scope: EditScope; targetId?: string }
  | { kind: 'datasets'; scope: EditScope; manifestId?: string }
  | { kind: 'resource'; scope: EditScope; resourceId: string }
  | { kind: 'resource-bytes'; scope: EditScope; sha256: string }
  | { kind: 'checkpoint-marker'; scope: EditScope; sha256: string };

type EditMutation =
  | { kind: 'put-root'; scope: EditScope; root: Snapshot }
  | { kind: 'put-edit'; scope: EditScope; edit: StoredEdit }
  | { kind: 'put-intent'; scope: EditScope; targetId: string; record: EditIntentRecord | null }
  | { kind: 'put-dataset'; scope: EditScope; manifest: DatasetManifest }
  | { kind: 'put-control'; record: DatasetControlRecord }
  | { kind: 'put-resource'; scope: EditScope; resource: StoredResource }
  | { kind: 'remember-checkpoint'; scope: EditScope; sha256: string }
  | { kind: 'put-projection'; scope: EditScope; snapshot: Snapshot }
  | { kind: 'prune-projections'; scope: EditScope; targetId: string; versions: readonly string[] };

type CapturedEditSnapshot = {
  // typed, deeply captured query answers; absent と未取得を区別する
  readonly values: SnapshotValues;
  readonly comparison: OpaqueComparisonToken;
};
type PreparedEditPlan<T> = {
  readonly snapshot: CapturedEditSnapshot;
  readonly mutations: readonly EditMutation[];
  readonly result: T;
};
type ApplyResult = { status: 'committed' } | { status: 'changed' };
interface EditDatabase {
  capture(operation: RepositoryOperation, reads: readonly ScopeRead[]): Promise<CapturedEditSnapshot>;
  compareAndApply(operation: RepositoryOperation, plan: PreparedEditPlan<unknown>): Promise<ApplyResult>;
}
```

scopeはnative authorityの代わりではない。実adapterは一つのcaptured host operationを外側から束縛され、capture／apply／結果公開まで同generationを使う。comparison tokenはそのadapter instanceが発行した非公開記録に対応し、呼出側に期待値を組み立てさせない。空readsetのtokenへ任意mutationを付ける入口を公開しない。これはtrusted Coreとstorage間の内部契約であり、HTTPへplanやmutationsを受け付けるAPIを作らない。

productionのstable repository facadeは各公開methodの入口でgate.runを一回呼び、そのoperationに束縛した短命のEditDatabase handleをCore runnerへ渡す。captureからasync hash、CAS retry、result公開まで同handleを使用する。並行する別methodのためにdatabaseの`currentOperation` fieldを書き換える方式は禁止する。必要ならそのcallだけのstateless DurableEditRepository evaluatorを作ってよいが、registry/session／第二writerは作らない。nested private helperは同じcallのPlanViewを使い、新leaseをcaptureしない。

同じoperationのprivate execution contextへ、固定request fingerprint、native attemptごとの未送出／CAS書込みゼロ／native送出／確認済みabort／oncompleteまたは検証済みHTTP結果の証拠を保持する。証拠はtrusted adapterだけが更新し、Coreが結果を返した後も**outer gateの最終delivery fenceとpublic facadeの結果分類が終わるまで**生存させる。gate.runの外側にあるstable facadeが最後の分類責務を持つ。action開始済みというflagだけではcommit可能性やCoreの確定validation拒否を判断しない。

`ScopeRead`のoptional targetは明確に「一target」または「当該scopeの全集合」を意味する。scopeを省略して全DBを読むselectorは存在しない。source/target epochを跨ぐselectorは同identityのtransition authorityでのみ許可され、通常admissionには一active scopeだけが許可される。

## 3. Coreのplan生成：既存の検証を一か所で使う

現`EditTransaction`をnative transaction interfaceとして残さず、同じ論理methodを持つCore内部の`EditPlanView`へ置き換える。`root/edits/resource`等はsnapshot＋plan内overlayから読む。Promiseを返す既存helperを保持してもよいが、そこでDBを開かない。`put*`はmemory overlayとmutation列に追加し、後続のreadが同じplanの書込みを見る。`publish`の`installRoot`後にcatalog commitが新rootを見る意味を保持する。

`pruneProjections`はこの段階ではtargetと保持versionのcommandを記録するだけである。Coreは物理page tableを知らない。graph、history、binding、resource hash、checkpoint hash、PDF inspectionはすべてnative transactionが閉じた状態で行う。

各operationは入力を最初にdeep captureし、ID／parents／history／publication／bytesを固定する。retryで新IDやbase、epochを生成しない。inputだけで確定するvalidationやPDF inspectionは一度行い、固定結果を使う。snapshot依存の検証を古いsnapshotの結果のまま新snapshotへ流用しない。

### 3.1 閉じたsnapshotの取得

operationごとのseed selectorsは次節で固定する。captureはそのselector集合を**一つのnative readonly transaction**で取得する。個々のgetを別々のtransactionで足し合わせて一つのsnapshotと呼ばない。

Coreは取得したroot/editsと固定入力から候補projectionを計算し、既存`snapshotResourceIds`、`publicationResourceIds`、`checkpointResourceIds`とcatalog item IDを使い、追加のresource metadata／child root selectorを一括列挙する。足りなければselectorのunion全体をもう一度captureし、planを最初から作り直す。既に取得した古い値と新しい値を継ぎ足さない。graphに必要な取得を終える前にmissing-target等のsemantic rejectionを確定しない。

`EditPlanView`は未取得selectorをundefinedと返さず、内部の`NeedSnapshot`として検出する。この例外はadapter/UIへ出さず、開発時のseed不足と依存closureを共通runnerが処理する。依存selectorは一個ずつI/Oするのではなく、projectionとincoming snapshotを走査してbatch追加する。plan内に作った新root/resourceはoverlayから満たし、存在しない保存rowを捏造しない。

再capture／CAS retryごとに前planのoverlayとmutation列は全て捨て、同固定入力と新しいclosed snapshotから作り直す。未完成planでenqueueや永続副作用を起こさない。comparison tokenに保持するbinaryもprivate copyとし、view／callerへそのbuffer参照を公開しない。

全readが一つのcaptureで満たされた時点だけをclosed snapshotとする。immutable projection／resource検証が完了すれば`PreparedEditPlan`を作る。authoritative rowを変更するmutationには、そのpoint rowまたは完全な対象queryのcaptureが必須で、未取得rowをblind overwriteしない。

### 3.2 再試行の有限性

write時のCAS missはnative writeを一つもenqueueせず`changed`で返す。共通runnerは同じ固定入力でcaptureとplanをやり直す。自動retryは3回までとし、それ以上は`repository-snapshot-changed`のretry可能失敗を返す。selector closureが並行編集で増え続ける場合もcaptureを無限に続けず同じbounded policyへ入れる。資料数／resource数そのものをretry回数にしないよう、依存列挙をbatch化する。

再planでも既存`graph.assertLocal`、expectedId、history順序等を再検証する。CAS missを理由にparent/headを最新へrebaseしない。semantic conflictなら従来どおり拒否する。`replaceIntent`／`replaceDatasetControl`はcallerのexpectedIdを保持し、相手の変更が入れば`conflict`へ収束する。

## 4. 全methodのread set／write set

以下のCは当該identityのcontrol＋整合するaccess値。host grant/profile/peer/admissionのread setはadapterが常に追加し、Core値として再定義しない。

| method | seed＋依存read set | mutation／結果 |
| --- | --- | --- |
| datasetControl／installedDatasets | C／対象scope datasets | readonly clone／validator |
| readIntent／pendingIntents | C＋対象intent／scope intents | readonly validator。未取得とabsentを区別 |
| replaceIntent | C＋対象intent（absence含む） | expectedId/transition検証後put/delete一行 |
| read(target) | C＋target root＋target edits全集合 | 既存graph／history／receipts／publicationOrigins。resource bytesは読まない |
| receipt(batchId) | C＋対象batch row、または現実装と同じscope edits | readonly receipt。batchId point selector追加は最適化として可能 |
| pending各種 | C＋scope edits全集合 | filterはCore。outbox/history/publicationを落とさない |
| checkpoint | C＋scope roots／edits全集合 | 既存checkpoint projection。BLOBなし |
| commit | C＋scope edits全集合＋target root、候補projectionが参照するresource metadata／catalog child roots | duplicate/history/graph/binding検証、edit＋receipt＋history＋projection/pruneを一bundle |
| publish | commitの集合＋item root absence、同item publication collisionを含むscope edits、新contentの依存metadata／root | content rootとprojection＋catalog batch/history/outboxを同bundle |
| initialize(root) | C＋target root、target waiting edits、root/projectionの依存metadata／child roots | existing root exact、waiting history/heads保持、root/projections/必要edit更新。通常host権限では拒否 |
| receiveRecords | C＋scope edits／roots、incomingと生成projectionの依存metadata／child roots | 原子merge、重複/parent-waiting/history検査、全変更edit/receipt/root/projectionを一bundle。receive/receivePublicationsは既存委譲 |
| acknowledgeUpload／Import | C＋対象edit row（現scope editsでも可） | 全receiptをコピーして必要fieldだけ変更。他peer／upload状態を上書きしない |
| storeResource | C＋metadata ID point＋hash bytes point（両absence含む） | 下記collision契約後metadata/bytesをatomic保存 |
| readResource | C＋metadata ID、その結果のhash bytes。closed captureに両者を含める | native readonly終了後にbytes hash検証。戻すのは同snapshotの一組 |
| resourceMetadata | C＋metadata ID | readonly validator、bytes取得ゼロ |
| installCheckpoint | C＋checkpoint marker＋scope roots／edits、incomingと生成projectionの依存metadata | marker trueの再送規則、merge/history/receipt保全。root/edit/projection/markerを一bundle |
| installDataset | 上段＋manifest ID/対象scope datasets＋manifest列挙のmetadata/bytes point | 非同期hashは外側。checkpoint導入とinstalled manifestを一bundle |
| replaceDatasetControl | C＋source/target各scopeのroots/edits/intents/datasets、必要manifest resourcesだけのmetadata/bytes | exact transition／frozen containment／resource proof、copied receiptsとcontrol/accessを一bundle。通常hostでは拒否 |

scope edits全集合は現Coreがbatch ID衝突、history、publication item衝突を判断する対象であり、今回その意味を狭めない。他Library／他namespaceのeditsを読む必要はない。将来のindex最適化は同じpredicate意味を保つ別差分にできる。BLOBは表に明記したreadResource／storeResource／dataset resource proof以外で読まない。単なるInk一stroke／catalog編集のためにPDF bytesを複製・hashしない。

## 5. exact比較とnative apply

### 5.1 read setは値と集合の両方

point readはrow key、scope、payloadのexact値、または明示absenceを捕捉する。queryは正規化したselector、返った全key集合と各値を捕捉する。CASで同queryを再実行し、挿入／削除／payload変更を全て検出する。countだけ、最大日時だけ、既存keyの比較だけではphantom insertを見逃すので不可。JSON構造は既存canonical equality、bytesはbyteLength＋全byte比較を使う。readsetの期待値はdeep captureしてcallerから変更できないようにする。

controlと`datasetAccess`の二保存値は同transactionで読む。accessがcontrolからの既存`datasetAccess(control)`と一致しなければ復旧対象とする。controlがないことを通常host編集許可へ代用しない。stage権限のCore fixtureだけが既存のcontrolなしstagingを明示使用できる。

`compareAndApply`はoperation allowlist／全selector/mutationのscopeを先に検査し、同RW transactionでhost grant/admission確認→readset exact比較→physical collision検査→mutation enqueue→最終host fence→commitの順を守る。readset不一致と認可失効は別結果であり、失効をretryで新leaseへ付け替えない。

### 5.2 IDBの実装

`IndexedDbEditDatabase`からasync `transaction(run)`とkeepAliveを削除し、上記capture／compareAndApplyを実装する。W1a `canonicalHostTransaction`へ渡すのはIDB request chainだけである。`capture`のmodeはreadonly、applyはreadwrite＋既存durability指定。native transaction内にCore planner、WebCrypto、PDF inspector、Promiseタイマー、ネットワークを呼ばない。

applyのread requestが全て完了したcallbackで同期比較し、成功した場合だけ書込みをenqueueする。`putProjection`のpage分割／不変page key collision比較と`pruneProjections`の保持page探索は既存adapterの物理責務として残す。これらもIDB request callback chainで行う。Coreのgraph判定を再実装しない。

projectionは派生cacheなので通常snapshot readsetへ全projectionを入れない。apply内で当該targetの既存page key内容を比較し、不変keyの異内容を検出したらtransaction全体をabortする。pruneは当該scope/targetのprojection/pageだけを扱い、Coreで確定したhead集合の保持規則を使う。必要な全request完了前にfinishしない。collision後に既にenqueueしたputがあってもtransaction abortで全て戻ることを実試験する。

mutationは一transactionにまとめる。content rootだけ、batchだけ、receiptだけ、historyだけ、checkpoint markerだけを先にcommitしない。snapshotとplanはmemoryだけに置き、pending journalの代わりに保存しない。apply直後のprocess停止は現intentから同IDで結果照会／再送する。

### 5.3 resource collisionは両言語で揃える

現TSは`putResource`で同hash bytesをputし直せる一方、現Pythonは`INSERT OR IGNORE`で異なる保存bytesを無視する。この差を新planへ持ち込まない。

入力bytesのSHAとPDF inspectionは外側で一度確定する。同resourceIdの既存metadataが異なれば既存`resource-id-reused`。同hashの既存bytesがある場合は入力bytesとexact一致を要求し、異なれば`resource-hash`として無変更拒否する。metadataがあるのにbytesが欠ける部分状態も復旧対象として無変更拒否する。metadataが未存在で、別resourceIdが同hashの完全な同bytesを共有している場合は新metadataだけを許可する。両者なしなら一bundleで保存する。壊れたbytesを通常storeResource再送で修復した扱いにしない。

この検査はPython `store_resource`にも小差分で入れ、TS/Pythonの同fixtureで確認する。別の大きなPython transaction設計変更に抱き合わせない。resource CASのwrite中比較はexact bytesであり、write transaction内でSHA計算を再実行しない。

## 6. read結果とcommit結果の意味

readonly methodはclosedな一snapshotから計算した結果を返せばよい。計算中に別writerが更新しても、snapshot readとして妥当であり、最新状態へ勝手に差し替えない。ただし結果公開時のcaptured host operation/epoch検査は必須。readResourceの非同期hash終了後に失効していれば結果を公開しない。通常readのためにRW transactionや全data CASを実行しない。

IndexedDBの同じreadonly transaction内では、最初に実際のgrantとadmission構成行を検証し、結果確定時とtransaction完了時に現在のowner／generationを確認する。同じtransaction内の永続行を末尾でもう一度getする必要はない。これは[IndexedDBのtransaction scheduling](https://www.w3.org/TR/IndexedDB/#transaction-scheduling)が保証するsnapshot不変性に限るもので、別transaction間で認可結果を使い回す許可ではない。readwriteはmutationによって同一transaction内の値が変わり得るため、従来どおり末尾の永続行再検査を行う。実DBテストではqueued writerと次transactionでの失効、finish／完了時の失効、書込後の行・markerのrollbackを確認する。[修正前後の検証](../checkpoints/shared-app/2026-10-30-p4-workspace/provider-composition-r1/readonly-host-verification-r1/independent-after-review-helpers-r1.json)

write operationはmutationゼロのidempotent resultでも同readsetを確認してから成功を返す。CAS changedはそのnative attemptのwriteゼロを保証するが、Coreの確定拒否ではない。共通runnerが同固定入力でbounded retryし、尽きた場合はretry可能なstorage失敗として扱う。確認済みnative abort、quota／permission／取消／transport errorも、Coreが固定要求をsemantic validationで確定拒否したこととは区別する。これらを自動的に`CommitResult.status='aborted'`へ変換してintentを終端化しない。

IDBの`oncomplete`前に確認済みabortはそのattemptの無commit、`oncomplete`が来た後は耐久済み。commit後のlease失効・結果配送抑止を単なるErrorにして`DurableEditRepository.commit/publish`のcatchがabortedへ変換してはならない。低層adapter内の配送失敗は既存`CommitOutcomeUnknown`を使えるが、それだけではouter gateで後から起きる失効を処理できない。**native oncomplete → Coreのcommitted結果返却 → outer gate失効**も、stable facadeが同operationのprivate証拠を読んで`{status:'unknown', reason}`へ正規化し、元intentを保持する。HTTPの耐久成功応答をparse済みでも最終gate fence前に失効した場合は同じ扱いにする。旧成功receipt／旧本文を失効後の画面へ公開しない。

既存公開型を増やさず、commit/publishのretry可能storage失敗もstable facadeで非終端の`unknown`経路へ渡す。private証拠とreasonでは「無commit確認済みで再試行が必要」と「commit結果不明」を区別し、無commitと証明できないattemptが一つでもあれば不明を優先する。Coreの確定validation拒否だけをabortedへ分類できるが、過去の送出／同ID再送の耐久可能性を覆す根拠にはしない。fixed request／intent bodyはどのstorage失敗でも保持する。readonly操作のstaleは値なしの失効errorとして返し、unknown receiptや古いread結果へ変換しない。

受理済みduplicate batchのreceipt/historyを返す既存意味、未送信upload状態、他peerのimport receipt、Undo/Redo逆batch、parent-waiting recordsを全て保持する。plan retryで履歴actionを作り直さず、既存履歴検証に通す。普通のreadやcancelでintentをack/削除しない。

## 7. Python／Desktopとの対応

Desktop JSは引き続き認可済みHTTP client、PythonはD1のoperation別authorityとSQLite transactionを使う。Pythonの同期graph/hash処理はIDBのtransaction寿命問題を持たないので、今回TS planをJSON化してserverへ送り付けたり、Pythonへ全plannerを移植したりしない。

Nativeのprivate `SyncAuthority`では、固定された5つのreadonly処理（receipt／pending-records／dataset-control／read-resource／resource-metadata）に限り、同じSQLite read transactionの永続proofを最初に完全検証し、末尾ではそのsnapshotに対する現在のlease・admission・owner・descriptor・evidence・scope／bindingを再確認する。別operationへproofを持ち越さない。対象のrepository処理はtransactionを終了・変更せず、同じconnectionへ書き込まない。この限定を任意のraw connection利用へ拡張しない。一般のowner guardとwrite処理の永続行前後検査は維持する。[SQLiteのsnapshot条件](https://www.sqlite.org/isolation.html)と、実SQLiteのDELETE／WAL並行writer・失効・初回破損拒否・write rollbackを含む19追加ケースで確認した。backend489件とAPI5件・型／lintは成功したが、ブラウザーの配送期限改善は別に確認する。[限定変更と独立検証](../checkpoints/shared-app/2026-10-30-p4-workspace/provider-composition-r1/native-sync-readonly-proof-r1/promotion-r87.json)

Pythonは同一SQLite write transactionとgeneration guardの間で既存stateを読んで検証・書込むため、TSのsnapshot＋CASと同じserializableな結果を満たす。Coreのbatch/graph/history/resource/transition規則を両言語fixtureで合わせる。今回のPython必要差分は前節resource collisionの不整合修正と、D1が全操作で原子性／権限を守ることの回帰確認である。native D2配線中のfileを別担当が上書きしないよう、Root指定candidateへ小差分を後で統合する。

Nativeの通常writable転送では、Coreで耐久適用できたedit・import receipt・resourceを、privateな返却object identityとgenerationに結び付けてACKする。同じ検証済みphysical header／bodyに限り、次回Coreへ返す差分から省く。毎回の完全metadata一覧・現在のowner／principal／scope・immutable／resource整合検査は保持し、処理済み状態は既存cacheの上限内に収める。dataset／readonly joinは全量を返す。受信未完了・取消・renew・古いACK・不明header・cache追出しでは再送し、認可結果はcacheしない。既存同期APIでの耐久後応答消失・再送、未到着receipt保持、実resource bytes／参照と競合拒否を含む8ケースを確認した。ブラウザー待ち時間と実providerの受入は別に行う。[転送契約の検証](../checkpoints/shared-app/2026-10-30-p4-workspace/provider-composition-r1/native-incremental-pull-r1/promotion-r90.json)

`EditMemoryDatabase`も新EditDatabaseを実装し、capture時には同lockで選択値だけdeep capture、apply時には同lockでcomparison検査＋mutationを全適用する。全state cloneを使うunit実装であっても、productionが全DB/BLOBをcloneする設計の根拠にしない。memoryだけの成功をIDB/SQLite耐久証拠へ数えない。

## 8. StableHostGateの共通化

W1aの`StableHostGate`にはIDB固有処理がなく、epoch、取消、flight drain、reauthorize、terminal closeをbrowser adapterへ置く理由がない。新`runtime/lifecycle/RuntimeIoGate.ts`へこのstate machineを一つだけ置く。`LocalHostAuthority`のgrant/proof WeakMap、IDB transaction registry、native server lease/token/HTTPはhost adapterに残す。

```ts
interface RuntimeIoGateHooks<Binding, Proof, Operation> {
  capture(binding: Binding, proof: Proof, signal: AbortSignal): Operation;
  assertCurrent(operation: Operation): void;
  sameAdmission(previous: Proof, next: Proof): boolean;
  validateCandidate(binding: Binding, proof: Proof, signal: AbortSignal): Promise<void>;
  subscribeInvalidation(listener: () => void): () => void;
}
// Bindingはhostのprivate credential/admission組。Coreは内容を解釈しない。
class RuntimeIoGate<Binding, Proof, Operation> {
  run<T>(signal: AbortSignal | undefined, action: (op: Operation) => Promise<T>): Promise<T>;
  runSync<T>(action: (op: Operation) => T): T;
  revoke(): void;
  reauthorize(binding: Binding, proof: Proof, acquisitionSignal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
```

gateはhostから発行済みのbinding/proofを保持するだけで、namespace/grant許可を発行しない。capture hookは真正性とgenerationを検査し、native credentialsをcaptured operationへ不変に束縛する。`runSync`は既存draft/reader preference port用で、前後のepoch/host検査を行う。localStorageを認証正本にしない。

状態はactive／revoked／closed、単調epoch、handoff ticket、一つのcloseFlight、実行中flight集合だけ。revokeはactiveを同期停止してgeneration signalをabort。runは開始時のbinding/proof/generation signalを捕捉し、action前後で同epochを検査する。旧runが最新bindingを途中で読み直すことを許さない。closeはterminalかつidempotentで、drain後に購読解除する。closed後のreauthorizeを拒否する。

reauthorizeはpersistent proof一致→旧epoch取消/drain→host validateCandidate→handoff ticketと取得signal最終確認→新binding/proofをatomic装着、の順。検証中のhost失効／別handoff／closeは旧候補を失敗にする。取得signalはresolve時にdetachし、新active epochのlifetimeへ持ち越さない。拒否されたUI closeはgate.revoke/closeを呼ばない。B3のscope/form保持契約と現在の`resources.reauthorize → sessions.resumeForHost → revalidate → unlock`の順は維持する。

gateはerrorを「保存中止」と解釈しない。`GateOperationStale`は同operationとの対応を保ってouter stable facadeへ返す。action未開始／開始済みは補助情報であり、耐久結果の証拠ではない。§6のprivate execution evidenceを最後まで保持し、facadeがgate.run自体のrejectも捕捉してcommit/publishを正規化する。既に返却済みの低層adapterだけにこの責務を負わせない。共通gateからresourceHash、receipt clear、DB close SQL、Google認証を呼ばない。

gateのdrain対象はport I/Oのpromiseであり、任意のReact effectやfeature全体の完了を保証するものではない。既存sessionのrequest/generation保全とB3の`resumeForHost`を併用し、遅延commit→失効→再入の試験でold resultが新payloadへ適用されないことを確認する。未収束sessionを強制resetして再入成功にしない。必要なら既存sessionのflight待ちをそのownerに追加し、第二sessionを作らない。

BrowserとDesktopはこの同じgateを使い、それぞれのcredential capture／revalidate／invalidate hooksを提供する。platform固有分岐はnative I/Oと保存原子性に限る。共通化のためにPythonのserver lockやIDB callbackをJSの擬似transactionへ置き換えない。

## 9. 有限実装順とfile境界

| slice | Terraの出力差分 | Sol gate |
| --- | --- | --- |
| T0 shared gate | `runtime/lifecycle/RuntimeIoGate.ts`、W1aからgate state machine抽出、browser hooks、native client用hook契約 | generation/late callback/close/再入/取得signalの共通unit。browser testは実authorityとの結合を維持 |
| T1 Core plan＋memory | 新`repositoryPlan.ts`／`repositoryExecution.ts`、`repository.ts`全methodをPlanViewへ移す、memory adapter更新 | 全既存repository/session意味回帰、mutation bundle／readset／CAS競合のunit。ブラウザ保存完成とは報告しない |
| T2 IDB snapshot/apply | `indexedDbEdits.ts`のtransaction/keepalive除去、W1a helper上のcapture/CAS/enqueue、physical projection処理 | 実IDBでdelayed crypto、phantom、bytes collision、abort/commit unknown、authority失効。全method coverage |
| T3 W1b接続 | 既存bootstrap IDB helperの同tx authority接続、production factory／draft/image/readers gate、real-grant fixture | 全bootstrap/read/write/I/O境界の実認可。stage/remoteの拒否と必要unit fixtureを区別 |
| T4 parity/integration | Python resource collision小修正、TS/Python fixture、D2 clientへshared gate接続、manifest更新 | 同candidate標準検査、両実adapter結果／atomicity、B3/B4前の実driver gate |

T1で一部methodだけ新plan、残りだけkeepaliveというproduction混在を完成扱いしない。有限tableの全methodを移した時点でT2を統合する。bootstrapの既存r3 prepare/execute/ackはすでにoutside validation＋exact CASなので、repository plannerへ無理に吸収せずW1b authority hookだけを接続する。

## 10. 追加の有限検証matrix

- WebCrypto／PDF inspectionを意図的に待たせてもRW transactionが開いていない。待機中に別tabが編集でき、旧planはCAS missから同固定requestを再検証する。readonly capture中もcryptoをawaitしない。
- point absenceへ相手がinsert、queryへ相手が新batch/publication/historyを追加、receiptを更新、intentを入替、controlをfreezeする各競合。古いsnapshotでblind overwriteしない。Library/namespace外の変更だけで無関係CAS失敗にしない。
- commitとpublishの同batch再送、同ID異payload、同item別publication、二tabの相反history、逆batch／pending upload／importedBy保全。root/content/batch/projection/history/receiptの一部だけが耐久化しない。
- read(target)／resourceMetadata／Ink strokeでresourceBytes accessゼロ。readResourceは一つのmetadata/hashのみ。dataset検証はmanifest指定のresourceだけ。無関係account/library BLOBのread/cloneゼロ。
- resource hash同key異bytes、metadata既存bytes欠落、別resourceId同bytes、同ID異metadataをTS/Pythonで同結果・無変更。bytes検証中に差替えられたらCAS拒否し、hashだけ同じと信じない。
- source/target epoch transitionのreadset、pending intent増加、resource変更、freeze、checkpoint marker競合。通常local host authorityではstage/control applyを最初から拒否する。
- delivery境界を個別に検査する：(a)native attempt前の失効、(b)送出後oncomplete前の結果不明、(c)確認済みnative abort、(d)CAS writeゼロ後の失効、(e)oncomplete→Core success返却→outer gate失効、(f)HTTP耐久成功応答parse→outer gate失効。e/fはouter facadeがunknownへ正規化し、c/dもCore確定拒否としてintentを削除しない。各caseで同operationの証拠・固定payloadを保持し、新leaseへ旧operationをrebindしない。retry exhaustionは全attemptの書込みゼロ／未確定attemptの有無を照合する。
- readResourceのhash完了後かつouter gate disclosure前に失効させ、旧metadata/bytesの公開ゼロを確認する。native失敗のreasonだけからCore validation abortedを推測しない。
- 同じshared gate testをbrowser credential hook／native credential hookへ適用。旧operationが新leaseへ再bindされない、close後復活しない、取得signalの後abortはadmitted I/Oを壊さない、dirty close拒否後も編集可能、locked form/registry identityを保持してexact再入できる。

source/hash、実IDB/SQLiteかmemoryか、権限fakeか実grantか、fixtureか通常entryかを各証拠へ記す。全体完了、provider対応、M6移行済みという報告へ本slice成功を拡張しない。

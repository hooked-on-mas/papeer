# 通常起動接続の実装契約：local-ownerから共通Libraryへ

2026-10-27、Astra設計。実装はGPT 6.1 Terra、独立レビュー・実行はSol。本書は[canonical bootstrap設計](shared-app-canonical-bootstrap-design.md) r2–r5を次の有限差分へ落とす設計案であり、source統合・レビュー承認・通常起動成功を表さない。r3の固定intent、r4のprofile来歴、r5のnamespace/provider分離を維持する。旧版互換のための二重経路は作らない。全M0–M6／67要件の完了条件は[計画](shared-app-plan.md)のままである。

## 1. 起点と今回の到達点

確認した実sourceでは、`DocumentLibraryBinding`はdocumentId必須、`LibraryContentConnection`がReact内部で`ContentNavigationSession`を作り、navigationも実UUID必須である。`mountDesktopApp()`／`mountWebApp()`の引数なしはlegacyを起動する。`startGuardedApplication`はholdの初回検査を行うが、canonical admissionは持たない。`SqliteCanonicalInitialization`／共通intentは実sourceにあり、bootstrap用の実host lease・HTTP routesはまだ接続されていない。既存`/api/edits`のbearer認証と呼出側scopeだけでは、r5のnamespace grant検査にならない。

調査起点証拠は `output/shared-app-bootstrap-sqlite-scope-summary-r1.json`（source92、SQLite focused17／backend161）。fake OWNER leaseによる証拠である。設計凍結時のRoot連絡では、Web provider＋fixtureはsource113へ正式統合済みで、Sol実行はapp/node/testsの型検査成功、E2E型5エラーの修正待ちである。本書は標準検査完了や通常entry成功を主張しない。`output/shared-app-bootstrap-indexeddb-draft/`自体をactual sourceの証拠へ読み替えず、統合後candidateの報告を参照する。IDB統合完了とlocal grant/schema gate完了は別条件である。

今回の有限到達点は、**両hostの引数なし通常entry → hold → 明示された端末local context → 名前付きLibrary作成または選択 → 文書未選択の共通shell → 既存作成・閲覧・編集 → cold reload回復**。Google未接続でも成立させる。クラウド接続ボタンを成功扱いのstubで埋めない。provider/cacheの入口は後述の同じ継続計画で実装するまでadmitしない。

## 2. authorityと所有者

| 値・寿命 | 正本と所有者 |
| --- | --- |
| namespace利用許可 | hostが検証した端末grant。accountIdはopaque namespaceでありGoogle subjectではない |
| 現active epoch | `DatasetControlRecord.active`。profile、receipt、最新日時、選択stateから決めない |
| Library名／来歴 | 既存`CanonicalLibraryProfile`。originとinitializationの不変性はr4どおり |
| 作成要求と結果 | 既存`CanonicalLibraryInitializationIntent`とprofileの不変受理証拠。BootstrapSessionは配送と表示のみ |
| 内容／履歴／pending／draft | `ContentRepository`、`DocumentEditSessions`と既存draft ports |
| Library一覧・検索・作成 | `sessions.getLibrary()`の既存`LibrarySession`／query |
| 文書選択・citation・back | 既存`ContentNavigationSession`一つ。bootstrapは文書IDを別stateへ複製しない |
| 起動操作・候補・取消 | 新`BootstrapSession`一つ。メモリ寿命のみ、選択永続storeなし |

BootstrapSessionはhost mountがReact render前に一回作り、scope runtimeを一個だけ所有する。React StrictModeやlayout remountは購読の付け外しだけを行う。scope runtimeはrepository、registry、replication、ink settings、reader state、navigationとhost close handleの一組であり、同scopeの第二registry／navigationをview側に作らない。

## 3. 先行する最小local grant/schema gate

### 3.1 保存する範囲

次のhost-local recordをcanonical SQLite／同じcanonical IDBに追加する。TS/Pythonの共通schema・fixture・storage upgradeを独立差分にする。既存profile／intent schemaを変更したことにしない。

```ts
type CanonicalLocalOwnerGrant = {
  version: 1;
  kind: 'local-created';
  contextId: Id;
  namespaceId: Id;
  revision: Id;
};
```

この一行がlocal contextとその初回namespace provisionの耐久証拠を兼ねる。hostが決めた単一primary-local-context keyで一意に保存し、contextIdとnamespaceIdを同transactionで生成・保存する。別々のcontext行とgrant行を必要としない。二tab／二requestの敗者は勝者の完全な行を読み直す。既存行が壊れていれば再生成しない。namespaceの各Libraryとnamespace単位peerはこの後に既存契約で生成する。Google subject、最後のaccount、選択Library、active epoch、credential、全Library許可配列はこの行に入れない。

新規schema provision／upgradeは明示「この端末で始める」「このブラウザで始める」でのみ実行する。既存grantのcold reload読出し、候補discovery、hold確認はreadonlyで、DB未存在・旧schema・破損・blocked・I/O失敗を区別する。旧schemaのupgradeと旧canonical metadataのadoptionを混同しない。既存control/profileがあっても新grantをそのnamespaceへ自動付与しない。根拠付きadoptionはr4の専用工程であり、根拠がなければ復旧表示に留める。

初回provisionだけはnamespace-owner leaseをまだ要求できないため、hostの固定local-context権限（Webの当該origin保存域、PCの認証済み固定保存域）でschema準備とgrantを保存する専用操作にする。callerの仮accountIdからfake owner leaseを作って既存初期化APIへ流さない。IDBのschema upgradeとgrant保存が別transactionになる場合、schemaのみの停止はsetup未完の正常状態で、次の明示provisionが同keyで完成させる。grantのcontextId/namespaceIdは一transactionで不可分、Library物はこの時点で作らない。

これは一台のlocal所有を定義する有限契約であり、ユーザー登録、パスワード、汎用account registry、任意namespaceへのgrant編集UIは作らない。grant／peerはdevice metadataとしてbackup対象を識別するが、他端末へのimportで所有許可としてコピーしない。初期版では一local context一namespaceを扱い、既存namespaceを利用者入力で選ぶAPIは設けない。

### 3.2 Webで何が許可の根拠か

Webのlocal所有は、**当該browser profile・originの保存域を利用できる人に、その保存域で明示provisionしたlocal Libraryを許可する**製品規則である。Google本人確認、同一端末内の別人識別、OS userをWebから証明する規則ではない。画面は「このブラウザに保存」と示す。

driverは固定DB名の当該originのreadonly接続から上記grantを検証し、新しいメモリgenerationのHostLeaseを発行する。contextIdは対応付けのIDであり秘密鍵ではない。呼出側が渡すcontextId/accountId文字列やlocalStorageの「最後のaccount」からleaseを作らない。初回provision操作では保存済みrowとcommit結果の一致を確かめてからleaseを発行する。cold reloadは同じgrantを読み、新leaseで再admissionする。storage消去は新しい保存域であり、旧namespaceの権限を復元しない。

Web leaseはdriver内部のclosure／非公開token registryで真正性を検査し、構造が一致するオブジェクトを認可しない。これはアプリの混同を防ぐ境界であり、同originの任意スクリプトに対する秘密境界ではない。失効／versionchange／closeでgenerationを無効化し、進行中write transactionをabortできる時点ではabortする。commit済み結果は消さず、旧generationへ公開しない。

### 3.3 Desktopで何が許可の根拠か

PCは、既存のOS利用者のアプリ保存域、native bootstrapから得たsidecar接続設定、現sidecar bearer認証をlocal-deviceアクセスの根拠に使う。bearerはここではlocal API証拠であってDrive account証拠ではない。root path／namespaceをHTTP callerに自由指定させない。既存token必須・loopback公開・origin許可の設定を維持し、auth無効development modeは本番認可gateの証拠から除外する。

serverがgrantを読み、process generation＋grant revision＋固定保存域に束縛したopaque leaseIdをメモリ発行する。再起動後は古いleaseIdを無効とし、同じdurable grantから新leaseを得る。leaseIdはbearerの代わりにならない。各HTTP requestでbearerとleaseIdの両方を検査する。`SqliteCanonicalInitialization`へはserver内で作ったleaseを渡し、その`guard()`はcommit終了まで有効性を保持する。scope/profile/intentのaccountIdをserverがleaseのnamespaceと照合する。

`/api/edits`の既存repository factoryも同じ認可を通す。bootstrap routesだけguardして、`/read`、`/pending-*`、`/dataset-control`、resource、commit、install、replace等に任意scopeで入れる裏口を残さない。control transition／stagingに必要な特権は既存transition工程に限定し、通常編集leaseへ汎用install権限を与えない。legacy backup/migrationの明示管理経路は別目的の既存guardを保持し、一般のLibrary編集から呼べない。互換fallbackとして「leaseIdなしなら昔どおり」は採用しない。

### 3.4 将来のLibrary単位capabilityを潰さない最小API

`CanonicalPrincipalLease`の既存accountIdフィールドはnamespaceを表す。内部owner storageは当面owner専用と明記し、provider leaseを同interfaceへcastして`list(accountId)`に通すことを禁止する。hostで認可済みのfacadeを作り、共通側はraw storageとleaseを組み合わせない。

```ts
// 発行と真正性検査はhostのみ。serialized bool/配列はcapabilityにならない。
type HostLease = OpaqueHostLease;
type LibraryHandle = OpaqueLibraryHandle; // 現discoveryが発行した対象。UIへraw namespace列挙しない
type LocalContextResult =
  | { status: 'ready'; lease: HostLease }
  | { status: 'setup-required'; reason: 'absent' | 'schema-upgrade' }
  | { status: 'recovery-required'; reason: string };
```

HostLeaseの内部capabilityは`namespace-owner`または将来の`library-bounded`。今回の発行実装は前者のみ。共通側は`canCreateLibrary`というUI案内を受けられるが、実際のcreateはhostでもownerを検査する。後者の正式schema・discovery query・全対象検査が完了するまでprovider-cache leaseは発行しない。LibraryHandleはidentityを隠すだけのセキュリティ対策ではなく、毎operationで元lease/grant/対象を再検査するためのハンドルである。

## 4. scope-only bindingと空Library

`features/reader/DocumentLibraryBinding.ts`を次の狭い分割にする。構成値は既存型を使う。

```ts
type LibraryScopeBinding = {
  repository: ContentRepository;
  sessions: DocumentEditSessions;
  replication: EditReplication;
  inkSettings: DocumentInkSettings;
  readerState: ReaderStatePort<SavedReaderPreference>;
};
type DocumentLibraryBinding = LibraryScopeBinding & {
  documentId: string;
  catalogVersion?: string;
};
```

`assertLibraryScopeBinding`は既存の五port scope一致を検査する。`assertDocumentLibraryBinding`はそれに実targetの検査を追加する。`LibraryContentConnection`、`LibraryCatalogPanel`、`AnnotationBrowserConnection`、Library側comparisonなど、documentIdを使わないconsumerをscope型へ移す。Reader／Markdown／Attachmentの実content描画時だけdocument型を作る。ダミーUUID・空文字・libraryIdをdocumentIdに代入しない。

`LibraryContentConnection`にはscope bindingとruntime所有のnavigationを渡す。既存の`useMemo(new ContentNavigationSession)`とdocumentId入りroot keyを除去する。keyはruntimeの不変scope寿命であり、文書を切り替えてもcatalog/registryを再作成しない。実content subtreeは従来どおりtargetで切り替えてよい。

既存の`mountDesktopApp({ documentLibrary })`／`mountWebApp({ documentLibrary })`注入試験は維持する。この明示composition branchだけは受け取った実documentIdをnavigationの初期targetに使い、同じscope shellへ接続する。新通常branchは引数なしでBootstrapSessionを起動する。scopeとdocumentの型分割によって、既存のReader fixtureにダミーのstartup principalやdocument選択手順を追加させない。注入branchは実host admissionの証拠には数えない。

`ContentNavigationSession`を拡張し、constructorとstateの`documentId`を`string | null`にする。nullは正当な「まだ資料を選んでいない」であり、backのentryは引き続き実document IDだけである。最初はnull、citationなし、back空。nullから最初のopenでは現在document guardを要求しないが、available/isActive、catalog membership、kind／resource、head選択、世代検査は全て行う。sourceがnullならbackへ追加しない。実documentがあるのにguardが欠落する現状の`current-unavailable`規則は緩めない。`openCitation`／deleted／annotationも同じnavigateを使う。

ready shellは既存`LibrarySession.refresh()`の結果を表示する。uniqueな有効catalogに利用可能資料がなければ`emptyLibrary`表示と作成UI、資料があれば未選択案内を表示する。削除済み資料や複数headは空dataset扱いしない。catalog conflictは既存head selectorへ渡し、先頭headを選ばない。nullの間にkind resolver、PDF load、document sessionのclaimは起動しない。catalog panelはnull時に一覧・作成導線が見える初期表示にする。作成後も実際に受理されたitemIdだけを既存navigationで開く。

空shellは「資料未選択」から選択を行えるので文書chooserを別作成しない。Library chooserは複数Libraryだけの特例でなく通常の明示選択入口で、既存一件でも勝手に先頭を選ばない。明示作成の成功時にはその要求のLibraryを開いてよい。選択Library／文書の永続preferencesは本sliceに追加しない。

## 5. host driverとBootstrapSessionの公開契約

型名は既存配置規約へ合わせてよいが、操作・結果の意味は固定する。`InitializationOutcome`と固定requestは既存Core型を再利用する。

```ts
type BootstrapDiscovery = {
  libraries: readonly { handle: LibraryHandle; title: string;
    status: 'available' | 'recovery-required' | 'frozen'; reason?: string }[];
  creations: readonly { requestId: Id; title: string;
    outcome: InitializationOutcome }[];
  canCreateLibrary: boolean;
};
type ActiveLibraryProof = OpaqueActiveLibraryProof;
type ScopeResources = {
  repository: ContentRepository;
  markdownDrafts: MarkdownDraftPort;
  markdownImages: MarkdownImagePort;
  appendDrafts: NoteAppendDraftPort;
  readerState: ReaderStatePort<SavedReaderPreference>;
  peerId: Id;
  close(): Promise<void>;
};
interface BootstrapHostDriver {
  readHold(signal: AbortSignal): Promise<unknown>;
  readLocalContext(signal: AbortSignal): Promise<LocalContextResult>; // readonly
  provisionLocalContext(signal: AbortSignal): Promise<HostLease>; // 明示操作
  discover(lease: HostLease, signal: AbortSignal): Promise<BootstrapDiscovery>; // readonly
  initialization(lease: HostLease): OwnerInitializationFacade;
  inspect(lease: HostLease, library: LibraryHandle, signal: AbortSignal): Promise<ActiveLibraryProof>;
  openScope(proof: ActiveLibraryProof, signal: AbortSignal): Promise<ScopeResources>;
  revalidate(proof: ActiveLibraryProof, signal: AbortSignal): Promise<void>;
  subscribeInvalidation(listener: () => void): () => void;
  close(): Promise<void>;
}
interface OwnerInitializationFacade {
  getOrCreatePeer(signal: AbortSignal): Promise<CanonicalDevicePeer>;
  prepare(request: CanonicalInitializeRequest, signal: AbortSignal): Promise<InitializationOutcome>;
  query(requestId: Id, signal: AbortSignal): Promise<InitializationOutcome>;
  execute(requestId: Id, signal: AbortSignal): Promise<InitializationOutcome>;
  acknowledge(requestId: Id, signal: AbortSignal): Promise<void>;
}
```

facadeは既存`CanonicalInitializationStorage`の薄い束縛wrapperであり、第二intent storeではない。candidate peer IDの生成はfacade内で一回行い、storageのunique winnerを返す。requestIdの照会もleaseのnamespace／権限をhostが限定する。provider-bounded capabilityにはこのowner facadeを渡さない。

`inspect`はprofile、現control、active installed manifest、peerを認可targetからreadonly取得し、Coreで検証したexact値に結び付くproofを返す。proofには内部でgrant revision/generation、identity、profile revision/remote、control id、active manifest id/scopeを固定する。UUIDをcallerが渡しただけのproof、検証済みboolは禁止する。`openScope`はそのscopeで既存host adapterを構築するだけで、初回schema生成やinitializeを行わない。`revalidate`は同tuple・hold・leaseを再照合する。

scope構成の共通側は`ScopeResources`から既存`DocumentEditSessions`、`DocumentInkSettings`、`ContentNavigationSession`、`EditReplication`を一組作る。host adapterにUIやeditor commandを入れない。PCは`createDesktopEditRepository`、Webは`IndexedDbEditDatabase`＋`DurableEditRepository`を使う。既存browser draft／Reader portsは固定scopeで再利用できるが、host grantを照合したwrapperと保全対象として扱う。PCのdraftがbrowser localStorageにある現実をSQLite保存済みと表示しない。device backup／M6のfootprintへ含める課題を残す。

local replicationは構築直後にsuspendし、transferの全methodは`remote-unconfigured`を明示拒否する。suspendedな`flush()`が完了しても同期成功表示にしない。UIは「この端末に保存／同期先未設定」。scope resourceを補うための偽pull空配列や偽upload成功は作らない。provider実装後のtransferは別leaseとr2/r5 barrierを通してのみ有効にする。

```ts
type BootstrapState = {
  phase: 'idle' | 'checking' | 'setup-required' | 'choosing' |
    'creating' | 'opening' | 'ready' | 'recovery-required' | 'closed';
  discovery: BootstrapDiscovery | null;
  creation: null | { requestId: Id; title: string;
    stage: 'preparing' | 'unknown' | 'pending' | 'accepted' | 'rejected'; reason?: string };
  error: string;
};
class BootstrapSession {
  getSnapshot(): BootstrapState;
  subscribe(listener: () => void): () => void;
  start(): Promise<void>;
  provisionLocal(): Promise<void>;
  refresh(): Promise<void>;
  createLibrary(title: string): Promise<void>;
  recoverCreation(requestId: Id): Promise<void>;
  acknowledgeCreation(requestId: Id): Promise<void>;
  openLibrary(handle: LibraryHandle): Promise<void>;
  returnToChooser(): Promise<ScopeLeaveResult>;
  cancelPendingView(): void;
  getActiveRuntime(): LibraryRuntime | null;
  prepareClose(): Promise<ScopeLeaveResult>;
  close(): Promise<ScopeLeaveResult>;
  setPageAvailable(available: boolean): void;
}
```

`LibraryRuntime`は上記binding＋navigation＋停止handle。readyだけで取得でき、BootstrapStateへdocumentIdやcatalog snapshotは複製しない。stateはimmutable snapshot。非同期操作ごとにgeneration/AbortControllerを捕捉し、全await後・state公開直前に照合する。cancelは画面遷移の取消であり、作成intent取消や耐久結果削除ではない。二重clickは同flightへ収束させ、同要求を再生成しない。読み取り失敗を`libraries: []`へ変換しない。

## 6. admission、作成、cold reloadの手順

1. `main.tsx`／`web/main.tsx`のhold gateを最初に維持する。hold不明／失敗／ありではlegacy writerもcanonical writerもimport／起動しない。driverの安全なreadonly部だけを使う。
2. 引数なしmountがhost driverとBootstrapSessionを作り共通`BootstrapConnection`を描画する。local contextが未provisionなら明示setup、既存ならreadonly discoveryへ進む。既存候補のprofile欠落／部分破損は復旧項目とし、空Libraryを自動作成しない。
3. Library選択で`inspect`を行う。activeなし、frozen、identity不整合、installed manifest不一致は開かない。rolled-backでも有効なactive sourceなら開ける。receipt.initialScopeをactiveへ代用しない。
4. exact scope resourcesを構築し、replication停止、registry.initialize、library.refreshを順に行う。recovery不成立なら編集viewなしの回復表示。複数headは通常の競合UIを含むshellとして開ける。未解決intent／draftは既存registryが所有し、隠れたtargetも回復する。
5. view公開直前に`revalidate`でlease/grant、hold、profile revision/remote、control id、active scope/manifestを再読する。不一致ならcandidateを閉じ、chooser再読または理由付き復旧へ戻す。旧candidateのscopeを書き換えない。manifestはimmutable installationとの一致を検査し、編集後の現checkpointを初期hashと比較しない。
6. ready shellを公開してnavigationを利用可能にする。通常entryから既存UIの実作成・選択で文書を開く。remote設定の有無はlocal-owner編集権限を変更しない。ただし未実装provider linkは同期を停止したまま明示表示する。

明示createはowner facadeでpeer取得を完了後、共通のpure request builderでtitle、peer、requestId、libraryId、epoch、root/version、manifest/checkpoint/object IDを一度固定する。builderは既存validator/hash/publicationを使い、UIとhostで別々の要求を生成しない。

`prepare`のdurable acknowledgementまでは`execute`しない。prepare応答消失は同payload prepare／同ID queryで確定する。executeは保存済みrequestIdだけを渡し、accepted／definitive rejectedは既存transaction契約に従う。一時失敗／timeout／取消はunknownとして保持し、新IDでretryしない。acceptedでも最新proofを取得して通常admissionを経る。取消／世代変更後のacceptedは保存に残し、自動mountしない。

結果表示の後だけack可能とする。accepted ackはprofile証拠の照合後にintentを除去、rejected ackは同ID予約を保持する。ackが失敗してもreceiptを再実行してLibraryを作り直さない。再起動でpending／未ack結果をdiscoveryに復元し、名前付き「作成結果を確認」操作から同ID query／executeする。discovery自体ではexecuteしない。prepare未commitならLibrary executeは開始していないため、新たな明示作成は可能である。

## 7. 切替・close・外部失効

既存`DocumentEditSessions.suspend()`は拒否時にactiveを維持する。この性質を壊さない。文書のguardは既存navigationへ`prepareScopeLeave()`を追加し、現在登録済みの`prepareClose`／`canClose`を同じregistration/generationで確認する。null targetは文書guard不要である。

Library catalogの未送信form値は現在React stateにある。registryの既存離脱判定へ、小さな`registerLeaveGuard(owner, canLeave)`を追加し、Library名変更、tag/folder/relation/bibliography入力、新規資料の入力途中等を同期blockerとして登録する。`needsExitConfirmation`、`prepareLeave`、suspendのawait後最終検査が同じblockerを見る。cleanupはそのownerだけを解除する。これはUIの未確定入力保護であり、内容sessionや永続journalの追加ではない。入力を暗黙破棄してcloseを許可しない。

自発的なLibrary切替／chooserへ戻る／logout／アプリ内closeは、(a) navigationのcurrent guard、(b) registry.suspend成功、(c) replication.suspendAndWait、(d)旧view・購読・transportを停止、(e)scope DB handleをclose、(f)次lease/contextへ進む、の順。各await後の世代検査を行う。拒否時は旧runtimeとpayloadを保持し、chooser／credentialを先に交換しない。耐久済み未送信outboxだけなら切替を妨げず元scopeへ残す。next admission失敗時は新scopeを表示せず、保存済み旧scopeは再admissionできる。

外部失効／pagehideでは自発的suspendの拒否待ちをして新編集を続けない。registryへ同期`deactivateForHostLoss()`を追加し、active=false、新入力・新commandを停止するがdraft/session/pendingを消さない。navigation unavailable、replication suspend、transport abortも同期開始する。既にcommitした結果は保持し、結果不明も元scopeに残す。復帰は同grantの新proofを検証してから既存registry.resumeを使い、別namespaceへ付け替えない。authorization loss時の画面は内容を公開しないlocked状態とし、旧runtimeは回復のためメモリ保持する。

**locked時のReact入力寿命:** registry blockerを残すだけではform本文を保全できない。BootstrapConnectionは一度公開したscope subtreeと同じkey／form ownerを、外部失効時にもunmountしない。内容のあるsubtreeを非表示・inert・アクセシビリティtreeから除外し、内容を含まないlocked案内だけを表示する。同時に上記available/active=falseとhost I/O失効を適用し、隠れたsubtreeの入力・command・新規queryも停止する。`getActiveRuntime()`がready以外でnullでも既存subtreeを条件renderで消さない。保持するのはそのscopeの既存React form stateであり、第二のwriter／form永続storeは作らない。

同一identity／epochのexact proofを新leaseで再確認した時だけ同subtreeを再表示する。epoch変更等で再admissionできなければlockedのままpayloadとownerを保全する。未確定formを持つlocked subtreeを新scopeへ再利用したり、別scopeを開くために破棄したりしない。自発的closeが許可されるか、再認可後に利用者が既存formの確定／取消を行うまでscope closeへ進めない。これは同process内保全であり、browser強制終了で未耐久React入力が永続化するという主張ではない。Solは「空shellでform入力→外部失効→非公開locked→exact再入→入力値・owner・guard復元」を検査する。

pagehide/BFCacheではcloseを完遂したと扱わない。browserイベントはasync離脱を保証しないため、beforeunloadはregistry＋未確定bootstrap操作の同期guardを使い、durable intent/draftを回復源とする。pageshow persistedは再admission後に同runtimeを再開する。React effect cleanupからBootstrapSession.closeを呼ばず、実host/window寿命だけが最終closeする。未保存拒否を無視する通常`forceClose`は追加しない。

## 8. 実装差分の順序とファイル境界

| 順 | Terraの有限差分 | 次へ進む条件 |
| --- | --- | --- |
| B0 | 隔離IDB providerの独立レビュー修正・正式統合。既存intent/storage意味を維持 | Solの同candidate実IDB fault／並列と必要標準検査。actual sourceとの差を記録 |
| B1 | local grant schema＋fixture、SQLite/IDB readonly context／明示provision、host lease、全canonical I/O guard | 実bearer PC／実origin Webで認可・cold reload・二tab収束gate。owner fakeのみでは不可 |
| B2 | scope binding分割、nullable navigation、emptyLibrary shell、既存registryへUI離脱guard／外部失効停止 | 両host共通UIで空→実資料作成→選択、現在のReader操作回帰。単独fixture段階と明記 |
| B3 | `features/bootstrap`のBootstrapSession／Connection、共通固定request builder、host driver二種 | 固定要求unknown/retry、admission競合、停止・切替のunit＋実adapter統合 |
| B4 | 引数なしPC/Web mountとmainを共通bootstrapへ切替。canonical branchのlegacy importsを除去 | 通常entryの無注入E2E、R29 trace、両hostの保存・reload。既存実データの移行は別M6 gate |
| B5 | r5 provider grant/descriptor/link schema→bounded queries/全operation認可→Drive linked barrier→別端末join | 次節P1–P3の独立gate。B4の完成を全体完了にしない |
| B6 | provider-cache cold offline、残M4/M5、M6全領域変換・移行・旧責務撤去・実機 | 全67要件の必要証拠を揃えるまで継続 |

表の番号は統合依存の整理であり、B1完了までB2の実装を待つ意味ではない。**直近のTerra差分はB2（scope binding／empty shell／nullable navigationとguard）だけでよい。** 既存注入bindingを保持した有限差分として独立レビューできる。B1のhost grant設計・隔離実装は別差分で進め、B3／B4の実host接続前に必ず統合・検証する。Sol実行中のactual sourceは凍結し、出力案からの正式統合はRootが指定するcandidate境界で行う。

想定配置は`features/bootstrap/{BootstrapSession,BootstrapConnection,bootstrapPorts}`、共通pure request builderは`runtime/edits`、host driverは`adapters/{desktop,browser}`。Pythonではlocal grant/lease factoryとbootstrap routesを狭いmoduleへ分け、`sidecar/routes/edits.py`のrepository生成に対象guardを接続する。bootstrapのためにReaderや全app機能を新controllerへ移植しない。

`DesktopApp.tsx`のstatic legacy `App` importと`App`内のlegacy import graphもB4の検査対象。共通canonical mountは直接BootstrapConnectionと既存host render adapterへ到達させる。`WebApp.tsx`の引数なしDriveSession／OfflineLibraryStore／LegacyWebConnection分岐は通常entryから除去する。明示binding注入branchは上記の既存試験用として維持するが、引数なし通常起動を隠れたfeature flag／`window`注入へ依存させない。

legacyデータが残る保存域で「新しい空Libraryしかない」ように見せて旧内容を放置しない。既存hold/inventoryのreadonly証拠から、移行が必要な保存域は明示移行／復旧導線へ送る。検出不能も未確認として止める。B4の実画面gateはclean／正当なlocal-provision済み保存域であり、既存全データ切替の完了はM6が所有する。legacy writerへの自動fallbackを作らない。

## 9. Solの有限gate

| gate | 必須確認 |
| --- | --- |
| L1 local proof | Googleなし、実bearer/正規originでprovision→二tab／二requestの同namespace・同peer収束→cold reload。無token／偽lease／旧generation／任意namespace／schema不足／壊れたgrantを無変更拒否。discoveryでcreate/upgradeゼロ |
| L2 認可対象 | bootstrap以外もread/control/intent/resource/commit/stageに同guard。未認可namespaceの名前・件数・BLOB・診断ゼロ。owner-only facadeへのprovider型偽装拒否。grantがない既存canonicalへ自動昇格ゼロ |
| S1 shell | nullでdocument session取得／resolver／PDF loadゼロ。空catalog→Markdown／paper作成→実ID選択。attachment/PDF通常import導線。複数head・全削除・壊れたcatalogを空扱いしない。view remountでregistry/navigation各一個 |
| S2 guard | 空shellのform入力、dirty Markdown、Ink gesture、非表示draft、unknown commitで切替／close拒否。許可後の停止順。pagehide中の後着結果非公開、BFCache再admission、旧cleanupが新guardを解除しない |
| I1 intent | prepare前／commit後ack前／execute前／Library commit後response前／表示後ack前の停止→同request/digest/IDの回復。固定payload変更拒否、accepted ack後receipt、rejected予約、同request二tab、peer-only正常／部分Library破損拒否 |
| A1 admission | discovery→inspect→initialize→mount間のhold/control/profile/grant変更、取消、DB close。旧scope mountゼロ。rolled-back active、activeなし、frozen、欠落manifest、receipt後epoch変更。編集後checkpointを初期hashで誤拒否しない |
| N1 通常入口 | mount引数／window binding注入なしのPC/Web entry。名前作成→一覧→PDF/paper/Markdown→編集・Undo/Redo・保存→process/page cold reload→同Library再選択→内容／履歴／draft/pending復元。local同期未設定表示、remote成功traceゼロ |
| N2 graph/標準 | Chromium/WebKitのPC/Web通常mount trace、legacy writer/recovery importゼロをR29へ紐付け。変更に対応した型4project/lint/unit/boundary、TS/Python generator適合、両build、台帳検査。実機未実行は別記 |

各実行はcandidate source/hash、host/browser、実adapterかfakeか、通常entryかfixtureかを記録する。B1–B4が通る前に通常entry完了へ昇格しない。既存source92／Reader source74の成功件数を本接続の証拠へ足さない。

## 10. r5と全体目標へ続く未達gate（削除しない）

| 次のgate | 具体成果物・終了条件 |
| --- | --- |
| P1 provider schema／認可 | provider-cacheはnamespace+library+subject+descriptorに限定。local linkもverified subject/descriptor ID/hashを保存。remote descriptor不変・同folder一意、local grantとprovider grantの衝突無変更拒否。TS/Python schema・SQLite/IDB同fixture。N内L1=A／L2=private/BでAがL2の名前・件数・本文・pending・resource・診断を取得できない |
| P2 link／barrier | local-owner lease＋現Drive subject leaseで明示link。namespace/IDs/hash不変。r2の固定publicationを毎linked admissionで検証／再公開。profile CASだけでresumeしない。旧folder/subject/descriptor完了を拒否。初期publication後に通常records/resource転送 |
| P3 join／再入 | 別端末Aがdescriptor→manifest→import/activation＋r4 profile＋library-bounded grantをatomic導入。同namespace・別peer。既存local/B所有への権限注入拒否。A→B→AでAのcache/名前/pendingをBへ漏らさず、local原本はGoogle logout後も保全 |
| O1 provider-cache offline | A本人が事前付与するdevice-local offline grantと再起動後local unlock規則を設計・実装・検証。保存subject／最後のaccountだけでは許可しない。通常local-owner cold offlineとは別gate |
| F1 残M4/M5／実機 | [引継ぎ書](shared-app-handover.md)・67要件の未達機能、preferences、input/OS serviceと実機matrixを更新しながら完遂。恒常的capability=falseで共通化を完了扱いしない |
| M6 migration | 全領域inventory/backup、全参加writer停止、非空変換・resource検証、r4 atomic profile attachment、Drive公開／rollback、実ユーザーデータ切替の明示工程、旧writer/recovery/責務撤去。local grant/peer/draftの端末帰属を保全 |

これらは今回の実装を無期限保留する理由でも、捨てる要件でもない。B4後はP1→P2→P3へ進み、O1/F1/M6を引継ぎの未完チェックとして維持する。設計文書を追加しただけではaccepted数や実装checkpointを変更しない。

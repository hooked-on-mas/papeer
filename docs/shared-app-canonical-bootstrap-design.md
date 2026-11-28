# 既存canonical datasetの通常起動接続

2026-10-27、Astra設計案。参照sliceのgate後にTerraが実装し、Solが検証・独立レビューする。startup/binding/controlの既存interfaceを読んだ方向設定であり、コードレビュー承認・実行証拠ではない。全領域移行、実ユーザーデータ移動、既定legacyの全面切替は本sliceに含めない。

## authorityと現在の接続点

- `main.tsx`／`web/main.tsx`は`app/startup.ts`の`LegacyMigrationHold`確認後、引数なしでhost mountを呼ぶ。holdなしは移行完了・canonical採用の証拠ではない。holdはそのまま最優先で維持する。
- epochの正本は`DatasetControlRecord.active.scope`。identityは`accountId + libraryId`、epochはそのactiveからのみ得る。`datasetAccess`がfrozenなprepared/published、activeなし、不正recordは編集起動不可。rolled-backでもactiveが有効ならそのsourceを使う。installed manifest、最新日時、checkpointの存在だけでactiveを選ばない。
- `activeDatasetScope()`は既にあるが、呼出し前にidentityを決める必要がある。control schemaはhostの選択中account/library、Drive folder、peer IDを所有しない。legacy Drive libraryのfile IDをcanonical library UUIDへ代用しない。
- PCは`createDesktopEditRepository`＋認証付きsidecarのcanonical storage、Webは`IndexedDbEditDatabase`／`DurableEditRepository`を使う。controlはSQLiteの`edit_dataset_controls`、IndexedDBの`datasetControls`にidentity単位で存在する。現在の個別読出しはscopeを必要とするため、未知identityの通常起動には狭い読出し入口が必要である。
- `DocumentLibraryBinding`は全portのscope一致と非空documentIdを要求する。初期文書を捏造せず、空Library／未選択を表示できる共通Library shellが必要。既存`ContentNavigationSession`とcatalogを使い、別navigation正本を追加しない。

## 採用案（Root承認済みの境界、下記r2で具体化）

既存control行を**readonlyに列挙**するhost adapterと、canonical Library選択画面を追加する。列挙は認可済みhost account/context内の既存保存域だけに限定し、別accountの候補・名前をUIや応答へ漏らさない。auth generationを捕捉して完了時にも照合する。DB未作成と読出し失敗を区別する。discoveryのために任意epochでrepositoryを作成してschemaや空datasetを生成しない。選択はメモリ内の起動要求であり、新しい永続startup store／feature toggle／active pointerを作らない。選択後にcontrolを読み直し、`assertDatasetControl`、`activeDatasetScope`と既存installed manifestの一致を照合する。

Rootはこのdiscovery＋chooser境界を承認した。既存の永続「選択中canonical identity」があると仮定しない。canonical候補がある場合は勝手に先頭を選ばず、認可されたcontext内のLibraryを名称で選ぶ。raw dataset／epoch IDを製品操作に出さない。名称の取得元も既存hostの対応付けで証明し、不明な対応は初期化不足とする。reloadも同じ通常入口から同一identityを再選択して同じdatasetを開く。自動選択の永続化は別のpreferences契約へ残す。候補なし・holdなしの既存legacy起動は維持するが、選んだcanonicalが不正／欠落／失効したときlegacyへ黙ってfallbackしない。

**認証・転送の不足はこの案で隠さない。** Drive accountは`DriveSession.bindAccount(accountId)`／PC `/api/edits/drive/lease`のpermissionId照合と既存generation leaseを使う。sidecar bearer tokenはローカルAPI認証であり、Drive account証拠ではない。folderIdとpeerIdはcontrolに入っていないため、Terraは既存host同期設定／migration peer記録からexactな対応を得られるかを実装前に列挙する。得られなければ推測ID・毎起動random peer・no-op転送成功を作らず、Rootへ不足portを返す。local/offline閲覧・編集を認める場合も、明示されたlocal利用として既存outboxを保持し、remote同期は同account leaseと転送先が成立するまで停止する。offline identity選択の扱いは既存account policyを確認し、Google認証済みと表示しない。

現在の認証からcanonical account/contextを導けない場合、必要なのは既存account連携／初期化の狭い読出しportである。全control走査やユーザーによるraw ID入力で代用しない。local/offlineも既存の認可contextが証明できる場合に限る。account対応、Library表示名、転送先、安定peerの不足は実装開始時に具体的なhost portとして確定し、未接続のまま通常起動成功とは報告しない。

## 起動と寿命

1. 既存hold読出しを完了する。未知／失敗／holdありは現在のretry可能な起動保留に残す。legacy store、legacy recovery、canonical writerを先にimport／起動しない。
2. hostがidentityを選択し、起動要求generationと取消signalを捕捉する。controlのid・active manifest id・scopeを保持し、非frozenであることを確認する。途中のaccount/library変更、pagehide、取消、旧非同期完了は起動できない。
3. active scopeだけでrepository、`DocumentEditSessions`、Markdown draft/image port、annotation append draft port、`DocumentInkSettings`、`BrowserReaderStatePort`、`EditReplication`を一組構築する。現在のscope付きadapterを再利用し、React viewのremountでregistryを作り直さない。replicationはadmission終了までsuspendする。
4. registryの`initialize()`で全pending/draftを回復し、catalogを既存LibrarySessionで読む。複数headは既存競合選択へ通し、先頭headを採用しない。Library shellを表示し、通常一覧から実IDを選んで既存kind解決→Reader/Markdown/attachmentへ渡す。`documentId`必須を偽値で埋めない。型はscope共通bindingと実target付きbindingの狭い分離でよい。
5. mount直前にgeneration／認証lease／hold／control idとactive scopeを再照合する。相違なら候補を破棄して再確認し、古いcandidateを最新scopeへ貼り替えない。manifest初期checkpointのhashを編集後の現checkpointと比較しない。resource実bytesは既存resource proofで検証し、activation検証を毎起動の全データ再hashへ拡大しない。
6. account/library切替・logoutは`DocumentEditSessions.suspend()`の成功後に`replication.suspendAndWait()`、旧view unmount／購読解除、旧transport取消、最後にcredential交換・DB closeを行う。拒否なら元scopeとpayloadを維持する。各await後のrequest世代照合を行う。外部失効では新操作／転送を止め、未確定内容と原accountのpendingを保持し、勝手に破棄しない。同account再入も新leaseで再検証する。BFCacheとview remountでregistryを二重起動しない。

初期化失敗・不正control・不足catalog/resourceは理由付き保留／復旧画面とし、自動initialize・新空Library作成・自動transition.resumeはしない。元raw記録を保持する。scope authorityは既存registry/control、起動generationは単なる非同期寿命とする。

## Terraへの最小作業とSol gate

変更候補は`app/startup.ts`、PC/Web entryとmount、hostのreadonly control discovery、既存control resolver、Library shell/binding型の分離、host scope composition factory。PCのdiscoveryが必要なら`sidecar/routes/edits.py`とcanonical storage読出しに限定し、生成schemaを更新する。入力hook／reference責務やdataset schemaをこのsliceへ混ぜない。

Solは次の有限matrixを同一candidateで確認する。

- 実SQLite／IndexedDBへ通常dataset install/control activationでfixtureを準備し、**引数なし通常entry**から選択→一覧→PDF／paper／Markdown→保存→reload→同identity再選択で同内容／履歴／pendingを復元する。runtime bindingをwindowやmount引数へ注入しない。
- controlなし、activeなし、prepared/published、rolled-back source、壊れたcontrol、失敗／遅延discovery、空Library、複数head、複数identityを区別する。epoch/control更新競合で旧mountなし。
- dirty／結果不明／非表示draftでlogout／scope切替拒否、許可後の停止順、account A→B→AでAのpendingをBへ送らない、旧lease/旧callback拒否。転送先未設定やofflineを成功同期としない。
- 両host・Chromium/WebKitの通常mount graphと実行traceをR29へ記録し、canonical採用中のlegacy writer／recovery起動なしを確認する。関連型・契約・標準検査を実行する。

実機matrix待ちでこの設計・実装を止めない。ただし未実機をacceptedにせず、全67要件の範囲を縮めない。全領域変換、参加端末/writer停止、backup、Drive公開・rollback、残るM4/M5機能とpreferences、全通常entry移行後の旧責務撤去はM6まで残る。本sliceの成功は「canonical化済みdatasetの通常起動接続」である。

## r2：不足が確認されたhost metadataと新規初期化の確定契約

追加のinterface棚卸しにより、account証明は存在するが、canonical Library名／UUIDとDrive folder／local peerの完全な対応付けは現存しないと確認した。上記の「Terraが既存portを探す」は以下で置換する。legacy IDや設定を無理に流用せず、有限の型付きmetadataを追加する。これは新しいstartup選択正本ではない。

### 保存する二種類のmetadata

```ts
type CanonicalLibraryProfile = {
  version: 1;
  revision: Id;                         // CAS用。epochではない
  identity: DatasetIdentity;            // real Drive permissionId + canonical UUID
  title: string;                        // 既存title規則、ユーザーが入力
  remote: null | { kind: 'drive'; folderId: string };
  origin: { kind: 'local-initialize' } | {
    kind: 'activated-installation'; source: 'import' | 'migration' | 'pre-metadata-adoption';
    controlId: Id; manifestId: Id; installedScope: DatasetScope;
  };                                    // 不変の来歴。現在epochのselectorではない
  initialization: null | {              // 新規initializeの不変受理証拠。旧controlへの名称設定はnull
    requestId: Id; requestSha256: string;
    initialScope: DatasetScope; manifestId: Id; peerId: Id;
  };
};
type CanonicalDevicePeer = {
  version: 1;
  accountId: string;
  peerId: Id;                           // この端末・accountで一回生成
};
```

profileはidentity単位、peerは端末内account単位。両方をPCの既存canonical SQLite保存域、Webの同じcanonical IndexedDBへそれぞれ専用table/storeとして置く。backup／移動のcanonical footprintへ含める。bearer token、認証generation、最終選択library、active epoch、文書選択を保存しない。peerはLibrary追加・epoch変更・logout／reloadで再生成せず、同一accountの複数tab作成競合をunique key＋transactionで一つへ収束させる。別端末へのデータ転送ではpeerをコピーしない。profileは現段階の端末の開くためのmetadataであり、Library名の端末間競合・改名同期は別途定義し、同期済みと表示しない。

TS/Python共通schemaへprofileとpeerを追加し、title・UUID・accountId・remote判別を同じfixtureで検査する。`DatasetControlRecord.active`だけがepochを決める。profileの存在／remote設定／名前をactivation証明にしない。profile/control identity不一致、不正profile、profileがあるのにcontrolなしは復旧状態であり、空Libraryを自動生成しない。

### hostの狭いport

host adapterに`getOrCreateCanonicalDevicePeer(principalLease, signal)`、`listCanonicalLibraries(principalLease, signal)`、`readCanonicalLibrary(identity, principalLease, signal)`、`initializeCanonicalLibrary(request, principalLease, signal)`、`linkCanonicalLibrary(request, principalLease, signal)`を設ける。実装名は既存規則に合わせてよい。これらは保存I/Oとprincipal束縛だけを担当し、Readerやeditorの意味は持たない。

- principalLeaseはWebの現在DriveSessionからpermissionIdを取得・固定したlease、PCの既存account証明＋generation leaseを用いる。hostが証明するaccountIdでfilterし、呼出し側が任意accountIdを指定して列挙できるAPIにしない。tokenを返さず、取消／auth失効はawait前後と公開直前に検査する。PCではsidecar token認証だけをDrive account証明に代用しない。
- discoveryは既存table/storeのreadonly transactionだけを使う。Webはreadonly discovery用openを分け、`onupgradeneeded`をabortする。DBなし／schema未準備は未初期化として返し、blocked／破損／権限失敗と区別する。schema作成・upgradeは明示初期化だけで行う。SQLiteもdiscoveryでrepository constructorやschema作成を呼ばない。現在の`IndexedDbEditDatabase`のupgrade可能openをreadonly discoveryへ流用しない。
- 表示するのは認可account内のprofile.titleと利用状態。raw UUID／epochを選択肢にしない。profileのない既存controlは「名前の設定が必要なライブラリ」として、同account・一意に確認したcontrolに対する明示名称設定を提供する。controlを列挙した順に自動採用せず、別accountを見せない。曖昧な旧Drive→canonical対応はこの経路でも推測しない。

このsliceの新規discoveryは現principalが証明できることを要求する。認証前や期限切れに、保存されたaccountIdだけで別accountの内容を公開しない。既にadmitしたlocal編集はネットワーク不通で内容を消さず、転送を停止し再認証を表示する。cold offlineのprincipal認可は追加のdevice/offline policyが必要な別gateであり、本slice成功へ混ぜない。

### 名前を付けた新規Libraryの初期化

通常起動のchooserへ「ライブラリを作成」を置き、ユーザーは名前だけ入力する。**先に**`getOrCreateCanonicalDevicePeer`をaccount単位の独立transactionで完了する。既存peerがあれば検証して返し、なければ一つ生成・保存する。同時作成の敗者は保存済みの勝者peerを読み返して返す。呼出し側の候補IDを固定Library要求へ持ち込まない。応答消失も同accountの再取得で解決する。peerのみが耐久化した後の取消・停止は正常であり、削除／巻戻しをしない。この操作は明示作成の準備であり、readonly discoveryでは呼ばない。

peerの耐久結果取得後、共通側がその`expectedPeerId`とrequestId、libraryId、epoch、manifest/checkpoint ID、catalog root ID/versionを一度固定した要求を作る。catalog IDはlibraryIdと同じ。既存validatorに適合する空Library rootと既存dataset checkpoint/manifest計算を使う。再試行時にIDやpayloadを生成し直さない。Library transactionは同accountの既存peerがexpectedPeerIdと完全一致することを検査し、peerを生成・置換しない。欠落／不一致／不正peerは拒否し、要求を書き換えて自動再試行しない。

外部Drive公開をしたと偽らず、`DatasetTransition.mode`へ有限の`initialize`を追加する。このmodeはsource=null、初回controlのみ、空Library catalog一つ・編集／resourceなしのcheckpointに限定する。hostの一transactionで、root/checkpoint/installed manifest、検証済み`active=manifest`のcontrol（phase=activated、epochs=[epoch]）、profile(remote=null、不変initialization証拠付き)を保存する。peerは同transaction内で照合するだけである。中間の編集可能状態は公開しない。既存controlの置換や既存データの移行にはこのmodeを使えない。TS/Pythonのtransition validatorを同時更新し、初回initialize→activatedだけの特例を明記する。既存publish/importのprepared→published→activatedは変更しない。通常`DatasetTransitionSession.start`へ偽transferを渡してこの処理を表現しない。

同identity・同requestの再送はprofile.initializationのrequestIdと正規化固定要求のSHA-256を照合する。hashはexpectedPeerIdと初期profile／全publication値を含み、派生するinitialization証拠自体は含めない。証拠はLibraryの初回transactionでのみ作成し、その後のrename/linkのCASでも不変に保つ。汎用の新journalは作らない。同ID異payload、同Library別requestは拒否する。account内のrequestIdをprofileのunique index／同transactionの一意検査で拘束し、同requestIdを別Libraryへ再利用しても拒否する。成功応答はこの不変証拠から同じ`{requestId, identity, initialScope, manifestId, peerId}`を返し、現profile revisionや現active epochは含めない。現在の起動可否は別の通常admissionで確認する。

再送時は受理証拠に対応するimmutable root/checkpoint/installed manifestの存在・一致と現profile/controlの構造・identity整合も確認する。完全受理済みなら、後続編集・改名・link・正規のepoch変更があっても初期化を書き戻さず受理結果だけ返す。現在のprojectionを初期空catalogと比較しない。証拠だけ／rootだけ／profileだけ／controlだけ等の部分状態、immutable初期物の欠落・異内容は`recovery-required`として無変更で拒否する。retryで不足rowを補完したり既存内容を初期値へ戻したりしない。初回insertは当該identityのLibrary状態が全く存在しない場合のみ許す。既存legacy由来controlへのprofile設定は別の明示経路であり、initialize再送成功として扱わない。

commit応答消失では結果不明としてIDを保持し、同ID照会／再送で確定する。Library commit前の取消ならLibrary状態は無変更（先行peerは残ってよい）、commit後ならdurable作成を残すが取消済み画面へ自動mountしない。process再起動後はprofile/controlから作成済みLibraryをchooserへ復元する。空Library shellから既存通常作成commandでPDF/paper/Markdownを追加し、実文書を選ぶまでdocument bindingを作らない。

この初回transactionのcontrol.idを固定requestIdとする。hostは認証失効をtransactionのabort／admissionへ結び、PCは既存auth generation guard内でcommitを行う。失効がcommit後なら旧accountの耐久結果を保持し、新accountへ返さない。readerの初期化とは違い、一transaction初期化を別々のinitialize／install／replace API呼出しへ分解しない。

### Drive linkと同期

remote=nullは実在するlocal canonical Libraryを意味する。UIは「この端末に保存／同期先未設定」を表示し、既存journal/outboxを保持する。`EditReplication`はsuspendし、必要なtransfer portは未設定を明示エラーにする。pull空配列／upload成功のno-op adapterで同期成功を捏造しない。

「Driveに接続」は同principalの既存Drive picker／folder検証I/Oへ接続し、選んだ実folderが現account leaseで利用可能なことを検証する。profile revision CASでremoteを保存し、同じscopeとstable peerで既存Drive transferを構築する。取消／auth変更の旧検証結果はCASしない。既存Libraryへのlinkは同期先の接続であり、空namespaceだから他datasetをimport／active変更する操作ではない。初期共有は既存dataset publicationの完全manifest/checkpoint公開経路へ通し、完了前に「他端末で利用可」と表示しない。転送失敗時はprofileとpendingを保持し通常再試行する。別端末のjoinは既存import/control activationを使い、端末自身のprofileとpeerを作る。

本sliceで新規initializeしたepochの初期共有は、controlに耐久化した同じ初期publication（空catalog checkpoint／manifest／object ID）を既存`publishDataset`で公開し、その後の編集を既存records/resource転送で送る。編集後の現checkpointを初期manifestへ差し替えない。既使用epochを再activationする`DatasetTransitionSession.start`へ流さず、remote完了前はreplicationの送信を開始しない。他の既存epochで対応publicationを得られない場合はlinkを未完了として保持し、既存の新epoch transitionを別の明示操作で必要とする。Solは初期publication再送と、別端末join後の後続編集受信まで確認する。

**linked admissionの必須barrier:** `profile.remote`のCASは同期先設定だけを保存し、初期publication完了を表さない。初回linkだけでなく、reload／process再起動／同account再入／replication再構築を含む**毎回のlinked admission**で、上記の固定publicationをidempotentに再公開して完了をawaitする。その後にだけ通常replicationを構築／resumeする。既存のimmutable remote objectが同じID・hash・bytesで成立すると検証できれば再uploadを省けるが、remote fieldの存在や過去のメモリ上成功だけでは省けない。新しい永続completion journalは追加しない。

barrier開始時に`profile.revision + identity + remote.folderId + control.id + active manifest id/scope + auth generation`を固定する。全remote I/Oはそのaccount lease・folderに束縛し、await後と通常replicationを許可する直前に同tuple、非frozen control、現principalと取消状態を再照合する。いずれかが変わったらその完了はadmissionに使わず、最新tupleで別barrierを開始する。旧folderへの遅延完了で新linkを許可せず、旧処理が新処理の状態を上書きしない。remote検証が不明／失敗／取消ならlocalの耐久内容・pendingは保持し、通常replicationは停止したまま理由と再試行を表示する。局所読書／編集の既存guardは保ち、同期完了とは表示しない。

profile CAS直後・checkpoint upload後・manifest upload後・barrier成功後でprocessが停止しても、次回は同じ固定publicationを検証／再送する。commit-last manifestと不変IDの既存契約を使い、現在の編集済みcheckpointで旧manifestを作り直したり、epochを再activationしたりしない。通常`EditReplication.flush()`自体に初期publicationを期待せず、このhost linked-admission barrierを通らないresume入口を作らない。

link変更ではregistryの離脱guardとreplication drainを先に適用し、旧leaseを新folderへ使い回さない。folder IDはadapter内のremote locationであり、canonical libraryIdやaccountIdにはしない。remoteの作成・検証・公開は外部I/Oなのでlocal transactionと原子的だと称さない。local profile commitとremote publicationの完了状態を区別する。

### Terraの実装順と追加Sol gate

1. profile／peer／initialize modeのschema・TS/Python validator、canonical table/store・readonly discovery・一transaction初期化と同ID照会を実装する。既存scope control/storageを拡張し、万能bootstrap DBを作らない。
2. account lease付きhost port、名前chooser／明示作成／名前未設定の既存controlへのprofile設定、empty Library shellを接続する。bindingをscope共通部と実文書部へ狭く分離する。normal entryはtest bindingに依存しない。
3. local保存表示とsuspended replication、検証済みDrive link／既存publicationへの接続、logout／再入・取消／closeを接続する。最後に通常entryのR29と両host回帰を採取する。

Sol追加gateは、名前付き空Library作成→通常作成→保存→reload、commit応答消失／再送／process再起動、二tab peer初期化競合、profile/control部分書込みゼロ、discoveryによるDB作成／upgradeゼロ、A/Bの候補名漏洩ゼロ、auth途中変更、local未設定時の偽同期ゼロ、Drive link旧結果／CAS競合／公開失敗後再試行。同一candidateでTS/Python契約と両host通常入口を確認する。既存legacyの一回変換・全領域切替・cold offline policy・全実機matrixは引き続き別の未完gateとして記録する。

linked barrierの追加gateは、profile CAS後／checkpoint後／manifest後の停止→再起動、完了済みremoteの同ID検証、同ID異bytes拒否、応答消失の同publication再送、barrier中のfolder A→B／profile revision更新／active control更新／auth変更。すべてで現tupleの固定publication確認前に通常pull/uploadを開始しないこと、旧A完了がBをadmitしないこと、barrier後に初期checkpoint＋後続recordsで受信側内容が成立することを確認する。この設計補足はSolの独立再確認対象であり、コード承認ではない。

peer／初期化の追加gate: 同account二tabが異なるLibraryを同時作成して同peerへ収束、peer作成応答消失、peer-only停止／取消から再開、期待peer不一致・欠落拒否、同request同payload再送／異payload拒否、初回Library commit応答消失、後続編集・rename/link・epoch変更後の同init再送で無書込み、各部分状態と不変初期物欠落の無変更拒否をTS/Python・実SQLite/IndexedDBで確認する。部分状態からの修復は別の根拠付き復旧操作であり、本初期化APIへ自動修復を追加しない。

## r3：非同期検証、atomic commit、未確定作成要求の耐久化

この補足はstorage/controller実装契約であり、Core実装やruntimeの承認ではない。r2の不変profile.initializationは受理後の証拠であり、未commit要求を復元できない。以下の狭い作成intentを追加してその境界を閉じる。

### 固定要求を実行前に保存する

既存のintent／journalと同じ「固定要求を先に耐久化し、同IDで照会／再送」の規則を、account単位の`CanonicalLibraryInitializationIntent`へ適用する。保存域は既存canonical SQLite／IndexedDB内の専用table/store。任意commandを格納する汎用journalにはしない。

```ts
type CanonicalLibraryInitializationIntent = {
  version: 1;
  accountId: string;
  requestId: Id;
  requestSha256: string;
  request: CanonicalLibraryInitializationRequest; // r2の固定要求全体
  result: null | { status: 'accepted'; receipt: CanonicalLibraryInitializationReceipt }
    | { status: 'rejected'; reason: string };
};
```

`request`はexpectedPeerId、identity/title、全root/version/epoch/manifest/checkpoint/object IDと初期profile値を含む。認証token/generationは入れない。型名はCoreの既存型に合わせ、同じ内容を別モデルへ再定義しない。account/requestIdをprimary key、account/libraryIdを一意に拘束する。profile側の受理証拠とのrequestId衝突検査も同じtransaction内で行う。

1. 明示「作成」の後にr2のgetOrCreatePeerを完了し、要求とdigestを一度作る。
2. `prepareInitializationIntent(lease, request)`で固定要求を耐久保存し、acknowledgementを得る。PCはsidecarのcanonical保存域への狭いAPI、Webは同じcanonical IDBで行う。保存結果不明なら同ID照会／同payload prepare再送を行い、**その耐久確認前にinitialize RPCを送らない**。
3. `executeInitializationIntent(lease, requestId)`は保存済み要求だけを読み、同じ要求を実行する。別payloadをこの入口へ渡せない。公開initialize入口もこのintentを必須とし、generic replace-control/install経由の初期化bypassを追加しない。
4. Library初回commitとaccepted receiptをintent.resultへ記録する更新は同じtransactionで成立させる。再送は同じreceiptを返す。受理された後もintentを即削除せず、callerが結果を受理した後の`acknowledgeInitializationResult`でaccepted intentを削除できる。profileの不変証拠は残す。確定rejectedのackは下記のcompact reservationへ変換し、requestIdを解放しない。

prepare応答消失でprocessが停止しても、commit済みなら次回discoveryに要求が現れる。prepare未commitならLibrary executeは未開始なので、新しい明示作成に進める。準備された要求は「作成結果を確認中」と名前で表示し、「同じ要求を確認／再試行」を提供する。同じ操作の復旧として新しいIDや空Libraryを自動生成しない。別のLibraryの明示作成まで無期限に禁止するものではない。

取消／通信断／timeout／auth失効／abort応答は、それだけではdefinitive rejectionではない。intentを保持し、結果照会でacceptedまたは無変更が確定したrejectedにする。definitive rejectionはexecutorが同transactionの状態検査から無commitを確定し、理由をresultへ耐久化した場合だけである。一時I/O失敗や同時変更のための再検証要求はresult=nullのまま。取消済み画面へ自動mountしない。要求の書換えはせず、確定拒否の結果を提示・acknowledgeした後の明示操作でだけ**新requestIdの**別要求を作る。

### ack後の恒久的なrequestId予約

acceptedの唯一の耐久証拠はr2の`profile.initialization`とし、intent内accepted resultはその同じreceiptの配送待ちcopyである。`queryInitialization(requestId)`／`executeInitializationIntent(requestId)`／`prepareInitializationIntent(request)`は、intentがなくても**認可account内の全profile（保持tombstoneを含む）のinitialization.requestId**をlookupする。名前・現在のprofile revision・現在active epochから探さない。exactなaccepted証拠があれば元のimmutable receiptを返し、要求再作成・Library書込み・再activationをしない。prepareでは保存証拠のdigest/identityと提供された固定要求のdigest/identityが一致することを必須とし、不一致はrequest-ID conflictで拒否する。query/executeへ期待identityを渡す場合も同様に検査する。

ack済みrejectedは、**同じaccount intent table/store**の同じrequestId keyへ、`{version, accountId, requestId, requestSha256, identity, result:{status:'rejected', reason}, retired:true}`だけを残す。full request payloadは捨ててよいが、この予約は通常cleanup／logout／再起動で削除しない。query/executeは元の拒否を返し、同digest/identityのprepareも元の拒否を返す。異payload・異identityへの再利用は拒否する。これにより確定拒否された要求を、新しいstateで勝手に再実行しない。上記intent schemaはfull pending/未ack結果とcompact retired rejectionの判別unionにし、TS/Pythonで同じ検証を行う。

account内requestIdの一意性は、intent（retiredを含む）とprofile不変証拠の両方を同write transactionで照合する。同じaccepted要求の配送待ちintentとprofileの重複はexact一致の場合だけ許し、不一致は復旧対象で無変更拒否する。acceptedのackはprofile証拠のexact一致を同transactionで確認してからintentだけを削除する。結果照会とack／prepare競合も、元の同じ結果か一時再読出しに収束し、新要求としてinsertしない。

将来のLibrary削除／登録解除でもprofile.initializationを黙ってGCしない。削除したLibraryのprofileは証拠付きtombstoneとして保持し、chooserの通常項目から外してもrequestId lookupでは読む。本sliceでは別のaccepted-receipt archiveや第二のauthorityを追加しない。予約の消去は、将来の明示account忘却／全保存域reset契約でのみ扱い、通常logoutやLibrary削除とは区別する。rename/link／後続epoch変更後も元receiptを返すが、現在のmountは別のactive-control admissionを必ず行う。

### cryptoとwrite transactionを分離する

CoreのSHA-256／resource検査等のawaitを、IDB write transactionやSQLite commit transactionの内部へ持ち込まない。手順は「readonly取得→transaction外の非同期検証／hash→write transaction内で必要な事実を再読出し→同期検証／CAS→全書込み→commit」の順とする。profile/peer/intent/control/初期root・checkpoint・manifestとrequestId衝突の有無を、今回の判断に関係する範囲で捕捉する。Library全projectionや他accountの状態をglobal CAS対象にしない。

検証結果はimmutableな要求と、読んだ関連recordのexact値／revisionへ結び付ける。write transactionでは現peer、intentの要求/digest/result、profile、control、request衝突、対象Libraryの既存物を**読み直す**。非同期検証した不変物は保存済みcanonical bytes等のexact比較で同一性を確認し、配送時の新revisionを古い検証結果へ貼り直さない。不一致なら書込みゼロで抜けて外側で読み直し／再hashする。期待peerや固定要求自体は自動変更しない。確定collisionや部分状態はr2どおり拒否／復旧理由へ分類する。

IDBではtransaction生存中のIDB request連鎖だけで読出し→同期検査→putを進め、crypto・fetch・timer等のawaitを挟まない。SQLiteでは同じ再読出し／一意検査をwrite transactionのlock下で行う。auth generationもcommit admissionへ結び、PCは既存generation guard、Webは失効時のtransaction abortとcommit後結果の世代照合を用いる。commit後の失効で耐久結果を消さず、別accountへ表示／転送しない。

initialize専用のatomic storage methodだけが、root/checkpoint/manifest/control/profileとintent.resultをまとめて保存する。Coreの検証済みというboolを任意recordのreplace権限に変えず、低レベルadapterは期待peer／identity／empty初回条件／request fingerprint／現在の衝突を検査する。既存publish/importの更新権限も拡張しない。

### 起動・logout・部分状態

認可済みdiscoveryは現在principalのprofileに加え、同accountの未acknowledged作成intentを名前と状態で返す。別accountの名前／ID／件数を出さない。読み取りだけでexecuteやpeer作成を行わない。logout/suspendは新しいbootstrap実行を止め、進行中処理のcommit結果を可能な範囲で確定させるが、未確定intentを削除しない。auth交換後は旧accountのintentを新accountで再送せず、同accountへの正規再認証後に復旧する。cold offline認可は従来どおり別gateであり、保存accountIdを認証証拠にしない。

正常な中間状態は「peerだけ」「peer＋pending intentでLibrary物はゼロ」「完全Library＋accepted intent／ack済み不変証拠」。peerやintentの先行存在はLibraryの部分破損ではない。Library物の一部だけ存在する場合はr2のrecovery-requiredで、intentがあっても自動補完しない。accepted receiptを得た後は、現在のprofile/controlを通常admissionで読み直す。受理時initialScopeを現在activeと見なさず、後のepoch変更／freeze／link変更を尊重する。

### Solの有限追加gate

- cryptoを意図的に遅らせてもIDB transaction完了後にputしない。hash中のpeer/profile/control/intent変更・同ID衝突は再読出しで検出し、部分書込みなし。SQLiteでも同じ競合結果。
- prepare前、prepare commit後ack前、initialize送信前、Library commit前、commit後応答前、結果表示後ack前の停止／再起動。各点で重複Libraryゼロ、同じrequest/digest/IDで復旧し、無関係のLibraryは保全する。
- initializeとlogout／A→B→A、二tab同request／別Library、結果不明中の再試行、確定拒否と一時失敗、peer-onlyとpending-onlyとLibrary部分破損の区別。別account露出ゼロ、未確定要求削除ゼロ。
- accepted結果の照会前に正規のactive epoch変更／freeze／link更新があっても元receiptは不変で、mountは現controlに従う。
- accepted ack→query/execute/同payload prepareで元receiptを返しLibrary再作成ゼロ、ack後の異payload／異identity再prepare拒否、rejected ack→compact reservation→同要求は元拒否／異要求はID conflict、rename/link/後続epoch変更後の再照会、ackと再送の二tab競合を確認する。account Aの予約をBへ露出・流用せず、Aへの再入で同結果になること、profileの通常非表示／将来の登録解除でも証拠を失わないことを確認する。

Terraは先にoutput-only Core/storage draftへこの契約を反映し、Sol独立確認後に実source統合へ進む。schemaへ上記intent型を加え、TS/Python適合fixtureと実SQLite/IndexedDB fault testsを同じ結果意味で揃える。汎用bootstrap store、偽offline認証、既定切替完了の主張は追加しない。

## r4：import／移行で成立したLibraryのprofile来歴

本補足は実source統合前の設計修正案である。Root確認とSol独立確認の前にTerraへ実装開始を指示しない。profileが表すLibraryは、新規の空catalogだけでなく、他端末import／join、非空の移行、metadata導入前の既存canonicalを含む。remote publicationから端末固有の初期作成要求hashやtitle/revisionを逆生成しない。

### originとinitializationの整合

- `origin.kind='local-initialize'`ならinitializationは必須nonnull。r2/r3の固定要求・digest・受理receiptと整合し、以後の改名／link／epoch変更でも消去・変更できない。
- `origin.kind='activated-installation'`ならinitializationはnull。sourceはimport／migration／pre-metadata-adoption、originのcontrolId/manifestId/installedScopeはprofileが最初に結び付いた検証済みactivationの歴史的証拠として固定する。現在のepochや起動可否は常に現DatasetControlRecord.activeで決める。
- originとinitializationは一組の判別unionとしてTS/Pythonで検証する。単なる任意nullable fieldにはしない。既存profileのupdateはtitle/remote/revisionだけを変更でき、origin／initialization／identityを変更できない。
- accepted request lookupはlocal-initializeのnonnull証拠だけを対象とする。initialization=nullのprofile、同じLibrary UUIDやmanifestを理由にinit成功を返さない。r3のaccount内requestId予約、accepted profile tombstone、rejected reservationは維持する。

### 新しいimport／join／移行でのattachment

profileを伴わないactivationを先に公開して後から通常画面で補う方式にしない。既存import／移行の完了controllerが、入力title・現principal・検証済みinstallation・expected control idを固定したprofile attachment要求を作る。titleはその端末での明示命名または移行planの検証済み名称、libraryId/accountIdは既存manifest/control identityから取得する。peerはr2のgetOrCreate結果を使い、remoteにある他端末peerをコピーしない。

activationのwrite transaction内で、expected predecessor control、installation/manifestのexact scopeと検証結果、principal generation、既存profileの有無を再照合する。初めてこの端末へLibraryを導入する場合だけ、既存activated controlへの更新とactivated-installation profile作成を**同一transaction**で行う。既存Libraryの新epoch adoptionなら既存profileを保持し、origin/title/linkを上書きしない。旧profileが存在すべき経路で欠落していた場合は復旧対象として止める。crypto/remote I/Oはtransaction外、exact再照合はr3に従う。

このattachmentはactivationを決定する別authorityではなく、既存guard付きtransitionの同じcommit境界へ付随するmetadataである。新しい汎用setProfile入口や、任意controlを「検証済み」とするboolは作らない。途中停止では元の未activation状態か完全なactivation＋profileのどちらかとなり、同じ固定transition planから再開する。初回profileが同identityで既に存在する場合は、その作成来歴と固定payloadが同じ再送だけを認め、異なる要求は競合として拒否する。

### metadata導入前の既存canonicalと破損の区別

既存の「名前を設定」は、通常discovery中の欠落row修復としては提供しない。**metadata導入前の保存域を対象とした明示adoption／復旧工程**に限定する。schema導入前のversionとraw保存域の固定backup／inventory、対象identityとactive control、installation/checkpointの成立を確かめ、principalとtitleを束縛する。現controlが非frozenで同じid/active manifestを保つこと、profileが未存在であることをwrite transactionで再確認し、profileだけをactivated-installation/pre-metadata-adoptionとして付ける。active/control/rootを再initialize・再activateしない。

これは古いinterfaceを通常経路へ恒久維持するためではなく、正当に存在する既存canonical内容を新metadataへ導入する一回の工程である。schema導入後にprofileが消えた状態、local-initialize control／pendingまたはaccepted init証拠がある状態、導入前の根拠がない状態はこの工程の対象外。既存初期化由来のprofile欠落をinitialization=nullで埋めてはならない。原証拠を含むbackupからの復旧が必要で、単に現control.modeがimport/publishになっただけではpre-metadata資格を得ない。

Rootがこのadoption工程を本slice外へ置く場合、該当Libraryは説明付きの復旧対象として残す。新規local作成・新規join/import・M6の非空移行をnullable証拠非対応のために塞ぐ実装にはしない。新しいM6移行は上段のatomic activation＋profile経路を使い、空Library初期化receiptを偽造しない。

### Core／Stage2の変更境界と有限gate

実source生成前にCoreのprofile型／validator／固定更新規則へorigin判別とnonnull/null制約を追加する。init receiptの抽出・requestId lookupはlocal-initializeだけへ狭める。Stage2ではlocal initializeのatomic putへlocal originを設定し、import/migrationの既存activation transactionへ専用attachment値とCASを追加する。profile discoveryは両originを表示できるが、欠落profileの自動補完はしない。現在epoch selectorや新しいhost-wide registryは追加しない。

Solの有限gateは、(1)空local initializeのnonnull証拠とack後receipt、(2)非空import/join・非空migrationのnull証拠profileと通常起動、(3)origin/証拠の不正組合せとupdate消去拒否、(4)同じLibraryの後続epochでoriginを保全、(5)activation/profile commit境界停止・再送とCAS競合、(6)根拠付きpre-metadata adoptionで内容/control不変、(7)fresh initialize profile欠落・後続epoch後欠落・根拠なし欠落の修復拒否、(8)null証拠profileをinit成功cacheに使わないこと。TS/Python適合とSQLite/IDB境界を揃える。既存output draftのレビュー成功／未実行件数を、この追加契約の実装・検証成功へ読み替えない。

## r5：local namespaceとprovider認証を分離する（host設計案）

Root／Sol確認前のhost設計案。ここではsource/schemaを変更せず、実装開始も指示しない。r2の「accountIdはDrive permissionId」「discoveryにはlive Drive必須」は最終製品契約として撤回する。PCとWebはGoogle未接続・cold offlineでも、明示された端末local contextでLibrary作成／閲覧／編集／再起動回復が必要である。現在のonline leaseだけのdraftをこのgateの成功にしない。

### 三つの寿命

1. **canonical namespace:** 既存`DatasetIdentity.accountId`は保存namespaceの不変opaque IDとして扱う。新local contextには一度生成・耐久化したnamespace IDを使い、Google permissionIdを要求しない。libraryId／epoch／batch ID／resource hashと共に、Drive接続で変更しない。既存field名の全面renameは不要だが、provider principalとの同一視をadapterから除く。
2. **host利用許可:** opaque `HostLease`がnamespaceへのread/create/edit/discover権限と現在のgenerationを証明する。portsに渡るaccountIdはnamespaceであり、実subject・device/context・許可根拠はhostだけが検証する。PCは当該OS利用者のアプリ保存域、Webは明示された当該browser/originのlocal contextとして「この端末」「このブラウザ」と表示する。localをGoogleログイン済みと表示しない。共通featureはDriveやhost認証を直接呼ばない。
3. **remote同期許可:** 別のprovider leaseがDrive subject(permissionId)／auth generation／folderを証明する。local編集leaseと独立し、失効で転送を停止するがlocalの確定内容・pendingを消さない。provider切替後に旧leaseを再bindしない。

### 最小のhost grantとnamespace link

必要な新metadataは、端末内の**namespace grant**と、remote folder内の**不変namespace descriptor**である。汎用auth storeや起動選択保存ではなく、canonical storageのhost境界だけに置く有限の型とする。正式field/schema変更はこの設計レビュー後に別差分へ分ける。

- 端末grantはnamespaceId、grant種別(`local-created`または`provider-cache`)、local context識別子、provider-cacheならproviderと検証済みsubjectId、revisionを持つ。local-created grantはlocal namespaceの初回provisionと同じtransactionで保存する。provider-cache grantは検証済みjoinと同じhostの導入transactionで保存する。他端末へgrantやpeerを転送しない。
- local contextのnamespace provisionは`getOrCreateLocalNamespace(hostLocalLease)`の有限なhost操作とし、同contextの二tab／再起動で同じnamespaceへ収束する。そのnamespaceでr2のstable peer→固定init intentへ進む。生成namespaceは真のlocal identityであり、架空のGoogle accountではない。
- remote descriptorはversion、canonical namespaceId/libraryId、当該Drive所有subjectIdを保持し、固定object IDとimmutable内容でfolderへ公開する。folder自身は検証済みremote location。descriptorはepochを選ばず、既存manifest/controlがepoch authorityのまま。local profileのremote linkには検証済みsubjectとdescriptor ID/内容hashを結び付ける拡張が必要で、folderIdだけでは別account admissionを許さない。
- Drive linkでは現provider leaseでfolderの所有者／利用権限とdescriptorを検証する。本sliceの基本契約は同じ所有subjectの端末間利用とし、共有folderの別subject参加は別のACL仕様なしに許可しない。local namespaceをDrive subjectへ書き換えない。descriptor ID／初期publication ID／bytesを固定し、r2の毎linked admission barrierにdescriptorとsubjectの照合も含める。
- 他端末joinは、現Drive subjectが所有するfolderの検証済みdescriptor→同namespaceの正確なmanifest/publication→通常import/activation＋r4 profileを使い、自端末peerとprovider-cache grantを作る。remoteのtitleをlocal init要求へ逆算せず、その端末のLibrary名を設定する。namespace文字列を任意入力して既存保存域へ入るAPIは作らない。

**joinの衝突境界:** folder所有とdescriptorはremote側の対応を証明するだけで、端末内に既にある同namespace／libraryの権限を与えない。install write transactionで、現namespace grant、対象libraryのprofile／link／originと既存provider grantを再読出しし、検証済みsubject＋descriptor ID/hash＋canonical identityのexactなidempotent再入だけを再利用する。既存local-created領域へremoteの自己申告だけでgrantを注入しない。既存local所有者が明示linkする経路は、そのlocal-owner leaseとprovider leaseの両方で別途認可する。

local-owner namespace／別providerの既存provenanceとの衝突は、既存の名前・本文・件数を返さず、権限やprofileを変更せず拒否／復旧対象にする。同namespaceに別libraryを導入する場合も、既存namespaceのlocal/provider所有境界と整合する明示認可が必要であり、remote descriptorのnamespace一致だけを根拠に追加しない。cache→local再分類やnamespace全体への権限昇格は禁止する。複数の異なるdescriptorが同folderで見つかった場合は曖昧として拒否する。同時初回linkでも先頭／最新／同名の一つを選ばず、exact不変descriptor一つという条件を満たすまで同期をadmitしない。

### discoveryとaccount切替

local contextのdiscoveryはlocal-created grantに基づくLibraryだけを返す。Drive account Aの画面は現在Aのprovider-cache grantと、Aへ明示linkされたlocal Libraryだけを対象とする。Bへの切替ではAのcacheの名前／件数／本文を返さず、AのpendingをBのtransferへ渡さない。local contextはaccount Bの暗黙fallbackではなく、利用者が明示して開く独立の「この端末」画面とする。Aからdownloadしたcacheをlocal-created扱いへ自動昇格させない。localで元から作成したLibraryはAへのlink後もlocal所有を失わないが、Bによる同期再開は許可しない。

providerのlogoutはそのprovider-cacheの新操作と全remote同期を停止し、未確定要求／draftを元namespaceへ保持する。元からあるlocal-created grantの編集権限はGoogle logoutだけでは失効しない。Library切替の既存未保存guardとscope suspendは維持する。namespaceとprovider subjectの組合せを毎requestと返却時に照合し、host側のdescriptor検証で得た証拠を共通側の単なるboolへ置換しない。

**Library単位のprovider権限:** 一つのnamespaceは複数libraryと一つの端末peerを持てる。local-owner grantは当該local contextのnamespace権限、provider-cache grantは`namespaceId + libraryId + provider subject + descriptor`に限定した権限とする。N内のL1をAへlinkしても、同じNのL2（非公開またはBへlink）の名前／件数／本文／pendingをAへ開示しない。namespaceをlibraryごとに作り直してこの境界を回避しない。

opaque HostLeaseはhost factoryだけが発行するnamespace-owner capabilityまたはlibrary-bounded capabilityを持つ。callerがlibraryIdの配列やgrant boolを付けて拡権できるAPIにしない。trusted storage／host adapterはdiscoveryのquery時と全read/intent/execute/control/resource操作の対象検査でcapabilityを適用し、**UIへraw namespace一覧を返す前**に対象を絞る。accountIdだけを指定する`list(N)`をprovider leaseに許さず、許可libraryだけの結果・診断・件数を返す。未認可対象の存在もエラー詳細へ出さない。namespace-ownerだけに許可する作成・全namespace管理操作も明示する。

pending join用capabilityはhostが検証済みdescriptorから発行する対象library限定の一時権限であり、install衝突検査を省略する権限ではない。namespace peerのgetOrCreateは、namespace-ownerまたは認可済みの対象library／pending-join capabilityで許可できる。peer公開IDは他libraryの探索・read権限にならず、同namespaceの別library用にpeerを増殖させない。peerの存在を理由にjoin認可済みとは判定しない。lease失効・auth切替・link revision変更はdiscovery返却時／install commit前にも再確認する。

**cold offline:** local-created Libraryはlocal host権限だけで起動でき、Googleへ問い合わせない。provider-cacheは保存subjectIdだけで認可せず、current BのセッションからAを開かない。importしたcacheもcold offlineで開く製品機能を追加するなら、A本人が事前に明示付与したdevice-local offline grantと、再起動後にそのgrantを使用できるlocal unlock／認可規則を別途設計・検証する。単なる「最後にAだった」記録はoffline proofにならない。このprovider-cache offline機能は本sliceで成功とせず、元のoffline／scope保全要件に紐付く残gateとして可視化する。local-first全体をGoogle必須へ戻して不足を隠さない。

### driver要求と有限gate

PC/Web host driverは、local context provision/lease、許可grantによるreadonly discovery、namespace固定のrepository/peer/intent生成、provider subject取得とgeneration lease、folder/descriptor検証、取消・失効・closeを提供する。`createDriveEditTransfer`等はnamespaceとprovider leaseを別入力として受け、`bindAccount(scope.accountId)`という同一視をやめる。Driveファイルnamespaceとmanifest内容は引き続き同じcanonical scopeであり、linkのためのデータ再hash／再ID化はしない。remote descriptor/link/grantの正式schemaとPC/Python・Web検証fixtureはRoot/Sol合意後の専用差分にする。現Core/SQLite/Web metadata sourceをこの文書追記で変更済みとはしない。

Sol gateは両hostで、Google未接続local作成→編集→cold reload、二tab local namespace/peer収束、local init unknown復旧、任意の後時点でAへlink（canonical ID/hash不変）、別端末A join（同namespace・別peer）、Bへ切替（A cache露出／A転送ゼロ）、Aへ再入、ネット切断中local編集と再接続、logoutしてもlocal原本保持を確認する。descriptor差替え／別subject folder／古いlink完了拒否、provider-cacheを無断local昇格しないことも確認する。手動実機未達・全M6移行・provider-cache cold offlineの未達を独立記録し、オンラインhost leaseの試験だけでPC/Web完成としない。

追加gate: 既存local N／provider B領域へAのdescriptorでjoinして権限注入しない、exact A再入だけidempotent、N内L1=A・L2=private/BでAのdiscovery/read/intent/control/resourceからL2の存在・件数・内容が漏れない、偽namespace/descriptor拒否、同folderの競合descriptor拒否、peer取得後も他library権限なし、discovery/join中のauth喪失／link更新で旧結果非公開を確認する。現在のCore/SQLite 92件等で使うowner用fake leaseはこのprovider境界の証拠ではない。実driverとstorage/adapterのcapability/filter対応は今後の設計レビュー後の変更であり、現source/schemaは未変更とする。

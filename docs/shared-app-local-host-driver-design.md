# B1b：local host認可と実driverの接続図

Astra設計案。[通常起動接続設計](shared-app-bootstrap-connection-design.md) §3/5/7の具体化。実装・検証成功の報告ではない。source134のgrant／storageを調査し、B3隔離案の`bootstrapPorts.ts`も照合した。実source・DB・tests・generatorは本作業で変更しない。Sol独立確認後にTerraが下記差分を実装する。全M0–M6／67要件、r5のprovider-bounded境界、受入状態は維持する。

## 1. source134に既にあるもの／足りないもの

| 実source | 再利用と不足 |
| --- | --- |
| `papeer/core/canonical_local_grant_sqlite.py` | 固定pathのreadonly discovery／明示provision、単一`primary-local-context`行、占有・破損拒否。lease発行機能はない |
| `frontend/src/adapters/browser/canonicalLocalGrantIndexedDb.ts` | 同origin・同DBでgrantを作る／読む。返すgrant値は認証credentialではない |
| `canonical_initialization_sqlite.py`／`canonicalIndexedDbStorage.ts` | 固定intent、peer、query/execute/ackを再利用。現在の構造的lease interfaceを渡すだけでは実認可にならない |
| `papeer/core/edit_storage.py`／`sidecar/deps.py` | `edit_storage_root(deps.get_data_dir()) / 'content.sqlite3'`が正しいcanonical path。`get_library()`はlegacyを開くのでdriverで呼ばない |
| `sidecar/routes/edits.py` | routerはbearer付きだが`repository(scope)`はcaller scopeを信頼する。bootstrap endpoint／host lease／admissionの検査は未接続 |
| `frontend/src/api/connection.ts` | native提供port/tokenとbackend URLのみを再利用。legacy client/storeをimportしない |
| `IndexedDbEditDatabase` | 同canonical DBを使うがopenがupgrade可能、各transactionにgrant証拠がない |
| `SqliteEditRepository` | constructorがschema CREATEを行う。各methodにBEGINが分散し、外側のHTTP checkだけではcommit競合を閉じない |
| `IndexedDbLegacyBackupStore.readHold` | 現在のprivate readはupgrade可能openを通る。B1bではhold専用readonly openへ直す必要がある |

local grantが保存されたこと、fake owner leaseでstorage試験が通ること、実driverの認可が成立することを区別する。今回新設するのはhost内のlease／admission寿命と既存transactionへの検査であり、新しい内容DB、writer、汎用account serviceではない。

## 2. B3と共有するinterface

B3隔離案の`BootstrapHostDriver`を正本とし、同名の別interfaceを作らない。`readHold`は検証後の`'clear' | 'held'`、I/O失敗・不正holdはthrow。`HostLease`／`LibraryHandle`はopaque object、`ActiveLibraryProof.scope`は観測値でありcapabilityではない。`sameAdmission`も既存B3案のmethodとして維持する。

必要な追加は既存`ScopeResources`の一methodだけである。

```ts
interface ScopeResources {
  // 既存repository / draft / image / readerState / peerId / closeを維持
  reauthorize(nextProof: ActiveLibraryProof, signal: AbortSignal): Promise<void>;
}
```

実装配置は`createDesktopBootstrapHostDriver`を`adapters/desktop/bootstrapHostDriver.ts`、`createBrowserBootstrapHostDriver`を`adapters/browser/bootstrapHostDriver.ts`とする。factory引数のDB名／IDBFactory／HTTP transportはテストで差し替え可能だが、返されたgrantやassertCurrent関数をcallerが認証証拠として注入する引数を設けない。production factoryは既存固定保存域・既存tokenを使う。

## 3. opaque authorityの寿命と再入

### 3.1 hostが保持する有限値

各driverは非公開WeakMapでHostLease、LibraryHandle、ActiveLibraryProofの真正性を検査する。型brand／`as HostLease`だけでは通らない。Desktopのwire leaseId／admissionIdはserverが予測困難な値で発行し、server memory内の対応表を照合する。token、leaseId、admissionIdをlocalStorageやDBへ保存しない。

leaseの内部値は固定storage instance、grant全文（contextId/namespaceId/revision）、host generation、失効signal。admissionはさらにidentity、profile全文またはcanonical fingerprint、control全文、active manifest、peerIdを保持する。control.idだけでなくphase／activeを含むexact値を比較する。scopeは常に`control.active.scope`から得る。

`LibraryHandle`はdiscoverが発行するselectorである。旧handleを新leaseでinspectする再入は許せるが、新leaseが同namespaceの同Libraryを認可できることをhostが最初に再検査する。古いhandleの存在から権限を復元しない。別driver作成物／別namespace／未登録objectは内容・存在を示さず拒否する。

`sameAdmission(previous, next)`は、同driverが実際に発行したproofについて、storage/context/grant、identity/epoch、profile/control/active manifest/peerの永続tupleがexact一致するかを返す。次proofの有効性も検査する。過去proofは失効済みでも比較用fingerprintとして保持できる。generation／nonceの一致を要求すると再入不能になるため比較から除くが、旧generationへ操作権限は戻さない。このmethodはI/O gateを変更しない。

### 3.2 retained runtimeのstable I/O gate

同scopeの`ScopeResources`は一つのprivate `RuntimeIoGate`を所有する。repository、Markdown image、draft、append draft、reader preferencesの各port objectはそのgateへのstable delegateである。registry／form owner／repository objectを作り直さない。

**acquisition signalとadmitted lifetimeを分離する。** `openScope(proof, signal)`と`resources.reauthorize(nextProof, signal)`のsignalは、その呼出しがresolveするまでの取得／handoffの取消だけに使う。resolve時にlistenerを解除し、以後のgate lifetimeへ保持しない。resolve後、B3の操作世代変更／旧AbortController.abortだけでadmit済みgateを失効させてはならない。gateの長期失効源は実host generation／leaseの失効、明示page unavailable、およびguard成功後のresources.closeである。未公開candidateの取得完了が古いB3世代へ後着した場合はcallerがそのcandidate.closeを実行する。

`prepareClose`／close拒否ではadmit済みgate、購読、transport、form ownerを維持する。close操作自身のsignalやB3の一時flight取消を実host失効と扱わない。close許可後だけresources.close→driver.closeへ進む。B3が自分のleaveFlightを世代無効化して、suspend/dispose後に「staleだからreturn」しdriver.closeを飛ばす構造は不可である。closeのterminal世代は最後まで一つで所有する。

各operation開始時に、gateの現在epoch、immutable lease/admission、scope、gate所有のoperation signalを一度捕捉する。このsignalは上記取得用signalではない。request送信時やtransaction開始時に「その時点で最新のlease」を再取得しない。旧operationが新leaseで再送・commitすることを禁止する。await後・値の公開直前に同じepochを検査する。

失効／pagehide時はgateを同期的に閉じてepochを進め、登録中transport／IDB transactionへabortを要求し、新I/Oを拒否する。旧commitがすでに成立し得る場合、元要求のunknownとして扱い、definitive abortedへ変換しない。元intent／draftを消さない。物理requestの遅延完了は旧epochで非公開にする。取消が効かないnative requestもidempotentな元IDに束縛されたままであり、新generationへstateを公開しない。

`reauthorize(nextProof, signal)`は、(1)gateがlockedであること、(2)sameAdmission相当のexact tuple、(3)新proofのhost再検証、(4)旧epochのclient側operationの取消・settlementを待つ、(5)取消／新失効がないことの最終検査、を行い、最後に新lease/admissionを新epochへatomicに装着して取得signalのlistenerを外す。旧promiseの結果配送と既存sessionのflightが収束してからregistry recoveryへ進む。永続commit結果が不明なものはquery／同ID retryで既存registryが回復する。通信相手の成功を推測してpendingをclearしない。通常openのgateは初期proofで作り、close後はreauthorize不可とする。

B3のretained再入順序を **inspect(new lease, old handle) → sameAdmission → revalidate(next) → resources.reauthorize(next) → sessions.resume → 最終revalidate(next) → availability/画面unlock** とする。各await後にB3世代検査を置く。最後の検査に失敗したら再度gate/registry/navigationをdeactivateし、同keyの非公開subtreeを保持する。新proofをruntimeへ記録するだけで古いbound portが使えると仮定しない。失効前の未確定formは通常起動接続設計§7どおり同React ownerに残す。

`reauthorize`はgrant revision／epoch／profile等が変わった場合には拒否する。変更後scopeへ未確定編集を移す機能は作らない。復旧不能ならlockedを維持して明示復旧工程へ送る。

## 4. B1b-Desktop：実HTTPとSQLiteの接続

### 4.1 固定pathとprovision

`sidecar/deps.py`へ`get_canonical_storage_path()`を追加し、既存`edit_storage_root(get_data_dir()) / 'content.sqlite3'`だけを返す。data dirの変更・restore・server再起動はstorage instance/generationを変え、古いleaseを失効させる。HTTP bodyにpath、root、任意namespaceは受け取らない。readonly接続は`mode=ro`、path/link検査は既存grant/storage規則を再利用し、mkdir/WAL設定/CREATEを行わない。

明示provision endpointのみが固定parent作成、`provision_local_grant`、canonical schema準備を行う。grant-onlyは正常な中間状態であり、schema準備前停止から同grantで再開する。grantがreadyでも必要table不足なら、driverは保存内容を検査し、grant以外が空のprovision中断だけをsetup再開とする。Library物があるのに必要tableが欠ける状態は復旧対象で、自動CREATE補完しない。新schema versionへのupgradeは対応する明示工程が必要である。

`SqliteEditRepository`のconstructorからDDLを`initialize_edit_schema(db)`へ抽出する。明示provisionから既存`SqliteCanonicalInitialization.initialize_metadata`とともに呼ぶ。constructor／inspect／通常openでschemaを作らない。Core単体testのsetupもこの関数を明示使用する。schema抽出で編集内容、hash、batch、Undoの意味を変えない。

### 4.2 server lease registry

新`sidecar/canonical_host.py`にprocess-local registry、generation/revocation lock、固定path factory、認可済みread/transaction factoryを置く。独立したdurable service storeは作らない。`deps.verify_token`による現bearer検証を先に通し、grantの実読出しと照合後にleaseを発行する。`PAPEER_DEV_NO_AUTH`で通ったrequestを本番local-owner leaseの発行根拠にしない。dev/testでも実tokenを設定する。

lease.guardはserverの世代変更と相互排他になり、write commitまで保持する。grant revisionはlockだけで証明せず、同SQLite transaction内で固定行を再読してexact比較する。読み取りも同snapshot内でgrantを先に検査する。終了時に世代・grantを再検査し、結果を返す前にもleaseを確認する。外部DB書換えをmemory cacheだけで承認しない。

新`sidecar/routes/canonical_bootstrap.py`をapp routerへ登録する。全routeはbearer必須、`Cache-Control: no-store`、token類をlog／エラーへ含めない。次のwire operationを既存driver methodへ対応させる。

| endpoint（`/api/edits/bootstrap/`以下） | request／authority | 結果と既存処理 |
| --- | --- | --- |
| `local-context/read` | 空body、bearer | readonly grant＋schema判定。readyなら新leaseIdを発行 |
| `local-context/provision` | 空body、bearer、明示操作 | 上記provision後に同じ発行処理。再送は同grant |
| `discover` | host lease header | `SqliteCanonicalInitialization.list`＋対象control状態からtitle/status／handleId、未ack intent |
| `peer` | host lease header、空body | serverが候補UUIDを作り既存get_or_create_peer。winnerだけ返す |
| `initialization/prepare` | host lease header、固定request | 既存prepare。request namespaceをleaseへ照合 |
| `initialization/query`, `execute`, `acknowledge` | host lease header、requestIdのみ | 既存同名操作。accountをcallerから選ばせない |
| `inspect` | host lease header、handleId | §6のproof検証、admissionId／scope／peerId |
| `revalidate` | host lease＋admission header | 同tupleとholdを再確認。成功boolを後続I/Oの代替証拠にしない |
| `release` | host lease＋任意の自分のadmissionId | 当該handleの失効／drain。別tabのleaseやdurable grantを削除しない |

wire headersは`X-Papeer-Host-Lease`、scope操作には追加で`X-Papeer-Admission`とする。Driveの既存body.leaseIdと混用しない。名前はこの差分内で一つに統一すればよい。hold readは既存`/legacy-startup/read`の安全な入口を再利用する。

### 4.3 全canonical I/Oを同じ境界へ通す

`sidecar/routes/edits.py`の`repository(scope)`を`repository(scope, authorization, operation)`へ変更し、各routeがFastAPI dependencyで解決した実server authorityと固定operationを渡す。operation文字列はrouteが選び、caller bodyから受け取らない。認可前にrepository／DBを作らない。missing lease/admissionは拒否し、旧APIへfallbackしない。

| operation group | B1bでの許可 |
| --- | --- |
| read、receipt、pending、pending-records、pending-publications、intent、pending-intents、checkpoint、datasets、dataset-control、read-resource、resource-metadata | 現local-owner＋active admissionのexact Library/scope。読出し後にも世代照合 |
| commit、publish、replace-intent、store-resource | 上記＋現非frozen active controlを同write transaction内で再検査。store-resourceはCoreでstageと分類されていても、通常のactive資料作成用途を許す |
| initialize、install-checkpoint、install-dataset、replace-dataset-control | 通常admissionでは拒否。初回Libraryはbootstrap executeのatomic bundleだけを使用 |
| receive／receive-publications／receive-records、acknowledge-upload／import | remote同期または明示importの専用authorityが必要。B1b local driverには発行せず拒否し、local outboxを成功扱いしない |
| `/drive/*` | local host leaseだけでは許可しない。r5のLibrary-bounded provider lease＋descriptor barrierまで未接続扱い。既存permissionId=namespace前提の経路をlocalへ流用しない |

transition privilegeはownerより強い汎用「管理者bool」ではない。将来の既存`DatasetTransitionSession`／M6 controllerが固定plan（identity、source/target epoch、publication fingerprint、expected control）を検証して発行する対象限定authorityである。B1bでtransition endpointを閉じてもCoreの移行実装・試験を削除しない。P1/r4/M6接続時にこの境界へ実発行器を追加し、恒久unsupportedで全体完了とはしない。legacy backup/legacy Drive routesは既存の明示migration管理用途を保持し、一般編集leaseへその権限を追加しない。

### 4.4 SQLite transaction hook

Coreの編集意味を持たない小さなtransaction authorityを`SqliteEditRepository`へ接続する。methodごとに散在する`with connection()`＋`BEGIN`を共通helperへ集約し、`read`または`write`、固定operation、scopeを渡す。helperは **server generation guard → connection → BEGIN（writeはIMMEDIATE）→ grant/admission検査 → 既存処理 → grant/generation再検査 → commit → guard解放** の順を実現する。二重BEGINや、先にHTTPで検査してtransactionには渡さない構造にしない。

認可hookは同db handleでgrant、profile、controlを読める。writerは同transaction内の実controlがproofと一致し非frozen activeであることを確認する。SQL処理前にnamespace/libraryを固定し、別scopeへの`_scoped_state`等は通常authorityでは拒否する。後から追加されるrouteもoperation分類がない限り拒否される。

`SqliteCanonicalInitialization`にも同じ実leaseのtransaction検査を接続する。既存`_write`のBEGIN後、全write前、commit直前でgrant/namespaceを検査し、read/list/queryのBEGIN後にも同snapshotで検査する。初期化は既存r3のreadonly検証→write exact再照合→atomic bundleを維持し、grantを新たなreceipt authorityにしない。確定rejectedと失効／timeout unknownを混同しない。

raw Coreを試すunit helperは認可試験ではないと明示する。production repository factoryに認可省略引数・no-op hook・`trusted=true`を設けない。既存API integration／本番mount fixtureは下記§8の実grant/leaseへ更新する。

## 5. B1b-Web：same-originの実leaseとIDB transaction

`adapters/browser/localHostAuthority.ts`を追加し、既存`discoverLocalGrant`／`provisionLocalGrant`から取得したgrantだけを元にopaque leaseを発行する。利用許可は当該browser profile/originのlocal保存域利用者という規則で、Google認証を要求しない。contextIdを秘密扱いしない。callerが渡したnamespace、grant object、assertCurrent関数からleaseを作らない。

認可済みdriverは同じ`CANONICAL_DATABASE_NAME`／version8のreadonly openでschemaを厳密検査する。未来version、必須store/index欠落をempty listや新DBへ変換しない。grant/provisionだけが明示upgradeを使う。通常`IndexedDbEditDatabase.open`は認可済みの既存DBを開く経路へ変え、upgradeを隠れて実行しない。

実portはprivate authorityを必須にして構築し、host factory外からscopeだけで開くproduction入口をなくす。`IndexedDbEditDatabase`のtransactionに`LOCAL_GRANT_STORE`と対象profile/controlを同時に含め、最初のIDB requestでgrant全文を読み、hostのcaptured tupleと一致した場合だけ内容requestを発行する。通常active repositoryは§4.3と同じmethod allowlistで包み、stage/control/remote privileged methodをrejectする。内部`EditDatabase`をfeatureへ公開しない。

既存`CanonicalIndexedDbPrepare.transaction`、`loadIntent`、`CanonicalIndexedDbRead.snapshot`、`CanonicalIndexedDbFoundation`のmetadata／peer transactionにも同じgrant照合を入れる。既存`CanonicalPrincipalLease.assertCurrent/withCommitGuard`はin-memory fenceとして残せるが、DB内grant照合の代わりにしない。実leaseはdriverがprivate authorityから生成する。grant検査を共有する小さな`canonicalHostTransaction` helperを使い、各helperが別の認証規則を持たないようにする。

grant storeをwrite transactionのstore集合に含めることで、別tabのgrant変更と内容commitは同じIDB順序に従う。request callback内で同期のgeneration/対象検査を行い、crypto／fetch／timerをtransactionへ挟まない。commit後もcaptured epochを検査してから結果を返す。versionchangeはconnection closeだけでなくauthority invalidate＋driver listener通知を行う。signal abort／closeは全登録transactionへabortを要求し、late open successを閉じる。

全profile列挙とrequestId lookupはowner capability専用のまま。将来のprovider-bounded leaseをこのreaderへ渡さず、query時に許可Libraryへ絞る別の実capability対応が完了するまで発行しない。隠れたnamespace list APIを新設しない。

`BrowserMarkdownDraftPort`／`BrowserAnnotationAppendDraftPort`／`BrowserReaderStatePort`はstable gateで包み、同期操作もepoch/namespace/Libraryを検査する。MarkdownImagePortは認可済みrepositoryの既存subsetを使う。localStorageのdraft keysは既存完全scopeのまま、grantやselected libraryの保存に流用しない。同processの未確定formはReact owner、耐久draftは既存portが保持する。

## 6. driverのproof呼出しとcomposition

| driver method | 実呼出しと完了条件 |
| --- | --- |
| readHold | Desktop: NativeLegacyStartupの既存read route。Web: holds store専用readonly read、DB未存在はclear、既存DBにholdを検証不能ならthrow。初回readでDB create/upgradeゼロ |
| readLocalContext | 実grant discovery＋schema検査→host lease発行。blockedはretry可能I/O errorとして保持し、setup/emptyに変換しない |
| provisionLocalContext | 固定保存域provision→schema準備→grant再読→lease発行。namespaceはhost結果からだけ取得 |
| discover | owner storage.listの既存profile/intent検証、認可namespaceのみ対象。profileなしcontrolの存在は同namespaceの復旧項目／復旧状態にし、名前を捏造しない。各profileは狭いcontrol読出しでavailable/frozen/recoveryを分類。readonlyでpeer/executeを呼ばない |
| initialization | 実owner leaseに束縛した既存facade。getOrCreatePeer/prepare/query/execute/ackは既存型のまま |
| inspect | 同snapshotでgrant→対象profile→現control→active installed manifest→peerを取得。schema/key/scope/profile来歴を検証、active非null／非frozen、manifest exact一致を確認。必要なCore非同期検証後に同tupleを再読しproofを発行 |
| openScope | proof真正性＋現再検証→stable gate→既存repository/draft/image/reader ports。peerIdは検証した既存peer。scope/resource ports一致を検査。新peer、empty catalog、schema、documentを作らない |
| revalidate | hold clear、実grant、profile/control/manifest/peer、captured generation／取消を再検査。現checkpointを初期manifest hashと比較しない |
| sameAdmission | §3.1のpersistent tuple比較。前proofの失効は比較を妨げないが操作には使えない |
| subscribeInvalidation / close | 実DB/versionchange、host/storage generation、lease失効、page lifecycleをgateへ伝播。closeはowned handleだけdrain/closeし、durable grant/intent/profileを削除しない |

Python inspectはscope不要のidentity限定SQLを`sidecar/canonical_host.py`のread serviceへ置く。`SqliteEditRepository(scope=仮epoch)`で探索しない。IDB inspectは`canonicalProfiles`の`[N,L]`、`datasetControls`の`[N,L]`、`datasets`のactive scope key、`canonicalPeers`のNを読む小さなhelperとする。raw all-store scanやresource BLOB取得は不要。

local-initializeの不変受理証拠と初期物の検証は既存storage/queryの契約を再利用し、現在activeの起動検証と混ぜない。activated-installationのnull証拠はr4どおり許容できるが、grantを持たない既存保存域へ自動adoptionしない。通常の起動では選択Libraryのcatalog/resourceを既存sessionが検証する。

holdはcanonical DB外にある。admission前後の再読と、同processでhold作成時にhost generationを失効させる連携を必須にする。Webの他tab通知／PCの通知は追加の迅速化で、grant/controlの同tx検査を省く理由にしない。全旧writer／他processの停止をhold確認だけで証明したと主張せず、全参加者quiescenceはM6が担う。

共通BootstrapSessionがScopeResourcesからregistry/navigation/ink/replicationを作る責務は維持する。driverが第二registryやeditorを作らない。local用transferは全methodが`remote-unconfigured`を拒否し、replicationは初期suspend。suspended.flushのresolveをupload完了と表示しない。DriveSession／Google permissionIdをlocal namespaceにbindしない。

## 7. 有限差分のファイルmap

| 差分 | 主なfile | 完了点 |
| --- | --- | --- |
| D1 native authority/storage | 新`sidecar/canonical_host.py`、`sidecar/deps.py`、`papeer/core/edit_storage.py`、`edit_repository.py`、`canonical_initialization_sqlite.py` | path固定、readonly schema分離、real lease、同tx grant/active検査 |
| D2 native wire/driver | 新`sidecar/routes/canonical_bootstrap.py`、`sidecar/app.py`、`routes/edits.py`、新`adapters/desktop/bootstrapHostDriver.ts`／認可HTTP helper、`adapters/desktop/editRepository.ts` | bootstrap全method＋全canonical routeの必須authority、旧無lease fallbackなし |
| W1 browser authority/tx | 新`adapters/browser/localHostAuthority.ts`／`canonicalHostTransaction.ts`、`canonicalIndexedDb{Foundation,Read,Prepare,Execute,Storage}.ts`、`indexedDbEdits.ts` | 実grant lease、全read/writeの同tx再照合、取消／versionchange／結果fence |
| W2 browser driver | 新`adapters/browser/bootstrapHostDriver.ts`／対象proof read helper、`legacyBackupStore.ts`のreadonly hold、既存draft/Reader portsのgate wrapper | D2と同じBootstrapHostDriver contract、同origin cold再入 |
| R retained reentry | B3 `bootstrapPorts.ts`のreauthorize追加、Session再入順、両driver stable gate | 同scope/同form ownerを保ちながら新leaseのみで再開、旧callback非公開 |
| T fixtures/gates | 次節の既存fixtureと追加host認可試験 | production bypassなしで従来編集シナリオを維持 |

D1/D2、W1/W2は隔離案で並行準備できるが、actual source統合はSol実行中candidateの凍結を尊重する。B3 pure session／B2 shellの意味変更へ拡大しない。source134全標準成功の有無はRoot/Solの実行報告で更新し、本書で推定しない。

## 8. 既存fixture更新とSol gate

`frontend/e2e/fixtures/editApi.py`は現在`get_edit_connection`を任意fixture DBへ置換し、token dependencyも独自関数へ置換する。実host認可gateでは隔離したdata rootと実PAPEER_TOKENを指定し、本物のgrant path・lease factory・token検証を使うmodeへ更新する。legacyを触らないsentinel試験は維持する。root差替えはprocess開始時の明示test設定で、HTTPでpathを送る仕組みではない。

`frontend/e2e/support/documentComposition.ts`と`fixtures/documentComposition.tsx`の`createDesktopEditRepository(scope, request)`／raw `repository.initialize(empty)`は、実local provision→peer→固定prepare/execute→discover/inspect→認可repositoryへ変更する。namespaceは生成grant結果を用い、Library/root/version等のfixture値は固定request builderへ渡して保つ。既存mountの`{documentLibrary}`注入は維持できるが、そのbinding内のhost repositoryは実lease由来とする。

Webの`editRepository.browser.test.ts`、`editIntent.browser.test.ts`、`webEditStorageRegression`等で本番host adapterを検証するcaseも同じ実provision/leaseへ変える。直接Core/低レベルstorageを検証するdataset transition/migrationの試験は明示したunit境界として保持し、host auth成功へ数えない。host経由stage拒否は別caseで確認する。raw IndexedDB seedingが必要な破損fixtureはtest setupに閉じ、seed後の通常openは実driver認可を通す。

HTTP-lossだけを見ていた`batchCommitSession.test.ts`／`contentPublication.test.ts`のtransport stubは、認可済みclient response変換関数のunitへ分離するか実test authority setupを使う。production APIへ`testLease`／lease未指定許可を追加して旧testだけ通す変更は不可。fixture/manifestの更新は実装差分に含め、旧Reader実行証拠を新candidateへ流用しない。

| gate | 同candidateでの必須確認 |
| --- | --- |
| H1 発行／cold reload | 実bearer PC／same-origin Web、Googleなし、grant provision二request／二tab収束、process/page再起動で同grant＋新lease。無token、偽object/id、旧server generation、異root拒否 |
| H2 transaction | 検証後commit前のgrant revision/control変更・失効、IDB versionchange／abort、SQLite同tx再検査。部分書込みゼロ、commit後失効はdurable保持・旧結果非公開。readonlyでcreate/upgradeゼロ |
| H3 全surface | §4.3全route/methodをparameterizedで検査。別namespace/libraryの名前・件数・body/resource/intent/診断ゼロ。missing lease/admission拒否。stage/control/receive/ack/Driveをlocal capabilityで呼んでも無変更拒否 |
| H4 initialize/proof | 既存r3 unknown/固定要求再送、grant-only正常、壊れたschema/部分Library拒否。inspect中のprofile/control/manifest/peer変更でmount proof不成立。accepted初期epochと現在activeの分離 |
| H5 retained再入 | form＋draft＋pendingを保持した失効→locked→新lease/exact proof→同session/repository/form ownerで再開。旧遅延callbackが新stateを上書きしない。異epoch/profile/grantへrebind拒否。beforeunload/close guard維持 |
| H5b signal/close | openScope／reauthorize resolve後に取得signalをabortしてもruntime I/Oが有効。dirtyでclose拒否後にも編集／保存が可能。guard許可後closeは全resources／driverを一度だけ完了し、新操作不可。未公開candidateだけは旧取得世代の後着でclose |
| H6 実integration | 認可済み本番mount fixtureのPDF/paper/Markdown保存・履歴・reload。B3/B4未接続ならnormal entryとは報告しない。local同期未設定、remote pull/upload成功ゼロ |

provider-cache／descriptor／folder subject照合／Library-bounded query、linked publication barrier、別端末join、provider-cache offline unlock、M6移行は前設計のP1→P2→P3→O1/M6へ続く。local-owner経路が完成してもこの未達を消さない。

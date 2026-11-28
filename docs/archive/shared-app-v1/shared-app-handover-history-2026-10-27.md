# PC・Web共通化 引継ぎ書

作成日: 2026-10-26／最終更新: 2026-10-27（JST）

## 1. 最初に把握すること

- 目標は、計画全体の実装と検証。今回までの実装だけに完了条件を縮めない。
- **既定起動はまだlegacy。** 新しい共通処理は、明示的なbindingを渡したPC・Webの本番mountから実行・検証している。通常起動への切替、旧責務の撤去、全データの切替は未完了。
- 共通Library検索・添付・原訳surface、注釈一覧、版指定移動、固定一操作追記と回復、削除時点比較に続き、**本文highlight CRUD、managed本文選択、同文書の固定readonly参照**を共通entryへ接続した。PC/Webの実mountでmixed PDF/paper、スワイプの先頭着地、cross-pane drain、主Inkの保全と相手hostへの採用を確認した。条件と版を分けた証拠は下の最新チェックリストを優先する。
- 受入台帳は67要件中、**accepted 0 / partial 47 / unverified 20**。Solの証拠監査後にR28をpartialへ更新した。`unverified`には「実装はあるが、その要件全体の受入証拠が揃っていない」ものも含む。未実装一覧そのものではない。
- 実ユーザーのLibrary／Driveを移行・切替したという記録ではない。試験は隔離した一時SQLite・IndexedDB・合成資料を使用した。
- **最新の担当指示: コード実装はGPT 6.1 Terra、デバッグ解析・検証実行・コードレビューはSol、設計・方向設定はAstra。** 2026-10-27の「レビューもsolが次からやって」に続く「実装はGPT 6.1 Terraに依頼して」を反映した。過去のSol実装／Astraレビューは履歴として維持する。
- **現在の統合manifestは142項目。** 共通BootstrapConnectionとpageshow再認可を統合。型4project・lint・関連62件・境界45件、strict Chromium／WebKit UI2case、全frontend1,423成功／benchmark1 skip・両buildが成功。入力DOM／値の保全・非表示／inert・旧flight後の新admissionを確認し、全142hash不変・所有process／PTY残存0。先行134版はbackend17file164/164成功。通常entry／実host認可adapterは未接続である。

### 再開時の作業チェックリスト（2026-10-27、最新）

- [x] 実装担当をGPT 6.1 Terra、検証・レビューをSol、設計・方向設定をAstraへ分担する
- [x] 文字選択handleの押下位置差を補正し、out-and-back／無移動upを保持する
  - [x] Chromium・WebKitの各PC/Web mountでmouse／keyboard代表を別runで通す
  - [x] PDF/PDF跨ぎで残った同じ指のmove/upと全up後の再入力を確認する
- [x] Ink接触試験・pressure observer・resource用process分離runnerを正式位置へ移す（変更manifest58項目）
  - [x] E2E型・lint・関連47件・境界45件を通す
  - [x] Ink初回失敗を保全する（PCのassertは完走、Web開始後の先行PC保存の後着でhistory基準が変わった）
  - [x] Terraが次host入力前の通常同期・同一head／Doc／history／既知batch IDの採用確認を追加する
  - [x] 修正版Ink PDF/PDF試験をSolが再検証する（Chromium1/1、PC/Web両mount、case31.118秒。最新test SHA `92bc561ac297b7828b539a19c3661a48d8ff657e4f0379851d21a809c785450f`）
- [x] 合法な混在Notebookの固定参照ページ設計を作り、設計をSol2名で再確認する
  - [x] Terraが隔離した実装案を作成し、Sol2名が独立コードレビューする
  - [x] 新規参照案の具体P2をTerraが修正する（terminal swipe、lease cleanup、zoom anchor、描画前入力、復元後の再pin、toolbar event、保存待ち中の配置変更、混在fixture初期化）
  - [x] 同期失効bindingの新規入力判定と、継続時の保全guard迂回も修正し、Sol2名の限定再レビューで新P1/P2なしを確認する
  - [x] Sol再レビューが収束した後、実sourceとの三者差分を照合して統合する（23base一致、23ファイル、manifest70項目）
  - [x] 統合後の型・関連unit・境界・契約をSolが確認する（r3、型4project・lint、83/83、45/45、契約・台帳成功）
  - [x] source73と診断追加後source74の全標準検査を別runで通す（各型4project・lint・全単体1,399成功／benchmark1 skip、両build、境界45/45、契約・台帳）
  - [x] 合法なPDF/paper・paper/PDFの参照固定・置換・解除・実キーzoomをChromiumとWebKitの別focused runで各両mount確認する
  - [ ] REF01–12の残行列と、mixed cross-pane／Inkを通常UIから検証する
  - [x] main paper→PDF→paperのtrusted一指swipe、先頭着地、pinned保持を確認する（source72、Chromium1/1・PC/Web両mount、明示的な「読む」mode）
  - [x] canonical main/reference paperのtouch-actionをPDFと揃え、正常な離指と既存cancel/drain単体28件を確認する
  - [x] source73でmixed cross-pane／Ink paperの別focused各1/1を通す（各PC/Web両mount、正規のmixed Notebook、実paper paneへの接触）
- [x] handle修正後の全frontend単体・両build・契約／台帳を通す（1,382成功／benchmark1 skip、境界45/45）
- [x] handle版sourceをexclusive採取し、元ready25秒条件のresource全6件を一つの新runで通す（910files、新run、6/6）
  - [x] 参照ページ統合版source73も新しい922-file freeze・別新runで6/6を通す（元予算、全TAP/cleanup一致）
- [ ] geometry全6件・既存highlight／引用／legacy入力の最終回帰を通す
  - [x] handle後のcold geometryを一つの新runで実行し、5/6成功と未到達failureを保存する
  - [x] 同じ厳格なmodule-only準備を明示採用し、新actual browser・元15/25/180秒条件でsource73 prepared全6件を通す（cold起動の成功とは区別）
- [x] 保存・引用／capture・legacy入力の回帰を版を分けて確認する
  - [x] source73 quote同一2/2、legacy touch／wheelの別run各1/1を通す
  - [x] source74 highlight同一2/2で4hostの選択受付・draft作成成功snapshotを保存する
  - [x] 旧source73 WK form待機失敗は原因未確定として保持し、actual-handler診断を追加する（falseをfont単独失効と誤解しない）
- [ ] 通常起動へ接続するためのcanonical初期化を進める
  - [x] Astraのprofile／peer／初期化・固定publication・durable intent設計をSolで反復確認する
  - [x] TerraがCoreの型／TS・Python admission／共通fixture・source testsを隔離draftに実装し、Sol2名が再レビューする
  - [x] 隔離したgeneratorで契約を生成し、隔離先の`--check`を通す
  - [x] import／migration用profile origin、durable account intent、post-ack再送と部分状態の設計をAstra／Solで確認する
  - [x] r4 Core／SQLite draftのnullable型・list／checkpoint／controlの受理proofを修正し、Solの限定再レビューで新P1/P2なしを確認する（sourceのみ、未実行）
  - [x] Coreを実sourceへ統合し、生成・型・TS/Python契約・unitを実行する
  - [x] TS/Pythonで同じ固定requestの1,466 UTF-8 bytes・digest・checkpoint hashを照合し、共通fixtureと恒久testへ固定する
  - [x] 共有account intentとSQLite atomic storageを実sourceへ統合し、16file160件と全frontend標準検査を通す
  - [x] 通常のreadonly repositoryで初期root／checkpoint／heads／history／receiptsを読み、DB bytes不変、ack後再open、同accountの独立2Libraryを恒久testで確認する
  - [x] Web同一DBのschema・peer作成・readonly snapshot／accepted proofの隔離案を実装し、Solがsource reviewする（未実行）
  - [x] Web providerのprepare／execute／ackとatomic再照合を実装し、Sol分担レビュー・全表取得／late-open修正後に21fileを正式統合する（113項目）
  - [x] 統合したWeb providerの型・関連unit53件・境界45件・Chromium／WebKit正常／fault10caseを通す（fake OWNER／注入quota／同page2connections）
  - [x] Web provider統合後の全frontend unit1,406成功／benchmark1 skip・PC/Web buildを通す（source113）
  - [x] 次の有限実装契約B1〜B5をAstraが作成し、Solがlocked時form保全のP2修正後に再確認する
  - [x] TerraがB2 scope binding／空shell／nullable navigation案とB1a local grant／SQLite・IDB保存案を別outputへ実装する（未統合・未実行）
  - [x] B1a／B2案をSolがレビューし、TSの末尾改行ID受理と外部navigationのscope未照合を修正・再確認して正式統合する（134項目、契約生成済み）
  - [x] source134の型・lint・関連TS103／Python47・境界45・SQLite／IDB schema8／空Library UI／旧保存のbrowser13caseを検証する
  - [x] source134の全frontend1,409成功／benchmark1 skip・PC/Web build・backend17file164件を通す
  - [x] B3共通BootstrapSession／固定要求builderをSol2名で反復レビューし、計6P2を修正後に正式統合する（138項目）
  - [x] B3の型4project・lint・関連94件・境界45件・Chromium navigation／空Libraryの画面回帰2caseを通す
  - [x] source138の全frontend1,423成功／benchmark1 skip・PC/Web buildを通す
  - [x] B3b共通起動画面／pageshowの旧flight後再admissionを修正・再レビューして正式統合する（142項目）
  - [x] source142型4project・lint・関連62件・境界45件、Chromium／WebKitのfake-host UI2caseを通す（hidden／inert／入力保全／I/O停止と復帰）
  - [x] source142の全frontend1,423成功／benchmark1 skip・PC/Web buildを通す
  - [ ] r5のlocal grant／Drive descriptor／Library単位capabilityとhost auth portを実装する
  - [ ] scope-only binding、名前付きchooser、空Library shell、通常entryを実装・検証する
- [ ] Safari／iPad／Pencil実機と未実施入力matrixを別記録する
- [ ] 元のM0–M6／67要件の残作業を継続する（既定legacy切替・旧責務撤去を含む）

### 次の実装再開点

1. 先行source92の全標準検査時manifest SHA256は `b7d24a537b0e3af44dc3ac78569703e96b08c9b9f7bf87d1d846abffbb016499`、要約は `output/shared-app-bootstrap-storage-standard-summary-r1.json`。その後、独立Solが無関係PDF bytesの全表取得をP2として発見し、TerraがSQLで対象account/libraryに絞る修正と回帰testを追加した。SQL修正後の92項目manifest SHA256は `4e671eee7ab0a899863ad1302f73a6a4a8e6ecbc90c8ac996ccc961350dfd8c6`。Sol再レビューは新P1/P2なし、focused17/17・同じbackend16file161/161、generator／台帳／diffcheck成功、全92hash不変・所有process／PTY残存0。要約は `output/shared-app-bootstrap-sqlite-scope-summary-r1.json`。現在は下の113項目版へ進んでいる。再編集前に検証担当Solの実行状態を確認する。
2. CoreとSQLiteは既に実sourceへ統合済み。原本checkpointは `output/shared-app-bootstrap-core-install-checkpoint/install.json`、`output/shared-app-bootstrap-storage-install-checkpoint/install.json`、恒久readback追加は `output/shared-app-bootstrap-readback-test-checkpoint/install.json`。実テスト160件は一時DBとfake OWNER leaseの証拠で、並列Library作成・実認証・通常entryの受入ではない。
3. Web providerは正式統合済み。`output/shared-app-bootstrap-indexeddb-install-checkpoint/install.json` SHA256 `84e1827bfd022132cf2252aa11088d5c446ea0f67a0cb7def2c274c6f5e681ab` にadapter／registry／旧manifestと20新規不在記録を保存した。初回113manifestは `3a4d2a03…`、fixture型修正後の現在SHA256は `011d415623e82be46a275df615ab4005732af69285b682b977a521c539d21289`、原本は `output/shared-app-bootstrap-indexeddb-type-fix-checkpoint/fix.json`。同じ `papeer-shared-edits` をv6→v7とし、prepare→execute(requestIdのみ)→ackをatomic確定する。関連検査r2と両engine計10caseが成功。要約は `output/shared-app-bootstrap-indexeddb-quick-summary-r2.json` と `output/shared-app-bootstrap-indexeddb-browser-summary-r1.json`。全unit／両buildを続行中。namespace OWNER fake lease・注入quota・同page2connectionsに限定し、実認証・実容量枯渇・独立2tab・通常hostの受入とはしない。
4. 通常起動設計は `docs/shared-app-canonical-bootstrap-design.md` r2〜r5。local grantとDrive subjectを分け、既存namespaceの所有権をremote descriptorだけで与えない。同namespaceの別Libraryを隠すprovider capabilityをtrusted境界で適用する。現在のOWNER限定listをLibrary限定providerへ渡さない。fresh local initのみ非null proof、import/migrateは別origin、active epochはcontrolだけをauthorityとする。
5. 先行source134は初回lint1件をnavigation seed／memo依存の有限修正で解消した。manifest SHA256 `bdeb5483216a4b2ad40c3d09b09bd679d056da1a440135156675292783a12338`。確定要約は `output/shared-app-local-grant-scope-{quick-summary-r2,browser-summary-r1,standard-summary-r1}.json`、元lint failureはr1に保全。全134hash一致・所有process／PTY残存0。B2原本は `output/shared-app-library-scope-install-checkpoint/`、B1aは `output/shared-app-local-grant-install-checkpoint/`、memo修正は `output/shared-app-library-scope-memo-fix-checkpoint/`。実認可・通常entryは未接続。
6. B3は6P2を修正しSol2名の再確認後に正式統合した。現在138項目manifest SHA256 `cedba34a8abd84414c8b006ec0031d47c957e4ac49540af7b4a3d0a298927540`、registry `defa71fb3acb452f066c1c9bd2dfdb5d56eec2add2501519c6815321098ffea6`。原本は `output/shared-app-bootstrap-session-install-checkpoint/`。確定要約は `output/shared-app-bootstrap-session-{quick-summary-r1,browser-summary-r1,standard-summary-r1}.json`、全138hash一致・所有process／PTY残存0。fake driverの共通sessionと既存明示mount回帰であり、実host起動ではない。
7. B3bは旧flight合流後に共通Session.resumePageで新admissionを行う修正と、fixtureの自動open前提修正後に統合した。現在142項目manifest SHA256 `fed28edf4939cf24a5bbd5d1068a073f08d30a718e99292d1cfdd92b749ebd9f`、registry `ddf4ef25288d6ca376c28ae200b552f4365fac510f83e0a649949d0fd495a9d1`。原本は `output/shared-app-bootstrap-connection-ui-install-checkpoint/`、runner原本は `output/shared-app-bootstrap-connection-ui-runner-fix-checkpoint/`。strict不足をbrowser前に検出し、Terraがrunnerのみ修正後に実UI2/2成功（13.98秒）。確定要約は `output/shared-app-bootstrap-connection-ui-{quick-summary-r1,runner-quick-summary-r1,browser-summary-r1,standard-summary-r1}.json`。全142hash不変・所有process／PTY残存0。fake host UIで、実driver起動ではない。
8. 実host側は全て未統合・未実行。D1b `output/shared-app-native-authority-hooks-draft/` はauthority失敗→aborted分類を修正し再確認済み（`a2c1074c…`）。D2 server `output/shared-app-native-bootstrap-driver-draft/` はhold／capability失効を同lockへ修正し再確認済み（`694d6dcc…`）。Desktop driver `output/shared-app-native-desktop-driver-draft/` は未レビュー、共有gateへのrebaseと既存fixture移行が必須。W1a `output/shared-app-browser-authority-draft/` は3P2修正後clear（`06c27586…`）、W1b hooksは準備のみで全repo／bootstrap未接続。共通transaction設計 `docs/shared-app-repository-transaction-design.md` はSol2名確認とouter unknown責務の有限修正後の再確認までclear（232行、SHA256 `fdcfe1ff23b510551e0d48ecc350a5029bbab17315809171d135c208f75d5e7d`）。TerraがT0 shared RuntimeIoGateを `output/shared-app-runtime-io-gate-draft/`、別TerraがT1 Core snapshot／PlanView＋memoryを `output/shared-app-repository-plan-draft/` に実装中（未統合・未実行）。T1はT2のcoherent adapterが揃うまで実sourceへ入れない。T2 exactCAS→T3/4全adapter・fixture→実driver／通常entry→残機能・全M6を完遂する。

参照ページは `output/shared-reader-reference-implementation-draft/` の反復修正後、実sourceへ正式統合した。全23baseが一致し衝突なし、原本と不在ファイル記録は `output/shared-reader-reference-install-checkpoint/install-hashes.json`。旧shallow cloneとmain/reference位置結合を置換。統合後の初回型3error、r2のtest型2error／lint4error、試験readinessとobserverの登録順／event phaseの問題をTerraが修正し、Sol再確認後のr3 quickは全成功した。要約は `output/shared-reader-reference-quick-summary-r3.json`。readonly観測口は実入力portを毎回読むscalar queryのみで、書込み・ready生成・別registryを持たない。実画面・全unit・両buildとREF行列は未検証なので機能受入は未完了。Ink旧失敗は `output/shared-app-f20-staged-ink-contact-failure-summary-r1.json`、修正後成功は `output/shared-app-f20-staged-ink-contact-sync-summary-r2.json` に保全した。PCの保存2batchをWebが採用してから入力し、Web側の保存後は計4batch／履歴4件、全strict観測空、当時58hash不変、所有process／temp残存なしを確認。証拠はChromiumのCDP pen/touchに限定し、paperや実機へ流用しない。handle版standardの要約は `output/shared-app-f20-staged-handle-standard-summary-r1.json`（graph439 source）。旧成功数と新sourceの検証結果を合算しない。

上記quick後の参照UIは、readonlyへ付かないselection属性と既定blank PDFへの文字要求という試験条件を修正し、正規の`pdfFixture: 'text'`でChromium1/1（20.228秒）・WebKit1/1（59.069秒）が別runで成功した。各PC/Web両mountでmixed表示・唯一のReader/no reference writer・pin/replace/clear・一回のtrustedキーとactual port zoom/settled幅増加・main page保持を確認。要約は `output/shared-reader-reference-browser-{chromium,webkit}-summary-r3.json`。先行WK起動失敗の原因は未確定で、後run成功を原因解消と読み替えない。全unit／両buildとREF全行列はなお残る。main swipeの新testを追加してmanifest72項目となり、旧UI labelと読むtool前提を修正して検証中。失敗ログ・actual traceは `output/shared-reader-main-swipe-browser-failure-summary-r{1,2}.json` に保持している。

handle後cold geometryは `output/shared-app-f20-staged-handle-geometry-failure-summary-r1.json`。Chromium3件・WebKit2件成功、最後のWebKit拒否系は最初の`page.goto(load)`15秒timeoutで、capture/admission実行は0、strict監視は全種空。teardown後の到着を期内回復の証拠に使わない。Astraは同一の厳格module-only準備による機能試験を条件付き採用した（新actual browser、PDF/font/worker/control/canvas/文書状態を先行成立させない、元予算維持）。coldの失敗解消・単一6成功はまだ主張しない。

handle版resourceは独立した新run `964ddb51-a71a-4d00-886a-885ee846f309` で6/6成功（151.865秒）。installed source910filesのexclusive hash `63493ceea4bb80194f72c1b74ea08de17aeac9abda907dbd157dc463a4f1a937`、元nav15/ready25/case180、各child一回、全TAP/cleanup marker/source照合一致。lock除去・所有process/PTY残存なし。要約 `output/shared-app-f20-staged-handle-resource-summary-r1.json`、生記録 `output/canonical-pdf-resource-isolated-runs/964ddb51-a71a-4d00-886a-885ee846f309/`。参照ページ統合前のappによる証拠であり、後続の変更へ無条件に引き継がない。

## 2. 作業ツリーと資料

| 項目 | 引継ぎ時点 |
| --- | --- |
| リポジトリ | `<repo>` |
| ブランチ | `feature/notes-foundation` |
| HEAD | `b54054a47a9450946b6ff82df602abc83ebac3a9` |
| 作業状態 | 大量の変更・未追跡ファイルあり。今回の実装は未コミット |
| 環境 | Windows / PowerShell、Node v24.20.0、npm 11.19.0、uv 0.11.23 |

**HEADだけを取得しても現在の実装にはならない。** 未追跡ファイルを含む作業ツリーを引き継ぐこと。既存差分を`reset`・`clean`等で消さない。削除扱いの旧adapterもあり、機械的に復元しない。

- [計画書](shared-app-plan.md): M0〜M6、F01〜F38・R01〜R29の全範囲。
- [設計書](shared-app-design.md): 採用する責務分離・保存・入力・移行仕様。
- [次工程の具体案](shared-app-next-steps-astra.md): Astra再設計と現在の着手順。
- [固定参照ページ設計](shared-reader-reference-page-design.md): 同文書のreadonly参照・位置／入力寿命・REF01–12。
- [通常起動・初期化設計](shared-app-canonical-bootstrap-design.md): 認可済みLibrary discovery、profile／peer、初期化・Drive admission。
- [通常起動の有限実装契約](shared-app-bootstrap-connection-design.md): local grant、scope binding／空shell、BootstrapSession、実hostと通常entryへの接続順。
- [実hostの認可・driver対応表](shared-app-local-host-driver-design.md): 固定保存域、実lease、全transaction／route検査、保持runtimeの再認可、fixture更新。
- [共通repository transaction設計](shared-app-repository-transaction-design.md): readonly snapshot、Core内plan、exact CAS／atomic apply、共通I/O gateとunknown分類。
- [実装・検証記録](shared-app-implementation.md): 工程ごとの実装、正確な検証範囲・ログ。
- [反復レビュー記録](shared-app-review-cycles.md): 指摘・修正・再確認の経緯。
- [受入台帳](shared-app-acceptance.json): 要件ごとの状態・証拠。
- [共有entry台帳](../frontend/src/runtime/sharedEntries.json): `staged`は既定起動への統合完了を意味しない。

引継ぎ用の差分一覧は`output/shared-app-handover-git-status.txt`、F37到達時のgraph・source hashは`output/shared-app-annotation-browser-module-graph.json`（以前の写しも保持）。**outputはGit管理外**なので、別環境へ渡す場合はログも別途保全する。

## 3. 採用方針・変えてはいけない境界

表示・入力、操作／状態、接続インターフェース、環境別保存／転送を分ける。共通featureからPCストア・ローカルAPI・Driveを直接参照させない。入力機器はイベント、配置は表示領域の寸法で判断する。

互換性維持だけを理由に不整合なモデルを残さず、理想形へ整理する。一方、旧データのraw保全、未送信内容、再試行ID、競合枝・履歴・resourceの保全を省略しない。全アプリを万能store／command busへ押し込まない。

保存は一つの対象に一つのauthorityを置く。結果不明を失敗確定・取消成功と解釈せず、同じID・要求内容で再試行する。新旧への自動二重書込みで切替の不足を補わない。

## 4. 実施済みの内容

下表は実装・工程内検証済みの範囲。機能全体の最終受入、既定起動への切替、実機完了を意味しない。

| 領域 | 実施したこと |
| --- | --- |
| 保存基盤 | 安定ID、canonical snapshot／batch、因果関係を持つ履歴graph、SQLite／API・IndexedDB、journal、同ID再送、resource先行転送、通常同期、dataset／checkpoint／controlの基礎 |
| PDF・手書き | 共通の全7tool、図形、選択・変形・文字・消去の基礎、文書session／履歴、入力所有、共通toolbar、paper／PDF表示への接続 |
| Reader | fit-page下限・400%上限、測定した表示倍率からの拡大、共通キー／wheel／touch操作、先頭／末尾着地の区別、位置・履歴・参照面、背景版付き引用jump |
| paperノート | ページ追加・複製・移動・削除、用紙変更、物理位置／線幅維持、はみ出し拒否と明示fit、文書Undo |
| Markdown本文 | 唯一の編集session、autosave、保存中追加入力、scope付きdraft、失敗・再起動回復、Undo／Redo、owner保持、中央／右配置、複数headの明示選択 |
| Markdown画像 | 本文と必須manifestの一体保存、ID／hash付き内部URI、bytes検証、先行同期、Blob URL寿命、SVGをimgとして表示、画像と後続入力・履歴の回復 |
| 引用・capture | 同scope資料切替、原文のstable page／背景版／pt anchor、文章選択と宛先選択、領域PNG＋出典の同一append。captureは手書き・図形の包含optionあり |
| Library | 共通一覧、Markdown／白紙ノート作成、原子的初期公開、改名、有限Undo／Redo、保存失敗・再起動回復、見出し更新と本文editorの分離 |
| タグ・既読 | 単一／複数対象の追加・削除・置換、既読／未読、一括一batch・一Undo、入力固定、無変化、競合検出、折畳み後の入力保持、相手hostへの同期 |
| 付箋編集 | 原文／訳文／paperの作成・本文／分類／色／位置変更・削除、同authority／文書Undo、draft再取得、F37明示編集、保存応答消失時の同ID再送、remote更新／削除時の拒否と取消 |
| 品質管理 | transitive依存境界検査、source graph、要件台帳、実SQLite＋IndexedDBを使う両本番mountのChromium／WebKit試験、反復Astraレビュー |

captureはcanonical InkObjectsが対象で、canonical付箋・本文highlightを含む全注釈capture／exportは未完了。原訳collectionは両explicit mountへ接続済みであり、既定起動への切替・旧責務撤去とは区別する。

## 5. 前工程の実装範囲: フォルダー階層

### 入っている差分

- TS／Pythonに`ownerId !== null ⇒ folderId === null`を追加。owned note／attachmentの表示位置はownerから導出する。
- 共有fixtureに拒否例と、owner移動→note独立化の有効例を追加・再生成。
- folder作成・改名・移動、独立itemの一括移動、内容を残すfolder削除、有限inverseと厳格な再送検証。
- 削除は直下folder／itemを親末尾へ移し、子孫と本文を残す。論理削除済みitemのfolder参照も処理する。
- folder／item混在の位置順を保つ。作成・移動・note作成で同じ末尾位置計算を使用。
- `LibrarySession.folders`／`createdFolderId`、選択folderへのnote作成。folder作成結果でdocumentのauto-openを起動しない。
- IDベースの階層表示、開閉、上下・左右・Home／End・Space／Enter、focus復帰。owned itemはowner配下一箇所に表示。
- 深さ4000のprojection／focus試験。再帰走査をstackへ変更し、UIの祖先探索をMap化。選択肢の経路表示も無制限に展開しない。
- folder編集draftを親で保持。通常pollで閉じた階層を勝手に再展開せず、選択資料の配置変更時だけ祖先をreveal。
- `beforeunload`を`LibraryContentConnection`へ集約。Doc／Markdown個別listenerを撤去し、本文controllerがまだない段階のmetadata保留も共通入口で扱う。

### 主要ファイル

| 責務 | ファイル |
| --- | --- |
| モデル不変条件 | `frontend/src/runtime/edits/editModel.ts`、`papeer/core/edit_model.py` |
| 共有fixture | `tools/build_edit_fixtures.py`、`tests/fixtures/shared-edits.json` |
| 操作／inverse | `frontend/src/features/library/canonicalLibraryOperations.ts`、`libraryHistory.ts` |
| 保存authority | `frontend/src/features/library/LibrarySession.ts` |
| 可視行／キー／focus | `frontend/src/features/library/canonicalLibraryTree.ts` |
| 共通UI | `LibraryCatalogPanel.tsx`、`LibraryHierarchy.tsx`、`LibraryFolderEditor.tsx`（同directory） |
| 共通退出guard | `frontend/src/features/reader/LibraryContentConnection.tsx` |
| 新規実画面試験 | `frontend/e2e/webDocumentLibraryFolders.browser.test.ts` |

### レビューで修正した点・注意

1. 削除時にsnapshot格納順で再採番して表示順が逆転する問題を修正。folder／item混在の`position → kind → ID`順を守る。
2. 作成／移動の末尾計算がfolderだけ・itemだけだった点を共通化。
3. delete Undo後のRedoで、当該操作が戻した既知参照まで「新参照」として拒否する問題を修正。初回一度の失敗は修正前の条件で説明でき、未解明flakeとして放置していない。
4. 深階層での再帰overflow・祖先の反復線形探索を修正。
5. FolderEditorの`targetsAvailable`、LibraryCatalogPanelのfocus/選択分離・`library-folder-title-changed`文言・`createdFolderId`展開範囲・WebKit `reload`時の`!replication.error && active.current`ガード、および`LibraryContentConnection`の`beforeunload`集約について独立Astraレビュー（初回＋再レビュー0件）とChromium／WebKit実画面確認を完了した。

**当時の残件**だった回復一覧・後着編集・書誌情報・検索・添付・通常作成Undoは後続工程で接続済み。現在はフォルダーdrag/drop／複数選択／並べ替え、専用比較（F38）、機能判定（F32）、訳文surface、付箋／highlight一覧（F37）、既定起動切替等が残る。最新台帳は**accepted 0／partial 40／unverified 27**。

### 直近完了: 資料関連・note独立化・owner削除モード・観測heads付き論理削除（F33 / F38）

- 独立PDFと独立noteの双方向関連（単一／一括のdialog追加・HTML5 drag/drop追加・重複no-op・関連解除・双方向`↗`リンク行表示とクリック移動）。
- owner配下への付属ノート作成（`ownerId !== null, folderId === null`）と、owned noteのownerフォルダー末尾への独立化（`detachNotes`）。
- 対象資料・子ノート・追記先（`NoteAppendSession.destinationId`）に未保存／送信待ち編集がある場合の削除前共通guard（`prepareDeleteTargets`／`canDeleteTargetsSync`）。
- owner削除時の既定`detach`（子ノートを残して関連を解除）と明示`delete`（内容も削除：子ノートも論理削除）の2モード、各対象contentの`observed` heads記録、有限Undo／Redo、応答消失時の同ID再試行。
- 表示中active資料が論理削除された場合の読み取り専用遷移（`useLibraryItemDeleted`、`editable: false`、`この資料は削除されています。新しい編集はできません。`／`この資料は削除されています（閲覧のみ）`）とUndo時の編集再開、および削除済み`source`の`ContentNavigationSession.back`への追加抑止。

## 6. 検証状況

### A. タグ工程終了時の実画面検証済みcheckpoint

| 検証 | 結果・証跡 |
| --- | --- |
| 全frontend単体 | 1,121成功、benchmark1 skip。`output/shared-app-library-tags-unit-final.log` |
| 型4project／lint／両build | `output/shared-app-library-tags-{typecheck,lint,build-desktop,build-web}-final.log` |
| 新規タグ実画面 | 2/2成功。Chromium44.02秒／WebKit181.50秒。`output/shared-app-library-tags-browser.log` |
| 既存実画面回帰 | 作成・改名・dirty Markdown見出し・PDF Readerの8/8成功。`output/shared-app-library-tags-regression.log` |
| Python関連 | 契約・intent・repositoryの33成功。`output/shared-app-library-tags-python.log` |

新規／既存のrunは別々。いずれもapp error・unhandled・禁止request・caught navigation診断0、関連process・今回temp残存0。全Python・実iPad／Safari／Pencilを実施したという意味ではない。

### B. フォルダー階層・共通退出guardの実画面検証済みcheckpoint

| 検証 | 結果・証跡 |
| --- | --- |
| 全frontend単体 | **1,134成功、benchmark1 skip、失敗0**。`output/shared-app-library-folders-unit.log` |
| 型4project／lint／両build | 成功。`output/shared-app-library-folders-{typecheck,lint,build-desktop,build-web}.log` |
| 新規フォルダー実画面 | **2/2成功**。Chromium38.03秒／WebKit110.21秒（総148.91秒）。`output/shared-app-library-folders-browser.log`（初回WebKit reload失敗ログは`output/shared-app-library-folders-browser-initial-failure.log`に保存） |
| 既存実画面回帰 | 作成・改名・タグ・dirty Markdown見出し・PDF Readerの**10/10成功**（総601.84秒）。`output/shared-app-library-folders-regression.log` |
| Python関連 | **48成功**。契約・intent・repository・publication。`output/shared-app-library-folders-python.log` |

### C. 資料関連・note独立化・owner削除・観測heads付き論理削除の実画面検証済みcheckpoint

| 検証 | 結果・証跡 |
| --- | --- |
| 全frontend単体 | **1,138成功、benchmark1 skip、失敗0**（31.22秒）。`output/shared-app-library-relations-unit.log` |
| 型4project／lint／両build | 成功。`output/shared-app-library-relations-{typecheck,lint,build-desktop,build-web}.log` |
| 新規関連・削除実画面 | **2/2成功**。Chromium59.87秒／WebKit210.75秒（総271.30秒）。`output/shared-app-library-relations-browser.log`（初期失敗ログは`output/shared-app-library-relations-browser-{initial,second,third,fourth}-failure.log`に保存） |
| 既存実画面回帰 | 作成・改名・タグ・フォルダー・dirty Markdown見出し・PDF Readerの**12/12成功**（総738.83秒）。`output/shared-app-library-relations-regression.log` |
| Python関連 | **137成功**（13.91秒）。`tests/test_edit*.py`・`tests/test_content*.py`。`output/shared-app-library-relations-python.log` |

上記検査は全てterminal終了し、関連process・temp残存0を確認済み。

### D. ユーザー側で進めた回復・書誌情報のcheckpoint

新規2/2成功（総214.10秒）、関連14/14成功（総1220.58秒）、単体1,140成功・benchmark1 skip、Python関連143成功。ログは`output/shared-app-library-recovery-metadata-{browser,regression,unit,python}.log`。検索追加前の証跡として保持する。

### E. 今回の共通Library検索のcheckpoint

| 検証 | 結果・証跡 |
| --- | --- |
| 新規検索の実画面 | 2/2成功。Chromium35.60秒／WebKit71.85秒（総109.32秒）。`output/shared-app-library-search-browser.log` |
| 既存の作成・folder・tag・Markdown | 8件成功。`output/shared-app-library-search-regression.log`は回復試験2失敗を含むexit 1の初回runとして保持 |
| 修正後の回復試験 | 別runで2/2成功。Chromium37.35秒／WebKit127.55秒（総165.46秒）。`output/shared-app-library-search-recovery-regression.log` |
| 全単体 | 1,150成功・benchmark1 skip・失敗0（43.98秒）。`output/shared-app-library-search-unit.log` |
| 型・lint・両build | 全て成功。`output/shared-app-library-search-{typecheck,lint,build-desktop,build-web}.log` |
| Python保存受入 | 契約・intent・repository・publicationの48成功。`output/shared-app-library-search-python.log`。上記Dの143件とは別scope |

回復試験は、タイトルと本文の同名h1をframeタイトルへ限定し、未同期peerのpullだけを一時的な空deltaにして後着編集の順序を固定した。productionの保存・回復処理は変更せず、実編集／耐久化／readonly／復元／履歴assertを保持する。関連10件が単一runで成功したという記録にはしない。依存境界は全単体内で成功、台帳checkも成功。実機・全release suite・大規模性能は未確認。

### F. 添付・通常作成Undoのcheckpoint

| 検証 | 結果・証跡 |
| --- | --- |
| 新規添付実画面 | 2/2成功。Chromium43.99秒／WebKit109.02秒、総153.59秒。`output/shared-app-library-attachments-browser.log` |
| 既存回帰 | 元3suite runは5成功／WebKit reload診断1失敗（exit1）を`output/shared-app-library-attachments-regression-initial-failure.log`に保持。回復suiteを別runで2/2成功（37.35秒／145.30秒）。作成・Markdown各2件も元runで成功 |
| WebKit独立再現 | catalog内のcatch構造でpageerror10、innerCaught20、completed10、unhandled0。`output/shared-app-library-attachments-webkit-catalog-repro.log`。exact engine/host/reload/read endpoint/stackに限定した分類を独立レビュー済み |
| 全単体 | 1,170成功、benchmark1 skip、失敗0（44.09秒）。`output/shared-app-library-attachments-unit.log` |
| Python | 編集／content／bibliographyの143成功（33.20秒）。`output/shared-app-library-attachments-python.log` |
| 型・lint・依存境界 | 成功。`output/shared-app-library-attachments-{typecheck,lint,acceptance-check}.log`。依存境界は単体内でも検査 |
| PC/Web build | 最終sourceで両方成功。`output/shared-app-library-attachments-{build-desktop,build-web}.log` |

初回browserのempty local catalog→item未取得による起動停止は`libraryContentKind`の同期1回で修正し、initial multiheadからの明示選択をloader closeguardで回復した。初回0/2は`...-browser-initial-failure.log`に保持する。read-only添付はexact item IDで開き、content rootを作らず、元bytes/hashと同ownerの子ノートを保持する。HTML/Markdownはescaped source＋download。未耐久sourceの同process保持と退出guardを、reload保全完了とは記録しない。

## 7. 全計画の実施状況・TODOリスト

`[x]`は記載した範囲を実施済み、`[ ]`は残作業を示す。実装と最終受入は別項目に分けている。小分類がすべて完了し、証拠を確認してから大分類をチェックする。新構成の画面接続済み項目も、既定起動への切替完了を意味しない。

- [x] 共通保存・同期の基礎実装
  - [x] 安定ID・canonical snapshot／batch・因果履歴graphを実装する
  - [x] SQLite／APIとIndexedDBのrepositoryを共通契約へ接続する
  - [x] journal・同ID再送・結果不明時の保持を実装する
  - [x] resource先行転送と通常同期を実装する
  - [x] checkpoint・dataset manifest／controlの基礎を実装する

- [ ] フォルダー階層の仕上げ
  - [x] 所有itemのfolder排他条件をTS・Pythonと共有fixtureへ追加する
  - [x] フォルダー作成・改名・移動・内容保持削除と有限inverseを実装する
  - [x] 階層表示・開閉・キー移動・focus復帰の共通UIを接続する
  - [x] 選択フォルダーへのノート作成を実装する
  - [x] 深さ4000の階層projection／focus回帰を追加する
  - [x] 共通退出guardのコードをLibraryContentConnectionへ集約する
  - [x] 最新のroot追加差分を独立再レビューする
  - [x] PC・Webの最新ビルドを通す
  - [x] 作成・改名・移動・内容保持削除・Undo／Redoを両版の実画面で確認する
  - [x] 選択フォルダーへの実ノート作成を確認する
  - [x] 本文controller未準備時を含むmetadata保留の共通退出guardを確認する
  - [x] 既存の作成・改名・タグ・Markdown・Readerの関連回帰を通す
  - [ ] drag/drop・複数フォルダー操作・focus・並べ替えを仕上げる
  - [x] F31の証拠と受入台帳を更新する（partial）

- [ ] PDF入力・注釈の仕上げ
  - [x] 全7tool・図形・文字・選択・変形・消去の基本経路を共通化する
  - [x] 文書session・履歴・入力所有と共通toolbarを両版の新構成へ接続する
  - [x] paperノートのページ追加・複製・移動・削除・用紙変更を接続する
  - [ ] 全tool・文字draft・選択・変形の最終受入を確認する
  - [ ] clipboard・消去・文書Undo／Redoの全経路と失敗回復を確認する
  - [ ] lock・表示切替・一覧・設定・狭幅での全tool到達を仕上げる
  - [ ] 付箋・本文highlightの編集UIを共通化し、文書Undoへ統合する

- [ ] Reader・原訳表示の仕上げ
  - [x] fit-page下限・400%上限と共通倍率操作を実装する
  - [x] 通常stepの先頭着地とPageUp等の末尾着地を分離する
  - [x] 位置・履歴・参照面と背景版付き引用jumpを接続する
  - [x] 明示bindingの両mountで訳文collectionの画面と原訳mappingを接続する（既定起動・旧経路撤去は未完了）
  - [x] 左右一つのtoolbar・文書履歴、実pageごとの位置、訳文未対応placeholderを実画面で確認する
  - [x] 異寸法の原訳でfit下限・リサイズ・入力面切替・文字draft guardを両engineで確認する
  - [ ] 翻訳済みfilter中のstep・指定移動・履歴・解除・空集合・更新を確認する
  - [ ] PDF検索・目次・内部link・named destinationを共通入口へ接続する
  - [ ] 遅い取得・旧描画callbackを取り消し、古い位置への誤着地を防ぐ
  - [ ] 全入力の着地・位置復元・異寸法の倍率下限を最終確認する

- [ ] capture・注釈付きexportの完成
  - [x] PDF文章選択・引用先選択・出典付きノート追記を接続する
  - [x] 領域PNGと出典を同じappend・履歴操作へ含める
  - [x] 手書き・図形の包含optionとcrop・resource検証を実装する
  - [ ] 全注釈・全page・未耐久確定編集を開始時snapshotへ固定する
  - [ ] 並行編集・lock・非表示optionを正しく扱う
  - [ ] font・resource不足を欠落成功にせず、対象を示して失敗させる
  - [ ] 回転・CropBox・UserUnit・DPR混在を実画素で確認する
  - [ ] clipboard拒否時のdownload等を接続する

- [ ] Markdownの残機能
  - [x] 唯一の編集session・autosave・保存中追加入力・Undo／Redoを接続する
  - [x] 未保存draft・保存失敗・再起動の回復と編集owner保持を実装する
  - [x] 画像manifest・bytes／hash確認・先行同期・Blob URL解放を接続する
  - [x] SVGをimgとして表示し、本文・画像・引用の共通経路を検証する
  - [ ] テンプレート・lightbox・importを共通経路へ接続する
  - [ ] 競合比較・両方保持・再編集を画面へ接続する
  - [ ] 既存画像・引用を一回変換し、resourceと参照を保全する

- [ ] Libraryの残機能
  - [x] 共通一覧とMarkdown／白紙ノートの原子的な作成を接続する
  - [x] 改名・有限Undo／Redo・保存失敗と再起動後の同ID復旧を接続する
  - [x] タグ・既読の単一／一括変更を同じ保存・履歴経路へ接続する
  - [x] タグ入力の折畳み保持・未編集置換の競合検出・無変化を検証する
  - [x] 本文editorを再読み込みせず資料名の見出しを更新する
  - [x] 関連の追加・解除、owner解除・削除、note独立化を実装する
  - [x] 添付import・改名・論理削除、resource先行保存、同ID再試行・公開前取消・exact ID表示を両explicit mountへ接続する
  - [x] PDFの書誌metadata編集・期待値検証・有限Undo/Redo・入力保持を接続する
  - [ ] 文書種類・サービス・データに基づく権限判定全体を仕上げる
  - [x] 観測heads付き論理削除・削除Undo/Redo・削除中資料の読み取り専用化を接続する
  - [x] 削除済み項目の回復一覧・後着未確認編集の検出・内容確認・復元と作成取消を実装・実画面検証する
  - [x] 保存済みpublication originで通常note/notebook/attachment作成のUndoを証明し、内容を残す論理削除／同ID Redoへ接続する
  - [ ] 削除時点と後着版を並べて比較する専用画面を含むF38全範囲を仕上げる
  - [x] 明示bindingの両版へmetadata／保存Markdown／PDF原訳・注釈の本文検索を接続する
  - [x] tag/read条件・共通sort・解除／reveal・取得範囲表示・古い結果拒否と失敗再試行を検証する
  - [ ] 外部index・大規模corpus性能・条件のreload復元・既定起動での検索切替を仕上げる
  - [ ] 全資料の付箋／highlight一覧・検索・絞込み・書出しを接続する

- [ ] Workspace・機能判定の完成
  - [x] 同scopeの資料切替・戻る・引用移動を共通navigationへ接続する
  - [x] 中央／右の編集配置と単一editorの保持を接続する
  - [x] 表示中資料のclose guardと全scopeの退出guardを分離する
  - [ ] 空Libraryを架空のdocumentIdなしで起動できるようにする
  - [ ] 選択・開閉・幅・theme等の設定復元を接続する
  - [ ] focus・tab・panel・編集面移動の全遷移を確認する
  - [ ] 文書種類・提供サービス・データに基づくcapabilitiesへ統一する

- [ ] 保存領域・データ変換の完成
  - [x] legacy raw backup収集・保存と一回変換の基礎部品を実装する
  - [x] 注釈・bookmark等の変換とdataset切替protocolの基礎を実装する
  - [ ] 全writerの停止・drain・入力固定を接続する
  - [ ] 全領域raw backupの取得・読戻し・復元を検証する
  - [ ] canonical stores・scratch・outboxを通常backup／move／restoreへ登録する
  - [ ] 旧catalog等のconverterを完成させ、一回変換する
  - [ ] 未送信内容・競合枝・履歴・resourceを全経路で保全する

- [ ] 既定起動への切替・旧責務撤去
  - [x] 新compositionを明示binding付きのPC・Web本番mountへ接続する
  - [x] 共通entry台帳・到達graph・依存境界検査を追加する
  - [ ] dataset manifest・control・active pointerを両entryへ実接続する
  - [ ] 新compositionをPC・Webの既定起動へ切り替える
  - [ ] 置換した旧writer・listener・stateを撤去する
  - [ ] 新側の編集を捨てないrollbackを検証する

- [ ] 全体の最終検証・受入
  - [x] F01〜F38・R01〜R29の67要件を台帳へ整理する
  - [x] 関連・owner削除工程までの新規・関連実画面試験をChromium／WebKitで実行する
  - [x] 添付工程後の単体1,170件・型4project・lint・両build・Python143件の成功を確認する（各工程のrunは別記録）
  - [x] Astraの反復レビュー・修正と実装・検証記録を残す
  - [ ] 全67要件について実装・接続・検証の証拠を揃える
  - [ ] 型検査・lint・関連単体・Python受入・依存境界・両buildを通す
  - [ ] Chromium・WebKitの全体回帰と大規模データ性能を確認する
  - [ ] 実iPad・Safari・Pencil・OS終了を確認する
  - [ ] 未実施・失敗を残さず、受入台帳と設計・実装記録を最終更新する

詳細は台帳の各F／R行を確認する。このリストにない要件を省略したり、テスト件数だけで完了判定しない。

## 8. 再開時に最初に行うこと

1. 作業ツリー・本書・次工程書を読み、未追跡ファイルもあることを確認する。
2. 関連／owner削除、回復一覧／後着編集、書誌情報、検索、添付、通常3kind作成Undoまで接続済み。添付は新規実画面2/2成功。最新標準検査は上記Fと実装記録を照合し、過去checkpointの件数と混ぜない。
3. 次の縦接続として、以下の残スライスを順に実装・独立Astraレビュー・実画面検証していく：
   - **M3訳文surface**は表示・位置・filter・倍率・入力面切替まで新規実画面2/2成功。訳文引用の専用試験と既存回帰の結果を記録し、F37の訳文場所移動へ進む。
   - **付箋／highlight一覧・場所移動／一覧復帰・固定Markdown一操作追記（F37）**。Astra 3観点の調査を次工程書の末尾へ記録済み。
   - **削除時点と後着版の専用比較（F38残件）**、文書種類・サービス・データに基づく機能判定（F32残件）、検索の外部index・大規模性能・条件reload復元（F36残件）。
   - **フォルダーdrag/drop・複数選択・並べ替え（`F31`残件）**、およびReader／PDF入力／Markdown／Workspace／Storage切替（`M5`／`M6`）の残作業。

### frontendで実行

```powershell
npm.cmd run build
npm.cmd run build:web
node --test --test-concurrency=1 e2e/webDocumentLibraryFolders.browser.test.ts
```

続く回帰例:

```powershell
node --test --test-concurrency=1 e2e/webDocumentLibrary.browser.test.ts e2e/webDocumentLibraryEditing.browser.test.ts e2e/webDocumentLibraryTags.browser.test.ts e2e/webDocumentLibraryMarkdownTitle.browser.test.ts e2e/webDocumentPdfReading.browser.test.ts
```

変更後の標準検査は`npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd test`。依存管理は既存`pnpm-lock.yaml`を使う。別lockfileを作るための`npm install`は行っていない。

### repository rootで実行

```powershell
uv run pytest tests/test_edit_contracts.py tests/test_edit_intents.py tests/test_edit_repository.py tests/test_content_publication.py -q
uv run python tools/shared_app_acceptance.py --check
```

fixture更新時は`uv run python tools/build_edit_fixtures.py`。モデル不変条件を変えたらTS・Python・共有fixtureを揃える。

## 9. 試験運用・再開時の注意

- **重いbrowser／実HTTP試験は単独で走らせる。** 全unit・型・build・Pythonを同時実行すると、sidecarの20秒起動待ちがtimeoutしやすい。
- 返された実行handleをterminalまで追跡する。観測timeoutだけで再起動しない。終了済みhandle番号が後で再利用されることもある。
- async `waitForFunction`がfalseを解決するPromiseでも通過する現象を最小再現済み。非同期観測は`e2e/support/waitForSnapshot.ts`で値をawaitし、読取り自体にも期限を付ける。
- wrapperや資料IDの表示はcontroller準備完了の証明ではない。reload後は実surface／toolbarとsession ready・idleを待つ。
- SQLiteを経るとJSON object key順が変わる。再送要求はparse後の全構造deepEqualで比較し、field・値・配列順を緩めない。
- WebKitの既知caught fetch診断は、engine・host・reload・正確なreadonly endpoint・stackを限定して分類する。pageerror全体を無視しない。別のunhandled検査は維持する。
- `test-web.mjs`は`web*.browser.test.ts`を自動検出する。新suiteが既存release gateに含まれるか確認する。
- Add File前に同名fileの有無を確認する。過去に旧helperを上書きした事例があり、新adapterは別名へ分離して復元済み。
- 最終完了は、各要件のUI接続・保存・再読込・他host・失敗回復・旧責務撤去まで証明してから判断する。staged数や単体成功数を代用しない。

## 10. サブエージェントの担当履歴

再利用できる場合の担当目安。最新sourceと本書を渡し、履歴だけを証拠にしない。

- `astra_canonical_ink_render`: pure操作・finite inverse・strict admission。現在folder pureはfreeze。
- `astra_pdf_semantic_commands`: LibrarySession・canonical tree・所有配置設計。現在所有fileはfreeze。
- `astra_pdf_composition_acceptance`: 合成fixture・両本番mountの実画面。今回検索suiteを追加（rootが実行し2/2成功）、添付F34を読み取り調査済み。

2026-10-26にユーザー側の進捗を取り込み、残工程を再開した。全体目標の完了を宣言していない。

## 11. ユーザー側作業の引継ぎ確認（2026-10-26）

- [x] 復元・書誌情報の新規実画面2/2成功をログで確認（Chromium69.45秒／WebKit143.75秒、総214.10秒）
- [x] 関連7suite／14件成功をログで確認（総1220.58秒）
- [x] 全frontend単体1,140成功・benchmark1 skip、Python関連143成功の終了ログを確認
- [x] 新たにAstra 2名で保存／取消と回復／navigationを独立点検し、新P1/P2なしを確認
- [x] 共通Library検索の実装・反復Astraレビュー・新規実画面2/2を完了する
- [x] 検索追加後の既存実画面回帰・全単体・標準検査の最終結果を記録する

証跡: `output/shared-app-library-recovery-metadata-{browser,regression,unit,python}.log`。初回browser失敗は`output/shared-app-library-recovery-metadata-browser-initial-failure.log`として保持。これらは引継いだ終了済みrunであり、検索追加後の検査とは分ける。

## 12. 原訳surfaceの進捗と次の再開点（2026-10-26）

- [x] 原文論理pageと訳文の実page／物理PDF番号を分離する
- [x] 原文／訳文／左右表示と単一toolbar・共有文書履歴を両explicit mountへ接続する
- [x] 翻訳済みfilter、数値入力時の解除、Home/End先頭着地、集合更新保留を共通Readerへ接続する
- [x] 実page・背景版付き位置／履歴／active面を保存し、未翻訳・多対一／複数候補を別ページへ代用しない
- [x] 非操作面の選択gestureを全指離脱まで消費し、window cleanupとblur解除を維持する
- [x] 独立Astraレビューでcompanionの古いRAFによるzoom anchor早期解除を修正し、pane寸法照合と新描画完了待ちを追加する
- [x] 新規原訳surfaceの最初の実画面runを2/2成功として保存する（output/shared-app-reader-surfaces-browser.log）
- [x] 最終の型4project・lint・両build・全単体1,199成功／benchmark1 skip・依存境界の成功を確認する。Python143成功は同工程の先行run
- [x] 強化した独立位置／連続wheel anchorと既存読書の実画面6/6を確認する（output/shared-app-reader-surfaces-reader-final.log）
- [x] 原訳の横位置も単面→左右→reloadで照合し、両engine2/2を確認する（output/shared-app-reader-surfaces-position-xy.log、135.13秒）
- [x] 有効訳文引用・修正済み引用／ノートの実画面6件成功を別run内で確認する（同runの原訳2失敗は保持し、単一8件成功とはしない）
- [ ] F37の一覧・場所移動・固定一操作追記を両mountへ接続して実画面検証する
  - [x] durable corpus・projection・filter／microsecond sort・head別variant・固定Markdown・世代付きSessionの13単体を実装／通過する
  - [x] 接続前のCore／Panelの複数Astraレビュー指摘を修正する（最新2名は新P1/P2なし。接続後のreviewは別途必要）
  - [x] scope singleton／共有一覧UI／exact-version navigation／NoteAppendへ接続する
  - [x] 全資料・原訳・競合・未取得・一覧復帰・同ID追記・Undo／失敗回復を両engineで検証する

元の6suite回帰runは9成功／3失敗・exit1、総472.23秒のまま`output/shared-app-reader-surfaces-regression.log`へ保全する。引用2件は「訳文は一律未対応」という旧エラー文言の期待でtimeoutした。現在は訳文collectionにない原文UUIDを拒否する試験へ更新。有効訳文は専用suiteで検証する。ノートWebKit1件は2台目の文字作成clickが1台目の既存textに重なり、同IDのtextを編集したため。両端末の新規作成位置を分け、既存注釈完全一致と新規path/rect/textのassertは維持した。独立Astraが意図と整合することを確認している。

このM3時点の台帳はaccepted 0／partial 44／unverified 23。後続のF37縦接続の結果は次節へ記録する。全計画と既定起動切替・旧責務撤去・実機の残件を維持する。

このM3時点の再開点はF37の縦接続だった。`docs/shared-app-next-steps-astra.md`末尾に当時の接続設計を記録した。現在の進捗は次節を優先する。実ユーザーの保存領域は切り替えていない。

## 13. F37縦接続の作業中チェックポイント（2026-10-27）

- [x] registryのscope singletonからAnnotationBrowserSessionと一覧専用NoteAppendSessionを提供する
- [x] LibraryContentConnectionへ共通一覧と追記Dialogを接続する
- [x] 表示catalog版と文書sourceVersionを別々に指定し、fresh readと表示側の双方でexact注釈payload／背景版を検証する
- [x] guarded refreshで取消・旧headをモデル採用前に拒否し、pagehideで該当する未完了移動を取消す
- [x] catalog未準備時は旧結果を残し、移動／新規書出しを停止して手動更新で回復する
- [x] 固定一覧全体を同じappend IDの一操作へ渡し、新規宛先のitem/content/publication IDも固定する
- [x] annotations要求をscope別scratchへ保存し、作成後・追記前の再起動を回復する
- [x] appendStartedを本文handoff前に保存し、復旧時の取消・pending再試行・accepted整理を区別する
- [x] 削除済み宛先の復旧確認をcatalog admissionより先に行い、未処理は取消可・pendingは既存処理だけを回復する
- [x] source／宛先／作成IDの削除・退出guard、破損raw保全、生成途中の取消を接続する
- [x] 複数Astraの反復レビュー・修正を実施し、最新保存／接続レビューは新P1/P2なし
- [x] 型4project・lint・全単体1,226成功／benchmark1 skip・Python143成功・両buildを確認する
- [x] 新規実画面2suite／両engineの4ケースを作成する
- [x] 選択欄の明示操作名を追加した後の実画面を通す
- [ ] head／payload／背景版の遅い更新・取消、catalog取得失敗中の停止を実画面で追加検証する
- [x] 既存Markdown・引用・読書・Library保存の関連回帰を確認する（元run7成功／1失敗、同sourceの失敗engine単独再実行1成功を区別して記録）
- [x] F37とR25の確認範囲をpartialへ更新し、実装／単体／両本番接続の実画面とsource graphを記録する

最初のbrowser runは4件ともselectの内包label完全一致でtimeoutし0/4、193.14秒。`output/shared-app-annotation-browser-browser-initial-failure.log`に保持。操作名の明示後、観測準備待ち・strict契約に沿うfixtureを修正した。複数版suiteの通常pollで移動検証が取り消されるP2も修正し、scanとlocationの世代／AbortControllerを分離した。修正は独立Astra再レビューで新P1/P2なし。最終の新規2suiteは4/4成功、194.86秒（`output/shared-app-annotation-browser-final-browser.log`）。原訳landing・固定一操作追記・同ID再送・reload・Undo/Redo・peer反映・新規宛先作成、source/catalog複数版・一覧scroll・読取失敗stale保持・親待ち拒否を確認した。最新全単体は1,227成功／benchmark1 skip、型4project・lint・両buildも成功。Python143は保存接続変更時の先行run。遅いhead／payload／背景版の更新と取消はdomain／session単体で確認しているが、全組合せの実画面試験とは区別する。

台帳はaccepted 0／partial 46／unverified 21。選択中Workspaceノートの自動宛先、既定起動・旧一覧責務の撤去、全領域scratch退避、実機の確認を含むF37全体の完了は宣言しない。関連既存4suiteは7成功／1失敗、462.08秒（`output/shared-app-annotation-browser-regression-initial-failure.log`）。失敗はWebKit引用追記の初期heading待ちで、ソース変更・timeout延長なしの単独再実行は1/1成功、82.06秒（`output/shared-app-annotation-browser-quote-webkit-diagnostic.log`）。単一8件成功とは扱わず、初期表示の失敗は未再現として保持する。

主なsourceは`AnnotationBrowserConnection.tsx`、`annotationLocation.ts`、`NoteAppendDraftPort.ts`、`annotationAppendDrafts.ts`と既存Session群。新scratch prefixは`paper-desk.annotation-append.v1:`。既定起動と全領域backup／move／restoreへのfootprint登録はM6で必ず扱う。旧quote/imageのhandoff前memory要求まで永続化したとは主張しない。

## 14. 次工程と担当方針（2026-10-27）

- [x] Astraで次工程を再評価し、既存回復一覧を再実装せず、F38の削除時点／後着Markdown専用比較を優先する
- [x] ユーザー指定に従い、実装・デバッグをSol、設計・方向設定・独立レビューをAstraへ分担する
- [x] 読取り専用の比較Sessionと左右の版・manifest・scroll・欠落／後着状態を実装する（専用単体15/15成功）
- [x] 共通Markdown previewを再利用し、既存回復行と既存restore writerへ接続する（型4project・修正後lint成功、実画面は未実施）
- [x] Sol実装をAstraが独立レビューし、重大指摘が収束するまで修正する
- [x] Markdown比較・親子復元・後着head保全を両本番mountで検証し、標準検査と記録を更新する

比較は本文の採用や競合解決ではない。復元時は選択版だけを保存せず、全content head・画像・履歴を保持して既存の削除recordを解除する。初回対象はMarkdown（付属ノートを含む）。PDF／paperの専用比較、F35全体、folder drag/drop／並替、付箋／本文highlight編集、PDF検索／outline／内部link、export、Workspace／preferences、M6は引き続き残件。

担当: `sol_deleted_comparison_model`がモデル・単体・標準検証、`sol_deleted_comparison_ui`がpreview・Panel／Connection・回復行結線・実画面suiteを実装。Astraは読み取りレビューを担当する。初回lintはeffect依存とcleanup refの2件でexit1、修正後r2はexit0。全単体1,242成功／benchmark1 skip・型4project・lint・両build・境界40件・generator／台帳checkは成功。初回実画面はscroll viewportが伸長し2件とも失敗。Solの最小CSS修正とgeometry事前assertをAstraが確認し、r3型lintとr2両build／境界が成功した。

修正後の新規実画面は2/2成功（Chromium26.21秒／WebKit77.51秒、総104.28秒、`output/shared-app-deleted-markdown-comparison-browser-r2.log`）。初回失敗は同prefixの`browser.log`へ保持。画像decode、observed／current、複数版の明示選択、旧pairとscroll固定、親待ち／到着、実read失敗回復、親子全対象復元、応答消失時の同ID同payload再送、全content checkpoint／head／history不変を確認した。関連Markdown／画像は2suiteの計6件（本文・PNG・SVG、各2engine）がすべて成功、224.07秒（同prefixの`regression.log`）。全handle終端をSolが確認した。F38／R26は確認範囲だけ証拠を追加し、partialを維持する。

次はAstraの方向設定に従い、PDF／paperへ同じ比較モデルを一般化し、Markdown専用モデルを置換する。PDF専用Sessionの複製は作らない。具体案は`shared-app-next-steps-astra.md`末尾。

## 15. 種類共通の削除内容比較への拡張（作業中）

- [x] AstraがPDF／paper比較とF20を比較して次優先を決め、具体API・resource検証・readonly描画の設計を提示する
- [x] SolがDeletedContentComparisonSessionへ一般化し、版別の実page keyとscroll保持・欠落表示を追加する（最終targeted27/27成功、Astra core再レビュー新P1/P2なし）
- [x] Solが共通PDFresource検証とreadonly背景／全注釈previewを接続する
- [x] SolがPanel／Connection／一覧入口／境界／試験を種類共通へ置換し、旧Markdown専用モデルを撤去する
- [x] Astraが独立レビューし、Solが重大指摘の収束まで修正する
- [x] PDF／paper／原訳／削除page／resource障害・全graph保全を両本番mount／両engineで検証する
- [x] 最終検証と記録を揃える
  - [x] 最終r4の型／lint・全単体1,251成功／benchmark1 skip・両build・境界40件・generator／台帳／diffcheckを通す
  - [x] 同sourceの実画面比較／既存capture回帰を完了する（成功は別runの組合せ、単一6件成功とはしない）
  - [x] 台帳・本書の最終path／証拠を更新する

モデル・unit・共通resource検証は`sol_deleted_comparison_model`、renderer／結線／実画面は`sol_deleted_comparison_ui`が担当。比較snapshotはMarkdown／Documentのunionとし、page keyは`{collection: original|translated|deleted, pageId}`。初回以外は同keyだけを引き継ぎ、別ordinalへ代用しない。PDF／paperで新しい編集authorityやReader位置authorityを作らず、既存restore writerは維持する。現在は作業中のため、Markdown段階の成功をPDF／paperの受入証拠にはしない。

現在のsource名は`DeletedContentComparisonSession.ts`、`DeletedContentComparisonPanel.tsx`、`DeletedContentComparisonConnection.tsx`、unitは`deletedContentComparisonSession.test.ts`、既存Markdown比較suiteは`webDocumentDeletedContentComparison.browser.test.ts`へ置換中。台帳pathも整合させた。旧Markdown成功段階の5 source／testは`output/shared-app-deleted-markdown-comparison-source-checkpoint.zip`へ保全し、runtime互換aliasは作らない。generic model19件＋PDFresource6件＋capture plan2件のtargeted r2は27/27成功。初回5失敗は新fixtureの訳文紙背景と、一般化後に有効なPDFを拒否対象にしていた不整合を修正したもの。初回logも保持し、Astraの抽出差分レビューとPDF／paper実画面は継続中。

Core／PDFvalidator／capture抽出をAstraが点検して新P1/P2なし。旧MD modelとunitの2pathはUI import移行後に削除済み。版変更のtest fixtureを正しいsiblings／resolution graphへ整えた最終targetedも27/27成功（`output/shared-app-deleted-content-comparison-targeted-final.log`）。UI全体の型lint・全unit・両build・実画面は次のgateで、まだgeneric版全体の受入成功とはしない。

generic UIは型r3／lint成功、全単体1,251成功／benchmark1 skip、PC build成功まで進んだ。その後Astraが、復帰時の非同期Markdown画像でscrollが先頭へclamp／保存されるP2を指摘。全実行handleを終端まで確認し、次のWeb build以降はholdした。現在Solが復元pending／寸法待ちと遅延画像の実画面回帰を追加中。これら先行検査を修正後の最終gateと扱わない。PDF／paperの新実画面はまだ未実行。

上記P2はSolが修正し、inner ResizeObserver／pending／clamp保存抑制／利用者操作取消と、実2400pxPNG・readResource遅延・合成pagehide/pageshowの回帰を追加した。Astra2名の最新確認は新P1/P2なし。最終r4標準gateは全て成功し、`output/shared-app-deleted-content-comparison-module-graph.json`へgraphを保全した。ログは同prefixの`{unit,build-desktop,build-web,boundaries,generator,acceptance-check,diff-check}-r4.log`。全handle終端確認後、Sol UIがgenericMD比較／PDFpaper比較／QuoteAppendの両engine（計6件見込み）を単独実行する。合成lifecycle試験と実履歴navigationのBFCache試験は区別する。

初回generic6件runは終端3成功／3失敗（`output/shared-app-deleted-content-comparison-browser.log`）。genericMD両engineでは遅延画像の復元／利用者取消を両hostで確認した。PDF／paper両engineはfixtureがtranslationと他commandを同batchに混在させたadmission拒否で、Solがtranslation独立batch・背景版／highlight版の正規化・applyBatch由来の期待lifecycleへtest-only修正した。修正後r5型／lintは成功、差分のAstraレビュー待ち。

QuoteはChromium成功、WebKitは機能／PNG確認の後finishのerrors[]で失敗した。reload-native時のAnnotationCorpus由来fetchエラーで、真の未処理かWebKitのcaughtfetch報告かは未確定。model Solが同production-sourceでWebKit単独run（session86777）を追跡中。元finishはerrors[]を先にassertするため、失敗logだけでunhandled[]が空とは断定しない。根拠なしのignore拡張は行っていない。UI Solは次のPDF／paper再runを待機し、現在productionはr4成功時から無変更。

最終結果: Quote WebKit単独は1/1成功、97.19秒（同prefixの`quote-webkit-diagnostic.log`）。errors／unhandled／forbiddenの既存検査も通過、source／ignore／timeout変更なし。初回failureは未再現として保持する。PDFpaper-r2はrouteの二重処理による試験側失敗で、handler完了→unrouteの順序と一次error保全へtest-only修正。r5以降の型／lintも成功し、PDFpaper-r3は2/2成功、157.76秒（Chromium54.37秒／WebKit102.69秒、`output/shared-app-deleted-content-comparison-pages-browser-r3.log`）。全handle終端、productionはr4から無変更。

genericMD2件成功・QuoteChromium成功は初回6件run内、QuoteWebKit1件成功は単独run、PDFpaper2件成功はr3別run。単一6件成功とは記録しない。F38／R26の確認範囲へ証拠を追加し、台帳はaccepted 0／partial 46／unverified 21を維持する。既定起動／旧legacy責務撤去／全領域backup／実機は残る。

## 16. F20付箋・本文highlight（付箋slice作業中）

- [x] Astraが設計し、別Astraの4指摘を反映して再確認する
- [x] Solが既存DocumentEditSession内へ専用draft確定とowner再取得・全guardを実装する（対象41/41成功、Astra Core新P1/P2なし）
- [x] Solが付箋の作成・編集・移動・削除を原文／訳文／paperへ縦接続する（実画面受入は未実施）
- [x] SolがF37の固定候補から明示編集へ接続する（fresh head／全payload／背景版を再照合）
- [x] Astraが実装を独立レビューし、Solが重大指摘の収束まで修正する（r8最新2名は新P1/P2なし）
- [x] 両host／両engineで保存失敗・同ID retry・Undo／属性保全・draft／gesture guardを検証する（通常r5の4/4、関連回帰は別run）
- [ ] quad geometryを両engineで証明してから本文highlight作成へ進む（任意回転等の未対応を完了扱いにしない）

詳細は`shared-app-next-steps-astra.md`末尾。通常editPageへdraftを流さず、commitAnnotationDraftで内部draft／owner／base／expected／元payload／許可fieldを検証して既存pendingへ原子的に移す。フォームはtokenを取得せず既存Ink hook facadeを使い、close finalizerで未確定フォームを自動保存しない。保存開始後は固定pendingだけをretryする。

現在の担当はCore／純操作／単体が`sol_deleted_comparison_model`、Ink facade／フォーム／surface／F37結線が`sol_deleted_comparison_ui`、新`webDocumentStickyAnnotations.browser.test.ts`が`sol_annotation_acceptance`。全3名Solで実装・debugし、sourcefreeze後にAstraが独立レビューする。Core APIはcreate-sticky anchor／edit-sticky exact payloadからdraft開始し、text／label／color／anchor／deletedだけを限定更新。owner再取得時にannotation ID／UTC／payloadは維持してdraftIdをrotateし、同token再利用でも旧callbackを拒否する。検証の現在地は次段を優先する。

上記Coreは実装済みで対象41件が成功。UIも型r4／lintを通過したが、Astraの全結線レビューでready再登録とremote削除後の取消不能の2件を確認し修正した。修正前の全unit1,268成功／benchmark1 skip・PC build成功は先行証拠として保持し、Web／Python以降はholdした。readonlyとbusyの分離、取消だけの狭い許可、gesture中の外部削除取消まで含めてr6以降を検査した。最新の現在地は次段を優先し、F20受入済みとはしない。

新受入suiteは原文／訳文／paper、pane再配置／remount、F37後着payload／背景拒否、draft中remote拒否、idle復帰後の同page編集、二接点排他、form／placement gesture中のremote削除後取消を含む。重検査は未起動。PythonのSQLite受入1件も追加sourcefreezeし、従来143件範囲と合わせ次gateで実行する。本文highlightの新規作成・編集は後続で、今回の既存highlightは完全保全のみを確認する。

その後のr7型／lintは成功。別Astraから第3P2として「確定後のfresh read中のreadonly化をpending設置前に再確認しない」を確認し、Core／UIへmayCommit admissionを追加した。fresh read後とpending直前の確認・副作用後再照合を入れ、対象44/44成功、指摘元Astraは解消確認・新P1/P2なし。UIの注釈中同期はimmutable受信だけを許し、Doc採用はcanNavigate guard維持。testerは実read timing保留＋ordinary remote catalog deleteの回帰を追加中で、最終snapshot型／lintと全gate、実画面はまだ未実施。

最終r8は型77967／lint11411とも成功、Astra2名のmayCommit／readonly取消／全owner接続／実IO timing fixture再確認は双方新P1/P2なし。標準gateも全成功: frontend1,271成功／benchmark1 skip、Python14file144成功、PC/Web両build、境界40件、generator／台帳／diffcheck。`output/shared-app-sticky-annotations-*-r8.log`と同prefixのmodule-graphへ保全した。以後の実画面担当は`sol_annotation_acceptance`、source debugはUI Solが担当する。

初回sticky実画面は0/2、115.16秒（`output/shared-app-sticky-annotations-browser-initial-failure.log`）。F37手動更新中に場所検証を開始できる競合をPanel.updateのbusy/lifetime guardで修正し、r9型／lint・両build・境界40件は成功。testerは旧rows数だけでなくexact sourceVersion／全payload／!loadingを待つよう強化した。WebKitの移動anchorは期待値／tol2を変えず実point／inputLayer／外枠／DPR等の診断を追加中。

r2実画面も0/2、96.19秒（同prefixの`browser-r2-failure.log`）。ChromiumではF37編集／取消を通過し、その後の通常receipt.importedBy更新だけをno-write違反としていた。receipt stable identity／件数と全canonical checkpoint・heads・waiting・rejected・history・publicationOrigins等を保持し、配送upload／importedByだけを除く比較へtest-only修正した。WebKitは本体前の初期heading待ちでtimeout、sessionがconstructor状態のまま。過去の同型startup単発失敗も踏まえ、UI Solが原因調査中で推測修正は行わない。

WK実case診断91717では両host初期化が各refresh/read/journal完了・ready trueとなり未再現。Nativeのanchorでactual(321.797583,575.887973)対expected(324,577.5)を得た。後続のpointer診断49643ではLayer boxは不変、指定client(566.9,756.6578125)が実WebKitイベントでは(566,756)となり、保存anchorは実イベントからの独立計算と一致した。製品の座標変換は変更せず、Solがテスト入力を整数CSSpxへ揃え、保存anchorと実pointerup／当時Layer boxからの計算値の厳密一致を追加した。元の.4W／.55H・tol2は維持。`output/shared-app-sticky-annotations-webkit-pointer-diagnostic.log`を保全した。修正後の通常受入はまだ未通過。

- [x] anchor差が実イベントの整数化に由来することを確認し、期待値を緩めずテスト入力と独立oracleを修正する
- [x] cold startupの間欠停止を独立再現し、未完了IOと文書owner取得を原因候補から外す
- [ ] startup停止の原因・必要な修正範囲をSol調査とAstra独立レビューで確定する
- [ ] 診断flag OFF・元errors／unhandled監視で付箋の通常受入を通す

独立cold startupの最初の6回は4成功／2失敗、r2は5成功／1失敗（各logのNode親失敗も別途残る）。失敗時もregistry初期化とrepository readは完了し、文書Sessionはrender中に生成されるが、Suspense fallbackからcommitせずConnectionのlayout effect／初期化／refreshが始まっていない。visible／focusedで、React rootにはretry laneとcallbackが残る。Coreのowner取得やpending readが原因とは扱わない。MessageChannel配送等の観測を追加したr3は6/6成功・174.47秒だが、観測が挙動へ影響する可能性を残し、解消扱いにしない。ログは`output/shared-app-sticky-annotations-webkit-cold-startup-diagnostic{,-r2,-r3}.log`。自動suite対象外の診断fileを使い、製品はPanel修正r9から無変更。Promise観測は`startupDiagnostics=1`限定で、最終受入はflag OFFの元errors／unhandled監視を使う。Astraが原因切分けと最小修正の判断基準を独立点検し、Solが実装・debugを担当する。

MessageChannel最小probeは明示保持の有無各12回とも配送成功（1.44秒、同prefixの`message-channel-diagnostic.log`）で仮説未再現。GC原因の否定にも確定にも使わない。Astraの追加静的レビューもstartup停止を説明する具体的P1/P2は確認できず、module固定lazy／寿命付きkind effectを確認した。根拠のないscheduler改変・polyfill・再試行timerは加えず、診断拡張を止めて通常flag OFFの付箋2engine受入へ戻した。起動停止は未解決事項として保持する。

通常r3は終端exit1、550.40秒。Chromiumは1/1成功・188.55秒。WebKitは既存case全体360秒の期限でcancelled1・360.54秒となり、失敗assertは出ていないが受入成功とはしない（Node合計pass1／fail0／cancelled1）。Native側のCRUD／各guard工程、Web側の原文・訳文復帰までは通過し、Web paperの削除前編集で期限に達した。browserclosedは期限後cleanupの二次errorで、初期startup／整数入力のanchor検査は両hostで通過した。`output/shared-app-sticky-annotations-browser-r3-timeout.log`を保持し、全process終端をSolが確認した。timeoutを延ばさず、engine×hostの独立caseへ分割して全assert／両peer通常同期／最終同ID再試行を保てるかAstraとSolで確認中。関連回帰はまだ起動していない。

分割はAstraの独立確認で新P1/P2なし、Solの型／lintも成功。通常r4は4caseの1成功／3失敗・cancelled0、524.96秒（`output/shared-app-sticky-annotations-browser-r4-failure.log`）。Chromium Native103.71秒はF37候補待ち、Chromium Web97.75秒は成功、WebKit Native136.29秒は全機能工程完走後のfinish pageerror、WebKit Web184.81秒はpaper復帰後のF37候補待ちで失敗した。全handle終端・重run0を確認し、以下の分担で修正中。

- [x] engine×編集host4caseへ分割し、全CRUD／guard／同ID再送／両peer同期／finishを保持したことを独立確認する
- [x] F37 guarded landingと通常同期のmodel refreshが競合する静的P2をSolとAstraが確認する
- [x] UI Solがflush後・refresh直前のlive annotation citation admissionを修正する
- [x] tester Solが実landing read保留→通常同期→解放のcontrolled回帰を両hostへ追加する（source、実行は後続gate）
- [x] 別Solが実corpus／Sessionの独立診断でWebKit reload時の捕捉済み失敗を証拠で分類する（元r4自体の未出力値は推定しない）
- [x] 実証済み経路だけの分類と全観測表示を実装し、Astra2名が新P1/P2なしを確認する
- [x] 新通常runで分類記録と独立unhandled0を確認する（r5全4case）
- [ ] 修正のAstra独立レビュー・標準gate・通常受入・関連8caseを完了する

F37はimmutable受信を保ち、着地要求中の背景model refresh開始だけを止める。入口だけの検査では既存sync flightが漏れるため、flush後の現在値を確認する。falseを一律retry／無視へ変更しない。`sol_deleted_comparison_ui`がprodと共有fixture、`sol_annotation_acceptance`がsticky suiteを所有する。

WebKit Nativeのpageerrorは`native(reload-native): Fetch API cannot load .../api/edits/read due to access control checks`、stackは`canonicalAnnotationCorpus`のread経由。過去F38 Quote初回と同型だが、その後単独未再現であり解決済みとはしない。Astraの独立読解ではfetchからcorpus／Sessionまでのreject所有に具体的P1/P2は確認できず、取消後の古い結果採用も確認していない。`finish`はerrorsを先にassertするため、今回unhandled空とは言えない。`sol_corpus_navigation_debug`が専用の自動検出対象外scriptでrequest ID・catch／最終settle・pageerror／unhandled／rejectionhandled・beforeunload／pagehide・requestfailedを同時記録する診断を準備する。新ignoreや期限延長で消さない。共有fixtureとは別所有で実装し、重runは引続きUI Solが一括統制する。

F37のprod／fixture／controlled suite合流後は型97423／lint71282が成功、Astra2名の独立確認も双方新P1/P2なし。回帰は保留中に別資料の全batch受信・durable ack・head／全文・flush完了を証明し、背景refresh開始0→解放後の正当候補／編集／取消・current全文履歴不変を検査する。fixtureのguardedGenerationは開始時の識別情報であり、現在の実readGenerationの直接証明とは呼ばない。WebKit診断sourceも完成し、実corpus／Sessionを使う`webkitCorpusNavigation.mjs`と専用fixtureで、通常・pagehide abort・事前cancelを処理済み失敗／意図的unhandled等の対照と比較する。診断分類を先に単独実行し、その後に最終unit／build／境界・sticky受入を進める。r10型／lint以外の最終gateを既に通したとはしない。

WebKit corpus診断はsession50287が全終端exit0・約116秒、`output/shared-app-corpus-navigation-diagnostic.log`へ342,898byteの時系列を保全した。current10/10とpagehide-abort10/10でpageerrorを再現したが、双方unhandled0・request caught20・corpus resolved10。事前cancelはpageerror0／unhandled0・caught10／corpus rejected10で、pagehide abortだけでは解消しない。意図的unhandled対照はpageerror1／unhandled1、遅延catch対照はさらにrejectionhandled1となり、監視の感度を確認した。この診断をF20通常受入成功へ代用せず、元r4の未出力unhandledを遡って空と推定しない。Solが元stack／イベント順序との一致を分析し、Astraが誤ったignoreやreload前の人工取消でraceを隠さない最小対処を判断する段階。共有監視・fixtureはこの診断のために変更していない。

分析後のAstra／Sol判断は、既存caught-navigation分類へ実証済みのcorpus経路だけを追加する方針で一致した。診断の順序はbeforeunload→先行fetch取消／catch→次item read→pageerror→同read catch→corpus resolve／Session loading解除→約190ms後pagehide。元r4とendpoint／message／source frame／reload境界は一致するが、元r4の時系列・unhandled値までexact一致とはしない。条件はWebKit・native・管理されたreload・実departing controller・同originの`/api/edits/read`既知message・同originのfixture requestとcanonicalAnnotationCorpus read frameの全AND。active／別endpoint／別source／別hostを許容せず、分類イベントは全stack付きでnavigationDiagnosticsへ保持する。独立unhandled0検査を維持し、finishでは両集合と診断が一次失敗時にも読める形にする。network Solが既存support／分類契約を実装中。人工pre-navigation cancelや本番beforeunload変更は今回採用しない。新しい通常runの全assertでのみ合否を判定する。

最終r11は全標準gate成功・全handle終端: 型95111／lint84943、frontend1,276成功／benchmark1 skip、PC80792／Web83664 build、境界40/40、generator／台帳／diffcheck。Python144はCore／保存接続無変更の先行証拠として維持する。ログは`output/shared-app-sticky-annotations-*-r11.log`、更新graphは同prefixの`module-graph.json`、直前graphは`module-graph-pre-r11.json`へ保全した。Astra2名のsupport最終確認も双方新P1/P2なし。通常r5はsession95194で4caseを単独開始、`output/shared-app-sticky-annotations-browser-r5.log`へ逐行保存。診断flag OFF・元navigation順・各360秒と全監視を維持し、分類event／errors／unhandledを別々に表示して判定する。終了後に関連4suite8caseへ進む予定で、まだ新通常受入の成功を宣言しない。

## 17. 付箋slice最終結果と本文highlightへの再開点

- [x] 通常sticky r5の4caseを同sourceで全成功として確認する（664.04秒）
- [x] 全caseのforbidden／errors／unhandledが空であることを確認する
- [x] 既知WebKit離脱診断を全stack付きで保持し、実unhandledと分離する
- [x] 台帳F20のUI／入力／表示／他hostを確認範囲のみpartialへ更新する
- [x] 関連4suite8caseのbaseline回帰を確認する（先行6件＋Tools最終2件、別run）
- [ ] 本文highlight用の新規共通capture／text bindingを実装・独立レビューする
- [ ] 既存PDF asset loaderを共通resource検証へ統一し、両実rendererのgeometry spikeを通す
- [ ] 本文選択／pan／swipe／pinchのowner排他を証明し、同draft／writerへhighlight作成・編集を接続する
- [ ] 既定起動・旧責務撤去・全領域の切替・実機を含むM0〜M6を完了する

r5はChromium Native89.42秒／Web96.82秒、WebKit Native156.01秒／Web321.00秒、各既存360秒内で4/4成功、全process終端。WKnativeだけcorpus2件＋既存pending-records1件のnavigationDiagnosticsを保持し、同caseでも独立errors／unhandledは空。他3caseの診断は空。実guarded read保留中の通常同期、原訳／paper CRUD、全属性保全、pane再取得、同ID・全payload retry、後着head／背景拒否、remote削除form／gesture／preflightを通過した。元r1〜r4失敗／cancelledと診断runはそれぞれ保全し、遡及passにはしない。

関連回帰session93247は終端exit1、6成功／2失敗・436.23秒。AnnotationVariants／Notebook／TranslationSurfacesは両engineの6case成功・全audit空。ToolsはChromium23.39秒／WebKit26.24秒のNative最初の投げ縄でselectedIdsにarrowが含まれない同assert（97行）に失敗した。全文を`output/shared-app-sticky-annotations-regression-initial-failure.log`へ保全し、通常sticky4/4とは別runとして記録する。全handle終端後も既存source／fixture／HTMLの凍結を継続し、UI Solが座標／実event／scroll／inputを診断、Astraが独立source確認を行う。共通rendererの既存結線はこのbaseline解消後までholdする。rootはdocs／受入台帳だけを更新し、公式台帳checkは重runの合間に再実行する。

次の`sol_pdf_highlight_geometry`は`canonicalPdfHighlight.ts`、`useCanonicalPdfTextBinding.ts`、pure unitの**新規・未import3ファイルだけ**を作成中。既存file／fixture／HTML／依存変更と検査実行は回帰終端まで禁止。Astraが設計・独立レビュー、Solが実装・debugを担当する。採用仕様・asset binding依存・capture→draftと保存authorityの分離は`shared-app-next-steps-astra.md`末尾。本文highlightはまだ公開・保存へ接続していない。

rendererの接続方針はAstra2名が再確認し、canonicalの旧PdfPane／WebPdfReader二本を共通`PdfSurface`／`CanonicalDocumentSurface`へ置換する案を採用した。新しい座標処理は流用し、旧2rendererへ新geometry propを足さない。Frame／resource port等だけをhost近傍に残し、位置・編集authorityは既存Sessionに維持する。asset検証統一→共通描画置換→既存回帰→geometry spikeの順。現在はTools失敗の切分けが先で、既存rendererはまだ変更していない。

台帳はaccepted 0／partial 46／unverified 21を維持する。F20全体、既定切替、旧code撤去、実iPad／Safari／Pencilを完了扱いにしない。

## 18. geometry初稿・Tools診断の記録（現況は第19節）

この段階のpaint-readiness helperはAstra軽量確認で新P1/P2なし。全workspace型76289／lint85881は明示exit0（`output/shared-app-sticky-annotations-tools-paint-{typecheck,lint}-r2.log`）。初回handleがturn境界で欠落したため、ログ無error／process終了だけで成功とせず再実行した。新geometryを含む型も通過。94619以降の最終Tools結果と現在のsourceは第19節を優先する。

次asset担当`sol_pdf_asset_binding`はread-only準備のみ完了・未編集。Astra承認のresource identity専用readerと既存full page readerの共有実装、実instance向けDocument／Page assertを準備する。verified bytes／URL proofと現在page検証を分け、初期bad pageでresourceを永久エラーにしない。同resource移動では再parseせず、hash／scope／attempt変更は即旧asset失効。Document factはresource＋URL、Page／text／drawは各tupleへ分離するため、geometry hookの次修正はcommon接続phaseで行う。

- [x] geometryの新規未import3fileを作成する（pure test初稿8件、まだ未実行）
- [x] Astra2名が初稿を独立レビューする（P1なし・P2各1件）
- [x] 同textLayerのnode再構築／変更をcapture→入場間で拒否するephemeral証拠と回帰を追加する
- [x] pageとcanvas／textLayerの中間祖先transformを検査し、rotate／skew／reflectionを拒否する
- [x] Astra2名が修正版を再確認し、旧P2解消・新P1/P2なしを確認する
- [x] 新geometryの純11testを実行する（targeted-r2、208ms）
- [x] 新geometryを含む全workspace型を通す（paint型の明示再run76289）
- [ ] 実renderer spikeで検証する
- [x] Toolsの同時座標／実入力probeで実原因を確定し、限定test修正・両engine再検証を完了する

## 19. 共通PDF asset／描画への置換phase（現在）

- [x] Tools baselineの最終2/2成功を確認する（37852、Chrome84.01秒／WebKit222.15秒、計308.23秒、全audit空）
- [x] post-tools台帳check／diffcheckを成功で確認する
- [x] resource／page分離とcanonical唯一のPdfSurface方針をAstra2名で確認する
- [x] geometry hookのDocument factをresource単位へ分離し、Astraがsource上の停止解消・新P1/P2なしを確認する
- [x] asset loader／resource共通検証／短い実PDF assertのsourceを作成する（型／unit／build未実行）
- [x] asset sourceの独立レビューを修正収束させる
- [x] Asset base型とmetadata／実PDF検証をgeometry側も共通利用する
- [x] 新PdfSurface／CanonicalDocumentSurfaceへ両canonical経路を置換する（source）
- [x] 合流sourceをAstra2名で独立レビューし、型／lint／unit／build／境界を通す（r5）
- [x] 置換後の既存Reader／Ink／付箋／引用回帰20caseを通す（複数run）
- [ ] geometry・resource lifetimeの両engine spikeを通す

Toolsの最終logは`output/shared-app-sticky-annotations-tools-select-browser.log`。前の6case成功と同production sourceの別runで、単一8件成功ではない。旧失敗／各診断は全て保持する。基礎状態を揃えた後、既存sourceの凍結を解除して以下3名Solへ正式実装GO。全heavyはまだ起動せず、全source合流後にUI Solが一括統制する。

| 担当 | 所有・現在地 |
| --- | --- |
| `sol_deleted_comparison_ui` | 新PdfSurface／CanonicalDocumentSurface、両adapter、DocumentLibraryView型、shared entry／境界を実装しr5標準gate成功。現在は唯一のheavy実行担当として既存回帰を順次検証中 |
| `sol_pdf_asset_binding` | useDocumentPdfAsset、Connection内inline loader除去／asset接続、canonicalPdfResourceと純test、capture／previewの実instance短assert共有を実装。6file凍結・Astra再確認とr5標準gate成功 |
| `sol_pdf_highlight_geometry` | geometry／hook／純test、resource単位Doc fact、共通Asset base型／assert利用を実装しr5標準gate成功。専用実PDF spikeの8file draft準備済み、既存回帰終端後の移設／生成GO待ち |

assetはscope／ID／hash／attemptとrepository instance／lifecycleでverified proofを管理し、page固有不一致ではproofを破棄しない。同resource内page移動のURL／PDF Documentを維持し、現在pageだけを既存assertで検証する。新共通renderはDocumentをresource単位、Page／text／drawを固定page／背景／view／DOM単位に分離する。private／readonly scopeRef、paneRef、現tupleのdata-rendered／data-pdf-surface等のDOM契約を維持する。旧PdfPane／WebPdfReaderはlegacy専用へ戻し、新geometry propsを足さない。

共通rendererはsource再レビューで3件の指摘を修正した。仮ratio metricsの永続倍率補正を止め、actual Document／Page両proof後のみ通知し、同Readerのowner／追従pane双方でpinch中sharp redrawを延期する。最後のAstra2名は新P1/P2なし。任意readonly Document observerはopaque instance tokenだけを公開し、イベント／TextLayer callback identityを変えない軽量追補もAstraが確認した。

r5標準gateは全終端成功: 全workspace型15558／lint、依存境界40/40、frontend全単体1,292成功／benchmark1 skip、PC95534／Web57389 build、generator／台帳／diffcheck。14source hashは開始／終端一致。初回unitはUI境界のglobalThis.document1件だけで失敗し、ownerDocument fallbackをwindow.documentへ直してallowlistを緩めずtarget40／全unit双方を通した。ログは`output/shared-app-canonical-pdf-surface-*-r5.log`、初回failureも保全。Python144はread-only TS変更なので先行証拠を維持。r11／paint型を新sourceの証拠へ流用したものではない。

実画面第一群90424は4成功／2失敗・362.50秒。ReadingStateとTranslationSurfacesは各両engine成功・全audit空。PdfReading両engineの失敗はWeb限定のhidden reference canvas attached待機だけで、新共通surfaceのzero-room描画延期に反する旧host差分期待だった。元失敗は`output/shared-app-canonical-pdf-surface-reading-browser-initial-failure.log`。Astra軽量確認後、両hostで初期／sync後／reload後hidden canvas count0へtest-only更新し、倍率・位置・履歴・内容保全のassert／tol／timeoutを全て維持した。E2E型79088／lint10428成功後、focused PdfReading27792は2/2成功・117.972秒（Chrome57.247秒／WebKit57.001秒、全audit空）、`output/shared-app-canonical-pdf-surface-pdfreading-browser-r6.log`へ保全した。先行4件とfocused2件は別runの成功として記録する。

第二群Notebook／Tools77834は4/4成功・439.166秒。NotebookはChrome51.721秒／WebKit73.878秒、Toolsは88.508秒／223.432秒、全forbidden／errors／unhandled／navigationDiagnostics空。`output/shared-app-canonical-pdf-surface-ink-browser-r6.log`。app14sourceのr5 hashは不変。

付箋初回52108は1成功／3失敗・410.76秒。Chrome Native101.45秒のみ成功、Chrome Webは旧pointerupを混ぜたanchor厳密照合、WebKitはsynthetic lifecycle／F37候補後に描画確認拒否で失敗した。初回logを`output/shared-app-canonical-pdf-surface-sticky-browser-initial-failure.log`へ保持。診断45308はChrome Web失敗／WebKit Native成功の限定2件で、他2件を実行していない。実event単調sequenceと同active pageのmarker／Layer／実Coreを観測し、見かけのCSS bboxが確定してもsharp redraw中はmarker=false／Layer pointerEvents=noneで、新pointerdownが届かないことを確認した。既存Map／guardとmarkerは同rasterReadyを参照しており、製品側のguardを緩める根拠は確認していない。元40件ringのlength／末尾依存は旧eventを選びうるため、新操作以降のsequenceだけを厳密照合する。

- [x] Solが現在の同一actual page UUID／背景版／物理page／描画marker／接続Layerを待つ付箋helperへ修正する
- [x] placement／moveではcreate・move modeとLayer pointerEvents=autoを待ち、元整数座標を一度だけ入力する
- [x] F37候補クリック後の描画待ちと2RAFを、元25秒の単一waitForSnapshot期限内へ含める
- [x] 新event由来のanchor厳密一致・既存tol2・全CRUD／history／remote／保存preflight／監視を維持し、Astraが最終差分に新P1/P2なしを確認する
- [x] helper r9のE2E型93540／lintを成功で確認する
- [x] 通常flag OFFの付箋4件を全終端まで確認する（93871、4/4成功・611.684秒。Chrome Native90.726秒／Web71.606秒、WebKit Native126.324秒／Web321.670秒、全case元360秒内・audit全て空）
- [x] 付箋全件成功後、QuoteAppend／TranslatedCitations／AnnotationVariants計6件を単独実行する（1138、6/6成功・315.926秒、全audit空）

診断原log・condensed summaryは`output/shared-app-canonical-pdf-surface-sticky-diagnostic-failure-r7.log`／`sticky-diagnostic-summary-r7.json`（後者も同prefix）。最後の通常4caseは`output/shared-app-canonical-pdf-surface-sticky-browser-r9.log`でexit0、08:01:59.707〜08:12:11.571 JST、app14sourceのr5 hash一致を確認した。固定sleep・入力再送・timeout延長・assert削減はしていない。診断2caseと通常4caseは合算しない。最終全4caseはforbidden／errors／unhandled／navigationDiagnosticsの全集合が空。

新spike fixtureはAstra設計をSolgeometryが`output/shared-app-canonical-pdf-spike-draft/`配下の8fileへsource準備・凍結済み。実resource hook／PdfSurface／ReaderSession／BrowserReaderStatePortとpublic readonly Document observerを使い、geometry／URL lifetime／実PDF検査前に保存倍率を変えないことを両engineで検証する。独立Astra2名のP2（初期landing seed不足による正規の補完保存との競合、hash完了前read recordから旧URL非公開を推定していた検証不足）をSolが修正し、両者の再レビューは新P1/P2なし。正確なseed＋明示flush、再出現を保持するURL履歴の終端検査、ready assetからの即失効を追加した。まだ未生成・未型検査・未実行。現行browserのHMRを避けfrontendへの配置・PDF生成・runtime実行は禁止し、既存回帰終端後に別GOする。PDFスキルのmarker・生成後PNG視覚QAもその時点で実施する。

引用／注釈最終1138は6/6成功・315.926秒、08:13:05.215〜08:18:21.387 JST。VariantsはChrome39.678秒／WebKit57.060秒、QuoteAppend40.069秒／81.111秒、TranslatedCitations31.790秒／61.984秒。全6caseの全audit集合が空、`output/shared-app-canonical-pdf-surface-citations-browser-r9.log`へexit0も記録、app14source r5 hash一致。実PDF文字選択とquote追記、Ink包含captureのred画素と非包含red0、原訳UUID／物理page／anchorと曖昧route拒否を確認した。全process／handle終端とpost-browser台帳／diffcheckも成功。第一群の先行4＋focused2、Ink4、Sticky4、今回6という別runの20case成功証拠で、元失敗を遡及成功にしない。

全browser終端後、geometry Solへ7fileの非上書き移設・直前marker一回・実PDF／oracle生成・8page PNG視覚QAの正式GOを出した。上段の配置禁止はこのGOで解除。重い型／lint／browserは引き続きUI Solだけが統制し、生成／QA sourcefreeze後に開始する。実PDF spikeの12caseとR28入力所有はまだ未受入で、新規highlight作成UIも公開していない。

専用fixture生成は第3試行でexit0。skill markerは直前に一回だけexit0で実行済みで、以後再実行しない。初回はLiberationSansのU+0301欠落、第2回はPyMuPDFの非BMP ToUnicode destinationがUTF16BEでなく実抽出を欠落させたためhardfailした。Solが既存SourceHan fontの実coverage確認・fontTools subsetと生成時ToUnicode正規化で修正し、glyph／CID／期待文字を変えず8page PDFとoracleを生成した。失敗PDFは`output/canonical-pdf-surface-generation-rejected/attempt-2-invalid-unicode.pdf`へ保持、全試行記録は`output/shared-app-canonical-pdf-spike-generation-log.json`。PNG視覚QAと型／両engineはまだ後続で、生成成功だけでgeometryを受入済みにしない。

PNG初回QAでは非BMP glyphの空白を検出し未合格とした。実fontはoutlineを持つがPyMuPDFがCID fontのCIDとGIDを取り違える経路があり、Solがgeneratorのfont encodingを修正中。ToUnicode抽出成功を見た目の保証にしていない。TS5fileを凍結し、独立したPython／PDF debugと並行してUI Solがfulltype29644／lint87738／境界40/40を実行、全exit0（`output/shared-app-canonical-pdf-spike-{typecheck,lint,boundaries}-r1.log`）。browserはPNG再QAと生成差分レビュー完了まで未起動。

本文highlight Coreは`sol_highlight_draft_core`が`output/shared-app-highlight-core-draft/`へoperations／Session／関連純testの4fileを下書き済み。本番srcへ未反映・未実行、追加unitは当初10件。Astra sourceレビューはP1なし・P2二点（新規indexed rangeの受理範囲が広すぎる、背景変更testがrevisionだけを変えて実descriptor不変）で、Solがmirror内で修正中。Astraが入力所有も再設計し、selectstart待ち・toolbar focus・keyboard開始経路・windowキー二重配送の指摘を修正、最終独立確認は新P1/P2なし。採用仕様は次工程設計末尾『F20／R28の次実装仕様』。全面managed選択はgeometryとは別に入力置換gateを必要とし、CSS／作成buttonだけを先行公開しない。

第4生成と最新8PNG QAはexit0で完了。結合文字・ligature・非BMP glyphの可視表示と実抽出、render warning空を確認した。実PDFは70,942B／SHA256 `e3f3992a8f57d9089dc1ae4f0dd8d51fc5dbb316ab486c257ec27c036b655e7d`、oracleは6,020B／SHA256 `bc788f9b4b2f2234a5fa216c24ebc392c4a659b22730b2211cf0f79dfd17391c`。Astra生成差分最終レビューは新P1/P2なし、実font由来のCID／ToUnicode／width、独立Courier marker／座標oracle／tol／assert維持を確認した。同hash再生成は未実証。TS5file／schemaはreview済draftと同hash、app14source r5 hash不変。UI Solへ第1群6caseの正式GO、成功後第2群6caseへ進む。MuPDF生成後検査と独立PDF.js両engineの成立は区別する。

- [x] 専用7fileの非上書き移設、marker一回、実PDF／oracle生成を行う
- [x] 欠落glyphをskipせず修正し、最新8PNG全文を視覚QAする
- [x] 型／lint／境界40、app／TS hash照合、台帳／diffcheckを通す
- [x] Astraが最終generator差分をレビューし、新P1/P2なしを確認する
- [ ] 第1群: resource lifetime／遅延取得／実PDF inspectionの6caseを通す
- [ ] 第2群: 部分選択／回転／倍率／Unicode／font／旧token／DOM／UserUnitの6caseを通す
- [ ] 本文highlight CoreのP2修正・再レビュー・移設・実検査を行う
- [ ] managed本文選択／入力置換と共通UIを実装し、既存引用／draft保存とともに受入する

専用第1群の初回73389は終端exit1・0/6・160.897秒（08:34:25〜08:37:07 JST）、`output/shared-app-canonical-pdf-spike-resources-browser-initial-failure.log`／`resources-failure-summary-r1.json`（後者も同prefix）へ保全した。lifetime両engineはfixtureの固定worker URLとVite pnpm実URL不一致。delayed readのChrome85行／WebKit75行、WebKit inspection161行はtextready待ち。Chrome inspectionは本文assertを通過後、finishのconsole404だけで失敗した。404のURLは未観測でfavicon等と推定してignoreしない。第2geometry群はhold、全handle終端後Solがfixtureのexact workerSrc取得とrawDOM／通信readonly観測を追加中。旧snapshotはbindingがnullならnode数も0となるため、実text DOMが空とまだ断定しない。別Astraがreact-pdfのtext render完了とtext data通知の順序による共通rendererの取りこぼし候補を独立確認中。

Core12追加testのmirror修正は、指摘元と第2独立Astraの双方が新P1/P2なしと確認した。本番へ未移設・型／unit未実行のまま保持する。専用PDF検証中に本番sourceを混ぜず、反映と保存／UI検証は別工程とする。

共通rendererのP2はAstraがsourceで成立を確認し、Sol UIが`PdfSurface.tsx`と新`pdfTextLayerCompletion.ts`へdrawローカルの完了証拠／3arrival joinを実装した。`pdfTextLayerCompletion.test.ts`に8caseを準備し、fixture supportのArray.at非対応は同義の末尾添字へ修正。sourcefreeze後、型／lint→helper8＋geometry11のquickgateを実施し、2Astraの独立レビュー収束後に全unit／両build／境界と第1実PDF群を再検証する。r5の14hashと20case成功は先行checkpointとして保持し、新修正の成功証拠へ流用しない。

R28本文選択は`sol_pdf_managed_selection`が`output/shared-app-pdf-selection-draft/`だけへ新hook／helper／testsとpointer／Reader key入口のmirrorを準備中。本番src／fixture／検査実行には触れていない。PDF pointerとwindow Readerに既存の別contact観測があるため、Astraが唯一のgesture ownerとlocal候補の境界を追加確認している。PdfSurface／Connection／toolbarの本体統合はまだ後続。

join修正のr3型54468／lintとhelper8＋geometry11の19/19は全exit0、全handle終端。第1Astra sourceレビューは新P1/P2なし、現在第2独立Astra確認中。app新hashは`output/shared-app-canonical-pdf-surface-source-hashes-r6.json`（従来14のPdfSurface差分と新helper／test、計16file）、fixture／gen／PDF等9fileは`output/shared-app-canonical-pdf-spike-source-hashes-r3.json`。ログは`output/shared-app-canonical-pdf-spike-{typecheck,lint,join-targeted}-r3.log`。全unit／両build／browserは2review収束後。

R28追加設計はAstraが確定。canonicalでpointer hookのraw接触を正本とし、Readerのwheel／key／GestureEvent guardはreadonly queryを使う。paper swipeも同hookのため経路維持。先行raw記録による自己接触の誤拒否を避け、付箋gesture開始だけcurrent pointerIdを除外するqueryへ変更する。作成buttonは全接触ゼロ。window up／cancelの共通finishとlegacy fallback撤去をM6へ記録する。詳細は次工程設計末尾、managed Solへ共有済み。

join修正は第2独立Astraも新P1/P2なし。r6標準gateは全終端成功: frontend1,300成功／benchmark1 skip（計1,301）、PC67282／Web34126 build、境界40、generator／台帳／diffcheck。Python144は保存source未変更の先行証拠で今回再実行ではない。`output/shared-app-canonical-pdf-spike-*-r6.log`、module graphは`output/shared-app-canonical-pdf-surface-module-graph-r6.json`へ保全。app16fileのr6 hash／spike9fileのr3 hashは始終一致。第1群r2をUI Solがsession29822・`output/shared-app-canonical-pdf-spike-resources-browser-r2.log`で単独再実行。元assert／timeout／全監視を維持し、初回0/6とsource修正後の結果を区別する。

Core担当Solは追加で`output/shared-app-highlight-ui-draft/`だけへannotation facade／フォーム／Layer／F37／Connection等のUI union下書きを準備中。managed担当とはcontroller readSelection／copy／key portを共有し、PdfSurface本体との接続は正式統合担当へ残す。本番はどちらも未反映で、r6実試験へ混ぜない。

第1群r2・29822は全終端exit1、1/6成功・133.36秒、`output/shared-app-canonical-pdf-spike-resources-browser-failure-r2.log`へ保全。WebKit inspection12.51秒だけは全assertとfinish成功。Chromium3件は本文のlifetime／全delayed scene／倍率補正assertを通過後、GET `/favicon.ico` status404・dest=imageのconsole errorでfinish失敗し、passにしない。WebKit lifetimeはhistory forward後67行、delayedはretry scene85行のtextready待ち。ready→nullの公開履歴とrastertrue／fontsloadedを確認したが、font event／view切替の詳細は未観測で原因未確定。ソースr6は固定し、第2geometry群はhold。

UI Solへ本頁とworker bootstrapの有効data faviconを明示し、404をignoreせず原因を取り除く最小fixture修正を依頼した。WebKit問題にはrawDOM／tuple／公開callback比較、必要なら実FontFaceSet eventのreadonly観測を追加する。本体の追加修正はAstra sourceレビュー後とし、先行join P2修正だけで今回全失敗の原因解消とは主張しない。

最新指示により以後のコードレビューをSolへ切り替えた。直前までのAstraレビュー結果は履歴であり、上段の今後のAstra sourceレビュー予定は独立Solへ読み替える。managed選択draftのAstra初回レビューは途中停止・未完了、`sol_managed_selection_review`が独立レビューを引き継いだ。AstraのWK調査は方向案だけで終了した。

UI Solは本頁／bootstrapのdata faviconと実FontFaceSet event／face属性、DOM node identity／構造／CSS幅、公開binding drawnWidth／DPR／viewportのreadonly履歴を4fixture fileへ追加してfreezeした。hashは`output/shared-app-canonical-pdf-spike-source-hashes-r4.json`、app16file r6／PDF不変、型lintはこれから。全runtime／handle終端後、SolへE2E型／lint→第1resource6の診断再runを正式GOした。Astra方向案はfont loadingdone→loadingerrorの終端順序で最後の失効が残る可能性を優先照合し、同width／DPRだけで150ms resize原因と断定しないこと。実causeは未確定。

r4診断sourceのE2E型89843／lintはexit0、hash一致確認後に第1群r3をsession21011・`output/shared-app-canonical-pdf-spike-resources-browser-r3.log`で単独実行中。Chromium3件は11.59秒／18.10秒／13.53秒で全本文・finish成功、favicon404なし。WebKit残3件は実行中で、第2群はまだ未起動。

第1群r3は全終端exit1、5/6成功・120.99秒。Chrome3件とWebKit lifetime／inspectionはfinish含め成功、WebKit delayedのhash scene97行だけtextready timeout。`output/shared-app-canonical-pdf-spike-resources-browser-failure-r3.log`／同prefixの`resources-failure-summary-r3.json`へ保全。失敗sceneはDOM最終4.307秒後の4.368秒にevent.type=loadingを観測したが実fonts.status=loaded、PDF face loaded、done／errorイベント0、binding一度も公開されなかった。node／構造／CSS571／DPR1不変。失敗後のscreenshotで影響されるlate eventは一次根拠から分離する。全errors／unhandled／console／HTTP失敗は空。第2群はhold、app16r6／PDF固定。

Sol UIはfont loadingの無条件失効とdone未到来による回復不足をsourceで確認し、実FontFaceSet.readyと現cycle／drawingを照合、保存済み実text DOM証拠を再検証してrefit後に既存refreshする案を提出した。本体未編集で、`sol_pdf_font_readiness_review`が独立Solレビュー中。単なるready代入やfont失敗の無条件成功にせず、真のfont変更後の補正と旧Promise失効を検証する。

managed選択draftは独立SolレビューでP2二件（長押しwordが無移動の離指で短縮／collapse、keyboard handle端点一致でDOM消失しfocus／key所有喪失）を確認、作者Solがoutputだけで修正中。missing source-sha256.jsonも追加する。cross-pane第二接点の先着候補保持は採用仕様未定義のため、Astraへ方向設定だけを依頼した。UI8source draftの独立Solレビューは新P1/P2なし、付箋四隅hitのP3だけを記録。全draftは未移設・型／unit／browser未実行である。

font readinessの独立Solは具体P2と最小方針を確定し、UI Solへ本体修正GO。同期失効とdraw-local pending gate、実FontFaceSet.ready settlement／現ticket・drawing照合、既存実text DOM証拠の再検証／refit後に既存refreshで再公開する。pending中も実Doc／Page／text／canvas完了factsは受理し、font errorを恒久拒否へ変えたり、全documentの無関係failed／unloaded faceを新条件にしない。新render完了は作らず、ready Promiseのreject／旧cycle／cleanupをfenceする。現実failureとの因果は未確定のまま、sourcefreeze後にSol実装レビューとr7標準／実画面gateを行う。

managedの初回2P2は作者修正後、同独立Solが解消・新P1/P2なしと確認した。cross-paneはAstraの設計で、同Reader別paneの重複接触を両側drain・全接触終端まで復帰禁止、異pane pinch禁止、inactive第二接点でactivate禁止、別Reader独立と確定。作者Solがoutput内だけで追加実装中。UI8sourceのP3は作者Solへ最小hit修正を依頼した。両outputとも本体未移設・全未実行。

cross-pane方向はさらに「読むgesture」とadmit済みInk pen所有を区別した。前者だけ両側取消、後者はstroke／ownerを保護し後着接触の新gesture／activateを拒否。cross-paneを理由にInkのbeforeCommand／commit／cancelActive／cancelPressを呼ばない。主pen通常upは従来処理一回、副接触は全終端までdrain。真のcancel／blur／owner失効は既存契約を維持。managed Solへ方向共有済み、既存readonly所有確認APIが不足する場合はUI接続残件として明示する。

UI8source P3は実hitしたsticky button IDだけを候補へ採用する最小修正を行い、同Sol再レビューで解消・新P1/P2なし。第2独立SolがUI統合draftを確認中。managed側のcross-pane追加はまだ作業中で、今回UI再確認の成功に未実装の統合APIを含めない。

font r7の6file（hook／PdfSurface／completion helper／新font helperと関連2test）はsourcefreeze。font11／completion11／geometry11のtarget33/33、fulltype58049（E2E込）／lintが成功、ログは`output/shared-app-canonical-pdf-font-{targeted,typecheck,lint}-r7.log`。app18fileは`output/shared-app-canonical-pdf-surface-source-hashes-r7.json`、fixture9r4／PDF不変。第1独立Sol sourceレビューは新P1/P2なし、実ready／ticket／drawing／owner検証、pending公開阻止・facts受理継続、通知済DOM証拠のrefit、旧Promise拒否を確認。第2独立Solが確認中、全unit／build／browserはhold。実WK回復と元failureとの因果はまだ未証明。

UI8sourceの第2独立Solも新P1/P2なし。最新cross-paneに必要なreadonly Ink実所有portと、接触中inactive activateの拒否、PdfSurface将来2propsは未実装の統合gateとして明記した。managed側の追加修正完成後にUI接続差分を揃え、実入力・型・保存受入を行う。

font r7は第2独立Solレビューも新P1/P2なし。全unit8936は1,314成功／benchmark1 skip・42.50秒、PC25557／Web37136 build、境界40／contract／台帳／diffcheck全終端成功、r7 graph保全・app18r7／fixture9r4／PDF hash一致。Python144は保存未変更の先行証拠で再実行なし。第1resource6を94165・`output/shared-app-canonical-pdf-font-resources-browser-r7.log`で単独再実行した。Chrome3件17.90秒／25.03秒／21.75秒とWebKit lifetime17.63秒／inspection16.83秒は成功。WK delayedだけcase既存180秒でcancelled、run全体は5成功／1cancelled・fail0・280.995秒。失敗logは`output/shared-app-canonical-pdf-font-resources-browser-failure-r7.log`へ保持。元assert／監視／timeoutを維持し、初回〜r3failureと別に扱う。

WK delayedの全6sceneは作成済みで、旧hash停止sceneもready2、最終displayed sceneはscopeB／attempt1／reads5／Document4／ready11まで到達。font最大53・DOM43・callback33という有限記録で、無限refitloopを示す根拠はない。Node WS2.23GBと複数WKprocessの増加を観測したが帰属は未確定。どの最後のawaitで180秒を超えたかは記録不足で未特定。全観測Node／WK PIDは終端後消滅、無関係processを停止していない。独立Solも新font P1/P2とは判定せず、元r3の初回ready停止と別問題として扱う。

次はNode側test／support2fileだけに既存55statement区間・56await、scene生成／strictfinish／teardownの前後時刻を追加したtrace診断。AST比較でawait順・31assert本文が同一、parse error0。app18r7／PDF／browserfixtureTSX・HTML・types不変、元180秒／25秒とclose順を維持する。E2E型／lint後、同WK delayed1caseだけを単独実行する。他5caseはpattern除外であり、成功数へ合算しない。

Sol harnessレビューは6contextの保存状態独立を確認したが、reads.completedがpre-hashで末尾terminal再検査の観測期間があるため、即contextcloseを完全同等とはしなかった。まず順序不変traceで時間の所在を特定する。別gapとしてnetworkFailures／httpFailuresはmessage記録のみでassertがない点を記録し、trace比較とは別に修正する。screenshot→snapshot後のlate事象を一次原因へ使わない。

markerのみのE2E型56647／lint62984はexit0。WK delayed単独57869は1/1成功・23.424秒（total24.114秒）、元全await／末尾再検査／strictfinish／teardown完走。最長scene作成9.146秒（goto7.918秒）、ready最大0.900秒、cleanup128ms。ログ`output/shared-app-canonical-pdf-stage-webkit-diagnostic-r1.log`、要約同prefixの`summary-r1.json`。前180秒cancelの最終awaitは未再現で未特定、marker／単独環境の影響も限定として保持する。全handle／Node終端・app18r7一致。

同じappとNode markerだけのsourceを維持して、fullresource6のr8・40853を`output/shared-app-canonical-pdf-font-resources-browser-r8.log`で単独実行中。start hashはapp18r7／spike9stage-r1一致、元180秒／25秒、全assert／監視／context寿命順不変。全6成功時だけ第2geometry6へ進む。前r7cancelとfocused1は別runとして保全し合算しない。

managed crosspane追加ではlostpointercaptureを物理up扱いしてrawを消すP2を独立Solが確認した。作者がlostでは候補取消＋rawdrain保持、真up／cancelだけ終端、normalrelease再入とprimaryInk終端維持へ修正し、同Sol再レビュー解消・新P1/P2なし。第2独立Solが最新manifestv3の全managed sourceを確認中。全未移設／未実行。

UI作者Solへ、outputだけでreadonly actual Ink所有port／opaque lease lifetime／接触中activate拒否の追加実装を依頼。必要最小のInkOverlay readonly method、DocumentWorkspace／SurfaceGestureGateのtyped pointer origin mirror追加を許可し、PdfSurface／pointerhook／Readerinput本体は別統合担当へ残す。初回inactive currentpointerだけ除外、第二接触／drainでactivate禁止、crosspaneでInk自動commit／取消しない。writer tokenを公開せず、毎render新lifetimeでraw履歴を失わないことを統合gateへ含める。

resource r8は5成功／1失敗・141.036秒。WK delayedは41.900秒、ready(displayed)成功24.054→39.195秒の後、別snapshot39.195→39.531秒がtextReady=falseとなり、切替前assert220行で失敗。永久nullではなく、font通知後6〜33msに再公開する間のtest TOCTOUとして独立Solが確認した。A修正はreadyと同一snapshotのwitnessを返しbefore／acceptedへ使用、retiredはfresh snapshot、既存31assert本文／25秒条件を維持。Bの診断layout読取変更は混ぜなかった。finishのnetworkFailures／httpFailures空assertは別hunkで強化。

A修正後のE2E型12404／lint／AST差分確認は成功、fullresource64388は5成功／1失敗・113.453秒（WK delayed28.76秒含む他5件は通常finish成功）。全6件の本文assertは到達したが、Chrome lifetimeだけ新networkFailures assertでfixture POST `/canonical-pdf-spike/worker-release`の`net::ERR_ABORTED`を検出し失敗。errors／unhandled／console／HTTP失敗は空。ログ`output/shared-app-canonical-pdf-witness-resources-browser-failure-r1.log`、app18r7／PDFは不変、全Node／handle終端。独立Solがvisible releaseのvoid fetch応答所有／ackとサーバーrelease順を点検中。ignoreやstrictassert削除で通さず、制御I/Oの完了契約を修正する。

UI追加draftは12source（既存11＋新AnnotationForm）へfreeze、manifest v2。追加4はInkOverlay／DocumentWorkspace／surfaceGestureGate／DocumentPaperPaneで、PDFとpaperのactualadmitted Ink読み取り、privateTokenと別lease、pointer／selection lifetime分離、typed originと同Reader gateを配線した。実11source basehash一致／Core4未変更／全未実行。独立Solが追加差分をレビュー中。managed最新manifestv3は同Solでlostcapture解消確認済み、第2独立Solが全6source／4unitを確認中。実PdfSurfaceの将来propsと最終統合は未実施。

## 20. 最新担当と再開地点（2026-10-27）

- [x] ユーザーのモデル指定を反映し、`gpt-6.1-terra`の`terra_implementation`を実際に起動する
- [x] Terraが本書／次工程設計／Core・managed・UIの3draftを読了し、統合残件を引き継ぐ（コード変更・検査起動なし）
- [x] 最新UI12とmanaged6source／4unitは、それぞれ第2独立Solレビューまで新blocking P1/P2なしを確認する（全未移設／型・unit・runtime未実行）
- [x] worker-release制御I/Oを、同じvisible POSTのHTTP200／JSON本文／同Request完了／visible ackまで所有するfixture修正へ変更する（ユーザーのTerra指定前にSolがsourcefreeze済み）
- [x] 上記E2E型88049／lint68545、lifetime19／delayed31の既存assert本文一致、app18r7とfixture9worker-release-r1 hash一致を確認する
- [x] resource6の88994を全終端まで確認する（単一6/6成功、`output/shared-app-canonical-pdf-worker-release-resources-browser-r1.log`、Solが唯一のruntime担当）
- [ ] 全6成功後、専用geometry6をSolが単独実行し、失敗があれば証拠と有限修正案をTerraへ渡す（1990実行中）
- [ ] geometry／resource受入が揃ったら、Terraへ3draftの三者比較・正式統合とPdfSurface残props等の実装GOを出す
- [ ] 統合後、Solが型／unit／両build／境界／実入力・既存引用・保存受入を実行し、独立レビューを収束させる

以後、コード編集は本体・fixture・test・診断sourceを含めTerraへ依頼する。Solはdebug解析／検証実行／レビューを継続し、Astraは設計・方向設定だけを担当する。既存のsourcefreezeとruntime所有を破らず、Terraは正式file指定・GOまで待機する。第19節以前の担当予定は履歴であり、最新指示は本節を優先する。

88994は実POSTのrequest／response ownershipを確認し、元180秒／25秒、finally fallback、network／HTTP strict assertを維持する。結果をまだ成功扱いにしない。App18r7の標準検査成功、resourceの本文検査到達、fixture制御通信の受入、未着手のgeometry／新UI実入力を区別する。既定起動legacy／M6／実機を含む全計画は未完了。

### 第1resource受入の完了と第2geometry（最新結果）

88994は終端exit0、単一full runの6/6成功・225.714秒（10:09:48〜10:13:34 JST）。Chrome15.19秒／19.91秒／16.19秒、WebKit24.46秒／132.54秒／16.51秒、全case既存180秒内。同POSTのHTTP200／JSON本文／同request完了／visible ack、Doc／resource／URL lifetime、旧scope／hash／attempt、初期bad-page回復、実PDF寸法不一致時の保存倍率不変と正常補正を確認した。全network／HTTP／console／errors／unhandled／forbidden strictを通過。app18r7／fixture9worker-release／PDF hashは始終一致。上段の「まだ成功扱いにしない」はこの終端結果で更新する。旧r1〜r8failure／cancelとfocused1成功はそれぞれ保全し、合算による6/6ではない。

Solは同sourceの第2geometry3定義×2engine・6caseを1990・`output/shared-app-canonical-pdf-geometry-browser-r1.log`で単独開始した。patternはreal PDF partial／representative scale／old-token/font、resource6は除外した別run。元180秒／25秒、tol、実PDF／font／worker、全strictを維持。失敗時はSolが証拠と有限案をTerraへ渡し、Sol自身でsource修正しない。

Terraは新しい`output/shared-app-pdf-surface-integration-draft/`だけへ実PdfSurface props／pointer port／overlay／共通CSSと必要wrapper差分を準備中。3つの既reviewdraft自体を上書きせず、base hashと統合順を記録する。現在の本体／fixture／PDFには触れず、geometry受入前に新機能を公開しない。

### geometry初回とTerra修正（最新）

第2geometry1990は4/6成功・2失敗、95.741秒（10:14:35〜10:16:11 JST）。Chrome部分選択／回転11.93秒・scale／DPR／Unicode17.10秒、WKの同2positiveも成功。拒否caseだけ両engineのresize後2回目marker363行でChrome stale-render／WK invalid-selection。旧captureのstale拒否362行は成功、heldfont／DOMfault／UserUnitは未到達。ログ`output/shared-app-canonical-pdf-geometry-browser-initial-failure.log`、要約同prefixの`geometry-failure-summary-r1.json`。全error／HTTP／network／console／unhandled空、app18r7／PDF hash不変、全PID／handle終端。

独立Solは同source／physical／hashのresizeを旧readyで通せるharness raceを確認。Terraがe2e support／test2fileだけを修正し、resize前page／layer identity・幅・URLを保存、既存25秒一回のreadyへnewpage／layer・正width変化・sameURL・current text条件を指定時だけ追加した。新witnessとRange構築直前のDOM identity照合、旧capture拒否と内容不変を保持し、capture後retryを追加していない。glyph math／tol／アプリ18file／ブラウザfixtureは不変。独立Sol source確認は新P1/P2なし、SolへE2E型／lintと拒否2engineだけの検証を依頼済み。初回positive4件とは別runとして記録する。

Terraの隔離integrationdraftはmanagedTextSelectionの型・Connection供給もsource実装し、5sourceの独立Sol2名レビューは新P1/P2なし。追加P3（pointer取消後のkeyboard／AT click巻添え）をPdfSurface／paper／Workspaceでdetail0非消費へ修正し、UI-v2 overrideの2source追加で計7source。Sol再確認でP3解消・新P1/P2なし。元3draft／実frontendは無変更、すべて型・unit・runtime未実行。正式統合前にbase hash／override順を確認する。

### WK部分Rangeの測定差（最新の未完了点）

afterDrawing修正の型18217／lint59711はexit0、support／test逆差分のbaseSHA一致で元assert／await／25秒条件を保持。76580 focused2は0/2・25.294秒。Chromeは全negative本文を通過したがfont-release POSTのERR_ABORTEDでfinish失敗、WKはnewdrawingとcaptureREADYまで進みmarker終端173.558468ptが172±1.25ptを超えた。App18r7／PDFは不変。

Terraがfontreleaseにも既workerと同じ実POST200／JSON body／同Request finished／visibleack契約を実装し、capture結果直後の同同期handlerでbounded last2のplain診断を追加した。Range／canvas／Page／layer／viewport、endpoint spanのrect・font／CSS・offsetWidth、同textのTextItem候補（対応断定なし）を記録し、native参照は外へ出さない。捕捉入力／math／tol／assertは不変。追加同期測定が後続font／admissionのtimingへ影響し得る限定を保持する。Sol独立確認は新P1/P2なし、E2E型93754／lint成功。

59077 focused2は1/2・23.494秒（10:51:18〜10:51:42 JST）。Chromeは新draw／font loading・回復／旧capture拒否／同文node交換・clear・skew拒否／UserUnit実mismatch拒否・overlay0とfont制御通信・全strictfinishまで成功。WKだけ同marker失敗、heldfont以降未到達。ログ`output/shared-app-canonical-pdf-capture-fit-probe-browser-initial-failure.log`、要約`output/shared-app-canonical-pdf-capture-fit-probe-failure-summary-r1.json`。型／lint／全PID終端／hash一致を確認済み。

WKの実capture時はbinding current／fonts loaded、新draw310（旧571）。raw Range x244.0625・width26、canvas x180.390625・width310、自然幅600なので、(rawX−canvasX)×600/310＝123.235887、width26×600/310＝50.322581と現canonical変換は厳密一致。全文span width62.015625、PDF item width120×310/600＝62、offsetWidth62、scale-x≈1、font10.333333px monospace。4文字MMMMの期待部分幅24.8CSS pxに対し実Rangeは26px。全幅fitはほぼ一致している。後のfont通知はscreenshot後なので一次原因へ使わない。

Solへ実測とsourceの独立解析、Astraへ「実DOM Rangeを維持し、共通TextLayerのintrinsic layout＋逆CSS scale等で低表示倍率の精度を確保する」設計方向を依頼中。tol拡大・字数比quad切詰め・font mirror再構成を行わず、glyph輪郭復元を主張しない。実装担当TerraはRootの有限GO待ち、App18r7は現時点未変更。新UIの正式統合はこの受入が揃ってから。

### intrinsic text layout r8候補（現在の本体）

Solの独立数式照合では、smallの実部分Range相対12..38pxは、全文等幅位置12.403125..37.209375のfloor／ceilと一致。wideも同じ関係を確認した。engine内部のpixel enclosureとは断定しないが、offsetWidth全幅丸めだけやcanvas座標変換では部分差を説明できない。

Astraは設計方向だけを提示し、各spanのnative最小font機構を利用する有限spikeを採用した。s=drawnWidth／naturalWidth、PDF.js元M0を保持し、M=max(M0,1/s)。intrinsic fontはH×s×M、逆倍率1/M、横fit分子はitemWidth×s×Mを一致させる。left／top／baseline／layer寸法／rotation／canvas／DPR／viewport／保存座標は変更しない。

Terraが実本体3fileへ実装した。`PdfSurface.tsx`はdrawing-local stateを既存completion／font refitへ渡し、新`pdfTextLayout.ts`がnative M0を保持、M設定→全span offsetWidth読取→同M横補正を適用し同値style writeを省略する。新unit2件は式／M0保持／冪等性／新layer／実font-height不変を確認する。未参照fontHeights cacheは小cleanupで削除し、Sol再確認新P1/P2なし。nativefont-height、font barrier、DOM証拠／token、quad mathとtolは不変。2独立Solの主reviewも新blocking P1/P2なし。実pixel精度と性能の保証はbrowser待ち。

編集前のr7実原本／hashは`output/shared-app-pdf-r7-before-text-layout-r8/`へ非上書き保全。最終App20hashは`output/shared-app-canonical-pdf-surface-source-hashes-r8-final.json`、pre-cleanup版r8と区別する。最終helperSHAは`DBA0CD6A092064A265020F01E8C58DDBBE96CF96A0FDE794B68A10878CD511EB`、testは`6CCF2A1D35315FD2AC71E2D5B35B4DD7EFAB23332FF6A4E009B39D164A5895CA`。

Solがcleanup後fulltype8480／lint37600／target35を全exit0で確認し、全unit89167も1,316成功／benchmark1 skip（計1,317）・35.007秒で終端。PC50244 build進行中、以後Web／境界40／契約／台帳／graphを実行する。全標準成功後、全geometry6→全resource6→production QuoteAppend2を同sourceで順に検証する。いずれか失敗時は以降holdし、Sol解析／独立レビューの根拠をTerraへ返す。保存Python144は未変更sourceの先行証拠、不要再実行しない。

隔離integration7sourceはr7 baseのまま保全する。正式統合時にこれを単純上書きするとr8のlayout改善を失うため、PdfSurfaceはr7 base／r8本体／integration差分の三者比較で必要port・overlay・click差分だけを適用する。

既定起動legacy、ユーザーデータ未切替、全計画未完了は変わらない。source／標準gate成功だけで実DOM・font／selection排他・全F20をacceptedにしない。

### r8標準検査完了とatomic geometry再検証

- [x] r8-finalの型／lint／target35、全unit1,316成功・benchmark1 skip、PC50244／Web53709 build、境界40・契約生成・台帳・diffcheckを通す
- [x] App20の最終hashと`output/shared-app-canonical-pdf-surface-module-graph-r8-final.json`を保全する
- [x] r8 geometry26920を全終端まで確認する（5/6成功・102.036秒。旧runと合算しない）
- [x] Terraがgeometry正常系のcapture直前にcurrentを確認し、同じbrowser taskで実buttonを一度だけclickするharnessを実装する
- [x] readyからcaptureまで単一25秒予算を共有し、拒否後のretryを行わないよう修正する
- [x] 結果公開後のcompleted counterと非layout scalar preprobeを追加し、独立Sol再レビューで前回未達解消・新P1/P2なしを確認する
- [x] 最新harnessのE2E型85958／lint61832／diffcheck、4file hash・App20r8-final／PDF等の不変を確認する
- [ ] atomic修正後のfull geometry6を単独で通す
- [ ] 同App20r8-finalのfull resource6を通す
- [ ] production QuoteAppend2を通す
- [ ] TerraがCore／managed／UI／integrationを三者比較して正式統合する
- [ ] 統合後の型・単体・両build・境界・保存・両mountの実入力を検証し、Solの独立レビューを収束させる

26920ではChrome全3件、WK scale／Unicodeと拒否全体が成功し、r7で不合格だったsmall310幅の部分Rangeも拒否case内で許容差を通過した。WK部分選択／回転caseだけ初回marker316行でstale-renderとなり、回転へ未到達。callbackのready→null→readyを観測したがcapture時刻がなく、screenshot後のlate eventを一次原因に結び付けない。失敗ログと要約は`output/shared-app-canonical-pdf-text-layout-geometry-browser-failure-r8-final.log`／`output/shared-app-canonical-pdf-text-layout-geometry-failure-summary-r8-final.json`へ保全した。

最新harnessの修正前4fileは`output/shared-app-atomic-geometry-before-budget/`へ非上書き保全。snapshotは`output/shared-app-canonical-pdf-spike-source-hashes-atomic-budget-r1.json`、検査ログは`output/shared-app-canonical-pdf-atomic-budget-{e2etype,lint,diffcheck}-r1.log`。geometryの合成DOM RangeとDOM clickは、実pen／touch／trusted pointerの成立証拠にはしない。negative系列・元assert・tol・case180秒は保持。RootはSolへgeometry6→resource6→QuoteAppend2の逐次GOを出し、失敗時は後続を保留する。

atomic-budgetの8187は4/6成功・105.139秒、11:49:23〜11:51:08 JST。Chrome全3とWK拒否全体が成功した。WK部分選択ではcapture開始12407ms／終了12422msでcurrent=true、READYの座標124.005469..173.005487はtol1.25を通過し、marker全座標assertは成功。後のloading12598／12641→公開null12724／newready12726を経た別taskのadmissionでstale-renderとなり、null期待だけ失敗した。WK UnicodeはDPR2の最初の境界負試験で直前loading6848→capture6867 current=falseとなり、期待unsupported-text-boundaryより前のstale-renderで拒否された。原failureと要約は`output/shared-app-canonical-pdf-atomic-budget-geometry-browser-failure-r1.log`／`output/shared-app-canonical-pdf-atomic-budget-geometry-failure-summary-r1.json`へ保全、全hash一致・handle／Node／WebKit終端。製品guardの故障と扱わない。

Terraへ次のharness限定修正を依頼した。正常markerのcaptureと実admission buttonを同browser taskで各一回実行し、両結果を元assertで確認する。Unicode境界と他の正常synthetic multiline／nonBMP／ligatureも、current確認→元Range→capture一回の共通helperへ接続する。各ready／navigateから同25秒、拒否後retry禁止、意図的old-token／font／DOMfault／UserUnit系列は保持する。resource／production Quoteは引き続き保留。

Core4mirrorの追加独立Solレビューは新blocking P1/P2なし。owner／fresh／mayCommit／pending／journal／historyの既存経路を維持するsourceを確認した。追加12unitは未実行であり、既存inkと既存historyを持つpageでjournal／write失敗を組み合わせた保全の直接coverageは統合時の確認残件とする。

正常系のsame-task修正後、独立Solは実capture→実admission間に診断layout／fullsnapshotが残る未達を指摘した。Terraが既存postgeometry診断をqueueMicrotaskへ後置し、両button後に初回snapshotで結果／完了counterを確認する形へ修正。atStart／atEndは即時の非layout scalar、遅延診断はsampledAt／delay／currentを持ち、同期capture時の幾何証拠へ使わない。fixture／support／test／typesの4原本は`output/shared-app-atomic-before-deferred-probe/`へ保持した。

最新deferred-probeのE2E型81191／lint50168／diffcheckは全成功、4hash一致、App20r8-final／PDF等は不変。snapshotは`output/shared-app-canonical-pdf-spike-source-hashes-deferred-probe-r1.json`、検査ログは`output/shared-app-canonical-pdf-deferred-probe-{e2etype,lint,diffcheck}-r1.log`。source reviewで両button間の介入除去を確認中、browser再実行前である。

deferred-probeは独立Sol最終レビューで新P1/P2なしとなった。browser8711は3/6成功・124.933秒、11:56:56〜11:59:01 JST。Chrome全3成功。WK positive2件は初回`page.goto(load)`の15秒期限で停止し、capture0・本文未開始。失敗後artifactのmodule取得にはreact系12〜15.334秒を観測したが、pending request／DCL／load時刻がなく、optimizer／browser／hostの帰属は未分離。WK拒否caseはresize／font／node交換／clearを通過し、skew後の別task admissionだけ期待unsupported-transformに対しstale-render。直近captureはcurrent／tol成立、後font cycleはあるがfault／admissionの時刻がなく直接因果は断定しない。原failureとsummaryは`output/shared-app-canonical-pdf-deferred-probe-geometry-browser-initial-failure.log`／`output/shared-app-canonical-pdf-deferred-probe-geometry-failure-summary-r1.json`へ保持した。全hash一致・全handle／Node／WebKit終端、resource／Quoteは保留。

TerraへNode-onlyのbounded request時系列とgoto timeout瞬間pending記録、controlled node交換／clear／skewのcurrent capture→実fault→実admissionを同task一回ずつへ揃える修正を依頼した。元15秒／25秒／180秒、3理由のassert、意図的old-token／font／UserUnitは維持する。Viteの対象fixtureだけへのdependency scan限定は検討案であり、今回failure原因と断定しない。

別途Terraが`output/shared-app-f20-browser-draft/`へ、highlight life-cycle／PC→Web実同期／keyboard・引用と既存Ink／historyのjournal失敗保全の未実行source draftを準備した。`sol_f20_browser_draft_review`が独立レビュー中。本体へ未反映・全未型／未実行で、受入成功扱いにしない。

最新baseline-admission版はTerra修正後、独立Sol sourceレビューで新P1/P2・未達なし。実capture→実baseline admission→実fault→実post admissionの順に、補助layout／snapshotを挟まず同taskで実行し、後の一括snapshotから同attemptの連続2件を確認して元のnull＋期待reasonをassertする。通信診断はNode側のbounded記録、goto失敗時点のpendingをscreenshot前に保存。isolated Vite serverの`optimizeDeps.entries`は実fixture HTML1件だけを指定し、browserの実import／依存／worker／HTTPは維持する。cold scanの実因果は未確定、新harness revisionとして扱う。

E2E型46105／lint10423／diffcheckは全成功、4hash一致・App20r8-final／PDF等不変。snapshotは`output/shared-app-canonical-pdf-spike-source-hashes-baseline-admission-r1.json`、検査ログは`output/shared-app-canonical-pdf-baseline-admission-{e2etype,lint,diffcheck}-r1.log`。Solへfull geometry6→全成功時resource6→全成功時production QuoteAppend2の逐次GO。旧failureを消さず、load15秒／共有ready25秒／case180秒・全strictを維持する。

baseline-admission91721は0/6・145.508秒、12:05:14〜12:07:40 JST。全件gotoは完了後Logical page可視待ち15秒で停止し、fixture実行／snapshot関数は未定義、geometry本文は全未開始。Vite stdoutにreact-dom export名`t`のSyntaxError、pageerrors原文は全case`['']`。Chrome初caseはmodule HTTP200／finished・DCL／load10.293秒で、以前のgoto load timeoutとは別。最終disk cacheには`t` exportが存在し、browser実受信bodyは未保存のためoptimizer世代混在／serve内容の帰属は未確定。`output/shared-app-canonical-pdf-baseline-admission-startup-failure-summary-r1.json`と元failureログを保持、全hash一致・全handle／Node／WebKit終端。

Rootが採用したfixture一件へのoptimizer探索設定は今回共有初期化故障の後に戻す判断をした。Terraへ`optimizeDeps.entries`指定だけ元未指定へ戻すよう依頼し、通信診断・fault前後の同task基準検証は維持する。実React依存／アプリ本体／lockfileは変更しない。cold scan／export不整合の原因を確定済みとしない。Astraには受入を緩めず工程を前進させる方向設定だけを依頼し、Solはコードレビューとdebugを担当する。

### 工程gateの整理（Astra方向設定を採用）

geometry6／resource6／production Quote2とF20実入力／保存が同じ最終candidateで揃うことは、受入・通常公開の条件として維持する。すべて通過するまでCore／managed／UIのsource統合と型・保存検証まで止める順序gateは外す。runtime終端とr8原本checkpointを条件に、Terraが明示bindingだけのstaged統合candidateを準備し、CSS／pointer／key／copy／overlay／作成入口を一組で隔離する。既定legacy起動と非有効化経路への常時副作用は避け、隔離できない箇所は統合前に報告させる。

同じfull6の反復をやめ、「一仮説→必要最小の計測／修正→focused実験→判定」を一巡とする。app契約違反・harness・起動失敗を分け、独立して成立する他領域の検証まで一律停止しない。別runの成功を合算して単一成功へ変えず、未達は残す。

Terraがentries指定のみ撤去した最新support SHAは`B21FA9D3C7F16A9B4D431799A754032DE4C6734718D3275DC24FD30BB49B64FC`、原本は`output/shared-app-before-optimize-entry-revert/`。Solへ型／lint／hash確認後、Chrome old-token／font／DOM拒否case1件だけのfocused GOを出した。この1件では起動とcontrolled faultの一巡を確認し、他5件を成功へ数えない。完了後にTerraへ正式統合GOを出す予定。実行中の同sourceを編集しない。

F20browser隔離draftの最後のreload後tool既定pen問題は、Terraが実「読む」clickを追加しSol再レビューで解消・新P1/P2なし。highlight SHA`59501a9242f990f3a4081d1b421ef53a5a8150cddb5f836e8f1c8ad493a2cfb1`。managed入力準備、exact blockquote、journal失敗時のoptimistic pending／既存Ink保全と同ID retryもsource確認済み。4draftは全未型／未実行、実入力所有と全保存接続は正式統合後に検証する。

entries撤去後のE2E型94422／lint38640／diffcheckは成功、Chrome拒否focused62707は1/1成功・case18.379秒／total19.393秒（12:12:15〜12:12:35 JST）。実PDF起動、resize旧capture拒否、heldfont loading／回復、node交換／clear／skew各基準admission nullと故障後reason、UserUnit実mismatch拒否・overlay0、全strictfinishを通過した。他5定義はpattern除外で成功へ合算しない。ログ`output/shared-app-canonical-pdf-entry-revert-chromium-refusal-focused-r1.log`、始終hash差0・全handle／Node／WebKit終端。WebKit／full geometryとresource／Quoteは未完了。

Terraは`output/shared-app-f20-preintegration-checkpoint/`へ40対象（既存28／新規予定12）の原本／hashを保全し、`output/shared-app-f20-staged-integration-preparation.md`へ統合順を記録した。ただしmanaged pointer draftがport未指定でも全呼出しへwindow capture／raw inventory／drainを入れるため、legacy PdfPane／usePdfTouchへの常時副作用を隔離できないことを検出。現srcは未統合のまま停止し、Astraへ明示canonical opt-inと共通owner基盤を維持する採用仕様の方向設定を依頼した。本文selectionの有無ではpaper／inactive面を判定できないため、textSelection optionalだけを切替条件にしない。

### F20 staged正式統合の着手（最新）

Astraは「一時的な旧入力実装の分離＋Reader mount単位の明示canonical opt-in」を採用した。managed版は状態機械そのものが違うためlistenerだけboolで止めても旧経路へ戻らない。旧r8hook／旧inventoryとcanonical managed版を一時分け、scope／getPdfPointerOwner／claim・release／usePdfTouchOwnerは既存authority一つを共有する。Reader内で方式を混在させず、全canonical PDF／paper／inactive面へ同じ安定bundleを渡す。text portの有無で方式を推定しない。方式はmount中固定、一pane一実装で、両hook同時稼働や条件付きhook呼出しを避ける。

RootはChrome focused終端後、Terraへ現srcへのstaged統合を正式GOした。TerraはPdfSurface／DocumentPaperPaneのcallerがcanonicalと実PDFspikeだけであることを確認し、legacy PdfPane／usePdfTouchは旧pointer、legacy useViewerInput／LegacyDocumentReaderConnectionは旧Readerを保全して接続する方針。共通owner基盤を抽出し、spikeもmanaged方式を明示する。Core→managed→UI→integrationとF20browser draftをcheckpoint／三者比較で反映中。現在source編集中で、型／unit／build／browserは停止中。

M6撤去対象は旧pointer hook／旧touch inventory／旧Reader fallback／旧caller／互換reexport。一時隔離を恒久的なPC・Web別実装へ変えない。受入・通常公開・既定切替は未完了、67要件の状態は変更しない。

Terraのstaged統合は43変更fileでsourcefreeze。前後hashは`output/shared-app-f20-staged-integration-changes.json`。追加のspike fixture原本もbundle差分を逆変換し元hash`326d2f...`一致でcheckpointへ保全した。旧form caller／inventoryをAnnotationFormへ変更し、旧formを撤去。legacy PdfPane／usePdfTouchはuseLegacyPdfPointerInput、legacy useViewerInput／LegacyDocumentReaderConnectionはuseLegacyReaderInput、canonicalはmanaged hookとConnection生成の安定bundleを使い、ownerはpdfPointerOwnerへ一本化した。r8 font／layout／completion／URL／metricsを維持した旨は実装報告であり、独立確認は後続。

- [x] Core／managed／UI／integrationとF20 browser・追加unitを現srcへstaged統合する
- [x] 原本checkpoint・前後hash・M6撤去対象を記録する
- [x] Sol①が入力／renderer／legacy隔離を独立レビューする（`sol_pdf_font_readiness_review`、新P1/P2なし）
- [x] Sol②がCore／UI／保存／実test接続を独立レビューする（`sol_f20_browser_draft_review`、新P1/P2なし）
- [x] Sol③が型／lint／関連unit・境界を検証する（`sol_deleted_comparison_ui`、sole heavy。関連117は別runで成功証拠、境界40）
- [ ] 指摘・検査失敗をTerraが修正し、Solが再確認する
- [ ] 全unit／両build／Python保存受理／境界・契約・台帳・graphを通す
- [ ] 同じ最終candidateで新UI／入力／保存・既存引用・geometry／resourceを受入する
- [ ] M6既定切替・旧責務撤去・実機確認を含む元計画を継続する

検証準備は`output/shared-app-f20-staged-validation-plan.md`。実機、touch／pen／handle／cross-pane／AT全matrixは未受入であり、追加life-cycle4sourceだけで証明しない。コード編集は引き続きTerra、重実行はSol一名、設計方向はAstraとする。

staged sourceの独立Sol2観点はともに新P1/P2なしで完了した。43file manifest／旧form削除、Core／UIの既reviewmirror一致、legacy hook保全とowner一本化、全canonical面のbundle／現inventory、r8 font・completion・M0／URL・metrics・canvasproof保持をsource確認した。実touch／pen／crosspane／focus等の動的保証は後続gateに残る。

fulltype49399（4tsc/E2E含む）／diffcheckは成功。lint初回はpointer396のunused eslint-disable一件だけで停止し、Terraが動作codeを変えず一行削除、次lint／diffcheckは成功した。関連12file117unit初回は110成功／7失敗で停止。7件は新PDF fixtureのresource未登録によるinitialize時のmissing-or-stale-resourceで、highlight／pending処理へ未到達だった。原ログ`output/shared-app-f20-staged-targeted-initial-failure.log`を保全した。

Terraは既存実PDF fixture bytesをstoreResourceしinspectPdf由来metadataの同ID／hash／寸法で文書を初期化するtest-only修正を行った。製品validatorは維持し、原本は`output/shared-app-f20-before-real-pdf-fixture/`へ保全。最新test SHA`54e87a4cbad837f3bb23af9e8e7916ba498f59d5fb7b410c0b9cba679b02dff8`、pointer commentcleanup SHA`b022896067c17664543e1d384694e56366bf6c1b244513097dbb070d46b90a05`をmanifestへ反映。現在はfixtureの独立Sol再確認と関連type／lint／target再実行、全unit／build／browserはまだ未実行である。

remote背景testも架空hashではrepositoryのbinding検証を通らないと独立Solが確認した。Terraが同登録PDFのphysical page2／実寸へ変更し、背景版変更・fresh拒否・draft保持を維持、再レビュー新P1/P2なし。新test SHA`435474215f3ff9b1e14c45f1603dcc612afa85d40e9ad30a4cbbf8453b2ca7b8`、DocAnnotationDraft22/22成功。前run他95成功とは別証拠として記録する。

境界初回39/40はmanaged selectionのglobal document参照で停止。Terraが接続済Reader rootへのportalとownerDocument一致へ最小修正し、原本`output/shared-app-f20-before-overlay-owner-document/`、新hook SHA`bb9673c4f35394f55c41f066ad0d4e7bcb0bfd18e25d8d6f3b9d1d885a969945`を保全した。独立Solは新P1/P2なし。r5 fulltype54685／lint／diffcheck、境界40、contract generator／ledgerは全成功。全unit16758を単独実行中で、全build／browserは後続。

PythonはTextHighlight indexed／unindexedのschema受理は既存geometry testが持つ一方、SQLite commit→同ID再送→restart→raw historyの全属性保持の専用caseが不足。Terraへ`output`内だけの追加回帰draftを依頼した。frontend標準終端後にsourceレビュー・正式移設・Python既存scope＋新caseを実行し、保存接続を確認する。現Python code／testはまだ変更しない。

### staged frontend標準検査の完了

- [x] fulltype54685／lint／diffcheck、境界40／contract generator／ledgerを通す
- [x] 全unit16758を1,366成功／benchmark1 skip（計1,367、49.315秒）で完走する
- [x] PC40904／Web97387 buildを通す
- [x] `output/shared-app-f20-staged-module-graph-r5.json`（439source）と`output/shared-app-f20-staged-source-hashes-r5.json`を保全する
- [x] frontend43項目・graph・PDF／oracleの始終hash不変と全handle終端を確認する
- [ ] Python dedicated highlight回帰を正式移設して既存144相当scopeと実行する
- [ ] 実PC／Web mountの新highlight／managed選択／引用・保存をfocusedから検証する
- [ ] touch／pen／handle／crosspane／focus／ATの入力matrixとgeometry／resourceを最終同candidateで確認する

Python隔離draftは`output/shared-app-python-highlight-draft/`。独立Solは実PDF登録／正規validator／同ID固定再送／SQLite再読込とraw batch・historyを確認し、実行前提P1/P2なし。receiptは件数だけのassertで完全比較不足だったため、Terraへ初回・再送・再読込・raw receiptのfield比較を追加し、原本を保全して正式testへ移すGOを出した。backend製品コードは変更しない。frontend標準成功を実UI受入・通常公開へ昇格しない。

### Python保存受入完了と実UI検証開始

追加Python testは正式`tests/test_edit_repository.py`へ移設し、SHA`b70e53b5c0a5176ce45b6a89fee814fb35c84051ae6e6a30acadcf7be7441325`。原本は`output/shared-app-before-python-highlight-integration/`、変更manifestは44項目となった。frontend43項目は不変。Sol最終sourceレビューでreceipt完全比較不足解消・新P1/P2なし、元sticky case維持を確認した。

- [x] 新TextHighlight保存caseのfocused1/1を通す（3.67秒、別run）
- [x] 今回明示したcanonical保存14fileを140/140で通す（25454、19.41秒、12:32:54〜12:33:14 JST）
- [x] indexed／unindexed highlightと既存InkのSQLite commit・同ID再送・restart・raw history／全receipt属性を確認する
- [x] 44manifest始終不変と全handle／Python終端を確認する
- [ ] 実PC／Web mountを内包するmanaged highlight lifecycleのChrome focused1件を通す（42806実行中）
- [ ] WebKit／既存引用／geometry／resource／旧経路回帰と実入力matrixを最終candidateで確認する

今回のPython scopeは`tests/test_edit_*.py`12file＋`test_content_publication.py`＋`test_shared_app_acceptance.py`の明示14file。完全な列挙commandと実countは`output/shared-app-f20-staged-python-canonical-scope-r1.log`に記録した。過去144件の元コマンドは残っていないため、scope完全一致や145成功と主張しない。focused1と全scope140も合算しない。hashは`output/shared-app-f20-staged-source-hashes-python-r1.json`へ保全。

Chrome lifecycleは`output/shared-app-f20-staged-managed-highlight-chromium-focused-r1.log`へ単独実行。元300秒／25秒・実mouse／keyboard・全strict監視を維持し、他engine／suiteを並行起動しない。台帳F20へsource・標準検査・保存の証拠を追加し、R28はsource／pure test証拠だけを追記した。accepted 0／partial 46／unverified 21を維持し、R28実操作の未検証を消さない。

初回Chrome42806は0/1・case26.578秒／total27.376秒。PCの実mouse選択→toolbar→form→保存、新version／highlight本文／history+1／quote／quadsは通過。reload直後のidleが未登録の`compositionObservedEvidence`を直呼びしてTypeErrorとなり、reload payload比較／編集Undo／Webkeyboard／strictfinishへ未到達だった。原failureは`output/shared-app-f20-staged-managed-highlight-chromium-initial-failure.log`、全44hash不変・全handle終端。

Terraが新testの既存25秒wait内だけでgetter未登録をnull→false待ちとし、登録後actual read例外は伝播する最小修正を行った。操作retry／追加wait／timeout増／assert削減なし。原本`output/shared-app-f20-before-reload-observer-wait/`、新test SHA`77f533b5e829ebf121b5e4b407f480b48bc7ec0deae7e503763e409901f5b5f9`、44manifest更新。Sol再レビュー新P1/P2なし、E2E59445／lint32458／diffcheck成功後、同Chrome一件66920を`output/shared-app-f20-staged-managed-highlight-chromium-focused-r2.log`へ再実行中。製品source／Pythonは変更していないため、標準成功検査を重複実行していない。

### 実managed highlight lifecycleの両engine成功（最新）

- [x] Chrome focused66920を1/1成功で完走する（case49.009秒／total49.897秒、12:37:22〜12:38:12 JST）
- [x] WebKit focused12027を1/1成功で完走する（case59.346秒／total60.128秒、別run）
- [x] 各engineでPC実mouse／Web実Enter＋ShiftArrow8の選択から、create／保存・history+1／reload exact payload／edit時のquote・geometry保全／Undo・Redo／delete／既存sticky保全／peer通常同期を確認する
- [x] 各runのforbidden／errors／unhandled／navigationDiagnosticsがすべて空、44hash不変・関連process／全handle終端を確認する
- [ ] 既存QuoteAppend両engine2caseを通す（4601実行中）
- [ ] 最終candidateのgeometry／resource／旧経路回帰とR28入力matrixを通す

Chromeログは`output/shared-app-f20-staged-managed-highlight-chromium-focused-r2.log`、hashは`output/shared-app-f20-staged-source-hashes-managed-focused-r2.json`。WKログは`output/shared-app-f20-staged-managed-highlight-webkit-focused-r1.log`。別runの2成功を単一full2の成功と表現しない。現在Quoteは`output/shared-app-f20-staged-quote-append-browser-r1.log`へ単独実行、元300秒／25秒、8字exact引用、PNG／再試行／全strictを維持する。

Terraへ`output/shared-app-managed-input-matrix-draft/`だけで長押し／72px超選択延長／pan・swipe／pinch残指・drain／handle・keyboard／cross-pane・inactive／admitted Ink pen保護の代表実UI試験を準備するよう依頼した。現sourceへ未反映、まだ未実行。実mouse／keyboardと合成PointerEvent・CDP transport、iPad／Pencil実機を分け、DOMdispatchをtrusted／実機証明へ読み替えない。受入台帳の状態は維持する。

QuoteAppend4601は両engine2/2成功・total150.386秒（Chrome48.772秒／WK100.892秒、12:40:47〜12:43:17 JST）。両PC／Web実mountのmanaged8字exact引用、固定retry、PNG／画像追記・全旧assertとstrictfinishを通過した。各forbidden／errors／unhandled／navigationDiagnosticsは空。WK includeInk trueでred2040／2324、falseでred0、black2223／2182保持を観測。44manifest不変・全handle／関連Node／Python／WebKit終端、hashは`output/shared-app-f20-staged-source-hashes-managed-webkit-quote-r1.json`。Chrome lifecycle1／WK lifecycle1／Quote2は別runであり、単一4case成功と表現しない。

Solへ同candidateのfull geometry6を一度実行し、共有起動故障がなければ独立resource6も逐次実行するGOを出した。個別geometry失敗で他領域の受入証拠を一律停止しない。元180秒／25秒／tol／全strict、合成geometryとtrusted入力の区別を維持する。

入力matrix隔離draft2suiteはsourcefreeze、独立Solレビュー中。Chromium CDP touchと両engine keyboard／handleの代表sliceを持つが、Reader page／historyの直接観測、長押しword成立→80px延長の別々のassert、pinch変化／残指drainのno-op排除が不足。全matrixを受入済みにしない。未実装の8px超pan、form copy、Ink pen保護、cancel／blur、逆順、WebKit touch等もREADMEへ残っている。

### geometry／resourceの未達と次のfocused検証

同candidate geometry28006は5/6成功・123.803秒。WK partial／rotationのphysical6もmarker採取・全axis／tol・同task admission nullまで通過し、後の別task「Show captured overlay」でfont cycle後のstale拒否となりpolygon不在timeout。全errors／console／network／HTTP／unhandledは空。原failureとsummaryは`output/shared-app-f20-staged-geometry-browser-initial-failure.log`／`output/shared-app-f20-staged-geometry-failure-summary-r1.json`。座標成立をfull geometry成功へ読み替えない。

独立resource3274は4/6成功・206.170秒。Chrome3とWK lifetime成功、WKdelayedはSwitchscope／Resume後ready25秒timeout（case115.841秒、case180秒内）、WKinspectionは初scene goto(load)15秒timeoutで本題前（18.253秒）。新scopeB ready callbackと後のfont loaded通知はあるが、Nodeの待機期間との時刻対応・回復・sampling／観測影響は未確定。スクリーンショット後snapshotを期中の連続状態へ使わない。全監視は空、旧modulelink初期化故障はない。原failureは`output/shared-app-f20-staged-resources-browser-initial-failure.log`、summaryは`output/shared-app-f20-staged-resources-failure-summary-r1.json`。44hash不変・全handle終端後にsource編集を再開した。

preview2fileはSol方向・sourceレビュー新P1/P2なしを経てTerraが正式移設した。rotation正常系だけcurrent→実capture→基準admission→実preview（内部admission）を同taskへ置き、同attempt連続2check両null／capture+1／admission+2を確認。元Marker／polygon再投影／negative／tol／25秒／180秒／strictを保持する。原本`output/shared-app-before-geometry-preview-transaction/`、新support SHA`22aac4a2f7ddf6803382d543692062319014c940bb9b14dfc2a053a8ab0123cf`、test SHA`ae4a21a7f76c473cf78ece9ef8249abc228343f5e540a9954f8784c0a4abb80c`。manifestは46項目へ増加した。

matrix6fileもP2を補強し、Sol再レビューで限定した代表sliceの新P1/P2なしを確認後、Terraが正式移設した。readiness後baseline、PageUp／Down各直後のDOM page／surface比較、保存Reader stateは存在時のpage／surface関連だけ比較、word成立→文字数増／端点変化、pinch実幅変化のbounded wait、残期限内の新ready witness再取得／旧handle dispose、hasTouch明示opt-in、JSHandle内bounded120event recorderを含む。保存は150ms debounceのため即時live back／forwardを証明しない。実機と未実装matrixの未受入を維持する。

6fileは基準一致（既存3／新規3）とdraft hash一致を確認、原本／不在は`output/shared-app-before-managed-input-matrix/`へ保全。既存managedPdfReady更新＋新規5項目を変更台帳へ追加して全51項目。製品app／Python／preview2fileはこの移設で不変、現在は全E2E型・対象lint／diffcheck・ledger path checkへ進む段階。Solへresource failureの有限静的解析も依頼し、不明点を断定しない。新browserはquick成功後にWK rotationfocusedとmatrix代表からGO予定。

preview＋matrixのE2E型90580／lint32010／diffcheck／台帳path確認は全成功、51manifest一致。hashは`output/shared-app-f20-staged-source-hashes-preview-matrix-r1.json`、ログは`output/shared-app-f20-staged-preview-matrix-{e2etype,lint,diffcheck,ledger}-r1.log`。製品app／Pythonは前標準成功時から不変なのでunit／build／Pythonは重複実行しない。SolへWK rotationfocused1→成功時Chromium selection/pinch/keyboard/handle代表suite1の逐次GO、失敗時原本保存して停止する。

resource時刻解析は`output/shared-app-f20-staged-resource-window-analysis-r1.json`へ有限packetとして保存。直接timeOrigin未採取のため、Node ready開始88.642秒はbrowser40.258〜40.939秒、名目25秒期限は65.258〜65.939秒の区間推定。scopeB ready65.556秒とloaded65.743秒は期限の不確実区間内であり、厳密なpre-timeout回復とは断定しない。teardown前は支持されるが永久nullの証明はない。text完成64.536秒・同page／layer／node／幅、正scope tupleは確認、期中font pending／private currentの同時sampleはない。rAFsampling、観測layout、font feedback、host負荷の帰属は未証明。

WKinspectionはgoto失敗時のreact-dom_client／react-pdf pendingが約86ms／262ms後にfinished、loadが約785ms後。これは本題前の起動段階の失敗で、後の初期化とscreenshotを一次原因にしない。Astraへdevserver準備とbrowser load／resource readyの責務・既存15／25／180秒の根拠ある扱いについて方向設定を依頼した。無根拠なtimeout増・font gate／tol緩和・本体cause断定は行わず、他の実装検証は停止しない。

### 代表touchの一次結果と次の診断

WK rotation80086はfocused1/1成功・case14.847秒／total15.642秒。全marker／四回転／overlay再投影／Doc1／strictを通過し、51hash不変・全handle／WK終端。ログ`output/shared-app-f20-staged-preview-webkit-focused-r1.log`。先行full geometry5/6と合算してsingle6成功にはしない。

Chromium trusted touch代表75863は0/1・case52.549秒／total53.488秒、pinch後のsurface width変化waitでtimeout。longpress word成立→80px延長→endpoint変化→文書／Reader page不変の先行assertは通過。実event／metricsを成功末尾だけreadしfinallyで破棄していたため、failure時のhost／target pane／zoomは未記録で原因を断定できない。原failureは`output/shared-app-f20-staged-chromium-touch-representative-initial-failure.log`、51hash不変・全handle／関連process終端。

独立Solはwidth oracleが固定paneでなくactive `[data-pdf-surface]`のBCRであり、親CSS zoom→Reader倍率に追随することをsource確認。CDP距離は49.244→72.801px（約1.478倍）で正しいが、longpress前の座標再利用が実同paneにhitしたかは未証明。本体修正・assert緩和の根拠はまだない。Terraへhost／phase／既取得値／bounded pointer target・id・XY・trusted／metricsの保存と、catchで原errorを保持したcleanup前の一回診断を依頼した。gesture／元wait／予算／oracleは変えない。現在source診断修正中でruntime停止。

Astra方向では、devserver準備を別の有限phaseへ分ける案を採用候補とした。準備は公開entryの実module graphに限定し、別context／namespaceでPDF・font・resource／遅延control／counterを先に成立させない。まず元15／25／180秒のまま準備効果を識別し、まだ期限境界なら識別実験としてnavigation20秒／ready30秒・case180秒固定を一段階だけ事前指定してよい。これは未適用の方向案で、恒常的な延長や性能保証としない。準備条件／予算を採用する場合は最終同candidate full runで確認し、cold failure記録を残す。

### trusted touch診断で検出したproduction pinch P2（現在修正中）

Terraがtouch試験／pointer recorderへbounded診断を追加し、Sol minimal review新P1/P2なし、E2E型96764／lint88533／diffcheck成功後に同代表32148を実行した。0/1・case46.530秒／total47.327秒、PCのpinch幅待ちで停止。word8文字「Adaptive」→80px延長11文字「Adaptive Co」は成功。trusted touch id3 down SPAN→id4 down DIV role=group→id4 move25pxが同original pane／Readerへ届き、endpoint=nullだった。120 metrics readは完了し、幅508／scroll0不変、catch時parent zoom1／Reader fit-page／Core idle／inputActive=false／physical1。portal誤hit・イベント未到達・locator待ちの仮説は支持されなかった。

原ログ`output/shared-app-f20-staged-chromium-touch-diagnostic-r2.log`と`output/shared-app-f20-staged-chromium-touch-diagnostic-r2-failure.log`、診断要約`output/shared-app-f20-staged-chromium-touch-diagnostic-summary-r2.json`を保全。51hash不変・全handle／関連process終端。入力／座標／assert／25秒／300秒は変えていない。診断によるわずかなtiming影響は残す。

Sol UIと独立Sol入力担当が具体P2経路を一致して確認した。window captureが二指目raw contactを先に登録し、PdfSurfaceのcapture側`pointer.activate`→`useDocumentInkEditor.admitsActivation`の`hasOtherPdfPointerContact`が先着touchを検出してpreventDefault／stopPropagationする。bubbleのfingers.length===2によるpinch開始へ届かない。ReaderSession zoomはraw contactを参照せずcanNavigateのみなので、zoom自己接触拒否説はsourceから支持されない。raw phase／停止位置の直接計測はなく、実因果の最終確認は修正後の同実入力gateへ残る。

Terraへproduction最小修正を正式依頼した。新activation許可は広げず、current active owner・同pane／scope／lifetime、incoming raw touch・scope全体exact2 touch、先着reading phase、input idle、他pane／drain／palm／admitted Inkなしの場合だけcaptureを副作用なしreturnしbubbleへ通す。editor.activate／deactivate／Reader.setSurface／新ownerを呼ばない。inactive／reference／別pane／pen／programmatic／未確定draft等の拒否は維持、三指目の既存drainがcapture停止で失われないことも退行確認する。現在source編集中で全runtime停止、旧通常起動は維持する。

module-only warmupは`output/shared-app-pdf-module-warmup-draft/`4fileの隔離案だけ。Sol reviewでbrowser.closeが30秒予算外・失敗時early teardownがないP2を検出し、採用HOLD。実sourceへ未反映、timeout変更・実experimentも未実施。pinch修正を優先し、warmup cleanupは別工程とする。

### pinch修正の反復レビュー（最新）

Terraはraw exact2同pane touch／reading phase／scope・lifetime・owner条件を読むcontinuation query、captureの副作用なし通過、raw登録での3touch drainを実装した。原本`output/shared-app-before-same-pane-pinch-fix/`。独立Sol pointer担当は新P1/P2なし。admitted Ink判定が3touch判定より先なのでprimary Ink＋3後着touchはpalmとして保護され、別pane drainでもprimary Inkと真up／外部capture releaseの既存契約を維持することを確認した。

Sol editor担当は初案のtool===select限定が、pen等tool選択中の合法finger pan→pinchを依然遮断するP2を指摘した。InkOverlayはtouchを描画から除外し、Connectionはmode ink／入力なしでtouchを許可するためである。Terraがtool条件だけ除き他guardを維持し、Sol再レビューでproduction P2解消・新P1/P2なし。原本`output/shared-app-before-pen-touch-pinch/`。既存読むlongpress→pinchは維持し、pen tool中の別CDP pan→pinch代表とprimary Ink＋3touch優先pure testを追加した。

初案snapshotはfulltype53384／lint／diffcheck成功、tool条件P2のためunit／browser前に停止。修正後r2はlint／diffcheck成功だが、新pen E2EのTS7022循環推論・element any・width unknownの6件でtype98289が停止した。原ログ`output/shared-app-f20-staged-pinch-fix-type-r2.log`、51hash一致・全handle終端。実appのpinch修正後挙動はまだ未検証。

Terraへ型注釈を実model／ElementHandle等へ合わせる修正と、pen case末尾tapだけではdrain解除を証明しないcoverage補強を依頼した。全up後の新current paintとfresh座標で次pinchの実倍率変化を同残予算内に確認し、tool／Doc／Ink／history保持とtrusted到達を維持する。any／tsignore／timeout増／retryで隠さない。現在source編集中、unit／境界／全unit／build／browserは停止中。warmupは別HOLDのまま。

型／coverage修正後、追加pen caseのSol再レビューは新P1/P2なし。全up後に同tupleの現paintを残25秒で再取得し、可視pane／surface交差から新座標で次pinchの実幅変化を確認する。新browser SHA`81a4ac0cd1b5bbbc91a57587b42568c72e6927ff92156c4fbbd337610a6a930a`、editor SHA`b89650c5f825b2e7deb77cf9e8b7f17e470477c4794d48418ebe9cca63995fd8`、unit SHA`5e755699f7dfa8d907a5f5e9b69777299cdbc375d8e0c348b24b936faecba66e`。原本`output/shared-app-before-pen-pinch-test-type/`、manifest51項目を更新した。

r3 quickは全成功。fulltype73944（app／node／tests／e2e）、lint／diffcheck、関連5file66/66（0.782秒）、boundaryVerifier／readerBoundary／sharedEntries実45/45（8.230秒）。以前の40件に合わせず今回実数を記録。ログは`output/shared-app-f20-staged-pinch-fix-{type,lint,diffcheck,target,boundaries}-r3.log`、graphは`output/shared-app-f20-staged-module-graph-pinch-fix-r3.json`、hashは`output/shared-app-f20-staged-source-hashes-pinch-fix-r3.json`。51hash始終一致・全handle終端後、元Chromium trustedtouch代表1→成功時新pen-tool代表1の別focused逐次GOを出した。全unit／buildはこの修正後まだ未実行、過去1,366成功を新sourceへ流用しない。

### production pinch修正の実入力成功と最終standard

読むtouch代表52360は1/1成功（26.115秒／total26.872秒）。PC幅508→751／Web506→748、8→11文字延長、pinch選択解除、drain中metrics／page不変、keyboard再入／文書履歴不変・全strictを通過。pen-tool代表56164も別run1/1成功（22.752秒／total23.384秒）。両hostでpen保持、fingerpan→pinch、全up後新paint→次pinch実幅変化、Doc／Ink／history不変と各sequence trusted入力を確認。53項目前の51hash不変・全handle終端。ログは`output/shared-app-f20-staged-chromium-touch-pinch-fixed-r1.log`／`output/shared-app-f20-staged-chromium-pen-touch-pinch-r1.log`、summaryは`output/shared-app-f20-staged-pinch-browser-summary-r1.json`。

最初の残指操作はCDP pを終えた後にpのidでmoveしており、新native pointerが始まって旧qは保持だけだったことを実traceで確認した。これはreplacement contact drainの別証拠として維持し、同qの現在位置＋85pxを動かすようTerraが補強した。native IDを固定せずpinch直前baseline／座標からp/qを対応させ、pUp→同qId move→同qId up／間newdown・cancelなしをassert。Sol最小レビュー新P1/P2なし。

moduleWarmup cleanup案もSol再レビューでP2解消・新P1/P2なし。専用BrowserServerの期限内close、失敗時bounded owned killと早期teardown／ログ保存、Vite成功時維持を確認。現libにないAggregateErrorはmodule内PreparationCleanupErrorへ置換しprimary先頭＋全cleanup／cause／stackを保全、再レビュー新P1/P2なし。元予算／条件に変更なし。4file正式移設＋bootstrap新規2件で全53項目、原本`output/shared-app-before-residual-touch-module-warmup/`、型対応原本`output/shared-app-before-warmup-error-type/`、最新support SHA`31f0556317573704b041e647ed831d4437f13a173331230befe9718abf9e75cc`。

- [x] pinch後の全frontend unitを1,369成功／benchmark1 skip（計1,370、51.913秒）で通す
- [x] PC78192／Web23022 build、E2E68778／lint15781／diff／ledger／契約、境界22566実45/45を通す
- [x] 53manifest／graph439 source／PDFの不変と全handle終端を確認する（Python140は変更なしで先行証拠維持、再走なし）
- [x] 修正survivor q代表6774を別focused1/1成功で通す（24.641秒／total25.369秒）
- [ ] moduleprepared WKinspection focused1を通す（現在逐次検証へ移行）
- [ ] 同準備条件のWKdelayed focused1を通す
- [ ] 代表keyboard／handles・crosspane、残matrix／最終full geometry・resource／legacy／M6を継続する

standardログは`output/shared-app-f20-staged-pinch-full-unit-r1.log`／`output/shared-app-f20-staged-pinch-build-{desktop,web}-r1.log`等。hashは`output/shared-app-f20-staged-source-hashes-pinch-standard-r1.json`、graphは`output/shared-app-f20-staged-module-graph-pinch-standard-r1.json`。残指の新ログは`output/shared-app-f20-staged-chromium-survivor-touch-r1.log`。PC／Webともnative3up→同native4move実85px→native4up、間newdown／cancelなし・倍率／scroll／page不変・全strictを確認。native番号3/4は観測値でtestの固定値ではない。

moduleprepared実験はまず元nav15／ready25／case180のままWKinspection1→成功時WKdelayed1を順に行い、準備browserの0 PDF／font／worker／control要求・canvas、30秒内close／実browser freshを確認する。準備失敗／所有process cleanup不明ならfailclosedで新run停止。20／30延長はまだ適用していない。coldstartup失敗と準備済機能受入を区別し、別focused成功を最終single full成功へ合算しない。

WK modulepreparedinspection3502はfocused1/1成功（case18.178秒／total18.881秒）。artifact `webkit-9634f92a-e983-4e6b-8f0e-8456a06171d5`はwarmup complete／10.951秒≤30秒／helperClosed=true／cleanup空／PDF・font・actualworker・control request0／canvas0。actual browserTimeOrigin `1793076141911`はwarm helper `1793076129502`と別で、専用helper close後のfresh WebKit launchをsourceとartifact双方で確認。53hash不変・全handle／owned process終端後、WK controlleddelayed35109を同準備条件で開始した。ログは`output/shared-app-f20-staged-moduleprepared-webkit-inspection-r1.log`／`output/shared-app-f20-staged-moduleprepared-webkit-delayed-r1.log`。全6contextとterminal旧応答再検査、元180／25／15秒を維持し、全終端後停止予定。

prepared WKdelayed35109は0/1・case101.794秒／total102.593秒、6個目normalの初回ready217行でtimeout（Switchscope前）。warmup8.737秒／helperClosed／cleanup空／0forbidden／canvas0を通過、全errors／HTTP等は空。時計paired差26msで、waitはbrowser7.833〜32.833秒、actualDoc25.150／DOMpage24.569／layer27.102／canvas27.941／本文31.991〜32.357秒。本文は期限0.476秒前に完成、PDFface30.854秒からloaded・done/error0、public callbackは初null6.428秒だけでreadyなし。raw text-render callback／font ticketは未観測なので、late factsかpending gateか未確定、永久nullと断定しない。

原failureは`output/shared-app-f20-staged-moduleprepared-webkit-delayed-initial-failure.log`、summaryは`output/shared-app-f20-staged-survivor-prepared-browser-summary-r1.json`。53hash不変・全handle／owned process終端後、Astra方向第2phaseの一回識別実験を採用した。専用`PDF_SPIKE_READY_CALIBRATION=1`かつprepared WKcontrolleddelayedだけready30秒、通常25秒・nav15秒・case180秒は維持。各ready開始時の単一deadlineとcase残の短い方を採用し、clock probeも同予算。ready条件／witness／6context／terminal旧応答再確認／strictを変えず、途中延長／retry／timeout0なし。

原2fileは`output/shared-app-before-ready-calibration/`、new support SHA`cc5a6cbaaeab9e19bb4adc649b56b7845c24be27e5e3219acb29abf85e7e41ba`、test SHA`fdd7d804d3b2f1a3468a39c262f1ec526c838a179839278a7a1444b720695106`。Sol sourceレビュー新P1/P2なし、E2E21289／lint74286／diff／ledger成功後、3941を`output/shared-app-f20-staged-ready30-calibration-webkit-delayed-r1.log`へ一回だけ実行中。flagは当shell／子Node限定でfinally削除。失敗時は追加延長せずscalar callback／ticket観測等の解析へ戻る。成功してもcalibration証拠で、まだ新標準の全受入としない。app／Python不変なので過去標準の重複実行はしない。

別途Terraへ`output/shared-app-ink-contact-matrix-draft/`だけでChromium trusted pen＋touch／crosspaneの代表sliceを準備するよう依頼した。actual Ink admit後の副接触、primary通常up一history、残接触drain、全up次stroke等を対象とし、新action/global writerは追加しない。未型／未実行・現sourceへ未移設、WebKit touch／実iPad/Pencil・live Reader historyを既存成功から推定しない。

### ready30識別実験の結論と次のmatrix

3941は1/1成功・case142.797秒／total143.717秒、6context／全guard／terminal旧応答再確認／strictfinishを通過。warmup16.902秒≤30秒／helperClosed／cleanup空／0 PDF・font・worker・control要求・canvasを確認し、53hash不変・全owned process終端、子flagをfinally解除した。summaryは`output/shared-app-f20-staged-ready30-calibration-summary-r1.json`。

ただし各readyは2.006／20.204／20.158／22.484秒で、全て元25秒未満。30秒必要性・旧失敗原因の解決・通常受入昇格は証明しない。識別実験は一回で閉じ、通常25秒を維持する。今後の最終full resourceは採用条件を固定して別に検証する。Astraへcaseごとの独立Node process直列によるorchestrated full6の妥当性を方向設定だけ依頼した。case間共有仕様はなく、case内6context保持／terminal検査は維持するが、累積負荷の原因確定とは呼ばない。

Solへkeyboard ownership／mouse handleのChrome93267→成功時WebKit focused各1→成功時crosspane pdf／paper両定義2caseの逐次GOを出した。crosspaneは各定義にPC／Web両mountを内包、片方削減／併合なし。元300／25秒・assert／strictとlive history／実機の未受入を維持。現在keyboard Chrome実行中、他heavyはない。

Ink-contact draftはTerraが2fileをfreezeし、`sol_pdf_font_readiness_review`がsourceレビュー中。test SHA`f243da1be6e3f7d9fbd973ef4fe764312f712b561272e6f2c99f5ff4fe9f188c`、observer SHA`fc761149491fccb2a07e4dd5f690413f79ceb0653a5818c403c96f782d72468c`。Chromium actual CDP pen force0.5とsame／other pane touch、primary一stroke／一history、全up次strokeを対象とする。Cancel／blur／captureloss・後着pen・逆順・WebKit touch／実機は未実装を明記、現sourceへ未反映のまま。

### mouse handleの実不具合と修正候補（最新）

keyboard/mouse93267はChrome0/1。12文字「Adaptive Con」のhandle ArrowLeft→ArrowRightは成功、handle中心から+12px・4stepのmouse後も選択が変わらなかった。最初の診断追加は宣言hunk未適用でE2E型に停止し、Terraが原本を保全して宣言／try-catch／3秒診断／cleanupを実readbackして完成、type／lint成功後に45034を再実行した。

45034もPCで0/1。handle box(454,277,44,44)、down(476,299)→move479／482／485／488,299→upのtrusted mouse1が正しいoriginal pane／focus handleに到達。raw最終点のnative caretはSPAN offset0／TextLayer外、page713・背景712・physical1・layer接続を確認した。操作中のbinding.isCurrentは未観測と分ける。summaryは`output/shared-app-f20-staged-keyboard-mouse-diagnostic-summary-r2.json`。53hash不変・全handle終端。元inputやassertを本文クリックへ変えて隠していない。

Sol2担当はhandle中心がcaret.bottom+14pxにあり、生client座標をそのままcaret検索へ渡す具体P2経路を確認。Astra方向として、指定logical endpointの現Text node／offsetのcollapsed Rangeから有限・一意なclient rect中心を取り、caret点−grab点のXY差を既存contactへ数値だけ保持する仕様を採用した。handle move/upだけ補正、body／longpress／keyboardは不変。fixed−14／font・文字幅推定／PDF回転再変換はしない。rectなし／非有限／両寸法0／異なる候補で決定不能ならdragを始めず選択保持・body panへ転用しない。

初候補は型31135／lint／44unit／45boundaryが成功したが、Sol2名が同じout-and-back P2を検出。point==downを常にno-opとすると、一度外へ動かした後にdownへ戻しても復帰しない。Terraが既存contactのmoved latchをrawMove／terminalで更新し、未移動upだけ省略する形へ修正。cancelReadingCandidatesでoffsetも明示破棄した。sourceレビュー2観点とも前P2解消・新P1/P2なし。binding／map／owner identityとcurrentの検査、invalid startの選択保持drain、logical anchor/focus役割を維持する。

原本は`output/shared-app-handle-fix-checkpoint/`／`output/shared-app-handle-return-checkpoint/`。最新gesture SHA`78f5f01df2fc5f47b2c316122994d69244777c54677468a8869523150c86e2f0`、pointer SHA`d0c3c67313bc4e2c5e9e3ab7f4b0bbc9ba65173d63a63349f6bacf6615c79c96`、selection hook SHA`a861b7e6af9d97feaeec83527c91f8e0161a6ee90a31cfe54233e05af90d95a1`、unit SHA`510589563164488960ec69debe9f3675e2ba23ef58ade56ce5d55430ca8fe332`、E2E SHA`727e83879d8c5b55f024468ca3b6dfbc72477071d41bf80218b2d285d7066acf`。元focus+12pxを維持した後にout/back復帰／no-motion upの実mouse回帰を追加した。53manifest更新、fulltype90530／関連unit／境界のquick中でbrowserは未開始。過去標準1369成功をこの新app sourceへ読み替えない。

### 次の検証準備（現sourceへ未反映）

- [ ] Ink-contact最終draftを三者比較して移設し型・trusted pen／touch代表を検証する
- [ ] case-process隔離resource runnerを移設してparser unitと準備済・元25秒の6caseを一runで検証する
- [ ] keyboard／handle両engine、crosspane pdf／paper両定義、残matrix・legacy／M6を継続する

Ink-contact draftはreviewの「残touch中newpen未試行」「ready:false idle過渡」「pen down直後admission未検証」「実touch保持未確認」をTerraが補強し、最後のSolレビューで新P1/P2なし。最新test SHA`7a3b285854de12080cac8e09d869b33b9d90c86027f062317c13d17554c3c391`、observerは`fc761149...`。raw touch IDを実座標から対応、primaryup～拒否penまでup/cancel無し、down直後のinput非active／durable等、保存ready／EditGraph版／終点／次strokeを確認するsource案。未型／未実行、OS cancel／blur等未受入は維持。

resource runnerはAstraがcase間仕様非共有・within-case6context保持のprocess分離を妥当と判断。別GPT6.1Terra `terra_resource_runner`が`output/shared-app-resource-runner-draft/revision-2/`だけへ実装し、Sol reviewでTAP skipped11誤判定をNode24のtests1/pass1/skipped0へ修正、再レビュー新P1/P2なし。parser有限fixtureは未実行。normal25／nav15／case180、calibration flag除去、6child直列・no retry、exact selected case／TAP／exit／同run協調cleanup marker／source hashを検証し、不明時STOP・lock保持。Windows Job Object等の敵対的完全保証はscope外、公開APIcloseに基づく協調cleanup確認と未確認時failclosedを採用する。

runner SHA`1043fef1c68b83776840d13de03454775876927d3dc7bb222ca1e8a4ab00f3d6`、parser SHA`1255fbf042cb3ae88004e5e1bec0ad84a634c55671f83fa57148cb97690dd496`。907source manifestは候補で正式freezeではなく、正式install後に`capture-installed-manifest.py`で新規・非上書き採取し`PDF_SPIKE_SOURCE_MANIFEST`を指定する。docs／outputはhash対象外。現supportのbaseは`cc5a6cba...`だがhandle app／keyboard試験は変わっているため最終source一覧を再採取する。runner／support mirror／parser／fixture unit等はまだ現sourceへ未移設、テストも未実行。

### handle修正の両engine実退行成功

handle-return quickはfulltype90530／lint26208／diff、関連44/44（0.586秒）、境界45/45（6.999秒）で全成功。53hash不変・全handle終端、graph／hashは`output/shared-app-f20-staged-module-graph-handle-return-r1.json`／`output/shared-app-f20-staged-source-hashes-handle-return-r1.json`、ログは`output/shared-app-f20-staged-handle-return-{type,lint,diffcheck,target,boundaries}-r1.log`。

- [x] Chrome keyboard/mouse65252をfocused1/1成功で完走する（case22.943秒／total23.639秒）
- [x] WebKit keyboard/mouse86238を別focused1/1成功で完走する（case35.255秒／total35.900秒）
- [x] 各engineのPC／Web両hostで元mouse center＋12px、out/back復帰、no-motion up、PageDown／PageUp個別不変、文書／history保持とstrict観測空を確認する
- [ ] crosspane Chromium pdf／paper両定義2caseを通す（76464実行中、各PC／Web両mountを保持）
- [ ] 新app sourceの全unit／両build／final regressionを通す（以前の1369成功は別sourceの先行証拠）

Chromeログ`output/shared-app-f20-staged-handle-return-keyboard-chromium-r1.log`／WKログ`output/shared-app-f20-staged-handle-return-keyboard-webkit-r1.log`、crosspaneは`output/shared-app-f20-staged-crosspane-chromium-r1.log`。各runで53hash不変・全owned process終端を確認して次へ進み、単一full成功へ合算しない。

次移設のmap／hash手順は`output/shared-app-integration-preparation/README.md`／`manifest.json`。5対象base一致（observer7e845...／resource supportcc5a6...／新Ink test・runner・parser不存在）。Ink draftの参照pointer hookはhandle修正で2155d...→d0c3...へ変わっているため、対象を上書きせずadmission／drain前提の差分を確認する。旧907source candidateを最終とせず、移設後exclusive再採取する。現sourceへのInk／runner移設とparser実行はまだ未実施。

### PDF/PDF跨ぎ成功・PDF/paperの製品gap

crosspane76464は両定義とも入力前に停止。pdfは実react-pdf canvasとhidden previewの二重一致、paperはtranslation poolへpaperを入れたfixtureが`translation-pdf-required`で拒否された。Terraはpdfを同tupleの`.react-pdf__Page__canvas`へ特定し、CDP second bをendした後、旧a同nativeIDのmove/up／aCancelなしを検証するよう修正。paperのvalidatorは緩和していない。E2E49102／lint／diff成功後、pdf exact55355が1/1成功（23.031秒／total23.736秒）。PC／Web両hostでbUp→旧aMove80px→aUp、500ms後選択なし／active original／Doc履歴不変／全up後keyboard再入とstrict空を確認した。ログ`output/shared-app-f20-staged-crosspane-pdf-chromium-focused-r2.log`、summary`output/shared-app-f20-staged-crosspane-pdf-summary-r2.json`。paperは除外・未受入で成功数に含めない。

Astraの設計把握では、現productionのreferenceは現在page cloneだけで、同Readerの異page PDF/paper同時表示経路がない。paperを原文へ移す案もtranslation mapping元がPDF必須のため回避にならない。合法な混在NotebookのPDF A／paper Bと同文書reference page固定を、M4/F23・M5/F27・R28をつなぐ先行sliceとして採用する設計追補`docs/shared-reader-reference-page-design.md`を作成した。これはまだ実装ではない。

設計Sol②はblockなしで、current accepted modelがdurable専用でなくlocal optimistic pendingも含むこと、remote保留中に現snapshotだけでlatest candidate照合不可なこと、reference retry/errorのmain混線防止を指摘。Sol①はP2三点：同target resizeの旧fitを識別する実metrics／pane instance／layout世代証拠、raw contact leaseとfont／draw／head callback世代の分離、Safari GestureEventとzoom commandのtarget/gen latch。AstraへMD修正を依頼し、単一Session・readonly狭型・ephemeral／保存形式不変を維持する。参照を単に未保存中に隠す等でInk/pinch接触を壊さず、実装可能なaccepted-model方針を明記させる。

### Ink／resource runner正式移設と検査（最新）

全runtime終端後、Terraがreview済Ink test／pressure probeとrunner revision2／parser／有限unit／capture helperを正式位置へ移設した。53→58変更項目、原本`output/shared-app-ink-runner-install-checkpoint/`。移設対象は以下。

- `frontend/e2e/webManagedInkContact.browser.test.ts`：`7a3b285854de12080cac8e09d869b33b9d90c86027f062317c13d17554c3c391`
- `frontend/e2e/support/observePointers.ts`：`fc761149491fccb2a07e4dd5f690413f79ceb0653a5818c403c96f782d72468c`
- `frontend/e2e/support/canonicalPdfSurface.ts`：`a459952c80ef5427b24f0c4ebbd33fe8a11aa98e23847b5ff7ba88b065a820a7`
- `frontend/scripts/canonical-pdf-resource-tap.mjs`：`1255fbf042cb3ae88004e5e1bec0ad84a634c55671f83fa57148cb97690dd496`
- `frontend/scripts/test-canonical-pdf-resources-isolated.mjs`：`1043fef1c68b83776840d13de03454775876927d3dc7bb222ca1e8a4ab00f3d6`
- `frontend/tests/canonicalPdfResourceTap.test.mjs`：`034c7af60a15b07e505836ffe76c5129e4e6d2ee81af33a1738a8bd2adb6c579`
- `frontend/scripts/capture-canonical-pdf-source-manifest.py`：`21bd5d7f7c35e85ce50178780bba88ff6279d3a8e998eaa13607fb35501c2323`

正式手順は`docs/shared-app-resource-runner.md`。capture helperはoutput draft依存を撤去し、installed sourceをexclusive再採取する。907候補を最終manifestへ流用しない。docs／outputを対象に含めず、最終型／小修正後に採取する。既存test:web動作とdeps／lockは変更していない。

最初のE2E61761はnewInk test44 expected／47 ready／62 inkのTS7022循環推論any3件で停止。lint7566／diff／ledger58hashは成功、parser unit／関連unit／境界／runner／browserは未開始で全handle終端。Terraへ実型の注釈だけの修正を依頼し、any／tsignore／schema・assert変更・wait追加で隠さない。app srcはhandle-returnのまま、Python140も不変。紙ケースは依然無効translation fixtureで未受入、reference機能の合法経路を実装するまで実行成功へ数えない。

### 直前phaseの診断履歴（再開時は上記現況を優先）

geometry修正は`sol_pdf_highlight_geometry`が新3file内だけで実施し、source freeze済み。既存src／fixture／HTML／依存／重検査は触っていない。採取後にlayerが空、同文字別node、採取nodeの文字列やitem対応変更になった場合も拒否する。成立済みdraftにDOM証拠を持ち越さない。source metadataの既存validator統一とfont／描画lifecycleの実試験は後接続時の必須条件で、pure testだけで完了扱いにしない。

P2修正はsource再freeze済み。captureのreadonly admissionEvidenceにnode／element identity・文字列・item／styles snapshot・wrapper／BR／end要素列を保持し、入場時に再構築mapと完全照合する。中間祖先はcanvasとtextLayer両方からpageまで全て検査する。pure回帰3件を加え計11件を記述したが未実行。Astra2名は旧P2解消・新P1/P2なしを確認。render token／証拠はあくまでdraft入場前だけで、保存payloadへ渡さない。

Tools probeはtest-onlyで元gesture／assertを維持し、同一evaluateのarrow／layer／scrollerとPointerEvent／public input stateを失敗時に出す。E2E型86801／lint80225・公式台帳post-regression checkは成功。focused両engineをUI Solがsession4043、`output/shared-app-sticky-annotations-tools-diagnostic-browser.log`へ単独実行中。他重runなし。新geometryを含む全workspace型／unitはまだ実行していない。

Tools診断4043は終端両engine同assert、約52.46秒。最初のarrow位置採取後のlayer scrollでarrow／layerが55px（Chrome）／56px（WebKit）移動したのに旧arrow座標を使い、実polygonが対象を囲めていないことを確認した。実pointerはInkSVGへ届きinputActive=true、gesture中box固定で、productionの入力拒否ではない。Solが最後のscroll後の同一evaluate座標へtest-only修正し、margin10／5頂点／selection assert／timeoutを維持。Astra軽量確認も新P1/P2なし。E2E型44429／lint76344成功後、focused Tools両engineをsession38994・`output/shared-app-sticky-annotations-tools-atomic-browser.log`で再実行中。元失敗／probeは保全した。

38994は終端両失敗・283.98秒。最初のlasso／両hostのseed geometry・style・clipboard・Undo・eraserは通過した。Chromium104.86秒は254行の文字draft中にdisabled前頁buttonをclick待ち、WebKit178.42秒は227行のWeb側7描画kindのcount付きidle待ちで失敗した。Chromeのbutton無効はF15／F20の未完了入力guard契約どおりとAstraが確認し、強制clickを使わずdisabled assert＋SVG focusで実ArrowLeft→page2／exact draft／全文・履歴／inputActive保持へ更新する。既存remount／remote／取消後採用は維持する。WKはkind／offset・actual events／座標／public stateを、元select→gesture→idleの間に追加wait/evaluateを挟まないreadonly probeで診断する。idleは同期waitForFunctionでready／idle／inputActive false／page別annotation countを待つため、async observer問題とは扱わない。

次のTools sourcefreeze後、E2E型／lintと新geometryの純11件quickgateを重複実行せず確認してから、focused Toolsを単独再実行する。geometryの全workspace型・実renderer接続はまだhold。純testで失敗が出た場合も新3file ownerへ返し、既存Toolsの実行graphに未importのまま修正する。

geometryの初回純testはNode24 strip-onlyでconstructor parameter propertyに停止し、11件は未開始（`output/shared-app-pdf-highlight-geometry-targeted.log`）。Solがtest-onlyの2constructorを通常field宣言／代入へ直してcase／assertを維持した。再runは11/11成功・208ms（`output/shared-app-pdf-highlight-geometry-targeted-r2.log`）。これをhook／実DOMの成立証拠へ代用しない。

Toolsのguard更新後53127は終端exit1・249.98秒。Chromium93.26秒は全成功・audit空。WebKit154.69秒はWeb側最初offset0のpenで、InkLayer不在・boundingBox null・入力event0だった。Coreはready／idle／inputActive false・actual page2・count7→target8で、データreadyと描画面readyの混同が見えた。旧idle失敗はこのrunで未再現として別記し、元ログを維持する。Astraが既存`data-rendered=true`はURL／physical page／drawnWidth／DPRの現tokenを示すと確認し、active paneの期待page UUID／背景版／physical page、正canvas寸法、可視Ink SVGをscroll後に同一DOM観測して元gestureへ入るtest-only修正方針を承認。固定sleep／timeout増加／mouseDown後の再送は使わない。次は全workspace型／lintを含め検査してfocused Toolsを再実行する段階。

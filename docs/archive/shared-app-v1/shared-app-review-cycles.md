# PC・Web共通化 修正と再レビュー

更新日: 2026-10-27

## 引継ぎ時の収束範囲（144項目、隔離T1/T2）

共通RuntimeIoGate初回reviewのP2は、reauthorizeの候補I/Oがclose／revokeで取消・drainされないこと。Terraがgate所有controller・candidate追跡を追加し、自己待機を避けて旧workをdrainする修正後、限定Sol再reviewは新P1/P2なし。generic gate＋unitのみ正式移設し、unit7・型4project・lint・境界45・全frontend1,430成功／benchmark1 skip・両buildを通過した。source144のgateはstagedで、browser authorityの完成は主張しない。

T1はSol2名がCore/readset/memoryとfacade/outcomeを分担review。Node strip-only非対応constructorと、不正publicationをfresh abortedではなくunknownにするP2を修正した。隔離型のunion narrowing／Array.at問題と、T2接続で判明したprivate evidence controller欠落も修正し、限定再確認後の型・6 suite60件が成功した。T2は物理keyを落としてpayloadを別IDとして扱うP2を修正。型4 diagnosticsを有限修正後、T1＋T2の協調隔離型・60件・実IDB両engine2件が成功した。正式factoryへは未反映である。

T3のscoped repository/local ports/raw relocationとnamespace-owner bootstrapは分担source reviewで新P1/P2なし。Raw adapterのe2e移設は認可証明ではなくCore/migration試験境界で、実owner経路の型・fault／permission回帰は次工程。

Nativeでは、破損grantのValueErrorが確定abortedへ混ざる経路と、hold保存時の既発行capability失効不足を修正した。さらにSQLiteの物理key／payload別ID、metadataだけ残るresourceの補修、同incoming versionの破損projection上書きを検出・修正し、最後の限定再reviewは新P1/P2なし。これらnative案は全てsource-onlyで、Python/API協調overlay実行・fixture移行が必要である。

ユーザーの引継ぎ依頼により、ここで新実装・試験を区切った。正式統合と候補の区別・exact manifest・再開順序は[現行引継ぎ書](shared-app-handover.md)、長い旧経緯は[退避した履歴](shared-app-handover-history-2026-10-27.md)を参照する。

## 最新：source142の起動UIと実host接続前の共通transaction設計

B3共通sessionはSol2名の計6P2を修正してsource138へ統合し、全frontend1,423成功／benchmark1 skip・両buildを通過した。B3b UIはpageshowが取消済み旧flightへ合流するP2とfixtureのauto-open前提を修正し、source142へ統合した。監視不足をbrowser実行前に検出してrunnerのみ有限修正。Chromium／WebKitの2caseで同じ入力DOM／値、hidden・inert・aria・focus、locked中I/O拒否と新admissionを確認し、全frontend1,423成功／benchmark1 skip・両buildも成功した。全142hash不変・所有process／PTY残存0。確定要約は `output/shared-app-bootstrap-connection-ui-{quick-summary-r1,runner-quick-summary-r1,browser-summary-r1,standard-summary-r1}.json`。fake-host UIの証拠で、通常entry／実認可の完了ではない。

実host案は未統合・全未実行。native D1bは破損grantのValueErrorをCore確定abortedへ誤分類するP2、D2 serverはholdとgeneration失効の非直列化P2を修正し、Sol再確認済み。Web W1aはrun前後の失効fence、closed gate復活、authorityとDB選択未結合の3P2を修正して再確認した。Desktop driverと全fixture移行はまだ必要である。

W1bで既存Coreのasync cryptoがlive IDB write transaction内にある構造を検出し、Astraが `shared-app-repository-transaction-design.md` へ共通snapshot→memory plan→exact CASとshared RuntimeIoGateを設計した。Sol2名がalgorithm/readsetとauth/gate/outcomeを分担確認。Core成功後にouter gateが失効した場合のunknown責務を一件のP2として追補し、最後の限定再確認は新P1/P2なし。232行、SHA256 `fdcfe1ff23b510551e0d48ecc350a5029bbab17315809171d135c208f75d5e7d`。T0/T1のTerra隔離実装へ進み、formal切替と実host成功はT2〜T4の検証後とする。旧source成功件数を新architectureへ流用しない。

## Core・SQLiteの実source統合とWeb providerの残件（source92）

Core／SQLiteの隔離案を正式統合する前に、Solがnullable proof型、await中のintent alias変更、accepted cacheのみの受理、listのpayload account、実checkpoint hash／物理marker／現control未照合を指摘し、Terraが修正した。限定再レビューで新P1/P2なしとなった後に、Coreと共有intent／SQLiteを統合した。

実行検証はCore TS/Pythonの固定bytes／digestの一致、SQLiteの通常readonly repository readbackを含む恒久testへ進んだ。最新はPython16file160/160、frontend1,406成功／benchmark1 skip、型4project・lint・両build・境界45/45・generator／台帳成功、92項目のhash不変。要約は `output/shared-app-bootstrap-storage-standard-summary-r1.json`。fake OWNER leaseと一時DB、順次2Libraryの範囲に限定し、実認証・並列create・通常entry・Web実行の証拠とは区別する。

追加の独立Sol実sourceレビューで、SQLite `_snapshot` が他account／Libraryのresource bytesまで全表取得し、write lock内で再取得するP2を検出した。TerraがSQLのaccount/library条件を先に適用し、別epochの対象footprintは維持した。無関係bytesを返すと失敗するrow-factory sentinelを恒久testへ追加。source再レビューは新P1/P2なし、focused17/17・同じbackend16file161/161、generator／台帳／diffcheckが成功。要約は `output/shared-app-bootstrap-sqlite-scope-summary-r1.json`。同時にWeb案の全store `getAll` に同型P2が見つかり、account metadata／対象proof／key-only occupancyへ限定する修正を依頼した。修正前のsource承認を最新版へ流用しない。

Web IndexedDBのschema／peer／readonly proof・prepare／execute／ack・public facadeをTerraが隔離案に実装し、Sol2名がcollector／transaction境界とCore／enqueue／ackを分担して確認した。全store bytes取得のP2はaccount metadataと対象Libraryのscope index／key-only occupancyへ修正した。追加P2としてexecute／ackのopen await中に失効するとready DB handleが閉じられない経路を検出し、即時try/finallyへ有限修正。限定再レビューは新P1/P2なし、18file manifest SHA256 `8c599d1e746c51eaf026c61c5eabd3e940b0e46385b2545c3d776f4638c99fd5`。

別のfault fixture3fileもSolが確認し、新P1/P2なし。injected quota／live revokeのexact snapshot、同ID再送、post-ack proof、rejected reservation、通常repository readback、late-open close検査を含むが未実行。並列は同pageの2connections、quotaは注入で実disk枯渇ではない。両runnerはpageerror／unhandled rejectionを監視し、console／network／HTTP全監視という意味ではない。正式統合後にSolが型とChromium／WebKitを検証する。r5のlocal grant／provider descriptor／Library単位capabilityは設計をSolが反復確認済みだが未実装で、現在のOWNER限定listをproviderへ流用しない。下のReader source74以前のレビューは各時点の履歴である。

source113正式統合後、E2E fixture型5件を型指定のみで修正。Solがdiffを確認し、quickの関連53・境界45、両engine保存10case、全frontend1,406成功／benchmark1 skip、両buildが成功した。元型failureは保持し、正常・faultの実行とsource承認を区別した。要約は `output/shared-app-bootstrap-indexeddb-{quick-summary-r2,browser-summary-r1,standard-summary-r1}.json`、所有process／PTY残存0。

次のB2／B1a案はSolが分担レビューした。B2は外部navigationとbindingのaccount/library/epoch未照合をP2とし、constructorの凍結scopeを同期検査する修正と同じdocument UUIDの別scope拒否testを追加。B1aはTS UUID正規表現が末尾改行を許すP2を指摘し、36文字の厳密条件と各ID×LF/CR/U+2028の共有9不正fixtureを追加。限定再確認はいずれも新P1/P2なし。正式統合・契約生成後は134項目となり、実行検証中である。実host認可／通常entryは別工程である。

## 最新の収束範囲と残件

固定参照ページの初回Sol2名レビューでは、terminal自己contact拒否、旧pane lease未解放、pinch後の旧位置復元、描画前入力、復元後の再pin不能、toolbar event欠落、保存await後の配置race、mixed fixture初期化を指摘した。Terra修正後、zoom継続が保全guardまで迂回する点と、同期失効bindingをbooleanで見逃す点も修正。分担した再レビューで新P1/P2なしを確認して共通sourceへ統合した。

actual main swipeでpaperの読むmodeが正常up前にpointercancelになることを確認し、PDFと異なるtouch-actionをcanonical managed main/reference paperに限定して修正した。別Solのscope確認でも新P1/P2なし。両hostのtrusted正常up・一ページ移動・先頭着地、mixed cross-pane／Ink保全、既存cancel/drain単体を通した。fixtureのblank/text、readonly textLayer属性、実toolbar名と読むmodeの前提誤りは試験側として分離し、元失敗を保存した。

source73の保存回帰はChrome成功／WK Web側form待機失敗となり、原因は未確定。実handlerのscalar診断とfailure時のstrict／DOM／PNG保存、primaryを維持するfinallyを追加した。Sol独立確認でguard順序・呼出回数・critical block不変を確認し、source74の同一full highlight2/2と4hostのpositive記録、全標準検査を通過した。keyCurrentはbinding・availability・保存選択の複合判断であり、単独のfont token失効と解釈しない。旧失敗を修復済みと読み替えない。

次の通常起動用Core／SQLite draftでは、async mutable input、generic control経由の初期化迂回、accepted delivery cacheへの依存、account index/payload不一致をSolが検出し、Terraが隔離先で修正した。r4 profile origin追加後はnullable型の扱いと、list／checkpoint hash／現controlを含む受理proofを再確認している。これらは実source未統合・DB試験未実施であり、設計／source収束を保存・通常起動の受入と数えない。詳細は[通常起動設計](shared-app-canonical-bootstrap-design.md)と[引継ぎ書](shared-app-handover.md)。

[初回Astraレビュー](shared-app-code-review-astra.md)の後、修正と独立した再レビューを反復している。重大指摘が連続して出なくなるまで、共通化の次工程へ進まない。収束の目安は、対象を分担した再レビューを2回続け、新たな内容消失・認証混入・復元不能・実用上の停止につながる指摘が出ないことである。試験の成功だけを収束の証拠にはしない。

## 初回指摘への修正

| 指摘 | 修正した責務 |
| --- | --- |
| C01 中央／右ノートの別writer | 同じdesktop registryから文書sessionを取得し、revision、未保存内容、Undo、構造変更を共有。旧ノートページ単位PUTを撤去。応答消失時は同一内容の読戻しで確認する |
| C02 外部Markdown反映のUndo混入 | 外部本文世代の変更でCodeMirror stateを再構築。通常の入力・挿入のUndoと分離 |
| C03 端の文字配置 | 保存前に共通fitInkで境界調整 |
| C04 消去の部分適用 | 削除集合を1つのdurable operationとして保存。失敗集合を保持し、再試行・取消・1操作のUndo／Redoを提供。Python取込も同じ集合を1 transactionで受理 |
| C05 用紙変更の非等方変形 | 共通の物理寸法変換、overflow拒否、明示した等方fitと完全Undo。中央の背景は保存確認済みrevisionに追従 |
| C06 起動照会の永久待機 | 期限・取消・試行世代・再試行を共通起動gateへ導入。失敗を起動許可へ変更しない |
| S01 account認証の未束縛 | 実accountと認証世代へleaseを固定。request、chunk、応答受理で確認し、認証変更時は失効・drain／abort |
| S02 native計算量・派生状態保持 | 不変page/objectを再利用、materialization cacheを16版へ制限。SQLite／IDBのprojectionはroot＋全headsに限定し、正本batchと待機枝は保持 |
| S03 resource破損の見逃し | 対象epochの実bytesをhash検証し、検証とimport marker／active pointer更新を同じtransactionで実行 |
| S04 不正／遅延history | 閉じた不正因果・順序を拒否。未到着参照は保留し、後着の正常metadataで修復 |
| S05 同期の全dataset再取得 | 通常pollではcheckpoint／manifest本文を除外。未ackは保持、既読ID/versionの本文は再取得しない |
| S06 backupの全body保持 | planを先に固定し、Driveは1 body、IndexedDBは単一snapshot transaction内の1 recordずつsinkへ送り、完了を待つ |
| V01 境界検査の抜け | package importとstorage／network globalをAST検査。local binding、型参照、viewのDOM許可を区別 |

旧ノート保存とWeb operationの修正は現行画面の不具合を閉じるためのもの。canonical repositoryへの本番切替や新しい共通editorの完成を意味しない。Webの`web-` IDによる編集制限も、共通editor／権限への接続まで残っている。

## 第2回：独立したAstra 3名の再レビュー

認証・転送・backup・起動・境界検査の担当では追加の具体的P1／P2は見つからなかった。編集と保存基盤では以下の追加問題を確認したため、収束とは判断しなかった。

| 指摘 | 再現と対応 |
| --- | --- |
| R2-01 P1 描画中のremote受信 | 古いgesture内容を新revisionに載せると相手の筆跡を消す。描画中はremote採用を延期し、確定は開始revisionを維持。取消／owner解放で未編集の場合だけremoteを採用。限定session試験で確認 |
| R2-02 P2 大量消去のUndo不能 | 個別に保存できた20,000点×2本をまとめて消すと、復元batchだけが旧1MiB上限を超える。合法なページ全体を復元できる32MiBへ送受信／Python取込上限を一致。Nodeと実SQLiteの大規模Undo・再読込回帰を追加 |
| R2-03 P2 history隔離後のUndo停止 | bare batchを一度通ると、その後の正常編集までUndo不能。履歴の境界として過去stackを区切り、後続の正常操作から再開。参照先が未到着のactionは利用不可のまま、metadata到着時に再構成 |
| R2-04 P2 TSの残存する二次増大 | 20点×80／160／320本のGraph再構築が約1.2／3.2／10.8秒。TS側もcache 16版、検証済みの内部状態に対するpage差分検証へ変更。正本batchと参照の隔離は維持。独立した再点検中 |

## 第3回：修正後の再点検

UI担当が実ChromiumのReaderArea経路で、pointerup前の中央→右移動による線消失を確認した。親のlayout cleanupでownerが解放され、子のpassive cleanupによる確定が拒否されていた。保存要求もpendingも残らないP2であり、pen lift後300ms猶予中の図形にも該当した。owner解放前の同期finalizer契約をsessionへ追加し、InkOverlayとHandwrittenNoteを接続。中央→右／右→中央のheld pointerと、pen lift後の移動をChromium／WebKitで確認した（penのCDP入力はChromium）。

## 第4回：所有者切替と保存応答の再点検

追加P2として、先の線Aの保存中にBを描き始め、A保存応答後、Bのpointerup前にownerを移すと、HandwrittenNoteのfinalizerだけが開始時の古いrevisionでBを保存し409で停止する経路を確認。確定時にsessionの最新ローカルnoteへ対象pageのstroke集合を適用するよう修正した。描画中に別端末から来たremoteをbaseへ載せ替えることはしない。実HandwrittenNoteを使い、Aの応答を遅らせ、B描画中に表示を再作成して2本の保存とUndo2回を確認した。

保存基盤は第3回・第4回とも新規P1／P2なし。第4回の独立probeでは220操作の分岐を完全検証と比較し、660回のcache退避後読出し・逆順配送の221 snapshotが一致した。認証・転送・backup・起動・境界も第2回・第3回で追加の重大所見なし。編集経路は上記の修正後に再度独立レビューを行うため、全体の収束判定はまだ行っていない。

## 第5・第6回：消去履歴と実保存容量

第5回では、消去Undoが新IDで復元した筆跡と過去の描画履歴のIDが食い違うP2を確認した。描画→消去→Undo2回／Redo2回で筆跡が残存・複製する。復元後の新IDを両stackの全参照へ反映し、page単位の履歴更新を原子的にした。実AnnotationStoreの周回と、Chromium／WebKitでsurface再表示を挟むUndo3回／Redo3回を2周確認した。

第6回では、通信上限内でも復元batchが実localStorage容量に入らないP2を確認した。空のChromium storageへ10本×20,000点を個別保存・送信し、集合消去は成功するが、約8.2MBのUndoでQuotaExceededErrorとなる。無制限Mapの単体試験では検出できなかった。消去前に完全な逆操作が端末へ保存可能かを検査し、復元できない集合は内容を変更せず拒否する修正を追加した。これは現行localStorage経路の保全措置であり、新しい共通IDB editorで大きな編集を扱う工程の完了ではない。

## 第7〜第10回と収束判定

第7・第8回の独立レビューは同じ追加P2を確認した。inverse単体の容量検査後に消去journalを加えると、offlineでは両方が収まらず即Undoに失敗する。実装をforward＋inverse本文と両operationキーを一つのscratchへ書く保守的な同時容量検査に変更し、本物の消去journalは検査後だけ保存する。有限総容量Storageで、旧実装の失敗境界における未変更拒否と、両操作を収容できる場合のoffline直後Undoを確認した。他tabや後続編集の容量を予約する機構ではない。

最新修正後の**第9・第10回は、編集経路全体で新規の具体的P1／P2なし**。それぞれ限定28件／26件が成功した。保存基盤は第3・第4回、認証・転送・backup・起動・境界は第2・第3回、追加のnative統合修正も独立2名の確認で新規重大所見なしだった。したがって、今回の実装済み範囲の反復レビューは収束したと判断し、元のPDF縦接続工程を再開する。

この判定は本番全機能の受入や障害不存在の保証ではない。全suite再検証と実機確認は下記の進行状態を維持する。新工程で変更した箇所は改めてレビューする。

## PDF本番接続後の追加レビュー

両本番mountへcanonical PDFを接続した新工程でもAstraの独立レビューと修正を反復した。途中で次の問題が出たため、その時点では収束扱いにしなかった。

| 問題 | 修正・確認 |
| --- | --- |
| 同じ物理PDF頁を共有する論理頁間でfinalizer登録が失われ、held pointer中のunmountで最後の線が保存されない | Browser overlayを論理page IDでkey付けし、登録callbackもpage/session寿命へ合わせた。実rootのunmount・耐久保存・reload・相手host反映を回帰へ追加 |
| 分岐到着前から表示していたheadがselectで選択済みのため、同版の明示checkoutを実行できない | 「表示中の版を開く」ボタンで直接checkoutできるようにした。入力中・保存待ちは拒否 |
| pending Undoのinverse保存後、定期pollがpreferred refreshを世代キャンセルしてUndo前の祖先版を表示する | 希望版を保存完了通知より先に保持し、読込競合・一時失敗で失わない。成功採用または明示checkoutで解除。延期readを使う3回帰を追加 |
| reload／閉じたviewの後続readとWebKitの通信診断 | pagehide／unmountでviewの世代を失効させ、同期・初期loadの各await後に確認。取消可能なbeforeunloadでは終了しない。BFCacheのpageshowでは未完了loadを再開。残るWebKitのcaught-fetch診断はアプリ非依存scriptで切り分け、未処理例外とは区別 |

全修正後、同じ公開範囲を独立したAstra 2名で2巡確認し、新規の具体的P1／P2は出なかった。限定session試験は10件成功。さらに最終の両本番mountを通すChromium／WebKitは2件成功（`output/document-composition-acceptance-20261026.log`）。上記のheld pointer unmount、両hostの集合消去／Undo／Redo／reload、保存応答喪失の同ID再試行、通常同期後の完全一致を含む。最終実行のWebKit通信診断・未処理rejectionはともに0件。全7toolなど未接続の機能は既知の残件であり、今回の収束判定により完了としない。

次工程用の`canonicalInkOperations`は、transform／style／pasteを元annotationへ適用する純粋処理を追加した。6件の専用試験に、実文書sessionでの保存・reload・Undo3回・別session・Redo3回の完全一致を含む。まだ画面から呼び出す接続は完了していない。

PDF接続段階の最終検査は、全単体946件（境界検査を含む）、全4 project型検査、lint、両buildが成功。両本番mountの新規2件とは別に、旧PDF経路の入力・倍率・resize・破損修復・位置復元・toolbarの関連browser 11件も成功した（`output/shared-app-canonical-*.log`）。全Web suiteや全Python suiteをこの新工程で再実行したという記録にはしない。

## 全7tool接続後の追加レビュー

新工程では`InkOverlay`／toolbarの操作をcanonicalの意味別差分へ接続し、Astra 2名の独立レビューを反復した。

| 問題 | 修正・検証 |
| --- | --- |
| text draft外へfocusしてDelete／矢印／pasteを使うと、別操作の受理で未保存文字が消える | hookは同一IDのtext確定だけを許可。sessionも同じ本文・同一IDの単一text変更以外を拒否し、空変更での暗黙破棄を防ぐ。17件のsession試験と両engine実UIで確認 |
| 選択ボタンの出現／消滅でtoolbarが折り返し、fit-page寸法がgesture中に変わる | ボタンは常時配置しdisabledで状態を示す。Webの旧固定幅指定を共通toolbarへ適用しない。入力受付も選択変更より先へ移し、拒否したgestureが選択状態を変えない |
| ページ端のellipse変形で、固定反対端が微小に移動する | 真のellipse極値で変形要求を制限する。固定端・線幅を保持する専用回帰を追加 |
| 長い消去で全prefixを繰り返し処理する | `CanonicalEraseCursor`で追加circleだけを適用。旧cut／eraseは撤去。fragment ID・重なり順・raw属性がpartitionに依存しないことを確認 |

最新sourceの最終2巡でも、独立2名とも新規の具体的P1／P2なし。全単体965件成功・benchmark 1件skip、全4 project型検査、lint、両buildが成功した。全7toolの実PC／Web composition試験はChromium／WebKitで各1件成功し、元compositionの両engine 2件も成功。未処理rejection／navigation診断は全runで0件だった。既存note session・中央／右owner・保存失敗・描画中command・共有toolbarの関連browserも6件成功（`output/shared-app-semantic-legacy-regression.log`）。

fixtureの転送は、耐久受信後に進む`acknowledgePull`とpeer別ledgerへ接続した。全履歴の再配送によるWebKit同期timeoutを、待機上限を増やさず解消した。実Driveの利用やsourceへの書込みはなく、全immutable転送logを保持する。

この収束は今回接続した隔離文書の範囲である。paper／Reader／Markdown／Library／全領域切替、通常backup・復元と実機確認を完了とせず、全計画のacceptedは0件を維持する。

### 同期状態表示のレイアウト追補

操作ロジックの検証後、幅640〜1280pxを40px刻みで調べ、同期状態の短い文言／長い文言だけでtoolbarが折り返し、PCで22.5625px、Webで23.5px、PDF表示領域が縮む境界を両engineで再現した。共通CSSのstatus欄へ固定幅とnowrapを設定し、長い文言は同じ領域内へ収める。入力／保存のJS処理は変更していない。

修正後は2 engine × 2 host × 17幅 × 4文言の272測定が成功し、toolbarと実scroll containerの高さが全68組で一定だった。失敗baselineは`output/document-layout-range-baseline-20261026.log`、成功結果は`output/document-layout-acceptance-20261026.log`。追加Astra 2名の読み取り確認でも新規P1／P2なし。両buildと追加e2e型検査も成功した。

## Python全体検査で確認した統合上の問題

全pytest初回は2,806成功・11失敗・28skip・62deselected、434 subtest成功だった。Markdown統合前のcount／schema期待値の更新に加え、実装側にも、本文変更が差分表示へ出ないこと、旧archiveの再読込時に移行revisionをランダム生成して内容hashが安定しないことを確認した。差分と移行の保全を修正し、file I/Oも共通atomic書込へ接続した。関連8ファイル194件、unified notes 11件、追加保全2件が成功し、**全pytest再実行は2,819成功・28skip・62deselected、434 subtest成功**（`output/shared-app-review-python-final.log`）。これらを単に古い試験として除外しない。

## 検証記録

この節の数値は限定検証であり、全suite／全計画の合格数ではない。

- 実PC部品のReaderArea、NotesPane、NotebookViewによる中央⇔右、保存失敗、Undo、再起動をChromium／WebKitで確認。外部Markdown反映、端の文字、用紙変更と明示fit、Web消去のquota失敗／再試行を含む関連browser 6件成功（`output/shared-app-ui-review-browser.log`）。
- 大きい消去復元を含むWeb operation単体9件成功。Python側ノート・PDF ink・notebook・Web取込の関連75件成功。新しい検証結果で更新するまで全suite成功とは記録しない。
- レビュー修正時点のfrontend全単体924件、全型検査、lint、PC／Webビルドは成功。Pythonの全型検査とruffも成功。**全browser suite 73件も成功**（`output/shared-app-review-browser-final.log`）。owner切替、遅い保存応答、Undo ID伝播、実quotaによる拒否／小集合Undo、PC取込、native再起動、Chromium／WebKitを含む。その後の新工程で行った変更は別に検証する。
- native性能は20点×80／160／320本でGraph 0.0217／0.0436／0.0952秒、peak 0.537／1.026／2.009MiB。派生cache GC後の一時SQLiteは0.316／0.523／0.922MiB。先行N−1件をcheckpoint取込後、最後の1筆を通常commitした比較であり、全本番操作の速度を保証する値ではない。
- TS性能の修正後probeでは同じ20点×80／160／320本のGraph構築が34.5／76.6／104.5ms、checkpoint再起動が32.3／53.9／107.2ms。GC後の追加retained heapは約237／237／451KiBでありpeakとは異なる。[再現script](../frontend/scripts/benchmark-edit-graph.mjs)を保存した。実画面やDB保存時間を含む値ではない。
- Windows WebKitでは通常のfixture書込自体がBlobを拒否するため、大容量IDB試験はArrayBufferを使用。Chromiumでは実Blob。他環境WebKitとiPad／Safari／ペン実機の確認は別に残す。

現時点で全計画のaccepted数は増やしていない。新canonical保存先の通常backup／move／restore、全writer停止、全領域変換、両本番compositionからの一連の操作証明は引き続き必要である。[次工程](shared-app-next-steps-astra.md)は、レビュー収束後の隔離libraryを用いたPDF縦接続から再開する。


## paper／Reader接続の反復レビュー（2026-10-26）

paperのページbuilder、物理背景、両host接続を別々のAstraが実装し、別境界を独立レビューした。paper接続単体では新しいP1/P2なし。その後Readerの状態・位置・入力へ範囲を広げると追加問題が出たため、前段の収束判定を新段階へ流用していない。

| 問題 | 対応 |
| --- | --- |
| PageUp直後、位置通知前に閉じると末尾指定が消える | 保存stateへ現在landingのtop/end/placeを含め、純粋モデルで位置通知なしの往復を検証 |
| PCが同じlandingのjumpTargetを毎render作り直し、保存・poll・位置記録で先頭へ戻す | canonicalから旧jumpTargetを外し、共通位置処理だけをownerにした |
| Webが旧pageのenabled viewportを新pageへ報告する | PDF surfaceを論理pageと背景revisionでkey付け。readyにもsurface identityを持たせる |
| 同pageの背景変更でpaneがremountしてもlistenerが旧DOMへ残る | 共通hookの寿命をsurface identityへ結び付け、scroll／input／resizeを再接続 |
| Safari gestureだけzoom anchorへ入らない | normalized zoom commandからwheel point／既定anchorを共通処理へ渡す。touch pointerの既存anchorへ二重適用しない |
| 参照側Ctrl+wheelの画面座標を編集側へ適用する | 各pane自身のgeometryからanchorを採り、各render完了で個別に適用 |
| hidden参照PDFの旧倍率正規化が共通zoomを書き換える | `externalReadingState`で旧倍率／位置ownerを停止し、寸法観測だけを維持。PCの旧resize位置処理もcanonicalでは停止 |
| 丸めで同幅のzoom anchorや、新入力後の旧anchorが残る | 各paneのrender完了で同幅も終了し、新しい通常inputで取消 |
| 参照側へtop/end landingが届かない／同寸法・同physicalPDFページではmetrics再通知されない | 参照readyを待って共通landingを適用。paper/PC PDFともcanonical surface identityの変更で再通知 |
| Webの新workspace内でPDF領域の高さがなく、fit→autoheightの循環で1pxへ縮む | 実画面の寸法診断でWeb pane1200×1.28125、canvas1×1、overlay0×0を確認。host wrapperへ明示heightを追加 |

この追記時点では修正後のPDF実画面回帰を実行中。直前のpaper Reader試験はChromium25.01秒／WebKit31.51秒で、両hostの型付き倍率・位置・配置の再読み込み、PageUp末尾／button先頭、wheel・Safari event・左右それぞれのanchor保持が成功した。その後のsurface-ready・旧owner停止・参照landing・高さ修正は、最新sourceでもう一度検証する。静的レビューの新規P1/P2なしと、実画面の成功は別々に記録する。


### この工程の収束と元タスクへの復帰

最新sourceは独立Astra複数名による後続レビューで新規P1/P2が出ない巡回を継続して確認した。実画面の新Reader4実行に加え、canonical composition／paper／全7toolの両engine6実行と旧Markdown UI2実行もすべて成功した。最終の単体1,015件・Python関連36件・全型検査・lint・両buildが成功。詳細と正確な検証範囲は[実装記録](shared-app-implementation.md#paperreader工程の最終チェック)へまとめた。

元の計画を再開し、Markdown core／scope scratch／registry回復・離脱／共通panel／ページ無し配置sessionを実装した。追加レビューで古いreadによる保存済み本文の表示巻戻りを再現して世代失効で修正し、別Astraの再点検と別の独立レビューでも新P1/P2なし。新adapter追加時に既存draft helperを上書きした問題は復元し、新adapterを別fileへ分離した。Markdownの新UIを両本番mountへ接続したという完了記録にはせず、その工程を次に続ける。


## Markdown本文の本番接続後レビュー

controllerとhost UIを別Astraが実装し、rootが種別resolver・entry・保存unionを接続した。相互に自分の実装を除いた境界を独立レビューし、当初は新P1/P2なしだったが、実画面でblur保存による配置click消失を確認した。UIのsavingだけによる無効化を外し、保存確認を共通controllerに一本化した。修正後、dirty本文＋選択のまま直接移動する回帰を両host／両engineで確認した。

その後のerror表示整形、ReaderFrameの純粋module分離、bound composition全体のlazy化も独立2名で再確認し、新P1/P2が出ない巡回を継続した。初回multi-headの明示選択を実画面へ加え、PDF／paper側も含む最終8対象は7成功＋限定fixture診断分類後の補足1成功としてすべての機能検証を通過した。元失敗を成功logへ書き換えず、アプリ非依存minimalと補足logの関係を実装記録へ明記した。

この収束はMarkdown本文の共通接続範囲であり、画像・引用・Library・backup・既定起動の残件を解消済みとはしない。全単体1,017件、全型、lint、両buildと実画面の正確な範囲は[実装記録](shared-app-implementation.md#markdown本文の両本番mount接続2026-10-26)を参照する。

## Markdown画像の反復レビュー（2026-10-26）

画像契約、parser／表示、実画面試験を3名のAstraへ分担し、rootが編集sessionと共通controllerへ接続した。実装後は担当を入れ替えて独立レビューを繰り返した。次のP2を再現し、回帰を追加して修正した。

- 下書き本文とmanifestの不一致を見逃し、画像参照なしで本文を確定する経路。current／append snapshot／flightを照合し、不一致のrawを保全する。
- scratchがないjournal-only復旧で同じ照合を通らない経路。共通flight生成の入口でも検証する。
- 契約上有効な逆順manifestをUndoで拒否する問題。比較用コピーだけをsortし、送信済みpayloadの厳密な再送内容は変更しない。
- 非ownerの読み取り専用表示面から、他ownerの保留画像を取り消せる問題。UIのdisabled、controllerのowner引渡し、coreのenabled／pending／owner確認をそろえる。
- previewがrenderごとに新しい画像componentを作り、通常pollだけで画像を再mountしてBlob URLを作り直す問題。componentとURL変換を安定したmodule scopeへ置き、manifestとresource portだけを表示用contextで渡す。実DOM・Blob URL・resource読出し回数の維持を追加回帰にする。

owner修正後は別々のAstra 3名が新しいP1/P2なしを確認し、実画面8件も成功した。その後のcomponent identity確認で上記の再mountを検出したため、修正・独立レビュー・画像試験を追加する。URI／引用markupとcitation resolverも相互に独立レビューし、Readerの位置指定操作は別Astraが確認した。引用の共通navigationや実画面接続の完成を、この基礎処理のレビュー結果から推定しない。

実画面の初期失敗は破棄していない。fixture module初期化前の観測呼出し、Reactのpreview button commit前の瞬間的なcount確認、単発の応答喪失がautosaveの再試行で解消する試験条件をそれぞれ分けて修正した。障害解除前の同ID・同payload再送と、解除後の実「再試行」clickを検証する。最終sourceの検証結果は実装記録へ追記する。

画像component identity修正後は別々のAstra 2名の独立点検で新P1/P2なし。追加のPNG／SVG両engine 4件が成功し、両hostで同期2回後も同じDOM要素・Blob URL・自然寸法・実resource読出し回数を維持することを確認した。最後の点検でも参照許可・owner・取消・再試行・非同期完了の無効化・URL寿命に新しい大きな指摘はなく、この画像工程のレビューは収束と判断した。先行8件の成功logと最後の4件の補足logを別々に保持する。

元タスクの引用navigation設計も再点検した。同scopeの資料切替でscope全体のprepareLeaveを使う前案には、未表示の復旧draft自身を開けなくする問題があるため撤回した。現在controllerのclose guardとscope/account退出guardを分け、復旧先のdirty／pendingをopening拒否条件にしない方針へ修正した。未表示sessionも含むbeforeunload確認の実装は次工程に残す。

## 引用リンクと資料切替の本番接続（2026-10-26）

前工程で区別したclose／scope guardを実装した。共通navigationが資料IDと資料間の戻る履歴を持ち、両controllerが現在の入力・保存だけを確認する。未表示の復旧draftがあるまま復旧先へ開けることを実repository＋registryで確認した。beforeunloadもneedsExitConfirmationへ統一し、未表示sessionとdraftを検査する。

原文への引用リンクは両本番mountへ接続し、stable page ID・背景版・pt anchorを最新の選択snapshotで再検証する。Readerと描画完了待ちの変更を別担当に分け、その後相互に独立レビューした。旧背景の遅いready通知が最新背景をreadyとして扱わないようexpectedSurfaceKeyを通知元から渡した。さらに設計との照合で通常stepが戻る履歴へ追加される差を修正し、jump／jumpToの履歴追加と分離した。拒否・端の変化なしでは履歴を変更しない。独立レビューの再確認で新P1/P2はなかった。

新しい実画面試験では同pageの異なるanchorへの実scroll、資料へ戻る、存在しない／削除済みpage、背景不一致、未対応訳文の明示拒否、元Markdownのquota失敗時の本文保持を検証した。初回WebKitはquota解除後にautosaveが成功してretrybuttonが消える試験操作の競合を確認した。解除と実DOMのretry clickを同一taskへまとめ、元失敗logを保持して補足実行を成功させた。両engineの機能確認後、新step版も含む既存回帰をsource固定で実行する。

引用作成・追記先選択・capture・訳文表示・全Library・既定起動・全領域切替は別の未完了項目として残す。リンクからの原文移動だけでこれらを完了扱いにしない。

最終の固定production source 12対象は、初回9成功とfixture補足3成功ですべて確認した。通常stepの履歴を前提にした旧PDF test 2件を、stepが履歴を作らないことと明示jumpの履歴復元を両方証明する形へ更新した。Markdown WebKitの残る1件はcatch済みreadonly dataset-control通信の診断で、app非依存最小再現を追加してからengine／host／reload／exact endpoint／全stackを限定して分類した。元失敗・再現・補足の対応と各時間は実装記録に残した。

## 引用作成・領域captureの反復レビュー（2026-10-26）

引用要求session、PDF選択／capture、実画面検証を3名のAstraへ分担し、rootが共通controllerと両hostを接続した。相互レビューの初回は新P1/P2なしだったが、rootの取消経路点検で「宛先側の画像取消後も引用元が退出を保留する」P2を再現した。exact requestの画像準備を観測した場合だけ引用元も取消へ遷移させ、別要求・本文保存待ち・受理後Undoを区別する回帰を追加した。修正後は独立Astraの再確認でも新P1/P2なしを継続確認した。

実画面14対象は初回13成功＋fixture限定修正後の補足1成功。async待機oracleの実装不備はapp非依存で再現し、値をawaitする期限付きpollへ修正した。既存iPhone／PWAの3箇所も同様に修正し、実suite3件が成功した。この工程のレビューは収束と判断し、元タスクのLibrary縦接続へ戻る。captureの全注釈・clipboard fallback・実機まで受入済みとは扱わない。ログと検証範囲は実装記録の同日節へ記録した。

## Libraryの最初の縦接続と反復修正（2026-10-26）

次の元タスクとして、scopeのcatalog authority、registry復旧・退出、共通一覧／作成UI、実画面検証を分担した。作成はcatalog項目と初期contentを既存publicationで公開し、別writerを増やしていない。

独立レビューで、journal復旧後に一度catalog readが失敗すると成功後もrecoveryBlockedとunhandledが残る問題を修正した。続いて同期で明示選択した版が解除される問題、metadata・戻る・引用への版伝播漏れを修正した。rootは単一headの通常移動まで版固定していたため作成後の戻るが拒否される問題を確認し、通常移動と明示版選択を分離した。さらに同資料の版指定なしopenがno-opになり固定解除できない経路も修正した。

最新の独立2名の再レビューで新P1/P2なし。Libraryの両engine実画面もWebKit成功＋Chromium補足成功として確認した。失敗はreload wrapperを準備完了と扱った箇所と、再読込後JSON object key順を要求内容の違いと扱った箇所に分けて保持し、controllerの実準備完了と全構造deepEqualへ改めた。失敗baseline、source固定の検証、未完了機能は実装記録へ明記した。

その後の既存引用／Markdown／PDF Reader／文章・画像追記の両engine8回帰も、固定sourceの単一runで8/8成功した。実画面で追加の重大問題は出ず、この作成・復旧範囲の反復レビューは収束と判断する。全計画を完了扱いにはせず、Astraの次工程案を計画書へ反映してLibraryの改名・履歴へ進む。

## Library改名と有限Undo／Redo（2026-10-26）

同じLibrarySessionへ改名と履歴操作を追加し、pure builder／inverse、保存session、共通UI／registry、実画面を分担した。作成とは別のwriterやjournalを作っていない。フォームはedit-start titleを保持し、他操作による名前変更と競合したら入力を残して拒否する。

独立レビューとroot点検で、履歴の未対応操作を境界として扱う処理を「現在の再送要求の検証」に流用したため、未対応のfolder／削除／新item／metadata要求まで送信できるP2を確認した。現在要求にはstrictなtitle変更検証を追加した。さらに、不正なUndo／Redo参照が過去履歴のgapとして扱われて通る経路を実repo journalで再現し、復元したstack末尾のoperation IDとexecution IDが一致することを要求した。いずれもcommit 0とraw不変の回帰を追加した。過去履歴のgap／resolution境界は維持する。

修正後の独立再レビューは複数名とも新P1/P2なし。最新単体1,113件、型・lint・両buildと、新規実画面4件が成功した。PDFで改名・応答消失・履歴再読込・キーの一回適用、Markdownではquota失敗中の本文と同じeditor DOM保持・見出し更新・本文履歴との分離を確認した。元タスクの残件を維持し、全Libraryや既定起動を完了扱いにしない。

後続の既存作成・Markdown・PNG／SVG・PDF Reader計10件も、固定sourceの単一runで10/10成功。Python保存／intentの関連14件も成功した。実画面で追加の重大問題は出ず、この改名・履歴範囲のレビューは収束と判断した。次のタグ・既読も同じauthorityへ追加し、別保存経路に分けない。

## Libraryタグ・既読の一括操作（2026-10-26）

pure builder／finite inverse、LibrarySession、共通選択／タグ入力UI、実画面を分担した。複数対象も一つのbatch／Undoにまとめ、対象と入力はawait前にコピーする。置換のexpectedTags、無変化、保護属性の拒否、失敗後の同ID復旧も確認した。

独立レビューで、子コンポーネント内にあったタグ入力・削除チェックが一覧の折畳みや資料openで消えるP2を確認した。親の保持draftへ移してcontrolled化し、追加／削除／置換それぞれで折畳み後の実入力保持を回帰にした。rootは未編集置換のUI即closeがexpectedTags検証を飛ばす点も修正し、raw配列の無変化判定より先に期待値を照合するようにした。外部実repository更新後に未編集でApplyし、alert・入力保持・追加commit 0となる実画面回帰を追加した。

修正後の複数Astraの再レビューは新P1/P2なし。新規2件と既存8回帰が固定production sourceで成功し、全単体1,121件・型・lint・両build・Python関連33件も成功した。実画面で追加の重大問題は出ず、この範囲のレビューは収束と判断する。全計画は継続し、次のfolder工程では互換性のために曖昧な二重配置を残さず、所有itemのfolder排他条件を先に固める。

## Libraryフォルダー階層と共通退出guardの反復レビュー（2026-10-26）

所有itemの`ownerId !== null ⇒ folderId === null`不変条件、folder作成・改名・移動・内容保持削除・有限inverse、IDベース階層UIと深さ4000の非再帰projection、選択フォルダーへのノート作成、`LibraryContentConnection`への`beforeunload`集約を実装し、独立Astraレビューを繰り返した。

引継ぎ後の最終独立レビューで、複数head時の版選択とdraft初期化、`library-folder-title-changed`の競合メッセージと対象存在確認、移動・削除時の展開とfocus／選択分離、および実画面試験での折畳みdraft保持・本文controller未準備時の`beforeunload`・選択フォルダーへの実ノート作成の検証を追加し、再レビューで新P1/P2なしを確認した。初回WebKit実行で検出したreload中の`replication.flush()`失敗直後の`library.refresh()`発火も修正し、元失敗ログ（`output/shared-app-library-folders-browser-initial-failure.log`）を保持したまま、固定production sourceで新規実画面2/2・関連回帰10/10・全単体1,134件・型・lint・両build・Python関連48件の成功を確認した。F31は確認範囲について`partial`へ更新し、drag/dropや関連・論理削除・回復等の残件へ進む。

## Library関連・note独立化・owner削除・観測heads付き論理削除の反復レビュー（2026-10-26）

独立PDFと独立noteの双方向関連（単一／一括のdialog追加・HTML5 drag/drop追加・重複no-op・関連解除・`↗`双方向link行表示とクリック移動）、owner配下への付属ノート作成、owned noteのownerフォルダー末尾への独立化（`detachNotes`）、未保存／未確定local編集を解消・拒否する削除前共通guard（`prepareDeleteTargets`／`canDeleteTargetsSync`）、およびowner削除時の既定`detach`（子ノートを残して関連を解除）と明示`delete`（子ノートも論理削除）の2モードと各対象contentの`observed` heads記録・有限Undo／Redoを同じ`LibrarySession` authorityへ接続した。

独立Astraレビュー（Cycle 1）で検出した5件（E2EのARIA/ボタン文言整合と`papeer://resource/invalid`による未確定下書きの決定的保持、論理削除された表示中資料の読み取り専用遷移`useLibraryItemDeleted`と`ContentNavigationSession.back`への削除済みsource追加防止、note再結合inverseでのowner生存・folder一致検証、`deletionEdit`の空`itemIds`拒否、`DocumentEditSessions.heldTargets()`への`NoteAppendSession.destinationId`追加）を全て修正し、Cycle 2再レビューでP1/P2残件0を確認した。実画面試験で発生した初期失敗ログ（`output/shared-app-library-relations-browser-{initial,second,third,fourth}-failure.log`）も全て保持し、応答消失後のreloadで既にserver受理済みの削除PDFが読み取り専用（`PDF書き込みレイヤー`非表示）になることの検証、WebKitでの`前の資料に戻る`押下前の`資料一覧`折畳み、peer同期直後の非同期`library.refresh()`完了待機（`value.version === finalHostState.library.version`）へ整理したうえで、固定production sourceで新規実画面2/2・関連回帰12/12・全単体1,138件・型・lint・両build・Python関連137件の成功を確認した。F33・F38は確認範囲について`partial`へ更新し、削除済み項目の回復一覧・後着未確認編集一覧（F38残件）や添付（F34）・書誌metadata（F32残件）・検索（F36）・注釈一覧（F37）へ進む。

## Library検索・表示条件の反復レビュー（2026-10-26）

引継ぎ済みの回復／書誌情報をAstra 2名が独立再点検し、新P1/P2なしを確認してからF36へ進んだ。検索／表示条件はLibrarySession配下のread-only QuerySessionへ置き、取得port、共通照合、共有UI、両本番mountの実画面まで接続した。

- Cycle 1: 2名が、通常の3秒同期によるsame-catalog通知で遅い本文検索が毎回abortされるP2を独立に指摘。catalog変更と軽量な本文revision比較を分離し、不変ならinflightと確定結果のidentityを維持するよう修正。
- Cycle 2: scope取消後のabort済signal再利用、初回revision取得失敗後の再開停止、同revisionで一時的なPDF抽出失敗がpartialに固定される経路を指摘。未完了／abort済scanの再開と、明示更新のforce retryを追加した。
- Cycle 3: 2名の再点検で新P1/P2なし。
- Cycle 4: public入口・既読／削除／複数head、UI・owned検索・reveal・試験の観点を変えて2名が再点検し、新P1/P2なし。補足された隠れたチェック項目と表示bulk対象の交差ケースも実画面試験へ追加。

deferred portで旧query・clear・catalog変更・scope取消後の遅い応答拒否、5回のsame-catalog poll中の単一scan維持、head更新、初回失敗後の再開、同revisionの明示retryを検証する。PDF source hash・physical page対応・deleted page除外、複数headのMarkdown、repository/checkpoint/history/journal不変も確認する。

新規実画面はChromium35.60秒／WebKit71.85秒、2/2成功（総109.32秒、output/shared-app-library-search-browser.log）。同一corpusのmetadata／保存Markdown／real PDF本文／owned hit、AND条件・tag/read・各sort、collapse／資料open後の条件、hidden checkedの保持とvisible-only draft、revealとfocus、catalog／content／history不変を確認した。全計画・既定起動・実機の受入完了とは区別する。

検索追加後の既存回帰で、回復／書誌情報suiteの試験条件を2点修正した。資料タイトルとMarkdown本文の同名h1へのstrict locator重複は、両frameのh1.border-bへ限定する。後着編集のpeerが未同期という仮定は通常3秒pollで崩れるため、peerのpullだけを一時的な空deltaとして返し、既存flight完了後に削除→peer編集耐久化→通常pullへ戻す順序を固定する。未受信削除のackは増やさず、実編集・unobserved判定・readonly表示・復元・既存履歴assertを維持する。Astra独立確認でproduction保存／回復を迂回していないことを確認した。

元runはoutput/shared-app-library-search-regression.logにexit 1（8成功／回復2失敗）のまま保持する。修正後の回復suiteは別run／別logとし、単一run10件成功だったとは記録しない。

## 添付と通常作成Undoの反復レビュー（2026-10-26）

F34をSession/保存・exact-ID navigation/表示・historyの3担当に分け、rootが共通UI・両mountの実画面を接続した。担当を入れ替えた独立レビューで以下を修正した。

- 公開前のFile読取をUI外のreader portとしてSessionへ渡し、await前から未保存sourceを退出guardに含める。resource失敗はbytes/IDを保持し、公開前取消は遅いIO完了を世代で拒否する。
- 通常のnote/notebook/attachment作成Undoに必要なproofはpending outboxから推測せず、保存済みpublicationの軽量originをTS/Pythonのrepository.readで投影する。ack後にも残り、本文全体をcatalog pollへ含めない。
- creationUndoの本文head未着でdurable history replayがthrowし一覧全体が停止するP2を修正。確認不能のdurable actionは履歴境界とし、catalog/deletedContent waitingを表示する。pendingのstrict proofと同一payload再送は維持する。head到着後に同じhistoryからRedoが復帰する実Session回帰を追加。
- 添付Viewの通常pageshowが読込世代を失効させるP2を修正。手動同期もtimerと同じcatch/世代/active検査へ統一し、失敗時のunhandledと離脱後refreshを防ぐ。

これらの修正後、観点を変えた独立再レビューで新P1/P2なしが2巡続いた。その後の初回実画面で、catalogだけ存在しitem未取得のWeb初期起動が同期へ進まないP2を検出。kind解決全体を一度ordinary syncで再試行し、explicit headを維持するhelperへ修正した。さらにinitial multiheadで実controller未mount→明示選択もcurrent-unavailableになる経路を再現し、loader/error/lazy待機中だけreadonly closeguardを持たせ、conditional unmountで実controllerへ引き継ぐ。Navの未登録sourceを無条件で迂回しない。両修正を別々のAstraが独立確認し、新P1/P2なし。

初回browserは0/2・exit1のままoutput/shared-app-library-attachments-browser-initial-failure.logへ保持。修正後の実画面と最終標準検査の結果は別runとして記録する。HTML/Markdown添付は安全なsource表示と元bytes downloadで、編集可能なノートへ変換しない。

## 原訳surface・Reader接続の反復レビュー（2026-10-26）

原文論理UUIDと訳文collectionの実UUIDを分離し、原文／訳文／左右表示、翻訳済みfilter、単一toolbar・文書history、実pageごとの位置、active面の倍率下限とguardを共通Readerへ接続した。

- Cycle 1: 訳文draft復旧時の表示面、同page指定のfilter解除、Home/End着地、cached viewportによる下限再評価、多対一mappingの通常render/filterにも曖昧判定が必要な点を修正した。
- 位置hookの再点検: 非操作面がpollやactive面のzoom復元を追従scrollと誤認し、保存済み位置やanchorを上書きする経路を修正。実利用者scrollだけに追従し、各面の描画完了と寸法を確認して復元する。
- 入力gateの再点検: windowの`stopImmediatePropagation`が同windowのpointer解放を止める問題を`stopPropagation`へ修正し、blur時にもgateを解除する。
- Cycle 2および再開後の別観点レビュー: Astra 2名がReader/mapping/filter/positionsとUI/gate/同page入力を独立確認し、新P1/P2なし。

新規実画面`webDocumentTranslationSurfaces.browser.test.ts`は2/2成功（Chromium36.46秒／WebKit63.44秒、総100.59秒）。原文logical1/3/7と訳文physical2/4/3、欠落placeholder、filter移動／同page解除、選択gesture消費後のキー操作、原訳筆跡と共有Undo/Redo、文字draft guard、倍率下限・resize・実DOMのreload位置復元を両本番mountで確認した。既存回帰と訳文引用専用試験は別runで追記する。既定起動と全M3完了は宣言しない。

その後の第3観点レビューで、両面が同じscroll位置の試験だけでは独立位置の復元を証明できない点を指摘。単面で別位置を作成し、split復帰とreload後の実DOM、3回のCtrl+wheelでactiveの指位置とcompanionの先頭位置を検証するよう強化した。初回の強化runは6成功／2失敗（output/shared-app-reader-surfaces-browser-final.log）。別の原訳位置runも0/2（output/shared-app-reader-surfaces-browser-positions.log）として保持する。

診断で、訳文単面のscrollTop420／正規化y約.151から左右表示へ戻ると、保存値は.151のまま実表示が420／y約.315になる不具合を再現した。Primary hookが新pane寸法に旧描画幅のreadyを受けてpending復元を消費し、その後の新描画幅で再復元しなかった。readyへdrawnWidthを保持し、zoom anchor処理中以外の描画幅変更で再復元する。診断前後のrunを別logに保持し、修正後のChromiumは両host通過（38.25秒）。両engineと既存読書回帰で最終確認する。

この一次修正をAstraが再点検し、drawnWidth変更だけではtouchのdevice-owned anchorを共通復元が上書きするP2を指摘。再復元はfitWidth／fitPageWidthの変更に限定した。scale-onlyのpinchと離指後のsharp redrawではdevice側を維持する。新規実画面にはChromiumの実touch pointerで倍率と中心を変え、離指・再描画後のpt位置を比較する回帰も追加。最新修正をAstra 2名が再確認し、新P1/P2なし。

## F37注釈一覧の読み取りモデル・未接続UIのレビュー（2026-10-26）

durable headだけを読むcorpus、stable row／variant／原訳tupleのprojection、microsecond日時sort、NFKC AND、固定Markdown、世代付きSessionと共有Panelを準備した。まだregistry／本番画面／append writerへの縦接続前であり、F37受入完了ではない。

- Cycle 1: 2名が、catalogの無関係なmetadata更新でも全取得結果を消すため、次のread失敗時にstale保持が働かないP2を独立に確認。同ID/kindのsourcesと選択／scrollを保持し、削除・型変更だけ除去するよう修正。
- 同cycle: 許容された負のannotation anchorが引用URI生成でthrowするP2を確認。位置をclamp／捏造せず、固定export開始を明示失敗にしてrowsとexportErrorを保持する。両ケースを追加unitへ固定。
- Cycle 2: Coreの修正を2名が確認。Panelのsession instance差替えで旧pendingExport／busyが残るP2を追加指摘。instance別keyで内側Panelをremountし、旧async完了を世代で拒否する。
- Cycle 3: Core／Panel最新修正に2名とも新P1/P2なし。13単体が通過。UIのmount・場所移動・appendの実画面試験は縦接続後に実施する。

## F37縦接続の反復レビュー（2026-10-27）

scope singleton／共有Connection／exact版navigation／annotations一操作追記／新規宛先作成とscratch復旧を接続し、3担当の実装を入れ替えて独立点検した。

- annotation要求の取消後、`refresh(preferred)`が先に版を採用してしまうP2を修正。DocumentEditSessionへ採用前guardを追加し、current head・全payload・世代を照合するまでmodel/history/preferredを変更しない。新たな復旧intentも勝手に採用しない。
- 一覧で選んだcatalog BをNavの旧pin Aへ解釈するP2を修正。文書sourceVersionと別に明示catalog版／nullを渡す。
- catalog未ready時に旧行をavailableとしてexportできるP2を修正。旧行を残して操作を停止し、通常のcatalog refreshから回復する。
- BFCacheで古い要求が無反応のまま残るP2を修正。actual pagehideだけで該当する未完了注釈要求を取消す。cleanupは新要求を取消さない。
- 再起動直後のtarget未接続をunseenと見なしてpending追記を取消できるP2を修正。必須appendStartedをhandoff前に保存し、復旧時の取消とauthority確認を分離する。
- marker保存後・append前の終了と外部削除が重なると取消不能となるP2を修正。復旧authorityの確認はlive catalog admission前に行い、unseenなら取消、pendingなら既存処理だけ再試行、acceptedなら整理する。
- 作成IO中はpagehideでbusy表示が解放されてもdrainまで取消／再作成を拒否する。失敗後のsource取消は別のLibrary journalを消さず、作成済みノートは残す。

最新保存／接続を別々のAstraが再点検し、新P1/P2なし。型4project・lint・全単体1,226成功／benchmark1 skip・Python143・両buildが成功した。実画面の初回は内包labelの完全一致で0/4、193.14秒としてinitial-failure logへ保持。操作名を明示した再実行は試験側のreload直後の観測呼出しと、strict保存契約が拒否する未登録content rootのfixtureで0/4、115.97秒。契約を緩めず、観測準備待ちと実read faultへ修正する。Chromium診断は主要追記工程1成功／fixture不整合1失敗、別logへ保持。両engineの実画面・関連回帰は継続中。

主要追記suiteは両engineで2/2成功（105.07秒、`output/shared-app-annotation-browser-append-browser.log`）。複数版suiteはWebKit成功・Chromium失敗の1/2（92.42秒）で、通常の3秒pollが場所検証と同じgeneration／AbortControllerを更新し、無変更でも要求を取り消すP2を再現した。失敗logは`output/shared-app-annotation-browser-variants-browser-poll-failure.log`へ保全した。

場所検証専用のgeneration／AbortControllerを分離した。無変更の通常pollは検証を継続し、head集合・payload・status・stale・catalog・query・current document・scopeの変更、読取失敗、強制retryでは失効する。fresh readで選択headと注釈全体を確認する処理は維持した。遅延readとAbortSignalを使う10分岐の単体回帰を追加し、別のAstraが読み取り再レビューして新P1/P2なし。修正後の型4project・lint・全単体1,227成功／benchmark1 skip・両buildは成功。実画面の最終runは別途記録する。

新規2suite最終runは4/4成功、194.86秒（`output/shared-app-annotation-browser-final-browser.log`）。既存4suite回帰は7成功／1失敗、462.08秒（`output/shared-app-annotation-browser-regression-initial-failure.log`）。WebKit引用追記の失敗はopenComposition初期heading待ちで、操作開始前のtimeout。原因確定前に成功扱いにせず、同source・同engineの単独runで切り分ける。

Solが同source・同engineを単独再実行し1/1成功、82.06秒（`output/shared-app-annotation-browser-quote-webkit-diagnostic.log`）。timeout延長・ignore・期待値緩和・推測修正は行わず、元runの失敗はそのまま保持した。

## F38削除Markdown比較の設計・実装分担（2026-10-27）

Astra再評価で、既存回復一覧・restore writerを再利用し、削除recordのobserved版と最新headをreadonlyで左右比較するsliceを選んだ。ユーザー指定に従い、途中のモデル／preview新fileをSolへ引き継ぎ、以後の実装とデバッグはSol、設計・独立レビューはAstraへ分ける。

Astraの初回UIレビューで、catalog未ready時にrequestを開始できず復帰後も空表示となるP2、および修正後にStrictMode cleanupがsessionをcloseしたままadmission記録が残るP2を指摘。Solがrequest単位の未開始待ちとlifetime cleanup時の記録resetを追加した。モデル・previewの読み取りレビューは新P1/P2なし。結線後のレビュー・型・実画面は別途実施する。

修正後のPanel／Connection／PreviewをAstraが再点検し新P1/P2なし。別のAstraも実際の回復行結線・画像manifest・readonly境界・scope／BFCache・新実画面suiteまで独立確認し、新P1/P2なし。試験の未到着parentをlocal commitするfixtureとJSON key順依存の比較はSolが受信record／通常transferとparse後全構造deepEqualへ修正した。

Sol検証で型4project・修正後lint・全単体1,242成功／benchmark1 skip・PC/Web両build・境界40件・generator／台帳checkが成功。diff-checkは既存CRLF予告warningのみで空白errorなし。`output/shared-app-deleted-markdown-comparison-module-graph.json`へsource hashとgraphを保全。新実画面はSolが単独実行し、結果を後続記録へ追加する。

新実画面の初回は両engineで本文scrollの事前条件が成立せず、一覧折畳み後の位置保持assertで失敗した。固定heightと`flex-1`の組合せで本文が伸長していたため、Solが`shrink-0`でheightを維持する最小修正を入れ、scroll可能寸法と事前到達のwaitを追加した。元の保持assertは緩めていない。Astra再レビューは新P1/P2なし。r3型／lint成功後、両buildを再実行してからブラウザーを再検証する。初回runは`output/shared-app-deleted-markdown-comparison-browser.log`の失敗結果として保持し、再runは別名にする。

再検証はr3型lint・r2両build／境界40件が成功し、graphを更新した。新実画面r2は2/2成功、104.28秒（Chromium26.21秒／WebKit77.51秒、`output/shared-app-deleted-markdown-comparison-browser-r2.log`）。既存Markdown／画像2suiteの関連6件（本文・PNG・SVG、各2engine）も同sourceで全成功、224.07秒（同prefixの`regression.log`）。全単体1,242成功はCSS最小修正前の同工程証拠として維持し、再実行したとは記録しない。

## F38種類共通比較・PDF背景のレビュー（2026-10-27・継続中）

Astraの方向設定に従い、Solが比較Session／Panel／ConnectionをMarkdown／Document共通へ置換し、実collection＋page UUIDの選択、版ごとのscroll、PDF／paper背景と全annotationのreadonly表示を追加した。旧Markdown専用モデルは撤去し、成功段階のsourceはzipへ保全した。共通PDFresource検証を既存captureにも接続し、重複したassertを除去した。

Core／validator／capture抽出をAstraが独立点検して新P1/P2なし。targeted最終27/27成功。型r3／lint-r3成功後の全単体は1,251成功／benchmark1 skip、PC buildも成功した。これらは下記P2修正前の先行証拠で、Web build／専用境界以降はholdした。

UI／rendererを別のAstraが点検し、新P2を1件指摘した。scope非active時のasset unmountから復帰するとき、背の高いMarkdown画像の再取得前にlayout＋1 RAFだけでscrollを復元すると、placeholderの短いextentへclampされ保存値も0へ上書きされ得る。PDF／paperはframe寸法を予約しているため、この指摘はMarkdownの非同期画像が対象。Solが復元pendingと寸法確定待ち・利用者操作による取消、実画像と遅延readを使う回帰を追加する。静的に具体化した経路であり、追加試験の結果は別途記録する。

その他のPDF検証順序・tuple／retry世代・URL／canvas cleanup・原訳／deleted候補・readonly境界・復元前後のgraph保全には新しい具体的P1/P2なし。ブラウザーは修正と再レビューが収束し、標準gateを更新してから開始する。

SolがP2を修正し、inner ResizeObserverで目標位置へ到達するまで復元pendingを維持、clampによる保存値汚染を止め、pointer／wheel／keyの実操作で取消する。実2400pxPNGと遅延read・合成pagehide/pageshowの回帰をgenericMDsuiteへ追加した。Astraの最小差分再レビューと別Astraの全結線レビューはいずれも新P1/P2なし。比較欄のHome／wheelがReader／Inkへ波及しない境界も確認した。

最終r4は型／lint・全単体1,251成功／benchmark1 skip・PC/Web両build・境界40件・generator／台帳／diffcheckが全て成功。全handle終端をSolが確認し、新generic graphを`output/shared-app-deleted-content-comparison-module-graph.json`へ保全した。実画面はgenericMD比較／PDFpaper比較／QuoteAppendの両engineを同sourceで単独実行する。

generic実画面の最終証拠は別runへ分かれる。初回6件は3成功／3失敗で保持し、QuoteWebKitはsource／ignore不変の単独1件成功、PDFpaperはfixture admission／route二重処理をtest-only修正したr3で2/2成功（157.76秒）。成功例だけを単一6件成功へ合成しない。詳細は実装記録・引継ぎ第15節。

## F20付箋draft・既存writer接続のレビュー（2026-10-27・継続中）

Astra設計の独立レビューで、DOM包絡矩形のquad代用、通常editPageへdraftを流す迂回、private ownerの二重claim、F37移動完了後の編集開始の隙間を指摘。専用commitAnnotationDraft、既存Ink facade、exact候補からの明示編集、geometryの成立確認を後続gateへ分ける設計へ修正した。再確認で付箋sliceの重大な不足なし。実装・debugはSol3名（Core／UI／受入）、レビューはAstraが担当する。

Coreの専用draft／owner再取得／取消・確定／preflight／atomic pending／同ID retryをAstraが確認し新P1/P2なし。pure操作5件＋draft11件＋既存Session25件の対象41/41は成功。型narrowing2件は拒否条件を変えずSolが修正し再成功した。UIのcontact scope cleanup／pagehide世代による旧facade拒否も点検した。

別Astraから2件の確定P2が出てSolが修正している。

- idle同pageの復帰後、ready集合だけ消えてadapter effectが再登録しない。小共通readiness hookへ3経路を統一し、世代付き登録／cleanupとMapで旧callbackを拒否した。合成lifecycle後のF37明示編集回帰を両host／原訳／paperへ追加。最小差分再reviewは解消確認・新P1/P2なし。
- 未確定付箋form中にremote catalog削除が届くと、編集禁止とともに取消まで無効となり退出不能。active scope／同owner／draftIdの取消だけを編集可否から分離し、readonlyでも取消のみ許す。gesture中の同族guard残留も同ownerの取消だけを許す。保存開始済みflightは従来pendingを維持し、readonly表示と保存中busyは区別する。ordinary remote deleteのform／gesture両回帰を追加し、最終差分の再確認待ち。

修正前の先行全unitは1,268成功／benchmark1 skip、PC build成功。新P2発見後は全handle終端を確認してWeb／Python以降をholdした。Python SQLite受入にはcanonical stickyのcreate／update／delete／同ID再送と全属性保全1caseを追加し、まだ実行していない。

受入suiteの静的reviewでは、初期bindingへ戻るremount、reload後の観測function未登録、Web→native受信待ち、非原子的session／durable観測の4点を修正した。追加remote背景の物理PDFdescriptor寸法、paper DOM locatorも正規化。multipointerのexplicit capture不足はimplicit captureを考慮して確定指摘を撤回し、CDP実touchとWebKit合成入力の保証範囲を明示して排他試験を追加した。timeout／ignore／保存契約を緩めていない。

remote readonlyの取消不能はSolが、liveOwnerと編集enabledの分離、cancelEnabled、readonly disabledとsaving busyの分離で修正した。配置gesture中も同ownerの取消だけを許し、最新deleted／activeSurfaceを編集時に再確認する。注釈draft／配置中はimmutable replication受信だけを許し、Doc snapshot採用は従来canNavigate内へ留めた。Webが編集中にremote削除を受信できない接続もこの範囲で直した。最小差分のAstra再確認は解消・新P1/P2なし。

続く別観点reviewで第3のP2を確認。確定後のfresh repository.read中にreadonly化すると、開始時のUI権限だけではpendingへ進めてしまう。SolがcommitAnnotationDraftのoptional mayCommitへ現在owner／lifecycle／編集可否を注入し、fresh read後とpending設置直前に確認する。predicate後もdraft identity／owner／scope等を再照合し、その後pending設置まではawaitしない。false／throw／副作用時はdraft保持、dispatch済みretryは不変。追加3unitを含む対象44/44が成功し、指摘元Astraの追確認で解消・新P1/P2なし。実IO読取保留中のordinary remote delete回帰を受入へ追加中。

実read結果の返却だけを保留するone-shot caller限定gateをfixtureへ追加し、catalog／corpus等は止めず、ordinary remote delete→実readonly表示→read解放→保存拒否／exact draft／batch・history・intent追加無し／取消離脱を両hostで検証する。Astra2名が新fixtureと最新全接続を再確認し双方新P1/P2なし。r8型／lintが成功し、全unit／両build／Python受入／境界・契約・台帳を最終-r8として再実行する段階。元の保存／削除セマンティクスやエラー監視はmock・縮小していない。

r8の全gateは成功（frontend1,271／benchmark1 skip、Python144、両build、境界40等）。初回受入でF37手動更新中の競合を確認し、Panelのbusy／lifetime guardをSolが修正、Astra再確認で新P1/P2なし。r9型／lint・両build・境界も成功。受入は初回0/2とr2の0/2を失敗logとして保全し、まだF20通過とはしない。配送receiptの通常更新をcanonical変更と混同したtest oracleはstable receipt identityと全canonical graphを保持する比較へ修正した。

WebKitのanchor差は、実pointerイベントが指定小数座標から整数化されることを実測し、保存値が実イベントからの計算と一致することを確認した。Solが整数CSSpx入力と実イベントを用いた独立anchor照合へ修正し、既存の期待値／tol2は維持した。別の間欠startup停止はcold runでも再現し、初期renderのSuspense未commitまで切り分けた。read／registry処理は完了しており、Core初期化やownerを推測で変更しない。Astraへ原因切分け設計の独立レビューを再依頼した。詳細・成功／失敗runの区別は引継ぎ第16節。診断観測入りrunの成功を、通常flag OFF受入や問題解消の証拠に代用しない。

通常r3はChromium1成功／WebKit1cancelled（case既存360秒）で終了、550.40秒。WebKitも両host初期起動とpointer照合は通過し、Nativeの工程とWebの途中まで進んだが、全case成功とはしない。AstraとSolが既存host別seed／peer同期／後続retryの依存を独立確認し、engine×編集hostの4独立caseへ分割する設計に合意した。各caseにNative／Web両peerと通常transportを保持し、Native caseの応答喪失・reload・固定ID／全payload再送、Web caseの全CRUD／guard／peer反映、両peerのfinish／audit／cleanupを維持する。timeout・errors／unhandled／forbiddenを緩めない。Solがsource移植、UI Solが型／lintと通常flag OFFの再検証を担当する。

分割sourceのAstra確認は新P1/P2なし、型／lintも成功。通常r4のChromium Nativeでは、paper後のPDF一覧からの明示編集候補を待つ段階で失敗した。Solが同期とguarded landing readの競合を提示し、Astraが静的P2として成立を確認した。同期flightはlandingを包含せず、flush後の無条件`session.refresh()`が先行landingのreadGenerationを進め、mayAdopt未実行のfalseをsource unavailableとして扱う経路がある。今回runとの一致は実診断待ちだが、この具体経路は修正対象。最小方向はimmutable受信を保ち、flush後・model refresh直前に現在のannotation citationを確認して着地中の背景refreshを開始しないこと。入口のみ検査やfalseの一律再試行で隠さない。現在の4case全終端まではsource freezeを維持する。

r4は全終端1成功／3失敗・cancelled0、524.96秒。Chromium Webは全成功、Chromium NativeとWebKit WebはF37候補待ち、WebKit Nativeは全機能assert通過後のreload時corpus read pageerrorでfinish失敗。後者は別AstraがPromise所有権・取消／旧結果採用を独立確認して新規の具体的P1/P2なし。ただし今回のunhandled値は未記録でcaughtとも確定せず、新ignoreを追加しない。全handle終端後、UI SolへF37最小fix／実read gate fixture、tester Solへ両host controlled回帰、別Solへ実corpus／Sessionを使うnavigation失敗の独立診断を割り当てた。詳細・各run証跡は引継ぎ第16節。

F37合流版は型97423／lint71282成功、別々のAstra2名がprod／fixture／controlled suiteを確認して双方新P1/P2なし。同期待pageの実read結果を保留し、別資料の実batch pull／ack／repository全文／flush完了を証明してから背景refresh開始0を確認するため、同期未実行による偽成功を避けている。元Promise／fresh guard／旧結果拒否／既存payload・背景拒否は維持。guardedGenerationは開始時の記録値で、単独で現在世代不変を証明するものではないが、全refresh入口の開始数と解放後のguarded成功が別に検証する。新WebKit診断を先に単独実行し、分類後に最終標準gateと通常受入へ進む。

WebKit診断は実corpus／Sessionでcurrentとpagehide-abort各10/10のpageerrorを再現し、両者unhandled0／caught20／corpus resolved10。意図的unhandled対照は監視が検出し、通常reloadの捕捉済みfetch失敗がpagehide約190ms前にpageerrorとなる機序を示した。元r4自体のunhandledは未出力のままで、遡及passとはしない。Astra判断に従い本番lifecycleや人工的なreload前cancelは変更せず、Solが既存分類へWebKit／native／管理下reload／観測済controller／exact同origin read endpoint／fixture requestとcorpus read frameの全ANDだけを追加した。

このsupport最終版は別々のAstra2名が独立確認し双方新P1/P2なし。既存4分類branchを維持し、全stackをnavigationDiagnosticsへ残し、実unhandledが同居すればstrict assertで失敗する。Node専用helperはbrowser bundleへ流入しない。拒否境界・実unhandled同居・先頭failureでも全観測が表示される契約5unitも追加。finish入口で全4集合を出し、元位置の3strict assertを保持した。teardown後lateevent監視という既存限定は今回変えていない。型／lint以降の最終標準gateと通常r5の新しい結果で評価する。

通常r5は4/4成功・664.04秒、全forbidden／errors／unhandled空。関連8caseは別runで6成功／2失敗、Toolsの両engineの投げ縄がarrowを含まなかった。Astraの静的確認では、arrow採取後にlayerへのscrollIntoViewでscrollが変わり旧arrow座標を使うfixture候補があるが、実原因は未確定。Solが元矩形・判定を維持した実event／同時座標probeを追加し、focused両engine診断を実行する。

## F20本文highlight geometry初稿（未接続・未検証）

Solがcapture／text binding hook／pure testの新規未import3fileを作成し、既存source／fixture／HTMLを変更せずAstra2名へ独立レビューした。P1なし、P2を各1件確認し、Solが修正中。

- 採取からdraft入場まで、同textLayer内のText node再構築を検出しない。空layer・同文字の別node・採取node文字列／対応item変更をephemeralな証拠と入場時再照合で拒否する。入場済みdraftへDOM／token条件を持ち越さない。
- canvas／textLayerとpageElementの間の祖先transformを未検証。中間rotate／skew／reflectionを拒否する全祖先検査、または厳格な直下構造契約を追加する。

8件のpure test初稿は未実行で、hookのfont／同asset再描画／旧callbackは実renderer spikeで別に証明する。UIのTools診断と並行するのは新3fileのsource修正だけとし、重runと既存source変更を禁止する。共通renderer方針はAstra2名が独立確認してcanonical両経路をPdfSurface／CanonicalDocumentSurfaceへ置換する案を採用、旧2rendererへ新geometry propsを足す案を撤回した。Tools baseline解消→asset検証統一→共通描画置換・既存回帰→geometry spikeの順序を維持する。

Sol修正版はadmissionEvidenceのnode／文字列／item・styles／DOM構造完全照合と、canvas／textLayer双方の全中間祖先検査を追加し、回帰計11件を記述。Astra2名の独立再確認で旧P2解消・新P1/P2なし。型／unit／実DOM・font lifecycleはまだ未実行で、source収束と分ける。

Tools限定診断は同assertを再現し、最後のscrollで55／56px動いた実座標と旧arrow位置の混在を両engineで確認。Solのtest-only atomic座標修正は元margin10／5頂点／assert／timeoutを維持し、Astraの軽量確認で新P1/P2なし。source・fixtureは無変更。型／lint成功後のfocused Tools再検証を行い、失敗run全体を遡及passにはしない。

atomic修正後の38994も両失敗だが、最初の投げ縄は両hostで解消。Chromeは文字draft中のdisabled前頁button待ち、WKはWeb側7kind描画のcount付きidle待ちという別原因。Astraが前者の無効UIは共通guard契約どおりと確認し、F15／F20に沿ってdisabled assertと別の実ArrowLeftによるpage／exact draft／全文／history／inputActive保全へtest更新する案を承認した。強制dispatchや不変条件削減は使わない。WKは元gesture／idle条件を維持した非介入readonly probeで原因確定を先に行う。実失敗記録はそのまま保持する。

53127はChromium全成功／WebKit失敗。Web側の最初のpenでInkLayer不在・event0を記録し、Core readyだけでは実描画readyを証明しないことを確認した。Astraが現URL／物理page／drawnWidth／DPR tokenの`data-rendered=true`と期待page／背景版・canvas／Ink可視をscroll後に同時観測する方針を承認。固定sleep・期限増加・gesture再送はせず、元count付きidleを保持する。旧WebKit idle失敗そのものの再現とは区別する。

新geometryの純11件は、初回Node strip-only構文エラーで未開始の後、Solのtest-only記法修正で11/11成功・208ms。sourceのP2再確認と純unit成功は揃ったが、全workspace型／font・実DOM／rendererの検証はまだ後続gateである。

## 共通PdfSurface／resource検証の合流レビューと回帰

canonicalのPC／Web描画を唯一のPdfSurfaceとCanonicalDocumentSurfaceへ置換し、assetはresource単位のverified bytes／URLと現在pageの検証へ分離した。Astra2名が設計と合流sourceを独立確認し、Solが次の3件を修正した。

- pinch中のsharp redraw延期をMapのkeyとpaneの同一比較で判定していた。Reader scopeがpaneを含むかで判定し、同Readerのowner／追従paneを一緒に扱う。
- asset未取得時の仮ratio metricsで保存された連続倍率をfitへ変更しうる。未検証の寸法通知を止める。
- metadataだけ確定した段階でも実PDF不一致後に誤った倍率補正が残りうる。実Documentの現在resource／URLと、実Pageの現在page／背景／物理page／自然寸法のproofを揃えてから通知する。width／DPR変更で有効なsource proofを破棄せず、遅延旧callbackは採用しない。

最終2名は新P1/P2なし。opaqueな実Document tokenを返すreadonly observerも軽量確認済み。r5標準gateは型／lint、境界40、全unit1,292成功／benchmark1 skip、両build、generator／台帳／diffcheckが成功。初回unitのUI境界違反1件はownerDocument fallbackの修正で解消し、allowlistは広げていない。Python144は先行保存受入の証拠を維持し、今回再実行とはしない。

実画面はReadingState／TranslationSurfaces各両engineが初回runで成功。PdfReadingは旧Web限定hidden canvas期待だけで失敗し、共通zero-room policyへ両hostの期待を揃えたfocused別run2/2が成功した。続くNotebook／Tools4/4も全audit空で成功。元runの失敗は保持し、別runを単一成功runへ合成しない。

付箋初回は1/4成功。新しい共通描画のpreview／sharp切替中にCSS bboxだけが安定し、marker=false／Layer pointerEvents=noneのままテストが入力することを、実event sequenceと同一active pageのreadonly観測で確認した。ring末尾から旧pointerupを採用する試験上の問題も判明。Astraは現rasterReady／readiness Mapの共通判定に具体的な矛盾を確認せず、製品guardは維持する方向を確認した。

Solのhelper r9は同一UUID／背景／物理page／実描画とLayer接続を待ち、create／moveだけLayer入力可能まで待つ。F37後の2RAFも元25秒の単一待機期限に含める。操作ごとの新eventからanchorを厳密計算し、元tol2・全入力・全CRUD／history／remote／監視を保持する。入力後再送・固定sleep・timeout増加はない。Astra最終軽量レビューは新P1/P2なし、E2E型93540／lint成功。通常4case r9は4/4成功・611.684秒、全caseの全audit集合が空、app14source r5 hash一致。診断2caseと合算せず、詳細は引継ぎ第19節へ記録した。残る引用／注釈の6case回帰へ進む。

専用geometry／asset spikeはoutput配下の8file source draftのみ。2Astraの初回P2を、正確なReader seed＋flush、再出現を含むasset URL履歴とready asset即失効の検証で修正し、両者再レビュー新P1/P2なし。生成・視覚QA・型・実ブラウザはまだ未実施で、source収束だけを実動作の成功としない。

既存回帰は引用／注釈最終6/6成功・315.926秒で終端し、全20caseの成功証拠が別runで揃った。全6caseの全audit空、app14source r5 hash一致、post台帳／diffcheck成功。既存回帰終端後に専用spikeをrepoへ移設して生成するGOを出した。skill marker一回はexit0、初回generatorはrepo LiberationSansのU+0301欠落をhardfailしexit1。未生成のままSolが既存フォントの実coverageを調べて修正中で、skipや追加依存で検査を省いていない。marker再実行は不要。

第2生成のToUnicode誤出力、第3生成後PNGの非BMP glyph空白もhard failureとして保全した。Solが既存SourceHan fontのcoverage／subset／UTF16BE destination／code→実CID encodingとwidth／combining placementを生成側で修正、第4生成と最新8PNG全文QAが成功した。Astra最終差分確認は新P1/P2なし、実font由来の修正と独立座標oracle・tol／assertの維持を確認。同hash再生成は未実証、MuPDF検査を独立PDF.js実受入の代わりにしない。TS5file凍結のfulltype／lint／境界40は成功し、両engine専用12caseへ進む。

## F20 highlight Core下書きとR28設計再レビュー

Core Solはoutput配下だけへoperations／Session／純test4fileを下書きし、本番srcは無変更・全未実行。Astra初回はP1なし・P2二点。新規seedだけunindexedへ限定し、既存indexed編集を保全すること、背景変更testのdescriptorを本当に変更して正規化後のgraphで確認することを依頼した。Sol修正・独立再確認が終わるまで移設しない。

R28はnative selectstart待ちでは5px panが先行することから、同inventoryで最初からtouch候補を所有するmanaged選択へ再設計。別Astraはtoolbar focusでの選択喪失、keyboard未選択からの開始経路、既存window Reader keyとの二重配送を指摘した。Range保持／再照合、到達可能な開始・延長・copy・AT通知、同じuseReaderInput入口で優先するpass／handled／blocked portへ修正し、最終確認は新P1/P2なし。採用仕様は次工程設計末尾。CSS・作成buttonを先行公開せず、geometryとは独立した入力置換・既存引用・保存接続gateを実施する。設計収束であり、実装・実機成功を表さない。

Core Solが二点をmirror内で修正し、指摘元Astraの再レビューは解消・新P1/P2なし。createのunindexed型／runtime拒否を追加し、既存edit indexedを保全する。PDF sourceRevisionとpaper templateの実変更後にgraph descriptor／背景版assertを入れ、背景競合を偽成功させない。追加12testは未実行、本番未移設。別Astraが第2独立sourceレビュー中で、型／unit／UI受入は別gateとする。

第2独立Coreレビューも新P1/P2なし。正式移設後の型／追加12unit／既存sticky／UI union接続と、geometry／入力置換／保存の公開条件は残る。

## 専用PDF spike初回と共通text完了joinのP2

専用第1群6caseは0/6・160.897秒、初failure／summaryへ保全。固定worker URLを本番公開workerSrcのsameorigin完全一致へ修正し、bootstrapで実worker未要求・Document未生成、hold1件・解放・cleanupを維持した。404のexactURL／発生元とbinding未公開時の実DOM履歴をreadonly診断へ追加し、ignore／元assert／timeoutを変えていない。Astra差分レビューは新P1/P2なし。観測によるtiming影響の可能性と診断run成功の限定を記録する。E2E型初回はArray.atのlib非対応1件で失敗、Solへ同義修正を依頼した。

別Astraは共通PdfSurfaceの具体P2をsourceで確認した。react-pdfのtext data callbackはpassive effect、text render完了はlayout effectからのPromiseで先行可能。page／text facts未到着ならrender完了を捨て、後着factsから再joinしないためtextreadyへ回復しない。今回timeoutとの実因果は未断定だが、具体経路を修正対象とする。

Sol UIへ、drawingごとの実render完了証拠とpage／text factsを同じtryCompleteTextでjoinする実装を依頼した。現resource／source／drawingとconnected DOM／structure一致を検査し、fit後の一回通知とする。page／textだけで完了を創作せず、旧drawing／error後を同期拒否する。font／canvas／Document／settledの既存hook検証、metrics／URL／PDF loadは維持する。sourcefreeze後の独立レビューと標準gate、rawDOM／404観測付き実PDF再試験はまだ未実施。

実装後のAstra2名は双方新P1/P2なし。draw-local実完了DOM証拠／3arrival join／DOMidentity・構造・text照合／同期invalid／通知前claim／参照解放とStrictMode新factsを確認した。r3型／lintとtarget19/19が成功し、r6全unit1,300成功／benchmark1 skip・両build・境界40／契約／台帳／diffcheckも全終端成功。app16file r6とfixture等9file r3 hashが一致。source観点のP2解消と今回timeout原因の実因果は区別し、rawDOM／404観測を加えた第1実PDF6case r2を再実行する。

## 担当指示の更新（2026-10-27）

ユーザーの「レビューもsolが次からやって」を反映し、以後の実装・debug・独立コードレビューをSolへ統一、Astraは設計・方向設定へ限定した。過去のAstra完了レビューは保持する。managed選択draftのAstraレビューは途中停止のため完了扱いにせず、独立Solへ再依頼した。WK ready解除についてAstraは既読sourceから方向案だけを引き継ぎ、追加のコードレビューや実行はしていない。

独立Solのmanaged選択初回はP2二点。長押しwordをup時の無条件moveで縮める経路と、keyboard handle collapseでfocus DOMを失いReaderへkeyが流れる経路を修正対象とした。Core作者とは別のSolがUI8source draftも独立確認し新P1/P2なし、軽微な付箋button四隅hitだけ指摘。いずれもoutput下書き、全未実行で、設計・source収束と公開受入を分ける。

PDF第1群r3は5/6成功、WK delayed hash sceneのready待ちだけ失敗。faviconは有効data iconで解消し、strict監視も保持。実statusloadedのloadingイベント後にdone／errorがなくbinding未公開というpre-timeout記録を得た。遅い他sceneのready→nullには失敗後screenshot影響があり一次根拠に使わない。Sol独立レビューはhookの無条件失効／done依存のliveness経路をP2として確認中で、実settlement＋current DOM証拠のrefit／既存refreshを最小案として検討する。元failure／raw観測は保全し、新source修正は未実施。

## 実装モデルの更新（2026-10-27）

ユーザーの「実装はGPT 6.1 Terraに依頼して」を受け、`gpt-6.1-terra`を指定して実装agentを起動し、3draftと現況の引継ぎを完了した。以後のコード編集はTerra、debug解析・検証実行・独立レビューはSol、設計・方向設定はAstra。過去のSol実装を破棄せず、sourcefreeze済みの検証をSolが続ける。新しい修正が必要ならSolが根拠を示してTerraへ渡す。最新の再開地点は引継ぎ第20節。

worker-releaseの未所有fetch gapは、実POST200／JSON body読了／同Request finished／visible ackの完了を所有するfixtureへ変更し、E2E型／lint成功後の単一fullresource6が6/6成功・225.714秒。全strict監視を保持した。void fetchや204が旧abortの原因と断定せず、制御通信完了の証拠を新runで得たものとする。旧failure／cancel／focused成功を遡及更新しない。第2geometry6caseは実行開始済み、まだ受入完了ではない。

## r8 intrinsic layoutとgeometry harnessの再レビュー

WK small表示の実Rangeが許容差を外れる問題は、canonical変換がraw Rangeと厳密一致し、全文fitも一致することをSolが確認した。Astraは方向設定だけとしてintrinsic font倍率と逆CSS倍率を揃える有限案を提示。TerraがPdfSurface／pdfTextLayout／unitの3fileを実装し、独立Sol2名の主レビューと未使用cache cleanup再確認で新blocking P1/P2なし。型・lint・target35、全unit1,316成功／benchmark1 skip、両build、境界40等は成功した。

r8 geometry初回は5/6成功。small310部分RangeとWK拒否全体は通過したが、WK positive初回markerはcapture時stale-renderで失敗した。共通アプリへready代入や再試行を足さず、geometry専用harnessの操作前admissionをSolが確認し、Terraが同browser task内のcurrent確認→実button一回clickへ変更した。拒否後はtruthy attemptedとして元assertで即失敗し、captureの再pollはしない。

独立Solの初回harnessレビューでは、ready25秒とcapture25秒が別予算、scalar preprobe欠落、handler入口counterと旧結果の混在可能性を指摘した。Terraが単一deadlineの残時間を共有、期限切れthrowでtimeout0を防止し、結果公開後completed counter、capture前の非layout scalar診断へ修正。同Sol再レビューは前回未達解消・新P1/P2なし。E2E型85958／lint61832／diffcheckとhash不変も成功し、Solへfull geometry6→resource6→production QuoteAppend2を逐次依頼した。実入力成立と全F20受入は別工程である。

atomic-budget full runは4/6成功。WK markerの実captureと座標assertは成立したが、その後別taskのadmission時に実font通知で正しくstale拒否された。UnicodeDPR2も別taskのRange作成とcaptureの間で失効し、境界検査へ届かなかった。Solは製品修正の根拠なしと判断し、Terraへgeometry専用のcurrent→Range→capture共通化とmarkerの直後admissionを依頼した。旧assert／negative／tol／25秒予算を保持する。

次draftの方向レビューでは、capture handlerの診断とhelper fullsnapshotのlayout読み取りがcapture→admission間へ残る点を独立Solが指摘。同taskだけで同期契約に一致したとは扱わず、診断layoutを両処理後へ移し、両button間にsnapshot等を挟まない修正をTerraへ依頼した。この未達はsource reviewで検出したため、そのdraftの型・browserを起動していない。

## F20 staged正式統合とSol再確認

Astraは受入・通常公開とsource統合のgateを分離する方向を提示。Terraは旧入力への無条件副作用を準備時に検出し、Astra仕様に沿って旧pointer／Readerを一時隔離、共通owner基盤一つとReader単位managed bundleへ整理した。Core／managed選択／highlight UI／実UI試験をr8へ三者統合。独立Sol①は入力・描画・legacy隔離、②はCore・UI・fresh／owner／pending／journal／history・F37・test接続を確認し、双方新P1/P2なし。r8のfont／completion／intrinsic／URL／metrics保持も確認した。

実検査ではtest fixtureのresource未登録と架空remote hash、未使用lint directive、shared UIのglobal document fallbackを検出。Terraが正規PDF登録／別physical page、directive撤去、接続済Reader root／ownerDocumentへ最小修正し、Sol再確認で解消。最終型・lint・unit1,366成功／benchmark1 skip・両build・境界40・contract／ledgerが成功。Python専用highlight回帰もreceipt比較不足を補強して移設し、focused1と明示canonical保存14file140が別runで成功した。

Chrome lifecycle初回はreload直後の観測API未登録で停止。Terraが既存25秒内で未登録だけ待機し、登録後read例外は保持。Sol再確認後Chrome1／WK1の別focusedで両PC・Webの実mouse／keyboardから全CRUD・保存reload・UndoRedo・同期・既存sticky保全が成功。既存引用／PNG／画像追記も両engine2/2成功、各終了監視は空。source収束と実入力・保存の確認範囲は区別する。

## geometry／resourceと代表入力matrixの残件

同candidate geometryは5/6、唯一WK回転の座標と同期admissionは成立し、後の別task previewでfont失効により拒否された。実preview guardを維持して同taskへ寄せ、Sol sourceレビュー／型・lint後のWK回転focused1が成功した。先行5/6と合算したsingle6成功にはしない。resourceは独立4/6で、WK scope readyとcold loadが期限付近に停止。Node／browserの時計区間を照合し、厳密なpre-timeout回復・永久null・製品原因は未証明と記録した。

新matrix draftはDoc履歴とReader履歴の混同、word→延長／pinch no-opを除外できないoracle、rAF前判定、旧layer再利用、正常な位置保存の誤拒否等をSolが指摘。Terraが代表sliceを補強し、Sol再確認・E2E型／lintを経て実装した。Chromium trusted touchの実長押し・80px延長は通過、pinch幅変化待ちで停止。width oracleと指定距離はsource上正しいが、失敗時target／metrics未保存のためアプリ不具合と断定しない。Terraが操作・予算・assertを変えずcleanup前のbounded診断を追加中。live Reader back／forward、Ink pen、全逆順、WebKit touch、実機など未実装・未受入は別に残す。

## 固定参照ページ案のSol独立レビューとInk同期基準修正（2026-10-27）

同文書の固定参照ページはTerraの隔離source案をSol2名が独立確認した。P1はないが、具体P2が残るため統合はHOLD。main swipeのterminal contact自己拒否、center/right往復時の旧pane登録未解放、pinch後の旧位置restore、描画未準備時の新input admission、削除復元後も残るunavailable、toolbar activation event欠落、保存await後の配置変更guard不足、mixed Notebook初期PDFに対するpaper待機を修正対象とした。current accepted/pending注釈投影、readonly狭型、第二writer不在、独立asset retry、合法publicationの方針は維持する。

Astraは設計書第12節へterminal callback中だけ有効な一回の継続証拠、現描画による新規admissionと既存gesture継続の分離、意図ごとの一回restoreを補記した。コードレビュー承認ではない。Terraがterminal入力とzoom/位置復元を隔離outputへ分担して修正し、Sol再レビュー後に三者差分で統合する。generic commandの全contact拒否、唯一のinventory、通常cleanup、既存ReadingPlaceを維持し、任意pointer ID除外や別writerを追加しない。

別工程のInk PDF/PDF試験は初回PC成功後、Webの入力中にPC側保存履歴が後着し、旧baselineとの不一致で停止した。Terraが既存25秒内の通常同期とexact Doc/history/head/batch採用待ちをホスト間に追加。SolのE2E型・既定lint・diff/hash確認後、Chromium focused1/1（31.118秒、両mount）で成功した。原失敗を保持し、paper／hardwareへ成功を拡張しない。ログと要約は引継ぎの最新チェックリストに記録。handle後の全frontend単体は別runで1,382成功／benchmark1 skipとなり、両build等は継続中。

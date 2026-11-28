# PC・Web共通化 Astra再検討後の実装方針

> 2026-10-29追記: 本書は過去の設計判断・接続案の記録として保全する。現在の作業順・TODOは[計画書第3節](shared-app-plan.md#3-実行todo大分類小分類)、現在地は[引継ぎ書](shared-app-handover.md)を優先する。本書内の「次」「最新」や担当モデル指定は当時の記述であり、現行の実行指示ではない。

更新日: 2026-10-26

[コードレビュー](shared-app-code-review-astra.md)を受け、別のAstraが今後の順序を再検討した。[元の計画](shared-app-plan.md)の全機能・データ保全・受入条件は維持する。**M1の全領域完成を待ってから巨大なM2へ進む順序を改め、現行の内容消失を先に閉じ、実際の画面を通る単位で共通化を完了する。**

この文書は実装順序の追補である。共通editorや全データ移行を完了したという記録ではない。初回の方針レビューは読み取りのみで実施した。その後の実装・再レビューは[実装記録](shared-app-implementation.md)と[反復レビュー](shared-app-review-cycles.md)へ記録し、acceptedは0件を維持している。

## 1. 現行画面の内容消失を先に直す

### 一つのノートに一つのwriter

中央`NotebookView/InkPage`と右`NoteDocumentEditor/NoteEditSession`の二重writerを最優先で解消する。中央・右はplacementとviewであり、同一noteの編集状態・所有・履歴は同じregistryから取得する。

最短の修正では既存保存形式を使ってよい。全移行の完成を待つ必要はない。ただし、新旧への二重書込や恒久的な互換layerを増やさず、その後のcanonical置換へ接続できる責務にする。cache invalidateだけで済ませず、未保存内容・revision・Undoを含めて統一する。

出口は**右でAを保存 → 中央へ移動 → Bを描く → Undo → 再起動でもAが残る**こと。同時表示、保存応答消失、保存失敗、遅い旧読込、page構成変更も同じ本番経路で確認する。

### 同時に閉じる本番の不具合

- Markdownのremote反映とユーザー操作を分離し、CodeMirrorの履歴を採用revisionに合わせてreset／rebaseする。remote反映をCtrl+Zで無言に巻き戻してautosaveしない。
- Web eraserはgestureの削除集合を一操作として耐久化する。二件目の容量失敗で一件目だけ削除済みにならず、操作全体のUndo／再試行を保持する。
- 手書き文字の確定を共通境界処理へ通す。ページ端に置いた文字で文書全体が保存不能にならない。
- 起動状態照会は期限・再試行・attempt世代を持つ。期限切れの後着応答で起動しない。照会失敗を起動許可へ読み替えない。

これらは新repositoryや全端末移行の完成を待つ項目にしない。

## 2. PDF一文書を両本番画面へ縦に接続する

最初の新基盤の単位は、同じPDFを両hostで開き、**描画 → 複数消去 → Undo → 耐久保存 → 再起動 → 他host反映**まで通ることとする。まずペンと削除集合で経路を成立させ、同じ単位の中で全7tool・選択・変形・文字編集を接続する。

使用するのは隔離libraryである。本番と別実装のデモや試験専用editorではなく、`DesktopApp/WebApp`の同じcompositionへ試験用保存先を注入する。実データを半分canonical・半分legacyへ分割書込みすることで接続の代用にしない。

| 責務 | 使用・接続する実装 |
| --- | --- |
| account／active scope／repository／resource／transferの生成 | host composition |
| 文書sessionの取得、編集owner | `DocumentEditSessions` |
| 内容・未確定状態・保存・Undo／Redo | `DocumentEditSession`／`DocumentEditHistory` |
| 成熟した操作計算・描画 | `useInkEditor`の計算を再利用し、`InkOverlay`へ接続。旧保存／履歴の副作用はsessionへ移す |
| 左右の道具とcommand | 文書で一つの`WritingToolbar`からactive surface tokenへ送る |
| 最小Workspace | target、placement、focus、editor owner、非同期leave guard |

`PdfWritingTools`や`EditablePage`の独自tool state・保存・履歴を新経路に残さない。最小WorkspaceのためにLibrary treeや全tab管理を先に完成させない。

### 接続に先立つ狭い必須修正

1. **認証lease:** 実account ID／auth generationをscopeへ束縛し、各request・upload chunk・結果受理で確認する。logout／account切替は旧転送を停止・drain／取消してからcredentialを交換する。JobManager外のnative転送も停止対象にする。
2. **履歴の因果検証:** 不正なaction参照と、合法な親／historyの遅延到着を区別する。不正履歴を正常記録として固定し、全Undoを回復不能にしない。
3. **native計算量:** 全文`deepcopy`と全祖先snapshot保持、毎read／commitの全DAG再構築を減らす。不変page／annotation共有、既存状態の再利用、必要版の再構成、現在headの差分投影を既存契約内で実装する。新CRDTや汎用event-storeへ置き換えない。

性能は累積する筆跡・page・点数を増やしたfixtureでnative commit/readと再起動を測る。今回の80／160／320筆の二次増大を解消し、連続操作時の保存待ちとメモリも記録する。固定サイズの小さなbatchを2,000件通した結果で代用しない。

### 全7toolへ拡張する際の操作境界

2026-10-26の追加Astra調査では、表示用`InkStroke[]`の置換から既存canonical annotationの変更を推測する方法を採用しないとした。opacity、fontFamily、非等方scale、両矢印の属性を投影後に復元できないためである。

- `InkEditor`に小さい意味別操作の接続を設け、作成・削除・変形・style・貼付けを元のcanonical値へ適用する。previewと確定は同じ純粋処理を使い、保存／履歴は引き続き文書sessionだけが所有する。
- 一様拡縮・回転・移動は物理座標のtransformを合成し、geometryとstyleを保持する。group fitはellipseの真の極値で計算する。
- clipboardは元annotationとsource page寸法を保持する。投影strokeをコピー元の正本にしない。
- 図形handleはcanonicalの軸／逆変換、部分消去は元pathの切断として扱う。文字draftはsessionのtext入力所有と離脱guardへ接続する。
- `beforeCommand`が確定した直前の操作を含め、最新session状態から次のcommandを開始する。gestureの開始baseをremote採用で差し替えない。

[意味別操作](../frontend/src/features/reader/ink/canonicalInkOperations.ts)は`useDocumentInkEditor`と`InkOverlay`を通して両hostへ接続した。文字draftとページ別選択は文書session、元annotationのclipboardはscopeで保持する。長い消去のpreviewは`CanonicalEraseCursor`で未処理のcircleだけを適用し、確定も同じ差分を使う。新しい汎用command bus、保存schema、別のhistoryは導入していない。実画面と障害回復の最終結果は[実装記録](shared-app-implementation.md)へ記録する。

## 3. 紙ノートを同じeditorへ通し、Readerの状態を一本化する

PDFの縦接続直後にpaper背景を扱う。ノート統合を旧M4まで待つことで二重writerを長く残さない。

- `NotebookView`と`HandwrittenNote`の描画・Undo・保存を同じ文書sessionへ移す。PDF／paperの違いは背景resourceとpage specへ置く。
- page追加・複製・並替・削除と用紙変更を`DocumentEditBatch`へ接続する。用紙変更は物理位置・線幅維持、overflow拒否、明示等方fitと完全Undoを持つ。
- 中央⇔右でsessionと履歴を作り直さない。参照viewと編集ownerを区別する。
- Web `DocumentReader`のpage／zoom／mode／historyとPC navigationの別状態を共通ReaderSessionへ移す。command名だけ共有し、保存される状態が別々のままにしない。
- Pointer／Touch／Safari差は入力normalizerへ限定する。pan／pinch／swipe／本文選択／preview取消の判断は共通interactionで行う。

左右一toolbar、fit-page下限、Web swipe、原訳mapping、位置復元、全図形の編集・消去を両本番entryの操作として受け入れる。`inkDraft`や倍率関数の単体成功だけでは合格にしない。作成元の`web-` prefixによる編集制限は、UIと保存validatorを共通ID／権限へ接続してから撤去する。

export全機能の完成を隔離sliceの着手条件にはしない。ただし、利用者向けにcanonical libraryを有効化する際は、旧exportが旧保存先を読む抜け道を残さず、当該機能を実装・検証する。

### paper接続の具体化（追加Astra調査）

新しい保存portや紙PDFは作らない。既存`PaperBackground`とnotebookの`ContentPublication`を使い、`DocumentLibraryConnection`のPDF-only gateをnotebookへ拡張する。

| 実装単位 | 境界 |
| --- | --- |
| `CanonicalPaperBackground` | 物理pt座標の純粋SVG。旧Python `notebook.py`の線幅`.35pt`／dot半径`.45pt`を基準に色・間隔・marginを統一する。`PaperPreview`のpreview用線幅を本番用紙へ流用しない |
| `DocumentPaperPane` | 共通scroll／寸法計測／`pageWidthFor`／pointer入力／`CanonicalPageAnnotations`／`InkOverlay`を使用。repositoryや別sessionを作らない |
| ページ追加・複製・移動・削除 | canonical `PageChange[]` builderから同じ文書sessionへ渡す。全annotationと順序、tombstone、文書Undoを保持し、最後の一pageは削除しない |
| 用紙変更 | `resizePaper`の物理位置・線幅維持、overflow拒否、明示fitを使用。先にsessionでbatch IDを生成し、`build(document,batchId)`へ渡す狭い入口を追加する |
| 中央／右の配置 | 同じsession/settings/ReaderSessionを保持する一つの編集owner。参照表示はclaimせず描画のみ。移動は確定・保存結果・旧owner解除の順に行う |

用紙変更のbatch IDは先行して確定する必要がある。`resizePaper`へ任意の別UUIDを渡した後に現行`editDocument`へ入れると、pageは内部batch IDへ更新される一方highlightの`backgroundRevision`が旧引数を指し、不整合になる。builderで同じIDを使ってからreplaceを作り、highlight付き用紙変更を実保存とUndoで検証する。

`PaperSettings`のvalue/onChangeフォームは再利用できる。`NotebookView`／`HandwrittenNote`本体、`NotebookPaperDialog`の旧page-actions hook、`NotebookPaperMenu`の旧writerをcanonical treeへ接続しない。dialog/menuはaction propsへ分離する。未知の用紙寸法をA4へ丸めない。

paperの直後にReader状態をcomposition所有の小さい`ReaderSession`へ移す。まずpage ID、既存`ReaderZoom`型（fit-page／scale）、landing、reading anchor、履歴、active surfaceを対象とし、`ReaderCommandPort`から操作する。現行Connectionで未処理のhistory commandも接続する。数値`0`への変換は旧paneへの境界だけに限定し、原訳mapping・引用jumpもその後同じ入口へ加える。

倍率commandはactive surfaceの実際の表示倍率・fit寸法を参照する。fit-pageからのキー／ホイール拡大も現在描画中の大きさを起点とし、固定sentinelへ単純にpresetを足す実装へ戻さない。左右で異なる寸法の下限、旧倍率の正規化、入力位置の維持を同じReader状態とsurface metricsで検証する。

## 4. Markdown・Libraryを接続し、旧writerを撤去する

`NoteEditSession`のdraft・edit-start base・remote・autosave規則は再利用する。手書きのsnapshot履歴は`DocumentEditHistory`へ移し、二種類の文書Undoを恒久保持しない。

Markdown editor、追記、引用、テンプレート適用を同じsession／`MarkdownEditBatch`へ通す。append専用の別保存sessionを増やさない。

Libraryは一覧read modelと「一件作成 → 初期contentの原子的公開 → 開く」から始め、その後変更・移動・関連・削除／回復を順に完了する。全CRUDの抽象portだけを先に増やさない。ConflictSessionも使う単位で比較・採用・両方保持まで画面へ接続する。

この最初のLibrary操作を共通`LibrarySession`と`LibraryCatalogPanel`で両explicit本番mountへ接続した。一つのlibraryId journalで初期publicationとcatalogを保持し、失敗・再起動後も同じIDと要求内容で再試行する。保存済み資料のopeningが現在の入力guardに拒否されても作成済み項目を残す。Chromium／WebKitでMarkdownと白紙ノートの作成・編集・通常同期・一覧からの再openを確認した。選択IDの自動復元や既定起動切替を完了したという意味ではない。

「一覧の一件を改名 → 保存失敗から同ID再試行 → Undo／Redo → 再読込」を同じLibrarySessionへ接続した。pendingはpublication／library batchを扱い、Document専用history型へLibraryを押し込まず、既存HistoryRecordのoperation／execution IDと有限の逆操作・現在値検証を使う。資料本文と見出し更新を分け、quota失敗中も本文editorを保持することを確認した。次はtag／既読の単一・複数変更、続いてfolder、関連、観測heads付き論理削除／復旧を追加する。ConflictSessionの直接commitを別writerとしてつなげず、比較はEditGraph、resolution保存も同じLibrarySessionへ通す。

タグ・既読の追加ではクリック時の対象IDを固定し、全件の存在・非削除を検証して一つのbatchとUndoへまとめる。add／removeは最新値への差分、replaceは編集開始時のタグ配列を照合する。既読はtoggleではなく明示boolを渡す。契約上のタグは1〜200文字・完全一致の重複禁止で、旧UIの80文字／100件制限を持ち込まない。新規入力だけ共通のtrim／先勝ち重複除去を通し、既存配列の順序や文字列を黙って正規化しない。

このタグ・既読操作を実装し、両hostの一括変更・同ID復旧・Undo／Redo・同期・無変化を両engineで確認した。タグ入力と削除チェックは親draftへ移し、一覧を閉じても保持する。未編集の置換もexpectedTagsを照合してからraw完全一致の無変化にし、外部更新時は入力を残して拒否する。次はfolder／treeの縦接続を進める。

有限inverseの対応範囲を既存itemのtitle／tags／readだけへ広げ、実際に変更したfieldの現在値とexecution後値が一致した場合だけ以前値を戻す。tagsは配列全体・順序込みで検証する。resource／kind／owner／folder／position／書誌metadata、作成・削除・linkはこの要求として再送しない。選択IDは通常pollや自身の保存で解除せず、表示から消えたIDを除き、版の明示切替・scope変更で解除する。入力開始後のbulk対象を無言で増減させない。

### 次のfolder工程と配置の不変条件

Astraの再調査により、stored folderを無条件に保全する前案は採らず、`ownerId !== null ⇒ folderId === null`をcanonicalの意味検証へ追加する。旧treeもowned itemの位置をownerから導出しており、古い非表示folderへ戻す意味は設計にない。共有owned fixtureと現生成物は既にnullで、完成済み旧catalog converterも未接続なので、既定切替前にTS／Python・共有拒否fixtureで条件を固める。旧形式の値はraw backupへ残し、後の一回変換ではownedの配置を正規化する。

owner移動で子itemを書き換えず、note独立化・owner削除で子noteを残す場合は、その時点のowner folderへ`ownerId:null`と配置順を同batchで付与する。owner必須のattachmentをnoteと同じ独立化へ流さない。添付の保持／削除集合は所有者削除工程で明示する。

次の利用者操作は「folder作成→item移動→階層開閉／キー→folder改名→内容を残す削除→Undo→再読込」。現在のLibrarySessionにfolders read modelと作成結果を追加し、document用createdIdのauto-openは起動しない。削除は選択folderだけを除き、直下item／直下child folderを親へ移し、子孫構造と文書内容を残す。論理削除済みitemのfolder参照も検証対象なので修復を漏らさない。folder作成／改名／移動・削除とその有限inverseを明示的にadmitし、任意のfolder差分を一括許可しない。旧path／store型のtree helperを直接importせず、IDベースの可視行・開閉・focus・キー規則を共通化する。

既定起動へ切り替える前には、初期文書がない空Libraryの一覧・作成画面も接続する。架空のdocumentIdを用意せず、選択なしのWorkspaceと選択後の種別別bindingを分ける。現entryは初期documentIdを必須とする。またbindingのcatalogVersionは現在navigation由来だけで、entryの初期指定は未対応である。対応時はNav初期値から両controllerのcurrent-head検証まで渡し、無視しない。

各単位の出口は次の三点をセットとする。

1. 両hostの本番compositionから同じ共通entryが実行される。
2. 保存・再起動・相手hostへの反映・必要な障害回復が成立する。
3. 置き換えた旧状態・writer・履歴・listenerがその経路から撤去されている。

### Markdown縦接続の具体化（Reader実装時の追加Astra調査）

`MarkdownSnapshot`／`MarkdownEditBatch`／publication／repository／通常replicationは既に本文を扱う。次は新writerを増やさず、canonical専用`MarkdownEditSession`を同じscope registryへ追加し、既存`MarkdownEditor`と純粋`MarkdownContent`を両mountへ接続する。`NoteEditSession`の旧revision／NoteDocument保存をcanonicalの外側へ残さない。

sessionは編集owner、edit-start base、draft generation、保存flight、再試行ID、到着remote、CodeMirror stateと外部baseline世代を所有する。保存応答待ちの追加入力をackで消さない。既存の不変intent requestを書き換えて追加入力を保存しようとせず、scope付きの別draft保全を用い、その保存先を通常backup／dataset切替のfootprintへ登録する。draft保存失敗は本文を保持し、耐久済みと表示せず離脱を止める。

registry起動回復はMarkdown intentも処理し、leave/suspendも未保存本文を確認する。append/templateのoperation IDはcanonical appendIdsとpending intentへ結び付け、確定前に呼出し元の要求を消さない。本文入力UndoはCodeMirror、受理済み操作の逆batchはversionと期待本文を検証して生成する。remote採用／耐久Undo後はCodeMirrorのbaselineを更新し、相手変更をCtrl+Zで無言に戻して保存しない。

初回の出口は両本番mountでの入力・autosave、保存応答消失の同ID再試行、flight中追加入力、Undoとreload、他host反映、中央／右移動でのdraftと選択保持とする。本文接続だけで画像・引用を受入済みにしない。

実mountへは`LibraryContentConnection`を置き、repositoryの対象root kindを確認してからDocument／Markdownのsessionを取得する。kind確認前にMarkdown IDで`registry.get()`を呼ぶと、未readyのDocumentEditSessionが残り離脱を拒否するため避ける。共通`ReaderWorkspace`はlayoutのみを受け持ち、document側は既存の参照view構築、Markdown側はdraft previewと一つのeditorを渡す。section／asideはblock要素なので、Markdown編集面にも高さを満たすflex wrapperを置く。

Markdownの配置にはpage IDを捏造しない。ページを持たない`ReaderPlacementSession`を用い、UI状態portは既存paged記録と`{version:1,kind:'markdown',placement}`のunionを保存する。1文書につきpaged ReaderSessionか配置専用sessionの一方だけを作る。配置変更は本文flushとcanLeave確認後に行い、CodeMirror stateを本文sessionへ残す。placement session、保存union、純粋workspace、両entryへの接続を実装し、本文の両host実画面を確認した。hostのbound composition全体をlazy読込し、controllerとviewを同時にcommitする。検証範囲と未接続機能は実装記録に区別する。


画像については現行PCのsidecar mediaとWebのlegacy manifest参照をそのまま持ち込めない。canonicalのsnapshot／batchへ必須manifestを追加し、安定参照構文、bytes／hash確認、resource先行転送、repositoryからのBlob画像表示を接続した。PNG／SVGの両本番mountによる追加・同期・再読込を検証している。旧画像の一回変換、lightbox、通常backup footprintは残件である。引用もhost別URL transformへ戻さず、安定page IDと背景版を共通navigationへ渡す。

### 画像契約と引用の接続工程

本文をMarkdownのまま保ち、画像resource manifestをMarkdownSnapshot／MarkdownEditBatchへ追加する。新しい契約は空集合も明示し、初期publication、scratch、append snapshot、逆batch、checkpoint、変換fixtureを同じ契約へ更新する。本文とmanifestは一つの操作として保存・復元する。

内部画像URIはresource IDと期待hashを持つ`papeer://resource/<uuid>?sha256=<hash>`を採用した。本文編集時のmanifest抽出は純粋処理で行い、実際のimage／解決したimageReferenceだけを、rendererと同じMarkdown／GFM／math／normalize規則で抽出する。code、未使用definition、math、通常link、表示しないHTML内のURLをresourceと誤認しない。rendererの既存parser依存を直接宣言し、本文はASTから再生成せず保持する。確定前にはmetadataの存在・ID・hash・MIMEを検証し、失敗した手入力URIを修正できるようimmutable batch割当前に確認する。

Pythonは明示manifestのID・重複・存在・hash・画像MIMEを検証し、TS/Pythonのresource列挙へ接続する。既存のresource先行upload／受信後edit取込を使う。rendererはmanifestに許可された内部画像だけをrepositoryから読み、scope／resource切替の旧完了を拒否しBlob URLをrevokeする。画像登録・hash確認が失敗したら元本文を変更せず再試行できる入口を設ける。

引用はlibrary／document／logical page IDと必要な背景版・位置を持ち、共通navigationへ渡す。ページ番号への黙った再解釈をしない。capture画像は同じresource登録を使い、画像と引用を同じappend ID付き操作へ含める。Libraryのopen／leaveガードと接続する小さなnavigation境界を使い、新たな万能storeは作らない。

「PDFの選択文章・領域を既存Markdownノートへ追加し、出典から同じ位置へ戻る」を両本番mountへ接続した。`NoteAppendSession`は引用元の固定要求だけを保持し、書込みは既存の宛先`MarkdownEditSession`へ渡す。出典と画像は同じappend ID・本文／manifest・Undo操作で保存する。共通PDF.js captureは固定したpage／resource／背景版とpt矩形を検証し、crop寸法のcanvasで生成する。手書き・図形の包含は選択できるが、canonicalの付箋・本文highlightは包含対象外。引用先選択、保存応答消失、両host反映、再読込、実PNGのink有無をChromium／WebKitで確認した。続くLibraryの一覧・一件作成・初期contentの原子的公開・開く操作も同じscope authorityへ接続し、次は上記の改名・履歴へ進む。テンプレート、lightbox、訳文collection、全Library CRUDと既定切替は残す。

共通compositionの選択文書IDと一回限りの移動要求、現在のcontrollerが提供するprepareClose／canClose、対象catalog／headの確認、描画待ち中の背景版確認を実装した。同scope内の資料切替にはscope全体のprepareLeave／suspendを使わない。未表示の復旧draftがあるだけで、その復旧先自体を開けなくなるためである。現在表示中の入力・保存だけを確認し、同じregistryを保持したまま移動前のreadで対象を検証してから既存sessionを取得する。移動先のdirty／pending／壊れたscratch／複数headsは、内容と復旧状態を確認するためのopening自体を拒否する条件にしない。await後は現在表示ID・scope・request世代・canClose・registry activeを再確認する。

scope／accountを離れるときは従来どおり全session・journal・scratchを検査する。beforeunloadは表示中sessionとunhandledTargetsだけでなく、未表示sessionの保留とdraft列挙を同期的に確認するneedsExitConfirmationへ統一した。この退出警告と、同scope内の復旧先openingの許可を混同しない。nativeの実終了・全dataset切替の接続を完成扱いにするものではない。

訳文引用のpage IDは訳文collection内の実IDを使い、原文への推定変換はしない。明示bindingの両mountは原訳collectionと一意mappingへ接続済みで、未対応／曖昧な逆引きを拒否する。既定起動と旧責務撤去は残る。capture生成は確定したresource・source版・physical PDF page・pt矩形から共通PDF.js処理を使い、legacy API／media path／storeを再導入しない。

実装前に、既存画像変換の欠落、raw保持と一回変換、historical／競合branch resourceの保全、parserのnormalizeとsource位置の関係を再確認する。必須試験は偽画像URL、参照形式、hash不一致、画像保存／転送の失敗と再開、画像付きUndo／Redo、別host反映、page reorder／削除後の引用である。

## 5. 実データの切替はlibrary単位の一回変換にする

既存backup／converter／manifest／DatasetTransitionSessionは維持し、移行製品として一般化しない。隔離sliceの開発と、実ユーザーのlibraryを切り替える条件を分ける。

実切替では次を満たす。

1. PC request／job／publisher、Web tab、端末別pending、Drive入力を棚卸しする。
2. 新規writer受付停止 → 既存処理drain → 全対象の入力固定を確認する。停止できないpeerや未回収outboxがあれば切り替えない。
3. canonical sibling、backup artifact、bootstrapも同じ保存footprintへ登録し、通常backup／move／restoreで同じ定義を使う。
4. 全領域backupの読戻し・復元試験を通す。raw収集はlibrary総量をRAMへ載せず、逐次退避できる方式にする。IndexedDBの原子的snapshotと容量の方式は実装前に確定する。
5. 固定入力から新epochへ変換し、未変換・表現不能内容を明示する。空や近似値へ黙って置き換えない。
6. **既存resourceも実bytesのhashを照合**する。metadata一致・row存在だけでimport完了／activationへ進めない。検証とmarker／pointer更新の整合を保証する。
7. resource／checkpoint／manifest公開、検証、active pointer切替を既存controlへ接続する。両entryがそのpointerから新compositionを起動する。
8. 旧writerを停止したまま、新側の未送信内容を保全した復元／rollbackを検証する。

全resourceの再検証はimport／移行／activationの境界で行い、通常の一筆ごとには行わない。rollbackで新編集を捨てず、旧datasetへ新batchを再取込しない。新旧自動二重書込で切替の不備を補わない。

## 6. 維持・簡素化・後回し

| 対象 | 判断 |
| --- | --- |
| schema・安定ID・DAG・同ID再送・journal・文書history | 維持し、不具合・計算量を修正して接続する |
| SQLite／IndexedDB repository | 保存契約を維持。Python側にUI判断を置かず、受入検証・投影・耐久化の意味と性能を両言語で照合する |
| 通常同期とdataset import | 分離する。通常pollは未取得recordの増分とし、全checkpoint本文を読まない |
| toolbar・gesture・noteの共通部品 | 再利用。ただし別state・別writerが残る状態を共通化完了としない |
| 旧形式の保全・一回変換・rollback | 実切替に必要な範囲を完成させる。汎用migration frameworkへ拡大しない |
| 全サービス入りruntime・万能store・汎用command bus | 新設しない |
| Library全UI・汎用query基盤 | 目前の縦接続に不要なら後回し |
| 性能のための履歴破棄・未解決枝圧縮 | 保全規則なしに採用しない |

共通化の中心は操作の意味と状態遷移である。OS／Drive／SQLite実装まで巨大runtimeへ押し込むことも、同じtoolbar／型を使いながら状態と失敗保持をhost別に残すことも避ける。

## 7. 工程と検証の運用

M0〜M6は全機能を網羅する分類として維持する。着手順は**現行消失修正 → PDF縦接続 → paper／Reader → Markdown → Library → 全領域切替**へ改める。全前工程の完了待ちではなく、該当する保存・認証・保全条件を各公開境界の必須gateにする。

基盤追加は「次に完了させる利用者操作」「本番接続先」「撤去する旧責務」が具体的な場合に限定する。staged entry数やtest総数を進捗目標にしない。

依存検査はpackage importとstorage／network globalも扱い、意図した禁止fixtureで失敗を証明する。viewのDOM許可とdomainの禁止は区別する。受入traceはfixture部品だけでなく、両本番entryからの操作で記録する。

この順序変更のために抽象的な確認質問は増やさない。実移行で対象account／library、停止不能端末、保全不能・表現不能項目、競合内容の採用判断が生じた時点で、具体的な内容を示して確認する。

## 検索工程後の添付F34の接続案（2026-10-26・Astra調査）

検索は明示bindingの両mountへ接続し、既定切替・外部index・大規模性能等は残す。次の未接続機能は添付。既存ownerへ1ファイルを取り込み、resource耐久化→contentなしContentPublication→正確な添付IDで表示→改名／論理削除／Undo→同期／再読込を一つのsliceとする。

- ファイル選択時のowner・元名・MIME・bytes/hashとitem/resource/publication IDを固定する。resource保存後の失敗でもbytes・IDを保持し、結果不明は同じpublicationで再試行する。
- LibrarySessionのresource portとpublication admissionを拡張する。attachmentはcontent rootを持たず、repository.read(attachmentId)やgetMarkdown(attachmentId)へfallbackしてはいけない。
- 共通navigation／表示へattachment item IDの分岐を置く。Markdown添付は保存bytesの読み取り表示、HTMLはscriptが実行されない隔離表示、他形式は明示保存等。編集ノートと添付を混同しない。
- resource保存後にowner・scope・catalog競合を再確認し、消えたownerから別ownerへ自動付替えしない。未送信取消と結果不明の同ID確定後inverseを分ける。
- 削除はcatalogの論理削除。resource／公開record／履歴を保持する。attachmentのobserved headsは空で、架空の文書headを作らない。成功importのUndoは通常history/admissionへ明示的に追加し、Redoで新IDを作らない。
- Python contentなしattachment受入とresource binding、resource先行replicationは既存実装を利用できる。wire／保存接続を変える際はPython受入も確認する。

受入では同ownerの子ノートとMarkdown添付を併置し、ID兼用・誤fallbackがないR04、resource保存失敗、公開応答喪失と同ID再送、rename/delete/import Undo/Redo/reload、両hostのbytes/hash一致を確認する。調査のみでありF34実装済みとは記録しない。

## 添付工程後の優先順（2026-10-26・Astra 3観点調査）

F34はexplicit両mountでresource先行保存・exact ID・再試行・readonly表示・通常作成Undoまで実装し、新規実画面2/2成功。通常起動／旧責務撤去は未完了。次はF37の一覧だけを先に完成扱いせず、依存するM3訳文surfaceを先行して接続する。

1. M3の原文固定controllerを原文／訳文collection対応に広げる。Readerの位置・履歴・保存先にもsurfaceを保持し、既存resolverのstable page/background/anchorを使用する。対応前の訳文を原文番号へ代用しない。
2. scope内singletonのAnnotationBrowserSessionをregistryが所有する。現在／全資料、原訳、sticky/highlight、label、複数語AND、並び順、選択行・rowKey/offsetによるscrollを保持。corpusはrepository readと既に存在するdocument sessionの確定済みread modelだけを読み、全資料分の編集authorityを作らない。未取得／partial／conflictedを明示し、旧結果を世代で拒否する。createdAt不明は不明のまま末尾へ置き、小数秒を落とさない。
3. 一覧行はdocument ID/version・annotation ID・page ID・backgroundRevision・surface・pt anchorを固定する。場所移動は最新選択版で注釈自体も再確認し、消失／移動／背景変更・別headを黙って読み替えない。資料間backと一覧復帰を分け、一覧条件・focus・scrollを維持する。
4. 絞込結果全体を固定Markdownへ一度だけ変換し、NoteAppendSessionの小さなannotations入力variantへ渡す。行ごとに追記しない。本文・順序・各出典・宛先・append IDを開始時固定し、既存dirty宛先を保全する。新規宛先作成と追記は別phaseで関連づけ、再試行でcreateを再発行しない。

既存NoteAppendDialogはDocumentLibraryViewへの型依存を小さな共通操作型へ分離する。出典URIは現行markdownCitations/citationLocationの実契約を再読して原訳tupleを確定し、page ordinalへ置換しない。同annotationの同payloadはsourceVersionsを保持して共有表示可能、異payloadはvariantを保持し採用を推測しない。

受入は両host・両engineの原訳／複数資料／競合variant／未取得、時刻不明、小数秒、遅延応答、場所移動と一覧復帰、背景変更拒否、固定結果の一操作追記・Undo/Redo・同ID再送・新規宛先失敗を含める。PDF付箋／highlight編集UI・全注釈capture・訳文collection全操作・検索／outline／内部link、folder drag/drop、専用回復比較、Workspace／preferences、全領域切替・既定起動・旧責務撤去・実機は残件として維持する。

### 原訳接続後のF37実装先（Astra再調査）

`canonicalAnnotationBrowser.ts`・`canonicalAnnotationCorpus.ts`・`AnnotationBrowserSession.ts`と共有Panelを作成し、13単体・複数Astraレビューを通した。これらはまだ本番UIへ未接続である。次は以下を一つの縦接続にする。

1. `DocumentEditSessions.getAnnotationBrowser()`をscope singletonとする。既存確定modelは`this.sessions.get(id)`のみで読み、一覧取得のために`get(id)`から編集authorityを新設しない。scope停止で取得をcancelする。
2. `LibraryContentConnection`内のcatalog隣に小さな共通Connectionを置き、選択済catalog snapshotとnavigationのcurrent documentを渡す。全headから勝手に一つ選ばない。資料間移動でもPanel／条件／scrollを維持する。
3. 通常`openCitation`ではsourceVersionが落ちるので、`openAnnotation`の一時的expectationにversionとexact row/payloadを保持する。closeguard後のfresh repository readとDocument controller側の双方で、現head・collection・page・背景版・annotation payloadを確認する。指定headへ明示checkoutして`jumpSurface`へ渡す。URIへ無制限の新形式を追加する必要はない。
4. 一覧専用のNoteAppend authorityをregistryに持ち、未完了requestとdestinationを既存退出／削除guardへ含める。NoteAppend入力へ`annotations` variantを追加し、固定結果全体をclone/freezeして同じappend IDの`appendText`一操作へ渡す。chooserはDocumentLibraryViewへの型依存を外す。
5. 新規宛先作成はitem/content/publicationのIDを要求開始時に固定する。`LibrarySession.create`への小さいidentity引数等で同一publicationを再試行し、作成成功後は宛先を固定して同じappendだけを再試行する。共有createdIdだけで別要求へ帰属させない。

この調査時点のNoteAppendはhandoff前の要求をmemoryだけで保持していた。F37縦接続ではannotations要求に限ってscope別scratchを導入し、作成・追記のphase、固定ID、appendStarted markerとauthority照会で強制終了後の再試行を接続済み。quote／image要求のhandoff前永続化は残る。別writerや万能runtimeは追加しない。

## F37接続後の優先スライス（2026-10-27・Astra再評価）

F37の新規両本番接続2suiteはChromium／WebKitの4/4成功。通常pollと場所検証の取消世代を分離し、独立Astra再レビューで新P1/P2なし。既定起動・旧責務撤去・実機・Workspace宛先の残件を維持したまま、次はF38の削除Markdown専用比較へ進む。

既存の回復一覧・未確認／確認待ち・readonly内容確認・restore writerを再実装しない。選択catalogのdeletion recordからobserved版を左、最新content graphのheadを右へ出し、複数候補は明示選択する。比較pairとscrollは固定し、後着headは通知する。欠けた版・waiting・取得失敗を別版や空本文へ置き換えない。画像は各snapshotのmanifestと共通previewで解決する。比較の閲覧でobservedを書き換えず、復元は全head・画像・履歴を残して既存LibrarySessionへ委譲する。親子一括recordでは全復元対象名を示す。

ユーザーの担当指定に従い、実装・デバッグはSolへ、設計・方向設定・独立レビューはAstraへ委ねる。初回対象はMarkdown（付属ノート含む）。PDF／paper専用比較とF35の採用・両方保持・再編集は別の後続スライスにする。

### Markdown比較後の方向（Astra追加評価）

Markdown比較の実画面確認後、F38のPDF／paper専用比較へ広げる。既存の削除一覧→比較→全対象復元を再利用し、種類ごとの比較Sessionを複製しない。現SessionをDeletedContentComparisonSessionへ一般化して`MarkdownSnapshot | DocumentSnapshot`を扱い、候補・固定選択・後着通知・世代・scrollは維持する。旧Markdown専用モデルは置換後に削除する。

文書の左右ページ選択は固定snapshot内の`{surface,pageId}`で指定する。別版の同ordinalや原訳へ代用せず、原訳・ページ欠落を明示する。PDF背景は共通PDF描画とresource検証、paper背景と全注釈は既存readonly部品を再利用し、比較時だけlazy loadする。InkOverlay・偽InkEditor・編集session・通常Readerの位置authorityは取得しない。復元writerと全head保全は変更しない。

原訳・異resource／物理ページ・paper寸法・ink／付箋／本文highlight・版間のページ追加削除・resource欠落／遅延取消・後着時の左右選択／scroll・親子復元後の全graph不変を両本番mount／両engineで確認する。F20付箋／本文highlightの作成・編集は、その次の独立sliceとして、入力draft／gesture排他と既存DocumentEditSession.editPage／文書Undoへ接続する。

## F38完了後のF20設計案（2026-10-27・Astra調査／独立レビュー反映中）

「付箋を置く／PDF本文をhighlightする→共通フォーム編集→保存／Undo→F37一覧から再編集」を一つの利用者操作とする。F38の実画面確認までは既存sourceを変更しない。

唯一のwriterとUndoはDocumentEditSession／既存pending・journal・文書historyを使う。通常editPageは入力中を拒否してexpectedを現在pageから作るため、draftを先に解除して呼ぶ方法は使わない。DocumentSurfaceStateへ注釈draftを追加し、実page ID、baseVersion、PageExpectation、変更前payload、作成予定ID、編集中payloadを固定する。commitAnnotationDraft(pageId, ownerToken, draftId)はSession内のdraftだけからcreate／update／deleteを生成し、owner・ID・base・expected・元payload・許可fieldを照合する。任意changesを受け付けず、受理時だけdraftから既存pendingへ原子的に移す。拒否ならdraftを保持する。別の編集SessionやUndo stackを作らない。

ownerはuseDocumentInkEditorの既存private tokenを使う操作facadeにbegin／change／commit／cancelを追加し、フォームへtokenを公開せず二重claimしない。cleanupで未確定draftを消さずownerだけ解放し、再claim時にdraftからphaseを復元する。Ink text draftと注釈draftの同時開始を拒否し、inputActive／claimPage／canEditPage／setInput／canNavigate／refusal、Connectionのdraft page優先、close finalizerを全て点検する。

draftはpane再配置・一時unmountでもSessionに保持し、navigation／背景変更／Undo／別page入力を拒否する。textDraftだけを見ているguard、復旧時の強制page選択、close finalizerを拡張する。保存開始後は既存pending／同ID retryを使い、フォーム取消で保存失敗内容を捨てない。未確定draftのreload耐久性は別に実装しない限り保証しない。

| 操作 | 保存する変更 |
| --- | --- |
| 付箋を置く | PDF／paperのpt anchor。原訳とも実page ID |
| PDF本文highlight | 同じ実textLayerの選択からquote／pt quads／anchor／背景版を固定 |
| 本文／分類／色 | 元annotationの他属性を維持して指定fieldだけ更新 |
| 移動 | stickyのanchor、highlightはコメントanchorのみ。本文quadは暗黙移動しない |
| 削除 | 選択annotationを一操作で削除 |
| 再編集 | page上の選択、またはF37移動後の「この注釈を編集」でexact payloadを再照合 |

highlight新規作成はPDF本文選択に限定し、paperの矩形を本文highlightとして作らない。paper上の既存highlightは表示／編集／削除可能。createdAtは開始時UTCで固定し再試行で変えず、stickyのcolor:nullも無操作で具体色へ置換しない。

既存canonicalPdfSelectionはquoteと先頭anchorのみ。任意角度の文字の包絡矩形を逆変換してglyph quadとして使わない。初回は水平・単一行・非折返しtext item、正scale／平行移動、pageの四直角回転に限定し、この範囲では実Text node単位のsubRange.getClientRects四隅をcanonical ptへ変換する。保証は実DOM選択領域でありglyph輪郭復元ではない。mirror全文再計測は独立レビューで不要と判断し初回採用から外した。任意角度文字回転／skew／perspective／縦書き等の対応を証明できない選択は明示拒否し、引用コピーは独立して維持する。これらの未対応をF20全体の受入済みとして隠さない。

複数item／複数行の選択は全体の成立を確認し、一部だけのquad集合で保存しない。text indexが未接続ならrangeはunindexedとしoffsetを捏造しない。DOM採取からdraft入場までは同一page／背景版／resource／描画tuple・font・contact状態を照合する。draft開始後はcanonical quote／quads／rangeと元page／baseを固定し、resize・font再描画・pane再配置で再計測しない。保存時は現owner／draftId／active admissionとfresh readによる元base／PageExpectation／背景版を検証し、採取時text tokenの継続を条件にしない。配置／移動は既存gesture admissionを先に取り、pointercancelで保存しない。selection handle／pinch／pan／swipe／Inkの所有を同時成立させない。

F37の既存場所移動はjump直後に要求を完了するため、その隙間で自動編集を開始しない。独立した編集候補にversion／全annotation payload／実page／背景版を保持し、移動後の明示「この注釈を編集」でactive owner・描画ready・現在版・全payloadを再照合してdraftを開始する。別navigation／取消／scope変更で候補を破棄し、別版の同IDへ読み替えない。

Core／draft／純粋annotation操作、selection geometry、UI／connectionの担当を分ける。AnnotationTextEditorは再利用し、StickyNoteDialog／Markerはフォーム・表示・drag部分をprops駆動の純UIへ抽出する。canonical経路へlegacy API mutation／stickyNotesStore／useStore／独自保存を持ち込まず、既定切替前のlegacy connectionは維持する。保存済み表示と新編集layerでは同じannotationの二重描画を避ける。

両host／両engineで原文・訳文・paperの付箋、複数行highlight、移動／本文／分類／色／削除、Undo/Redo、F37反映、同ID再送、背景／remote変更guard、pane再配置、pointercancel、selection handle／pinch排他、対象外属性の完全保全を検証する。owner token共有・geometry・復旧guard全呼出しの実装前独立レビューを行ってからSolへ渡す。

順序は専用draft入口／owner再取得の単体→付箋の縦接続→F37明示編集→quad geometryの両engine確認→highlight作成。付箋を先に完結させ、成立していないgeometryを曖昧な描画で埋めない。独立レビューの4点を上記へ反映したため、実装前に修正案の再確認を行う。

修正案のAstra再確認で、付箋sliceをSolへ渡す上で重大な不足はないとの結果。受入条件として、close／unmount finalizerは未確定フォームを自動commitせず、owner解放後もdraft／guardを保持することを明示する。begin／changeだけでなくcancel／commitもactive・owner・draftIdを照合し、古いフォームcallbackで再取得後のdraftを消さない。保存開始後はフォームdraftとpendingの二重authorityを残さず、固定pendingだけをretryする。

### Highlight geometry技術案（installed source調査、spike未実施）

現在描画されたtextLayerの選択領域をcanonical pt quadへ固定するもので、PDFグリフ輪郭の復元とは扱わない。installed PDF.js 6.3.289にはTextLayer.textDivs公開getterがあるがreact-pdfはinstanceを外へ渡さない。onGetTextSuccess／onLoadSuccess／onRenderTextLayerSuccessから軽量なpage bindingを作り、空item／br／marked-content wrapperを区別して非空TextItemとpresentation spanの文字列・方向・件数・構造を検証する。private fieldやcustomTextRendererのHTML差替えは使わない。

Selection端点は実text nodeのUTF-16 offsetを保持し、cleaned quoteのoffsetを幾何へ流用しない。実Text node内のsubRangeへ分割してgetClientRectsを取り、元Rangeに完全包含された親elementのborder rectとの重複を避ける。許可範囲では各rectが矩形そのもので、祖先のscale／四直角回転を適用しても軸平行なため包絡による情報損失がない。[CSSOM View §9](https://drafts.csswg.org/cssom-view/#dom-range-getclientrects)に基づき、実DOMが適用済みのfont／spacing／scale-x／最小font補正を再実装せず使う。独自ascentやCanvas幅で補完しない。

座標はclient→描画viewport→PDF座標→natural viewportへ写す。後半はnaturalViewport.transform×inverse(renderViewport.transform)を使い、natural viewportは既存captureと同じgetViewport(scale:1)の向き／原点へ揃える。raw PDF左下原点へ保存しない。CropBox／UserUnit／PDF回転はviewportへ任せ、canvas backingだけのDPRをclient rectへ重複して掛けない。任意角度の親transformをページbox幅比だけで吸収しない。metadata／Page寸法、DOM／viewport整合を検証し範囲外をclampしない。**UserUnit≠1は実spike必須**。現react-pdfのCSS total-scale-factorとPDF.js rawDims配置はUserUnitを自動反映する保証がないため、実canvas／textLayer不一致ならlayout-mismatchとして拒否し、黙って対応済みにしない。

初回は水平・単一行itemと検証可能なscale／平行移動、pageの四直角回転を対象にする。複数item／行は各item全て成功した時だけ採用。任意item回転／skew／vertical／perspective／未知wrapper／font読込中／旧tupleは拒否する。surrogate／grapheme途中は拒否する。ligature内部の厳密glyph分割は保証せず、実DOM selection semanticsとして両engineで確認し、文字数比からrectを切り詰めない。bidiは初回拒否とする。

API案はcaptureCanonicalPdfHighlight({range,binding})→ready({pageId,backgroundRevision,quote,quads,anchor,range:unindexed})またはrefused(reason)。reasonはstale-render／fonts-pending／item-map-mismatch／unsupported-transform／unsupported-text-boundary／layout-mismatch／invalid-selection。bindingはscope、実page／背景版、resource/hash、physical page、viewport、render generationを固定し、開始・終了で再検証する。既存quote-only selectCanonicalPdfTextは独立して維持する。

Coreは既存draft unionへcreate-highlight／edit-highlightを追加し、新規のquote／quads／range／backgroundだけを固定する。以後の本文・分類・色・コメントanchor・削除は許可fieldのみ、同owner／mayCommit／pending／Undoを再利用する。paperは既存highlightの編集対象にできるが新規本文選択作成はしない。

実装前spikeは水平部分選択・複数行/item・CropBox offset・page四回転・倍率/DPRを両engine実PDFで照合し、UserUnit／回転文字等の拒否とoldtuple／font待ちも固定する。成功quadを両hostで再描画し、拒否時draft／journal／batchが増えないことを確認してから作成buttonを接続する。付箋sliceの実画面を先に完了させ、未実証geometryを通常機能へ出さない。

この簡素化は別Astraのinstalledsource／CSSOM一次仕様による再レビューを採用したもの。mirror案は任意transform対応を拡げる将来候補であり、初期対応のためにfont substitution／shaping／spacingを二重管理する仕組みは作らない。

### Solへ渡すgeometry接続境界（Astra追加具体化、未実装）

共通の`canonicalPdfHighlight.ts`へDOM採取・item map検証・座標変換を、`useCanonicalPdfTextBinding.ts`へ同じ描画tokenのpage／textContent／text render／canvas／font readinessを置く。独立storeやwriterは追加しない。既存canvas向け`useCanonicalAnnotationReadiness`はtext準備完了を保証しないため、bindingへ代用しない。

両canonical経路は新しい共通`PdfSurface.tsx`と`CanonicalDocumentSurface.tsx`へ置換する。旧`PdfPane.tsx`／`web/PdfReader.tsx`はlegacy専用とし、新geometry propを追加しない。PDF.js callbacks／測定／layout幅・実描画幅／preview／DPR予算／text補正／readinessを共通surfaceへ集め、両adapterはFrameと同じ共通surface呼出しだけにする。受付・active面照合・作成操作は共通Connectionへ置き、描画側に別のReader／registry／保存／位置authorityを作らない。共通採用する`fitTextLayer()`補正後にbindingを検証し、検索の有無から独立して準備を通知する。covering中／CSS zoom過渡中は拒否し、静止後の通常倍率は成立させる。

tokenはscope／実page・背景／resource/hash／physical page／URL／drawnWidth／DPR／rotation／実DOM mountを固定し、旧callbackで新tokenをreadyにしない。font loading開始時にも失効する。TextItemとpresentation spanは件数だけでzipせず、実文字列・dir・単一text node・空item／EOL／marked-content構造を検証する。座標原点は描画済みページcontent-boxとし、border／追加2px／padding／overlay原点は共通の一仕様へ揃える。layout幅と実drawnWidthは分離し、Webの即時readyへ単純統一しない。

本文選択は既存「読む」で作成buttonへ渡す。`getPdfPointerOwner()`だけでなく、pan開始前の接触も`hasPdfPointerContact()`で拒否する。現pointer inputは5pxで独自panを始めるため、文字選択／handleが所有したcontact列をpan／swipeへ再解釈しない接続を、公開前のP2 gateとする。二指pinchへ移った選択候補は破棄し、全離指まで作成できない。geometry関数にsynthetic Rangeを与えた成功だけでは入力排他を証明したことにしない。

spikeは自動suiteへ登録する前の専用fixtureから始めるが、両canonical経路の実`PdfSurface`と共通hookを使う。実PDF・既知のPDFマーカー位置を独立oracleとし、成功quadを既存`CanonicalPageAnnotations`へ重ねる。倍率0.75／1.5・DPR1／2・四回転・CropBox・UserUnit2・複数item／行・空item／EOL／marked content・Unicode境界／ligature・非対応文字方向を確認する。resize／再配置／旧callback／font待ちも検査する。UserUnit2のcanvas／textLayer／自然viewport不一致は拒否系として先に証明し、非対応変換の拡張をspikeへ抱き合わせない。共通renderer置換後の既存回帰を先に通し、両engineのgeometry成立後に作成入口へ接続して、拒否時にdraft／journal／batchが増えないことを確認する。

別Astraの独立確認は接続境界に新P1/P2なし。同token準備・補正後通知・content-box・item map・UserUnit拒否・入力排他を条件として、このspikeをSolへ渡してよいとの判断。実装・実行の成功を表すものではない。

renderer境界はその後Astra2名が再評価し、2つの旧rendererへ同hookを足す案から、canonical描画を一つへ置換する案へ更新した。旧Desktopの遅延redraw／covering／CSS zoom／補正とWebの即時redraw／別readinessを残すと、M3／R29の共通化とgeometryの再検証が先送りになるためである。第三の独立canonical仕様は増やさず、両adapterから旧2rendererへのcanonical importを撤去する。legacy既定呼出しだけはM6まで残す。

`PdfSurface`は固定asset／実page tuple／zoom／実scrollerRef／typed pointer callback／overlay slotを受け、metrics・raster readiness・text bindingを報告する。`CanonicalDocumentSurface`はPDF／既存paper表示を選び、Ink／保存済み注釈／編集中layerを同じready情報に接続する。ReaderSession・reading/companion place hookは唯一の位置ownerとして維持し、`paneRef`と`data-pdf-surface` selectorを抜かさない。active private scopeRefとreference／inactive専用scopeRefを保持し、pointer hookは実paneごと1回、window Reader入力はConnectionで1回だけとする。host近傍に残すのはFrame、resource取得port、OS外部opening等。実装順はasset検証統一→共通surfaceへ両呼出し置換→既存reader／ink／sticky回帰→geometry spike。独立Astraはblocking P1/P2なしと確認した。

Astra追加確認で、描画tokenは採取とdraft入場までの証明に限定する。入場前のcaptureがresize等で旧tokenになれば明示再採取が必要。一旦入場したdraftは元canonical geometryを保持し、旧token失効だけで保存不能にしない。回帰は採取→resize→begin拒否、begin→resize／font再描画→同quad保存、unmount／reclaim→旧callback拒否・新callback保存、remote背景／base変更→拒否・draft保持を固定する。再描画後に同じ文字を探してquadを書き換えたり、新tokenを古いcaptureへ付け直したりしない。

### Geometryに先行するPDF asset binding統一（Astra依存確認）

下記F18調査で指摘した`useDocumentPdfAsset`の検証統一は、F18を待たず実rendererのgeometry spikeと同sliceで行う。保存admissionは元page／baseを検証するが、DOMがそのPDF bytesから作られたことは補完できないためである。既存hookと既存`canonicalPdfResource`検証を使い、`CanonicalPdfAsset { binding, url, metadata }`を返す。別のloader仕様／global cache／storeは作らない。

hook内の検証済みresource proofとpage assetを分離する。resourceKeyはscope／resource ID／source hash／再取得attemptで、変更時だけ既存resource readerによるbytes／hash検証とURL生成を行う。proofはimmutable metadataとbyteLengthを保持する。render時にproof keyが現在要求と違えばcleanup前でもassetを返さず、旧応答をresource世代とactive scopeで拒否して旧URLをrevokeする。

page切替では現在の固定`canonicalPdfResourceBinding(scope,page)`を、proofへ`assertCanonicalPdfResource(binding,metadata,byteLength)`で検証し、成功時だけ同じURLと新page bindingのassetを返す。取得開始時のpageをそのまま公開せず、完了時の現在pageを再検証する。asset memoはbinding値で安定化し、注釈更新で再hashせず、同resourceの物理page移動でもPDF再parse／font再読込を起こさない。original／translatedの2呼出しは保ち、URLと検証済みbindingを同じassetで渡す。未検証の旧URLへの付替えは禁止する。page固有の不一致をresource全体の回復不能な失敗へしない。

同じreact-pdfのdocument／page load callbackでmetadataの全page数、binding.pdfPage、natural viewport寸法を確認し、二度目のPDFロードはしない。capture／previewと同じ短い実PDF寸法判定は既存`canonicalPdfResource.ts`へ抽出して共有できる。text bindingはこのasset identityから構築する。同resource IDのexpected hash変更／physical page・寸法変更／scope変更中の旧応答／metadataと実PDF不一致で旧assetとgeometry入場を拒否する回帰を加える。この保証なしでhighlightを公開しない。

Documentのloaded facts／numPagesはresourceKey＋URL／instanceに束縛してpage移動で維持し、Page proxy／text factsとdraw completionは固定page binding／view／DOMの別tokenで管理する。現在のtext hookはasset変更でdocumentPagesをnullへ戻すため、同URL移動でonDocumentLoadSuccessが再通知されずready待ちになる点を接続前に直す。retryによる新URLは同ID／hashでもDocument事実を失効し、旧instance callbackを拒否する。PdfSurface自身もDocumentをpage keyで丸ごとremountせず、Pageとdrawだけを必要なtupleで失効させる。この性能訂正をAstra2名が独立確認しblocking P1/P2なし。回帰は同resource移動でread／hash／URL／Document load増加なし、新page寸法不一致拒否、scope／hash／attemptの即失効、取得中page移動で現pageだけ公開を含める。

前節asset APIの具体化: `CanonicalPdfResourceIdentity = Pick<Binding, scope|resourceId|sourceRevision>`と`readCanonicalPdfResourceBytes(identity,resources)`を既存resource moduleへ追加し、scope／descriptor／bytes／hashの実装を一つにする。既存full page readerは共有処理＋fullpage assertを通るまで返さない。await前にidentityを固定しawait後もscopeを確認する。metadata／bytesをコピーし、ID／expected hash／PDF MIME／byteLength／schema／実bytes hashの拒否条件を減らさない。検証済みproofはpage mismatchでは破棄せず、valid pageへ取得なしで再評価する。このAPIをAstraが新P1/P2なしと確認した。

実PDFの短い共通helperは`assertCanonicalPdfDocument(binding,metadata,numPages)`と`assertCanonicalPdfPage(binding,actualPage)`。有限正の整数件数／metadata件数一致／physical範囲、pageNumber一致／natural viewportの有限正寸法と既存`.001pt`以内を確認する。capture／preview／新surfaceは既に読込済みの同instanceへ適用し、許容差拡大・clamp・二重loadをしない。実装はTools baseline後のSol担当へ渡す。

## F20後のF18／F19方向案（Astra静的調査、未実装）

F20を先に完了し、そのtext bindingを再利用して現文書PDF検索・結果送り・一時highlight・目次・PDF linkを一つのReaderへ接続する。legacy `ReaderSearch`のAPI／navigationや`pdfLinks.originalPageFor`のordinal fallbackをcanonicalへ持ち込まない。

- 共通`canonicalPdfText`をReader検索と既存`libraryPdfText`の下へ置き、PDF.js item順・空item／marked content・EOL／区切り・UTF-16 offsetと正規化後の逆対応を定義する。Libraryの既存文字列方針は保つ。抽出keyはscope／resource／source hash／physical page／policy版で、論理pageの順序とは分離する。キャッシュは有界・取消時にtaskを解放し、未取得／失敗／対象外／制限と0件を区別する。
- `ReaderPdfSearchSession`を共通Connectionへ合成し、query／原訳scope／世代／結果／選択hit／coverageを一つで所有する。結果は実page・背景版・resource/hash・physical page・index版・offset・anchorを固定し、論理page順→文字位置順。query／source／checkout／scope／lifecycle変更で旧結果を失効し、注釈のみの変更でimmutable本文を再抽出しない。取得前のEnter／F3は同世代に限定し、guard拒否を保存後に勝手に再実行しない。
- 移動はConnectionの単一callbackでcurrent tuple／原訳mapping／編集guardを確認し、位置を保存して既存`ReaderSession.jumpSurface`へ渡す。適用／有効な無変化時だけ選択hitを変更する。検索hitはanchor、anchorなし目次は先頭へ着地し、履歴・filter解除・描画待ちをReaderへ任せる。独自`scrollIntoView`待ちやhost側navigateを追加しない。
- 一時検索highlightは検証済みtext bindingと抽出offsetの対応からDOM subRangeを作り、SelectionやtextLayer HTMLを変更しない。zoom／resizeでは再描画するがannotation／draft／journal／Undoを作らない。F20のunindexed rangeを、検索index導入だけでindexedと偽らない。
- `canonicalPdfNavigation`で元resourceに束縛されたnamed／explicit destinationとoutlineを解決する。resource/hash／physical pageに対応する実論理pageが0件なら未対応、複数なら曖昧として拒否し、原訳の一意mappingも維持する。座標は対象pageのnatural viewportへ変換し、対応するdestination種別・null座標方針を明示する。PDF指定zoomを別ownerで適用しない。混在PDFノートのoutlineはresource別表示または現resource限定を明示する。
- canonical唯一の`PdfSurface`から元binding/token付きraw destinationを共通resolverへ渡す。旧`PdfPane`のawait後最新callbackへ結果を渡す処理と、Web旧rendererのannotationLayer無効はcanonicalへ引き継がない。外部linkは既存安全なopening境界へ渡し、launch／remote file等をpage移動へ代用しない。両adapterはFrameと型付きeventの接続だけを持ち、別resolverを作らない。
- asset検証統一はF18に先行して実装済み。`useDocumentPdfAsset`はscope／resource ID／source hash／attempt単位のproofを`readCanonicalPdfResourceBytes`で取得し、現在の固定page bindingを`assertCanonicalPdfResource`で別検証する。page移動でresource effectを再実行せず、実Document／Pageの短いassertも共通化する。F18はこの境界を再利用し、pageごとのloaderや別の検証規則を追加しない。

試験は抽出offset／Unicode対応→search sessionの取消／結果送り／guard→named destinationと曖昧mapping→両hostの共通実描画で検索highlight／旧token→両explicit本番mountの原訳・左右・outline／link／戻る・保存失敗／scope切替の順。誤resource／誤page、旧async dispatch、guard迂回、正規化offset不整合、host別の検索・navigation authorityを公開前P1/P2 gateとする。別Astraの実装前独立確認はblocking P1/P2なし。null outlineは正常な0件として未取得／取得失敗と区別し、非対応外部actionは無移動で明示拒否する。Sol実装は未実施で、F18／F19の受入済みを表さない。F20のgeometry成立と入力排他を先に完了する。

## F20／R28の次実装仕様（2026-10-27・最新Astra設計／独立再レビュー）

共通PdfSurface置換の既存回帰20caseが複数runで成功した。専用geometry／asset spikeはまだ両engine受入前。この節を本文highlight作成・編集と入力所有の次実装の採用案とする。最新のユーザー指示により、コード実装はGPT 6.1 Terra、debug解析・検証実行・独立コードレビューはSol、設計・方向設定はAstraが担当する。以下のSol実装／Astraレビュー記録は役割変更前の履歴である。

### Coreと編集UI

既存AnnotationDraftStartへcreate-highlight／edit-highlightを追加し、payloadをStickyNote／TextHighlightのunionにする。新規seedはcanonical quote／range／quads／anchor／backgroundRevisionだけ。ID／createdAtはSessionで固定し、DOM・capture証拠・renderTokenをSessionや保存へ入れない。新規はPDF限定、paperの既存highlightは編集・削除できる。

変更可能fieldはtext／label／color／anchor／deleted。highlightのquote／range／quads／backgroundRevision、既存indexed rangeと作成時刻は完全保全する。highlightのcolor:nullは拒否し、stickyのnullは維持する。comment anchorの変更で本文quadを移動しない。fresh read、base／PageExpectation、private owner、draftId、mayCommit、既存pending／journal／Undoを再利用する。

フォームはquoteをreadonlyで表示し、位置変更を「コメント位置」と明記する。annotation-select時だけ実polygonのhit領域を有効化する。同一annotationの複数quadはIDで重複排除し、異なる注釈の重なりは候補を明示する。draft表示は既存CanonicalPageAnnotationsと元annotationのomitを組み合わせる。F37のsticky限定をunion化し、fresh read・exact全payload・背景・active面・raster readinessのguardを維持する。既存highlightの編集にtext bindingを要求しない。

### 採取からdraft入場まで

各面の現text binding／selection read口をConnectionのrefへ登録する。inactive面や旧mount cleanupがactive面の登録を消さない。現active paneの単一非collapsed Rangeを読み、owner／scope／実page／背景／resourceとcontactゼロを検証する。現bindingでcaptureし、同bindingへのadmission証拠とowner／PageExpectationを再確認して、awaitなしにprivate Ink facadeからcreate-highlightを開始する。seedへcanonical値だけを明示copyし、capture全体をspreadしない。拒否ではdraft／history／journal／batchを増やさない。

toolbar pointerdownで選択を失わせず、click／keyboard activation時に再照合する。draft成立後はcanonical geometryを固定し、resize／font redraw／再配置で再採取しない。保存時に古いDOM tokenの有効性を要求せず、現在のowner／draftId／元baseと背景等を確認する。

### 本文選択の置換は独立gateとする

nativeのselectstart／selectionchangeを待つだけの案は撤回した。現pointer hookの5px pan／無条件touchmove preventDefaultが先行するためである。本文上の一本指panを維持するため、既存usePdfPointerInputの同じcontact inventoryで、最初のpointerdownから選択候補を所有する。別owner map／writer／選択modeを増やさない。

| 状態 | 共通遷移 |
| --- | --- |
| 本文touch down | text-pendingとして予約 |
| 450ms前に始点から8 CSS px超 | pan確定、選択候補破棄、既存pan／swipeへ接続 |
| 450ms経過・移動8px以内 | 現実caretを再検証しtext-selecting |
| pending離指 | tap、選択解除のみ |
| selection／handleで二指 | 選択破棄、既存pinchへ |
| pinch後の残指 | drain、全離指までpan／swipe／作成なし |

これはOS長押し時刻の推測ではなく、アプリの共通操作仕様。deadlineとmoveを同じclock／最新位置で一度だけ判定し、pan確定後は同列を選択へ戻さない。pen中のtouchはpalmとして抑止し、pen＋touchをpinchへしない。

全面managed方式を採用し、touch-action:noneを事前固定する。canonical textLayerと子のuser-select:none／webkit指定・callout抑制は、mouse／pen・keyboard・コピー・引用・選択表示がすべて接続されるまで通常経路へ反映しない。mouseだけnativeを残す案は、CSS切替、mouse→touch handle、native Selectionとの二重管理が継続するため採用しない。geometry spikeとは別の入力置換受入を完了させる。

小さなuseCanonicalPdfTextSelectionが実Range／caret解決／client rect表示／44px程度の端点handleを持ち、gesture決定は既存pointer hookへ返す。caretPositionFromPoint、存在時だけcaretRangeFromPointを使い、現在の実Text node所属・UTF16 offsetを確認する。別page最近傍や文字数比で補完しない。Intl.Segmenterで操作境界を合わせ、geometry側でも独立検査する。長押しはword segmentまたは一grapheme。mouse左drag／読むmodeのpen先端dragはRange選択、barrel／eraserは選択しない。handleは役割をdown時に固定し、交差してもlogical anchor／focusを維持する。

引用用caret mapはhighlightの厳格geometry条件と分離する。水平item等に対応できない文字でも、本文選択・コピー・引用が成立すれば保持し、highlightだけ明示拒否する。window.Selectionを正本にせず、native handleを出すためのaddRangeもしない。readSelectionは現bindingとclone Rangeだけを一時的に返し、外へ長期保持させない。

### Focus・keyboard・コピー

同Readerのコピー／引用／highlight toolbarへTabやpointerで移る場合はRangeを保持し、実行時にactive／contactゼロ／現bindingと端点を再照合する。window.blur／pagehide／owner・scope・page・token失効で破棄する。PDF要素のblurだけで消さない。別Reader・入力欄・無関係な操作先ではPDF commandの対象から外し、input／textarea／contenteditable内のコピーを横取りしない。

本文をTab到達可能とし、ページ名・操作説明を付ける。Enterで最初の有効文字境界から操作を開始し、左右でgrapheme移動、Shift併用で延長、Home／Endで本文端へ移動する。Escapeで解除してfocusは残す。handleにも端点名とkeyboard操作を付ける。polite live regionで開始／解除と確定時の文字数・短い抜粋を通知し、drag全eventの読み上げを避ける。本文はaria-hiddenにしない。

選択用の別keydown実行listenerは付けない。既存useReaderInputのwindow bubble入口へReaderSelectionKeyPort.handleKeyを渡し、defaultPrevented／IME／ownsKey検査後、Reader shortcutより先に一度だけ呼ぶ。最新portはrefで参照する。結果はpass／handled／blocked。後二者はpreventDefaultしてreturnし、拒否後にReader page移動へ落とさない。capture側のzoom shortcutから重複実行しない。

選択開始後の本文／handleだけがArrow／Home／Endを所有する。contact中・旧binding・未対応modifierはblocked、PageUp／PageDownもblockedとする。未開始の本文ではEnterだけ開始し、通常矢印はReaderへ渡す。toolbarではRangeを保持するが選択key所有は解除し、button操作と従来Reader操作を維持する。Ctrl／Cmd+Cは通常copy eventへ通し、同Readerのcopy handlerと明示copy buttonが同じread／validationを使う。

### 所有分担と公開条件

- Terra: 現Core／managed／UI draftを引き継ぎ、正式GO後のコード実装・修正・統合を行う。geometry受入前は本体統合を公開しない。
- Debug／検証Sol: 実PDF spikeと実画面、型・unit・build等の重検査を統制し、根拠と有限修正案をTerraへ渡す。独立のwriterを追加しない。
- 独立Sol: 以後のコードレビューと再確認。実装者と分けて重大指摘が収束するまで確認する。
- Astra: 設計・方向設定。役割変更前の独立レビューではselectstart待ち、toolbar focus、keyboard開始経路、window二重配送の指摘を修正し、最終再確認は新P1/P2なし。

公開条件は実PDFgeometry受入・独立入力置換受入・既存引用回帰・draft保存接続の全成立。CSSだけ／作成buttonだけを先行公開しない。入力gateでは実pointerとwindow keyを使い、長押し／72px超の選択延長／handle／pinch残指／inactive面／pen／cancel／旧tuple、keyboardのみの開始→コピー／引用、toolbar focus、formコピー保全、一event一実行、Reader page／history不変を確認する。両本番mount・Chromium／WebKitとSafari／Pencil実機は分けて記録する。未実機確認を自動試験の成功で代用しない。

### 既存Reader contactとの接続（Astra追加source確認）

useReaderInputのlocal contactsはswipe認識ではなくwheel／keyboard／GestureEventの広域安全guard。paperのtouch swipeもDocumentPaperPaneから同usePdfPointerInputを使う。canonicalではpointer hookの既存contactPanesとpane接触IDをraw contactの正本とし、Readerへreadonly pointerContacts.hasContact()を渡してcontacts.size判定を統一する。Reader window captureはpointerInReader／activePane更新を維持し、canonicalの二重接触記録を止める。未切替のlegacy呼出しだけlocal fallbackを残し、M6で撤去する。

pointer hookの既存touchesをall-pointerへ拡張し、window captureのdown／up／cancelでInk／非active gateが伝播を止めた接触も観測する。raw inventory更新とgesture phase処理を分け、一eventを二回進めない。pan／swipe／selection／pinch／drainは同hookだけで判定し、managed選択hookはRange操作portとする。usePdfTouchOwnerはpinch中のredraw調停に限定し、文字選択がpinch ownerをclaimしない。別のowner map／全域storeを作らない。

window captureで先行記録すると、既存CanonicalAnnotationLayerのhasPdfPointerContactが自分のpointerdownも拾う。gesture開始だけはreadonly hasOtherPdfPointerContact(element, currentPointerId)へ変え、当該接触のみ除外する。同scopeの他paneや第二接点まで除外しない。highlight作成等は全接触ゼロを維持する。up／cancelは共通finishへ集約して二重終端を防ぐ。window blur／pagehide／unmount／失効時もcapture／inventory／phaseを整合して解放し、古いcleanupが新しい登録を消さない。既存付箋配置／移動の回帰を入力集約sliceに含める。

### Cross-pane接触の採用仕様（Astra方向設定、実装Terra・レビューSol）

同Readerの異なるpaneへ接触が跨ったら、PDF／paperの組合せとtouch／pen順にかかわらず、両側のtext-pending／timer／Range／handle／pan／swipe候補を取消し、そのReaderの全接触up／cancelまでdrainする。paneを跨ぐpinchを開始しない。第二接点が即座に離れても、先着側を途中から復活させない。適用済みscroll／zoomや保存済み内容を巻き戻さない。

先着接触がある状態でinactive paneへ第二接点が来てもactivateしない。無接触からの初回inactive操作は従来activateGateを優先してその列を消費する。同paneのpen-first palm抑止は維持するが、別paneへ例外を拡張しない。別Readerは独立。既存Ink所有者から別編集ownerや保存操作を開始せず、確定筆跡を変更しない。

既存scopeのraw接触正本と各gesture phaseで表し、新registry／store／authorityを作らない。PDF/PDF・PDF/paper・paper/paperの両順、成立済み選択、即離指、inactive面、同pane palm、別Readerを検証し、先着timer発火・誤activate／ページ送りがなく、全終端後の次gestureが正常であることを確認する。blur／pagehide／owner失効のcleanupではcapture／接触記録／候補を一緒に解放する。

### Ink pen所有の保護（cross-pane仕様の限定）

上段の両側取消は「読む」のselection／pan／swipeに限定する。既存Inkがpen gestureをadmit済みなら、そのownerと未確定strokeを維持し、同Readerの後着touch／penは副接触として新gesture／activateを拒否する。pointerTypeだけで既存Ink所有を推測しない。cross-pane接触を理由にbeforeCommand／commit／cancelActive／cancelPressを呼ばず、途中の自動確定・破棄を避ける。

主penの通常upは従来の完了を一度だけ実行し、残る副接触は全終端までdrainしてpanやInkへ昇格させない。読むtouchが先行した場合、penのInk割込みは開始せず読む候補を取消してdrainする。読むpen選択は上段cross-pane取消に従う。複数Inkは既存唯一owner admissionで後着拒否。真のpointercancel／blur／scope失効／unmountには既存Ink終端契約を適用し、cross-pane接触自体をowner失効原因にしない。

手書き中の別pane接触でstrokeが欠落・確定しないこと、通常up一回、残副接触の新操作拒否、touch先行のInk割込み拒否、第二pen拒否、真のcancel後の旧callback拒否を実入力で検証する。実装上必要なreadonly所有確認portは既存Ink状態から得て、新しいwriter／registryを追加しない。

### F20統合と受入の順序（Astra方向設定、2026-10-27追記）

実PDF geometry／resource／既存引用とF20実入力／保存が同じ最終candidateで成立することは、受入・通常公開のgateとして維持する。未実行draftの正式統合まで全成功に直列依存させず、実行中sourceのfreezeと原本checkpointを条件に、Terraが未公開staged candidateを統合し、Solが型・関連unit・保存・入力接続を先に確認できるようにする。

managed CSSとpointer／keyboard／copy入口、overlay、作成操作は一組の明示有効化に閉じる。既定legacyと非有効化経路を維持し、shared hookの無条件副作用を隔離できなければ統合前に報告する。r8 PdfSurfaceを土台としてCore→managed→UI→integrationを三者適用し、旧r7 mirrorを上書きしない。

反復は一仮説・最小の計測／修正・focused実験・判定の一巡で行う。共通の初期化失敗がある間は同じfull6を反復しない。app契約違反、harnessの対象／task差、起動段階の失敗を分け、製品操作へ未到達ならその機能の成功にも失敗にも読み替えない。geometry失敗が他suiteの環境を壊さなければ、同sourceの独立resource／引用検証まで停止する必要はない。別runの成功を単一full成功へ合算しない。

### 旧入力の隔離とM6撤去（Astra追加方向設定）

managed pointerは旧touch状態機械を置換するため、optional text portやlistenerのboolだけでlegacyを維持しない。旧r8入力hookを一時legacy専用として保全し、canonicalはmanaged版へ接続する。scope／getPdfPointerOwner／claim・releaseとusePdfTouchOwnerは一つの既存基盤を共有する。別owner storeを作らない。

方式はReader mount単位の安定した明示bundleで選び、PDF／paper／inactiveの全paneを同じinventoryとguardへ接続する。textSelectionの欠如は選択機能がないことだけを表す。方式はmount中に変えず、切替は既存guardとcleanupを経たReader remountとする。一paneで両hookを動かさず、条件付きhook呼出しを避ける。

legacyではmanaged raw capture／drain／CSS／keyboard介入を動かさず、canonical guardは旧contact queryを読まない。M6で旧hook／旧inventory／旧Reader fallback／旧caller／互換reexportをまとめて撤去する。恒久的なhost別入力実装を増やす案ではない。

## 参照slice後の直近三工程（2026-10-27・Astra方向設定）

現在の固定参照candidateの修正・Sol再レビュー・統合・REF検証を優先する。pinの範囲は参照設計追補のまま増やさない。標準1,382成功／benchmark 1 skip・両build・境界45成功は、そのsourceの証拠であり、outputのみの参照candidateや既定切替の証拠ではない。既定legacy、67要件のaccepted 0／partial 46／unverified 21を維持する。以下は文書に基づく方向設定であり、新しいsourceレビュー・runtime検証ではない。

| 順序 | 次の実装単位 | 有限の出口 |
| --- | --- | --- |
| 1 | **永続active datasetから通常host起動を共通compositionへ接続する。** 既存control／repositoryを使い、canonical化済みdatasetをPC/Webそれぞれの実bootstrapでaccount・library・dataset・auth generationへ束縛する。試験からbindingを直接注入しない起動経路を作る。未変換legacyは従来起動を保ち、不整合markerで空canonicalを新規作成したりlegacyへ暗黙fallbackしたりしない。新しいruntime selector/storeは作らない | 隔離canonical datasetで両hostの通常entry→一覧→PDF/paper/Markdown→編集→再起動→同ID復元、scope/logoutの保留と再入、marker不整合拒否を確認。R29のgraphと実行traceを同sourceで採取。これは既存全データの変換・既定切替ではない |
| 2 | **F18/F19のPDF検索・目次・linkを両hostへ縦接続する。** 上の採用済み方向案を使い、共通本文index／検索状態と既存Reader navigationに限定する。resource/page/mapping identity、Unicode offset、取消、temporary hit、named destination、戻るを一つの経路へ通す | 原訳・同page別anchor・遅延旧結果・guard拒否・outlineなし／失敗・内部／許可外部linkを両mount/engineで確認。annotation／Undoを検索で増やさず、host別navigation authorityを残さない |
| 3 | **F21/F22の全注釈snapshotをcapture/exportへ通す。** 既存共通snapshot/workerとappendを拡張し、全page・全annotation、確定済み未耐久／未送信内容、font/resource、原訳対応、lock／非表示の明示方針を開始時に固定する。表示中DOMや保存済みinkだけから出力しない | 混在PDF/paperと非表示pageを含む固定snapshotで、並行編集による混在なし・文字／付箋／highlight／図形包含・不足resource/fontで成功しないこと、clip／clipboard拒否download／note出力を両hostで確認。R14/R17を関連付ける |

第一工程はhost起動identity/storage境界を閉じる工程であり、機能欠落を無視したdefault flipではない。全体既定切替には、既存計画どおり全writer／job／tab／参加端末の停止確認、全領域raw backup、旧Web ledger/pendingとPC内容の意味上の一回変換、resource／本文／geometry／mapping／履歴／pending照合、公開とactive pointerの中断再開・rollbackが必要である。新旧二重書込みでは補わない。

M4/M5は既実装部分を再実装せず、通常entryから未到達のpage/混在Undo、Markdown template・画像/lightbox・競合、全tab/panel/focus/open/reveal、preferences復元、Library全操作・大規模表示等を元のF行に沿って閉じる。F18/F19とF21/F22は機能coverageの不足、起動bindingと全領域変換はデータ切替の不足として別々に追跡し、どちらかだけでM6へ完了を付けない。旧writer／入力hook／fallback撤去は、その全callerの共通移行と起動切替を確認した責務ごとに行い、残るlegacy利用者を壊さない。

Terraがコード実装、Solがdebug・検証と独立レビュー、Astraが必要な設計判断、Rootが統合と工程順を管理する。実機待ちだけで上記実装や自動検証を停止しない。Chromium/WebKitの有限gateとSafari/iPad/Pencil実機matrixは別記録し、未実機を成功扱いせず、全67要件／M6の完了条件も縮めない。各sliceは同一candidateの該当検査が成立してから次へ接続し、無関係の全suite反復を出口にしない。

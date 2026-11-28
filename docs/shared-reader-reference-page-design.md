# 同文書の参照page固定・解除：共通Reader設計追補

更新日: 2026-10-27

状態: 採用する設計追補。Astraが方向設定・設計把握として作成。実装、コードレビュー、型検査、試験は未実施。実装はTerra、設計レビューと実装レビュー・検証はSolが担当する。本書の記述だけでF20/R28やF23/F27をacceptedにしない。

改訂r2: Sol二観点の初回設計レビューを反映。Reader側P2三件（viewport証拠不足、接触leaseと描画世代の混同、Safari gesture配送先の変動）とread-model側補足を下記仕様へ反映した。指摘解消の独立再確認は未実施。対応表は第11節。

## 1. 必要性と既存計画との関係

[共通化計画](shared-app-plan.md)のM4/F23はPDF/paper混在ノート、M5/F27は中央/右側への単一editor配置を対象にする。[設計書](shared-app-design.md)の参照viewは読取専用で、別編集ownerを持たない。[次工程設計](shared-app-next-steps-astra.md)のcross-pane仕様は同ReaderのPDF/PDF、PDF/paper、paper/paperを同じcontact規則で扱う。今回の小さな先行sliceは、この三つを実production compositionで接続し、R28/F20の入力所有を合法なデータと通常UIで検証するために必要である。全Workspace/store統合を前倒しするものではない。

設計把握時点のgapは次のとおり。

- `editModel.assertSnapshot`はtranslation poolのpageとmapping元にPDF背景を要求する。翻訳poolへpaperを投入するfixtureは不正。validatorを緩めない。
- `DocumentWorkspace`の原訳splitはoriginal/translatedのみ。mixed-background notebookを投入しても、それだけでは異なる二pageを並べられない。
- 現referenceは`DocumentLibraryView`のshallow cloneで、pane/編集可否だけを変更しpage/assetは現在面を借りる。`useDocumentReadingPlace`もmainとreferenceのpage、zoom anchor、復元を結び付けている。
- `ReaderSession`に独立した参照対象の指定がない。別Readerを同じrootだと偽るfixtureやtest専用writerでは、productionの不足は解消しない。

従って、canvas selectorの多重一致はfixture修正、同Reader PDF/paperを構成できないことは製品の配置責務不足として分ける。本書は後者を埋める。「現在のpageを参照に固定する」という具体的操作は、この追補で採用する。

## 2. UXと配置

参照は同じDocumentの一つの実pageを読み続ける表示で、編集面は従来の原文/訳文・page移動を続ける。pinはpageと背景の固定であり、文書の履歴版全体を凍結する機能ではない。

| 状態/操作 | 採用する動作 |
| --- | --- |
| 未固定、editorがcenter | toolbarの「このページを参照に固定」で現active面の実pageを固定し、editorをrightへ移す。一つのguard付き状態更新として成立させる |
| 未固定、editorがright | 同じボタンで現pageを固定。editorの位置はそのまま |
| 固定中 | 「参照固定中：原文/訳文・page名」を表示。「固定を解除」と「現在のページに置き換える」を別操作として用意する |
| 固定解除 | targetと参照位置を破棄。rightでは従来どおり現在面の読取専用参照を表示するが、後述の明示read modelで構築する。center/rightを勝手に移動しない |
| centerへ配置変更 | referenceをunmountし、pinと最後の参照位置は同Reader session内に保持。toolbarに固定状態を残す |
| rightへ戻す | pinがあれば同じ参照対象・位置を再表示。なければ現在面を追従表示する |
| 同じ対象への「置き換える」 | 有効なtargetが同一ならunchanged。position/zoomをリセットしない |
| 参照不可 | 固定対象を表示できない理由と「固定を解除」「現在のページに置き換える」を表示。現在pageや先頭pageへ代用しない |

初回pinは切替後のpane寸法からfit-pageを測定し、先頭へ着地する。mainの倍率・scroll値を初期値としてコピーしない。解除してfollow表示へ戻るときもfit-page/先頭から開始する。解除にmain移動やUndo項目は発生しない。

toolbarのpin/解除/置換はbuttonとしてkeyboard/ATでも操作可能にする。接触中や入力保全guardで拒否される場合は理由を提示し、自動確定・保存再試行・操作の予約再実行をしない。現在面が未取得/曖昧/削除済みなら新規pinを開始できない。

## 3. 対象とread model

### 3.1 固定対象

scopeとdocumentIdは既存ReaderSessionが所有する。固定対象はそのscope/documentのactiveな実pageから取得する。候補はmainのoriginal/translatedで現在解決済みのpageだけであり、任意ID入力UIは追加しない。

targetは少なくとも`pool: original | translated`、実`pageId`、`backgroundRevision`、`lifecycleVersion`を固定する。背景identityの検査には背景kind、自然寸法、PDFならresourceId/sourceRevision/physical pageも含める。現Page由来の検証済み情報を使い、ordinal、タイトル一致、原訳の逆推定で補完しない。translatedをpinした後は実translated pageを保持し、mapping変更で別訳文へ追従しない。

通常注釈の保存/remote更新は同じ背景・lifecycleの現pageへ反映する。pinはannotationVersionやDAG headを永久固定しない。削除/背景変更でtargetが不一致になった場合はunavailableを保持し、ユーザーの置換/解除まで自動的に新しい背景へ採用し直さない。

### 3.2 resolveと失効

referenceは既存DocumentEditSessionとReaderSessionが現在の表示へ採用した同じ文書read modelから解決する。本書の「受理/accepted」は耐久保存済みだけを意味しない。既存Reader.modelにはlocal annotationのoptimistic/pending投影も採用されるため、その既存表示契約を維持し、参照だけrepositoryの耐久版へ戻さない。保存済みとは既存の保存状態表示で区別する。

独立repository polling、別checkout、参照専用DocumentEditSession、remote candidate保存storeを作らない。現Session/Replication snapshotから未採用remote candidateの全内容を得られると仮定しない。remote到着/同期busyだけでは失効を断定せず、Readerが保持する同じ現表示モデルをreferenceも維持する。referenceだけ新しい版を先採用しない。

| 変化 | referenceの動作 |
| --- | --- |
| 注釈だけの現表示モデル更新（local optimistic/pendingを含む） | 同じtargetで現注釈を表示。本文resourceを無意味に再取得せず、接触lease/raw contact/drainを保つ |
| remote候補到着、mainが未保存等で採用保留 | 現Reader表示モデルを維持。候補内容を検証したと称さない。未保存/入力active/replication busyだけでreference DOMを消したりpinchやInk保護を解除したりしない。新操作は既存guardで拒否する |
| head/checkoutが実際に表示モデルへ採用 | read-model依存callbackの世代を失効し、現モデルで同じtargetを再照合。成立すれば現版表示、不一致ならunavailable。同じtarget/pane所有の注釈変更だけならraw接触は失効しない |
| 現表示モデルでのpage削除、または既存Library/Document lifecycleで確定的に観測した削除 | unavailable。deletedPagesや別の生存pageから代用しない |
| 背景版/lifecycle/自然寸法/resource/physical pageの不一致 | unavailable。旧asset、overlay、viewport、pointer leaseを新対象へ使わない |
| mapping更新 | pinは同じ実pageを維持できる場合だけ継続。followはmainが受理したmappingを使う。両者を混同しない |
| pin/置換/解除、対象変更、scope切替、unmount | 対応世代を失効。遅延resource/font/metrics/scroll callbackが次の参照状態を変更できない |

unavailableへの遷移は観測できる事実（現モデルのtarget不一致、既存lifecycleの削除/scope失効、対応asset/proofの失敗等）による。未採用remoteの内容が不明という理由だけでは発火させない。背景不一致/削除によるunavailableを別pageで回復させない。pinを保持したまま元pageが同一lifecycle/背景で再び有効と証明できる場合と、復元操作で新lifecycleになった場合を区別する。いずれも拒否されたユーザー操作は自動再実行しない。

### 3.3 PDF/paper描画

Connectionがreference専用のPageとPDF assetを組み立てる。PDFは既存`useDocumentPdfAsset`、resource/Document/Page proof、唯一の`PdfSurface`へ通し、paperは`DocumentPaperPane`/`CanonicalPaperBackground`へ通す。referenceのためのrenderer、PDF loader、geometry式は作らない。

resource bytes共有/キャッシュは既存契約の範囲で可。ただしDOM、draw、font readiness、描画token、metrics、viewport、pointer lifetimeは各paneの実表示に属する。同一PDF pageをmainとreferenceで表示しても、幅/DPR/描画世代の異なるtokenを共有しない。参照のreadinessをmainの`data-rendered`やready値で代用しない。

referenceのresource error/retry attemptはreference asset instanceへ結ぶ。参照の「再試行」がmainのresourceAttemptや保存retryを呼んだり、main asset/errorを上書きしたりしてはならない。main側のretryも参照を暗黙再起動しない。同じresourceの実障害が両paneへそれぞれ報告されることと、片側のerror stateをコピーすることを区別する。再試行中の旧callbackはasset attemptで拒否し、参照失敗の表示は参照欄へ限定する。

### 3.4 世代と接触leaseを分離する

以下は既存lifecycle内の識別責務であり、新しいowner/storeを作るものではない。一つのgenerationを全用途へ渡さない。

| 識別子 | 変更する境界 | その変更で消してはいけないもの |
| --- | --- | --- |
| reference targetGeneration | pin/置換/解除で対象モードを切替、実target失効、scope/Document切替。followの実target変更も含む | 同じtargetのzoom/resize/font/注釈更新では増やさない |
| paneInstance / pointerLease | 当該paneのmount/owner、scope、実targetが変化・失効した場合 | 同targetのpreview→sharp、font pending→ready、注釈head更新ではraw contact/phase/drainを消さない |
| readModelGeneration | 現表示モデルの更新/checkoutに依存する非同期結果の失効 | 同target/pane所有が保たれるなら接触leaseを変えない |
| layoutMeasurementGeneration | 寸法/zoom/DPR等の現在のlayout要求と、そこから計算したfit測定を区別 | paneが同じなら接触leaseを変えない |
| asset attempt / draw・settled・font ticket | 既存rendererの取得、draw、font cycleに従う | readinessの一時falseだけでpaneをunmountし、接触/drainをclearしない |

known target失効は旧callbackを拒否し、読むgestureを取消す。ただし同Readerの別paneでadmit済みのInkを巻き込んでcommit/cancelしない。残る物理接触を全終端までdrainする既存契約を維持し、当該paneの失効によって別paneのcontactまで消さない。真のup/cancel/blur/pagehide/unmount cleanupは各既存契約で処理する。

## 4. authorityと最小API

以下は責務を示す提案型。実装名は既存命名に合わせてよいが、状態とwriterを増やす方向に拡張しない。

```ts
type ReaderReferenceTarget = {
  pool: 'original' | 'translated';
  pageId: string;
  backgroundRevision: string;
  lifecycleVersion: string;
  widthPt: number;
  heightPt: number;
  background: Page['background']; // 検証済み背景identityのimmutable copy。注釈snapshotは含めない
};
type ReaderReferenceState = {
  mode: 'follow-active' | 'pinned';
  target: ReaderReferenceTarget | null; // followは現在のmainから導出
  targetGeneration: number; // draw/font/layout/readModelの世代とは別
  zoom: ReaderZoom;
  place: ReaderPlace | null; // referenceだけの一か所。main.positionsと別
  landingId: number;
};
type ReferenceResolution =
  | { status: 'ready'; page: Page; target: ReaderReferenceTarget }
  | { status: 'unavailable'; reason: string; target: ReaderReferenceTarget | null };
type ReferenceCommandExpectation = {
  targetGeneration: number;
  target: ReaderReferenceTarget;
  paneInstance: object;
  pointerLease: object;
};
type ReferenceViewportReport = {
  expected: ReferenceCommandExpectation;
  layoutMeasurementGeneration: number;
  paneWidth: number; // 実際にfitを計算したときのclientWidth
  paneHeight: number; // 同clientHeight
  requestedZoom: ReaderZoom;
  dpr: number;
  metrics: ReaderViewport; // 実fitWidth / fitPageWidth / drawnWidth
};
```

ReaderSessionへの最小追加は以下とする。

- `pinCurrentReference(expected)`：呼出し時の現active実pageとexpected tupleが一致する場合だけpin。必要ならplacement=rightも同一更新に含める。既存guardを再確認する。mainのpage/history/landingは変えない。
- `clearReference()`：follow-activeへ戻す。pin解除はview状態のみ。
- `resolveReference()`：現Reader表示モデルから上記Resolutionを返す。未採用remote候補の照合は要求しない。既知のlifecycle失効だけは既存Connection境界から反映する。
- `setReferenceZoom(expected, zoom)`：参照専用zoomを更新。expectedのtargetGeneration/target/paneInstance/pointerLeaseを照合し、旧gesture/旧paneからの更新を拒否する。引数省略で最新対象へ解釈する入口を作らない。
- `setReferenceViewport(report: ReferenceViewportReport)`：Connection/view hookが現DOMと現layout要求を照合したreportだけをReaderSessionへ渡す。ReaderSessionも現在のtarget/登録済みpane/layout要求に一致する値だけ採用する。旧`reportReferenceViewport(): void`は撤去する。
- `rememberReference(expected, place)`：参照の一か所だけを更新。復元/scroll報告には必要なlayout/read-model世代もview hookで検証し、旧target/旧paneからの報告を拒否する。
- 既存`reconcileDocument`の受理境界でreferenceも再照合する。参考表示だけ別headを読む入口を設けない。

ReaderSessionはreferenceのview状態を既存subscribe/getSnapshot経由で公開する。Connectionはscope/registry active、未保存guard、raw contact、描画tupleを確認してこれらを呼ぶ。Connection内に第二のpin state正本を置かない。

上記targetの背景copyはpin時の期待identityであり、描画するPageの代用品ではない。毎回現read modelと照合してからrender用Pageを得る。既知のtarget失効によるunavailable時は旧canonical surfaceを現対象として操作可能なまま残さず、理由を示すplaceholderへ置き換える。通常のfont/draw pendingや未保存guard拒否をこのtarget失効と同一視しない。resource retry/描画準備中は同じpane shellを保ち、非ready内容への新規操作を止める。pane破棄が不可避の場合は明示的なpane所有失効としてcleanup/drainを検証する。

`DocumentLibraryView`には`reference`とpin/解除/置換操作を追加する。referenceのrender契約は独立したreadonly surface型とし、Page、asset、paneRef、scopeRef、reference用zoom/metrics/scroll、inputBundle、pointer lifetime、statusを明示する。editable=false、Ink owns=falseを確実にする。edit/create/capture/append/Undo等のwriter callbackを丸ごとコピーした`DocumentLibraryView`を渡さない。

`CanonicalDocumentSurface`/`DocumentPaperPane`は既存共通描画entryとして維持し、必要なら編集surfaceとreadonly surfaceの判別unionへ引数を狭める。readonly variantは`InkOverlay`/編集hit/annotation formをmountしない。使わないwriterをダミー関数で大量に埋める契約にしない。

## 5. 位置、倍率、原訳同期との分離

referenceは固有のpane metrics、zoom、normalized ReadingPlace、restore pending、zoom anchorを持つ。同じpageを表示していても、mainの`positions[pageId]`と共有しない。保存先はReaderSession内のreference一か所でよく、無制限のpage別参照履歴を追加しない。

- mainのoriginal/translated同期は既存仕様のまま。referenceは同期グループに含めない。referenceを動かしてmain/companionのscrollやzoomが動いてはならない。
- `useDocumentReadingPlace`から旧referencePaneへのrestore/zoom anchor同時配布を撤去する。低レベルの`measureReaderPane`、`readingPlace`、`scrollForPlace`等は再利用し、reference用の小さなview hookでReaderSessionのreference APIへ接続する。
- fit下限はreference自身の有限正の`fitPageWidth/fitWidth`から算出し、既存zoom semanticsで上限4.0（400%）、下限以下はfit-pageへ戻す。mainの縦横比/幅/viewportを使わない。metrics未成立中はzoom操作を開始せず、表示を待つ。
- resize/center-right切替で参照の正規化位置を保持し、同じtargetと現pane/layout要求のmetricsが揃ってから復元する。targetGenerationが同じでも旧layout測定値は拒否する。
- 初回pin/異なるtargetへの置換/背景失効後の明示置換はfit-page・先頭。current mainのscrollやzoomをコピーしない。
- follow-activeでも明示reference read modelを使い、main targetの変化で参照をfit-page・先頭へ更新する。pinしていない従来の中央参照表示は残すが、mainと一緒にzoom/scrollする暗黙結合は本追補で廃止する。

viewport報告は「callbackが今呼ばれた」ことを現在の測定の証拠にしない。producerはfitWidth/fitPageWidth/drawnWidthを計算した測定時点で、pane instance、実clientWidth/clientHeight、対象tuple、requested zoom、DPR、layoutMeasurementGenerationを一組で捕捉する。古いmetricsへ配送時の新しい世代だけを貼り直してはならない。

consumerは受信時に(1)現ref.currentと同じ接続中pane、(2)現target/lease、(3)現client寸法、(4)現layout要求の世代・zoom・DPR、(5)有限正で同一計算に属する三metrics、を照合する。不一致なら下限/zoom/restore/readyを更新せず、現在の測定報告を待つ。寸法がA→B→Aへ戻った場合も旧A報告を世代で拒否する。layout要求が変わった時点で旧measurementの採用を停止し、ResizeObserver報告順だけに依存しない。drawの完成を必要とする復元は、加えて現draw token/settledの証拠を照合する。

## 6. 入力、focus、guard

### 6.1 同じReaderの一つのcontact境界

referenceは同じ`data-reader-root`と同一の安定したcanonical managed bundleに属する。別rootを追加しない。既存pointer hookのraw contact inventoryとcross-pane drainへ参加する。referenceのpointerLeaseはscope/実target/pane所有に結び、第3.4節のdraw/font/read-model世代から分離する。mainの編集owner leaseをそのまま借りない。第二writer/owner storeは作らない。

参照ではpan/scroll/pinchを許可するが、page swipeを提供しない。pinしたpageにしか作用しない。mainへのactivate/deactivate、暗黙のeditor移動、beforeCommand/finalize/commit/cancelは呼ばない。referenceのfocusは読取focusであり、activeSurfaceや編集ownerを変更しない。

本sliceではreferenceの本文選択/copy/quote/highlightを追加しない。mainの選択portへreferenceを登録せず、mainのtoolbar操作をreferenceでのfocusから誤発火させない。参照の注釈は表示だけ。native選択を新しい正本として追加しない。

### 6.2 window入力入口

既存`useReaderInput`の唯一入口で、実target/現在focusからpane role（primary/companion/reference）とそのcommand portを解決する最小変更を行う。DOM上の`.react-pdf__Page`有無だけで対象を推定しない。paperも正しいpaneであり、unavailable referenceからmainへfallbackしない。

reference上のwheel/Ctrl-wheel/Safari GestureEvent/zoom shortcutはreference用読取portへ、main toolbarの明示操作はmain portへ渡す。reference上の通常矢印/PageUp/Down/Home/Endは参照内scrollだけとし、端でmainのpage/historyへ落とさない。参照内のzoom toolbarも同じreference portを使う。別window listener、二重keyboard配送、新global active-pane storeを追加しない。

Tab/Shift+Tab、入力欄の編集/copy、IME、AT detail=0は既存規則を守る。referenceへfocusが移ったことだけでmainのannotation draftを確定/取消しない。

native Safari GestureEventは`gesturestart`で配送先role、target、targetGeneration、paneInstance、pointerLease、および開始zoomを固定する。`gesturechange`はその同じexpectationを毎回検証して`setReferenceZoom(expected, zoom)`へ渡す。現在focus/hover/activePane/最新portを読み直してmainや新しいpinへ転送しない。focusだけが変わっても、開始対象が有効なら同じ対象に留まる。置換/解除/target unavailable/pane所有失効の後は、その列のchangeを拒否し、gestureend/cancel/blur/pagehideまで再admitしない。ready/font cycleだけで配送先を変更しない。main側で始まった列もreferenceへ横流ししない。

gesture latchは既存useReaderInputのgesture状態に保持し、別window listenerやglobal storeにしない。start時にmetricsが未成立、入力guard拒否、別pointer gesture所有等で開始できない列は、その後readyになってもchangeから開始しない。pointer pinchとnative GestureEventを同じ列に二重適用しない既存normalizerの責務を維持する。native gesture中の状態変更は既存入力guardへ反映し、失効後のchangeでも他paneへfallbackしない。

### 6.3 操作ごとのguard

| 操作 | 条件/拒否時の保全 |
| --- | --- |
| pin/置換/解除（初回right配置含む） | initialized/現scope active/Document利用可、session.canNavigate、append等既存離脱guard、全raw contactゼロ、drainなし。同期に現tupleを再確認し一更新。拒否時はpin/placement/selection/history/journal不変 |
| mainの通常page/原訳移動 | 既存guardを維持。参照contact中もroot単位で拒否。pinを移動先へ追従させない |
| center/rightの明示配置変更 | 既存moveEditorの保存/annotation.canReposition契約を維持し、全contact/drain検査を追加。再配置可能なannotation draftはexact payload/ID/owner意味を保全。raw接触中にはfinalize/retryを呼ばない |
| referenceの新pan/pinch/wheel/key操作 | 現target/描画利用可、既存session/入力保全条件とroot contact規則を満たす。mainの未保存/結果不明/入力中は新操作を拒否し、読み操作のために保存を起動しない |
| admit済みreference gestureの継続 | 同じcontact/phase/leaseで継続。自分のcontactがあることを理由に毎moveを拒否しない。新規commandのcontactゼロ条件と区別する |
| admit済みmain Ink penへ参照側の接触 | 既存cross-pane契約どおり主Inkを維持、副接触をdrain。Inkの自動確定/取消し禁止、主upは一回 |
| 読む接触がpane間に跨る | 両側の読む候補を取消し、全離指までdrain。異pane pinch、途中復活、参照clickによるmain activation禁止 |
| scope/Document切替 | 既存未耐久/結果不明guardを先に適用。成立後はpinを破棄し旧callbackを失効。拒否された切替でpinだけ消さない |

初回touch downはwindow captureで自分のraw contactが先に登録される。読むgesture開始ではそのeventのpointerIdだけを除く既存other-contact検査/phase admissionを使い、toolbarの「全contactsゼロ」を適用して自己拒否しない。同pane二指目は既存pinch遷移、異pane二指目は既存drain判定へ通す。「自分を除く」を他pane/他pointerまで除外する口実にしない。toolbar/keyboardによるpin等は引き続き全contactsゼロを要求する。

viewport/scrollの報告はwriter commandではないが、lease/tupleを必ず検証する。受理済みgestureの終了や真のcancel/blur/pagehide cleanupはguardで妨げず、旧cleanupが新しい登録を消さない。

## 7. 永続化と非scope

pin、参照zoom、参照位置は**このReader session内だけのephemeral state**とする。reload/別Document/scope切替後はfollow-activeに戻る。別pageの固定と復元を耐久契約に追加すると、削除/背景変換/旧状態migrationまで広がるため本sliceでは行わない。画面には「この閲覧中の固定」であることが分かる説明を付ける。

既存SavedReaderState v1、文書batch、journal、Undo/Redo、同期payloadにreference fieldを入れない。既存のmain placement保存は維持するので、pinによってrightへ移動した後のreloadはright＋follow-activeになり得る。これを固定の復元と表示しない。`flush()`は既存の明示serializeを維持し、新runtime state全体のspread保存へ変えない。

非scope: 別Document参照、任意の複数pin、参照page独立history、左右のeditor二重化、参照からの編集/copy/引用/highlight、cross-doc navigation、pinの端末間同期、Workspace全体のstore移行。これらを未対応capabilityで元計画の既存機能を隠す理由にはしない。

## 8. 合法fixtureと実UI受入

fixtureは通常publication経路で、一つのnotebookのoriginal pagesへPDF page Aとpaper page B（可能なら異寸法のpaper Cも）を公開する。PDF resourceは実bytes/metadata/hashを先に耐久化する。translationを使わず、既存validatorを通す。testはpin state、Reader model、writerを直接差し替えない。

基本操作は両explicit production mountで、Libraryからnoteを開く→Aを表示→通常buttonでpin→editorがrightになったことを確認→通常page操作でBへ進む。左A/right Bの実page ID・background・同Reader root・bundleを観測してからtrusted入力を行う。逆組合せはBを固定してAへ移動する。単に異Readerを同じwrapperへ入れたものは不合格。

| ID | 受入内容 | 必須観測 |
| --- | --- | --- |
| REF01 | 初回pin/同target置換/異target置換/解除、center/right往復 | target/placementの一括成立、main page/history不変、guard拒否で副作用ゼロ |
| REF02 | A PDF固定→B paperへmain移動、逆方向、paper/paper | 実compositionの同Reader root、各実page/背景/tokenの一致。referenceにwriter/InkOverlayなし |
| REF03 | main/参照の異寸法・幅・DPR、fit→連続zoom→400%→fit、各scroll、同targetのresize旧報告/A→B→A | 操作paneだけ変化。実三metrics＋pane/寸法/layout世代一致、旧fitによるzoom/restoreなし、同page表示でも別状態 |
| REF04 | PDF/paperと逆、PDF/PDF、paper/paperで接触交差、初回touch自己登録 | 読む候補取消、異pane pinchなし、自己contactによる誤拒否なし、72px超移動でも誤page送りなし、全終端後に次gesture成功 |
| REF05 | main Ink pen→参照touch/pen、読む参照touch→main pen、真cancel | 主Ink保持/通常up一回、副接触drain、先行読むgestureへのInk割込なし、cancel後旧callback拒否 |
| REF06 | 参照focus/wheel/key/AT、main toolbar/フォーム/原訳split、Safari start後のfocus変更/置換/解除/unavailable | 参照は局所scroll/zoomのみ。gesture列の配送先固定、旧expectedでのzoom拒否、新pin/mainへの転送なし、keyboard一event一実行 |
| REF07 | 未保存文字/注釈draft、保存失敗、結果不明、接触中のpin/解除/配置/page移動 | 保存契約どおり拒否または既存canRepositionで保全。pin操作で自動commit/retryなし |
| REF08 | pinned page削除/背景変更/訳文差替え、remote head採用と保留、local optimistic annotation、checkout | 既知失効はunavailable/同target再照合。未採用remote/未保存だけでDOMを消さず、現Readerモデルと同じ表示。独立polling/別page fallbackなし |
| REF09 | scope/Document切替拒否と成立、unmount、pagehide、reload | 拒否時pin保全、成立時旧世代破棄、reloadでephemeral状態が復活しない、main保存形式不変 |
| REF10 | resource/font/描画遅延・失敗・retry、resize/remount、接触中preview→sharp/font cycle/注釈head更新 | reference自身のproof、retry/errorのmain混線なし。draw/read-model失効とraw leaseを分離しcontact/drainを保全、旧callbackが新pinへ届かない |
| REF11 | 原文/訳文をpin後にmain mapping/activeSurface/filterを変更 | pinは実page固定、mainの原訳同期/履歴と独立。paperを翻訳poolに入れない |
| REF12 | 旧follow参照と既存F20/highlight/引用/保存の回帰 | shallow clone撤去後も合法な表示、既存共通entry使用、独立sessionへの迂回なし |

SolはReader state/guardの意味あるunit、renderer/port統合、actual PC/Web UIの順に検証する。少なくとも基本経路・失効・keyboard/wheelはChromium/WebKit×両mountで記録する。trusted multi-touch/penは利用するprotocolの能力を明記し、未送信/非trusted eventを成功証拠にしない。Safari/Pencil実機は別欄に残す。未実機確認や未到達caseをskipして全体acceptedにしない。

## 9. 実装順とレビュー境界

1. Sol設計レビューを二観点（対象/guard/保存、描画/入力/位置）で行い、本書の採用仕様を確定する。現stageの型/実入力成功をこの新責務の証拠へ転用しない。
2. TerraがReaderSessionのephemeral state/target照合/guard付き操作を追加する。target/pane leaseとlayout/draw/read-model世代を分け、setReferenceZoomへexpectedを必須化する。SavedReaderStateとDocument保存契約は変更しない。Solが拒否・失効・pin/placement原子性を検証する。
3. Connectionが現Readerモデルからreadonly reference modelと独立したasset/error/retryを組み立てる。実測証拠付きviewport reportへ移行し旧void report、旧shallow clone、main-reference位置結合を同時に撤去する。既存rendererのpane shell/接触leaseをdraw/readiness変化だけで破棄しない。
4. 唯一のReader入力入口にpane role/portの解決とSafari gesturestart latchを接続する。初回自己raw登録を考慮し、referenceのscroll/zoom・root contact/drain・writer不在を確認する。original/translatedの既存同期は維持する。
5. pin/解除/置換の通常UIを両host共通entryへ接続し、合法publication fixtureでREF01〜REF12を実行する。実装途中のボタン/CSSだけを通常経路へ公開しない。
6. 関連型/unit/両build/境界とmodule graph/実行trace、既存F20・引用・保存の必要回帰をSolが確認する。独立レビューの重大指摘が収束してから、台帳へ実際の証拠と未達を記録する。

最終実装判断はRoot、コード編集はTerra、debug/検証/独立コードレビューはSol。Astraのこの設計把握はコードレビュー承認ではない。[引継ぎ第20節](shared-app-handover.md#20-最新担当と再開地点2026-10-27)の役割分担・source freeze/runtime所有を維持する。他の独立featureの作業をこのslice待ちで停止しない。

## 10. M6への移行TODO

- [ ] canonicalの旧reference shallow clone、main-reference共有restore/zoom処理を本sliceで撤去し、残存callerを確認する。
- [ ] 既定起動切替後、legacyの参照/配置/入力経路を新共通entryへ移し、二重listener・独立writer・旧fallbackを撤去する。
- [ ] 一時legacy pointer hook/旧inventory/互換reexportの既存M6撤去項目と合わせて確認する。新referenceのために恒久duplicateを追加しない。
- [ ] F23/F27/R28/F20とR29の台帳に、このsliceのsource・両mount実行証拠・実機未達を関連付ける。
- [ ] referenceのephemeral仕様とreload後follow-activeをユーザー向け操作説明へ反映する。永続pinを後日導入する場合は別契約として設計する。

上記TODOやmatrix未実行の間、PDF/paperの不足をfixture修正済みと報告せず、全67要件の完了・既定切替・M6完了も宣言しない。

## 11. r2設計レビュー対応表と残件

| 指摘 | r2の採用仕様 | 対応箇所/再確認 |
| --- | --- | --- |
| Reader P2-1: expected generationだけでは同target resizeの旧fitを区別できない | 三metricsを計算時のpane instance/実client寸法/zoom/DPR/layoutMeasurementGenerationと同時に捕捉。consumerで現DOM/現要求と照合し、旧void reportを撤去 | 第4・5節、REF03/10。同target A→B→Aと旧report後着をSolが再確認 |
| Reader P2-2: font/draw/head世代をcontact leaseへ流すと接触が消える | targetGeneration、pane/pointerLease、read-model、layout、asset/draw/fontの失効境界を分離。同target preview→sharp/font cycle/注釈更新ではraw contact/drainを維持 | 第3.4・6.1節、REF04/05/10。main Ink保護を含めSolが再確認 |
| Reader P2-3: Safari change時の再routingで別paneへ転送し得る | startでrole/target/targetGeneration/pane/lease/start zoomを固定。changeはexpected付きzoom、失効後は列の終端まで拒否。初回touchの自己raw登録とtoolbar guardを分離 | 第4・6.2・6.3節、REF04/06。focus変更と置換/解除/失効をSolが再確認 |
| Read-model補足: acceptedをdurableだけと読める | 既存Readerが採用するoptimistic/pendingを含む現表示モデルと定義。参照専用の耐久版読出しをしない | 第3.2節、REF07/08 |
| Read-model補足: 未採用remote candidateを現snapshotだけでは照合できない | 同Readerモデル維持、未採用remoteを先採用しない。観測可能な既知失効だけunavailable。未保存/入力activeだけでDOMを消さない | 第3.2節、REF08/10。新polling/storeなし |
| Read-model補足: resource retry/errorがmainへ混線し得る | reference asset instanceのerror/attempt/retryに限定。main resourceAttempt/保存retryと分離 | 第3.3節、REF10 |

設計上の選択は上表の方針で確定する。現時点で未解決なのは、r2に対するSol独立再レビューと、これから行うTerra実装/Sol検証であり、指摘解消済みとはまだ報告しない。第9節の順序で進める。合法mixed notebook、同文書readonly、狭いrender型、一つのDocumentEditSession、ephemeral pin、原訳scope、REF01〜12の対象範囲は維持する。

既存PDF/PDF cross-paneの実Chromium/PC/Web成功は別の先行証拠である。PDF/paperは本書作成時点で通常配置経路が未実装・未受入のまま。翻訳poolへのpaper投入や未到達caseのskipでは、この残件を消さない。

## 12. r2実装境界の補足：terminal swipe、入力readiness、復元意図

以下はAstraの設計方向の補足であり、候補実装のレビュー・検証済みを意味しない。第3.4・5・6節のauthorityを増やさず、既存hook/Reader型の境界を明確にする。

mainの通常commandはroot全raw contactゼロを要求する。一方、既存pointer hookの`finish`が自分のterminal contactを残したままsettle callbackから通知する、admit済みpage swipeには専用の同期continuation境界を設けてよい。汎用commandへ任意の「除外pointerId」を渡せるAPIにはしない。hookが既存contact object/ID、root/pane、pointer lease、admit済みswipe phase/ownerへ結び付けた非公開生成の証拠を渡し、そのcallback中だけ一回使用できるようにする。型brandだけでは不十分で、既存inventory/phaseに対するruntime検査とcallback終了時の失効が必要。callback局所のlive/consumed値は可だが、別のcontact registry/ownerは作らない。

専用continuationも、実mutationの直前に現owner/phase/lease、drainなし、自分以外のroot contactなし、および既存session/navigation guardを照合する。証拠は`finally`で通常終端cleanupに先立って失効させる。非同期処理やcallback外への保持には使えない。自分のraw contactを先に削除して通常guardを通すこと、toolbar/keyboardへこの例外を開くことは禁止する。正常up/cancel cleanupはcommandの成否にかかわらず既存契約どおり完了する。

referenceのcurrent metricsはgeometry証拠であり、draw/font readinessの代用ではない。新pointer/native gesture/wheel/key操作は現target/pane/layoutと当該pane自身の現settled draw/font proofを確認して開始する。admit済みpointer/native列は開始時の証拠をlease/target/phaseへ結び、以後はその継続条件と既存入力保全guardを検査する。自分のzoomによる再描画/font cycleで開始時draw tokenが旧くなっても、それだけで列を取消さない。計算に必要なgeometryは現要求に適合した有限値を用い、真のtarget/pane/owner失効は既存cancel/drainへ通す。

reference復元はmeasurement到着やpreview→sharpを理由に毎回起動しない。初回landing、明示zoom anchor、remount、resizeの意図から、target/pane/layoutへ結んだ一つのpending復元を作り、対応する現metricsと必要なsettled draw proofで一回消費する。既存`ReaderZoom`、zoom commandの`anchor`、normalized `ReadingPlace`と共通変換helperを使う。明示zoom/pinchのanchorは以前の保存placeより優先し、連続zoomでは最新の意図が旧pendingを置き換える。sharp完了でgesture前のplaceを再適用しない。resize/remount用placeは旧geometryが失われる前に捕捉する。live zoomのanchor反映は既存geometry経路を用い、最終drawは最新意図だけをsettleする。新しいgeneric busや位置正本は追加しない。

Solの局所確認対象は、通常main swipeの一回成立と二接触/drain/旧proof/再使用拒否、current metricsのみ・font/draw pendingでの新規入力拒否、admit済みpointer/nativeの自己redraw継続、off-center zoom/pinch後sharpでanchorが跳ねないこと、およびresize/remountの一回復元とする。

# PC・Web共通化 引継ぎ書

**最新の作業（11月9日 9:06、B5 install）:** **pin161版の診断版をinstall済み・readback確認済み。実GUIでの編集・Undo・再起動は未確認（`guiEditVerified: false`、受入台帳は不変）。** 更新helperがexit 0（journalは`installed`で終了、`error`なし）。独立readbackで、1,055ファイル（main `1b31fca4…ca48f`、Sidecar 1,053件はbuild出力とbyte一致）、旧pin151版を`install-before-s161-r1`に保持（byte・更新時刻とも不変）、診断版データ・marker不変、レジストリとスタートメニュー・デスクトップのショートカットが新exeを指す、通常版（キー・ショートカット・保存先）は不変（通常版は前後とも未起動）、WiX痕跡なし、実ユーザー領域の前後比較は変更0。インストール済みSidecarをGUIなしで隔離rootで起動確認（smoke 9/9・frozen probe全項目成功）。[配布物の記録](../output/s161-p1/README.md)

**最新の作業（11月9日、B5）:** [pin161](../checkpoints/shared-app/2026-10-30-p4-workspace/frozen-inputs-provider-composition-r161.json)（2,200入力、bundle `2b5859f6…1e04`）から診断版を**build済み・未install**。Sidecar（1,053ファイル）・frontend（400ファイル）・Tauri/NSIS・強制終了しないinstaller（SHA256 `31bd77d4…b362`、67,962,434 bytes、配置予定1,055ファイル）と、未実行の更新helperを `output/s161-p1/`・`output/s161-nk1/` に作成した。前後の`pin.py check`は不変、隔離のSidecar単体smoke 9項目と、frozen exeに対する追加probe（`/api/edits/`のno-store、準備→preview非空、切断後の復帰、正常終了）が成功。installerは実行せず、展開して全payloadのbyte一致とmainの補正（UNK→NSS）を読戻した。実ユーザー領域の前後比較は変更0、通常版・既存Diagnosticには触れていない。**インストール済みDiagnosticはpin151のまま。installは利用者の明示依頼待ち。実GUIの編集・Undo・再起動は未確認。受入台帳は不変。**[記録](../checkpoints/shared-app/2026-10-30-p4-workspace/IMPL-r153-b5.md)・[配布物の記録](../output/s161-p1/README.md)

**最新の作業（11月9日、B4）:** Python `tests/`直下のtranslation群9本を`tests/translation/`、pdf群8本を`tests/pdf/`へ移した（直下153→136本）。製品source・frontend・spec・受入台帳は変更せず、[pin156](../checkpoints/shared-app/2026-10-30-p4-workspace/frozen-inputs-provider-composition-r156.json)（SHA256 `f9facbdf…68e5`、2,200入力）のbundleはpin155と同一で、差分は削除17・追加17・変更0。書換えは5ファイルのpath式7か所と`docs/translation.md`の2か所だけで、逆置換のbyte一致は実行時assertと独立読戻しで確認した。全収集3,448件は前後で一致し、対象の個別結果・ディレクトリ単位・単独実行は前後で同一（translation 100成功＋1失敗、pdf 94成功＋skip19）、import edge 7,141件一致、Ruff成功、台帳の欠落evidenceは35件のまま。**translationの1失敗**（`test_translation_cleanup`の起動時cleanup）は移動前から同じ失敗だったが、のちに原因を特定してテストだけ修正した（古いテスト。起動cleanupは保存域にファイルがあれば意図的に何もしない設計で、B1・B3a・B4とは無関係。pin157、bundleはpin156と同一、[記録](../checkpoints/shared-app/2026-10-30-p4-workspace/IMPL-r153-b4-followup.md)）。**tests/全体のpytestは196ファイルを1つずつ実行して実測済み（3,883件中 3,835成功／20失敗／28skip。失敗は6ファイルの既存・環境依存・古いテストで、B1・B3a・B4・pin157起因ではない）。**`papeer/core/translation_plan.py`のdocstringの旧pathは次に`papeer/`を変えるときまで残す。インストール済みDiagnosticはpin151のまま（pin156は未build）。次はB5。[実施記録](../checkpoints/shared-app/2026-10-30-p4-workspace/IMPL-r153-b4.md)

**（前の作業）11月9日、B3a／B3b:** B3のheadless一巡で失敗した「画面の取消／クライアント切断がサーバーのworkerに届かない」不具合を、`sidecar/app.py`の`@app.middleware('http')`（BaseHTTPMiddleware）を素のASGI middleware（`CanonicalNoStore`、同じ位置・同じヘッダ規則）へ置換して修正した（[pin155](../checkpoints/shared-app/2026-10-30-p4-workspace/frozen-inputs-provider-composition-r155.json)、2,200入力、pin154との差分は3ファイル）。回帰テスト3本（構造・実stack・実uvicorn＋実socket、計4件）を追加し、旧実装へ戻すと全件失敗することを確認。旧新の全268route・277要求のstatus・headerが同一で、認可291・preview51・lifecycle125＋1・読取り144・終了復旧117＋1・API5・Ruff・Pyright・frontend型／lint・e2e24が成功（suiteごと、合算しない）。headless再一巡（run-r5・r6、合成IPC・Edge）は2回とも完全成功で、画面取消167／196ms、Node abort131／240ms、コピー途中の取消53／113msでworkerのcancelに届き、取消後の新規previewは2秒以内に受理、コピー途中の取消と`/shutdown`の後も`.analysis-*`は残らなかった。実ユーザー領域の前後比較（範囲拡大）は変更0。**未確認:** 実Native窓・実WebView2・OS強制終了・大きなLibraryでの取消遅延。EdgeにはB3同様に実USERPROFILE等を渡す制限がある。B3のr1〜r4（切断検出の失敗）は変更せず保持。受入台帳はaccepted0／partial47／unverified20のまま。[B3a記録](../checkpoints/shared-app/2026-10-30-p4-workspace/IMPL-r153-b3a.md)・[B3b記録](../checkpoints/shared-app/2026-10-30-p4-workspace/IMPL-r153-b3b.md)・[B3失敗の記録](../checkpoints/shared-app/2026-10-30-p4-workspace/IMPL-r153-b3.md)

**（以下は11月9日のpin153時点の記述）最新の作業（11月9日）:** 作業ソースを[pin153](../checkpoints/shared-app/2026-10-30-p4-workspace/frozen-inputs-provider-composition-r153.json)（2,197入力、152からの変更21path）として固定し、Notebookの読取り専用preview（API2本・終了待ち用のgate・Native画面）を接続した。限定的な検証（隔離環境のunit／統合／headlessの静的描画）まで: 読取り側144件、終了・復旧117件＋Windows対象外1件、preview47件、lifecycle125件＋1件、認可291件、frontend全unit 1,923件（成功1,922・skip1。専用runnerのフラグ付き）、型・lint・Ruff・Pyrightと両buildが成功（件数はsuiteごとで合算しない）。実Native画面・実WebView・OS強制終了後の残り・切断検出・画面ボタンの対話は未確認で、インストール済みはpin151のまま。`pnpm test`の既定実行は既存の`providerActivation.ts`の記法（Node 24で読込不可）で1ファイル読めない既存問題を残課題とする。レビュー中の検証でテスト外のprobeが実ユーザーの`%LOCALAPPDATA%\PapeerSync`へ小さなlock等3ファイルを作った（既存ファイルは不変、削除はしていない。削除の可否は利用者判断。今後のprobeは必ず隔離する）。受入台帳はaccepted0／partial47／unverified20のまま。[実行状況](../checkpoints/shared-app/2026-10-30-p4-workspace/RESTART-CURRENT.md)・[B2記録](../checkpoints/shared-app/2026-10-30-p4-workspace/IMPL-r153-b2.md)

**（以下は11月8日時点の記述）最新の作業（11月8日）:** インストール後の作業ソースを[pin152](../checkpoints/shared-app/2026-10-30-p4-workspace/frozen-inputs-provider-composition-r152.json)として固定し、復旧時の保存先照合、バックアップとNotebookの読取り上限、準備動作中の終了通知の待機を追加した。関連テストは読取り140件、終了・復旧117件成功／Windows対象外1件（suiteの重複あり）。Notebook previewのAPI・画面およびworkerとshutdownの制御は未接続。これらの変更はインストール済みpin151には含まれず、実Native画面や強制終了の検証も未完了。最新状態は[実行状況](../checkpoints/shared-app/2026-10-30-p4-workspace/RESTART-CURRENT.md)を優先する。

**最新の配布（11月8日）:** 利用者の依頼でpin151の「Papeer Shared Diagnostic」を更新install済み。配置1,055ファイル、旧版の保全、診断版データと登録・ショートカットを照合した。Sidecar単体の起動・保存・PDF・模擬翻訳・CLI・正常終了は成功。初回更新の形式不一致と復旧は履歴として保持。新版の実GUI編集・Undo・再起動は未確認。[配布記録](../output/s151-p1/README.md)

**最新の検証（11月8日）:** pin151で復旧時のフォルダー再試行とテストの参照・ルート列挙を修正。関連520件成功・Windows対象外skip１、APIスキーマ／型生成一致、lint成功、型検査エラー０。全24スイートの再検証を実行中。149/150の中断・失敗を上書きしない。ビルド・インストールと実画面確認は未完了。

**最新（11月8日）:** Sidecarの管理３ファイルとテスト４ファイルを責務別に移動し、参照更新とCLI検査の古い許可リスト修正を適用した。pin150・2,189入力の全収集と関連24スイートを実行中。前の149基準テストは中断・CLI検査失敗であり、成功扱いしない。整理後の回帰、API生成、ビルド・インストール、実画面確認は未完了。[実行状況](../checkpoints/shared-app/2026-10-30-p4-workspace/RESTART-CURRENT.md)を優先する。

**最新の進捗（11月8日）:** 作業ソース149・2,188入力。backend944成功・OS固有skip3・API5、frontend型／lint・全unit 1,904成功／既知skip1・両buildが成功し、入力と各400生成資材を照合済み。物理sourceの一巡はEdge終了待ち超過と、別runのsidecar応答待ち超過で失敗。空cacheの読み込み専用診断は12.156秒で終了し、対象process残存0・入力不変を確認したが、前回の原因は未確定。Sidecar構成整理は独立レビュー済み候補を保持。診断版141は設置済み。[現在の実行状態](../checkpoints/shared-app/2026-10-30-p4-workspace/RESTART-CURRENT.md)

更新: 2026-11-08（JST）。現在の実行状況と証拠は[RESTART-CURRENT](../checkpoints/shared-app/2026-10-30-p4-workspace/RESTART-CURRENT.md)、大分類・小分類のTODO正本は[計画書第3節](shared-app-plan.md#3-実行todo大分類小分類)で管理する。

**次の順序:** 149のserver準備を個別に観測し、物理sourceの復旧・中止一巡を再確認する。並行してSidecar責務別配置の同一ソース基準検査と限定的な適用手順を用意する。Windowsは解除済みだが画面操作ランタイムが接続失敗したため、復旧後に141の実操作を確認し、保全と再起動防止を監査して最新検証済みsourceの診断版をbuild・更新installする。TODO正本は[計画書第3節](shared-app-plan.md#3-実行todo大分類小分類)。

**以下のpin137以前の経過は履歴。各段落の「現在」「次」「承認待ち」は当時の記述であり、冒頭の作業149／設置141と計画書TODOを優先する。**

**現在地:** 作業ソースはpin137。後着Markdown枝の比較・再編集136の4件に続き、同期停止中の表示とSync操作抑止を7ソースへ反映した。型4系統・lint・全単体1,808成功／既知skip1、両engineの通常Web画面4件が成功し、backend bundleは配置整理135と同じ。別名のWindows診断版「Papeer Shared Diagnostic」はsealed pin124のままで、後続のジョブ終了修正126・自動受信127・退避解析132・配置整理135をまだ含まない。診断版の全1,035配置ファイル、通常版20,505ファイルと既存Shared Trialの保全、登録、ソース・証拠ZIPの2,194 memberは照合済み。OAuth設定1件の内容を除外しているため、完全な再構築用一式とは扱わない。[診断版の記録と起動先](../output/shared-app-builds/2026-11-03-b47-diagnostic/README.md)。元の単体検査の後片付け失敗・タイムアウトは残し、同じソースで必要なWindows操作を許可した成功とは区別する。通常54件の51成功・3失敗を追加ケースで置き換えない。最終B4.7と全67要件の受入は継続する。

**次のまとまり:** 診断版を通常起動し、実際のbackend保存先とWebViewプロファイルの分離を確認してから、編集・保存・Undo・完全終了後の再起動を実画面で確かめる。画面操作ツールが `Computer Use app approval timed out` を返したため、現在はユーザーのアプリ操作承認待ち。監査時点で診断版プロセス・新規プロファイルはなく、編集操作は未実施。承認待ちの間に位置変換群の整理はpin125で前倒し完了した。診断版は封緘済み124のソース・配置digestへ結び、live124を要求する旧封緘helperは再実行しない。残る失敗の修正、同期／offline、実データ移行、旧経路の撤去、全67要件の最終受入を続け、各段階に構成整理とbuild・installの節目を置く。

**構成整理:** Readerのページ送り・左右スクロール同期に続き、注釈・引用の位置変換2ソース・2テストを既存navigationへ移動し、4参照元を更新した。Reader直下は77→74→72ソース。pin125の前後で関連44件・境界51件が成功し、型4系統・lint、unit発見239／Web発見123、両entry依存edge、全2,121入力と逆変換を照合した。[整理の証拠](../checkpoints/shared-app/2026-10-30-p4-workspace/provider-composition-r1/reader-navigation-batch-review-20261103-r1/annotation-citation-r124-r1/root-independent-readback.json)。さらにpin131でPythonの旧データ関連テスト6本を`tests/legacy/`へ移し、同じ53件の前後成功・全収集3,174件の維持・原本と参照更新の逆変換を独立照合した。[再配置の独立照合](../checkpoints/shared-app/2026-10-30-p4-workspace/provider-composition-r1/legacy-tests-organization-r130-r1/independent-readback.json)。膨大なcheckpoint群もGitの通常表示から外し、薄いREADMEから現在のTODOへ誘導済み。再開索引も古い実行中表示を原文保全して一本化した。元の証拠は移動・削除していない。

**終了処理:** pin126で、最終通知中のジョブを終了済みと報告してしまう既存の待機処理を修正した。元125で失敗する3回帰を追加し、実rootのジョブ27件・backend504件／既知Windows skip1・API5件、Python型／lintが成功。変更はジョブownerと通常testの2ファイルで、frontend1,416入力は125と一致する。[修正と検証](../checkpoints/shared-app/2026-10-30-p4-workspace/provider-composition-r1/jobs-drain-fix-r125-r1/root-independent-readback.json)。実画面一巡後の次のfresh build・隔離更新に取り込む。別に試したNative移行coordinatorは、実inventory・writer排除・安全な起動経路が未接続で不採用とし、本体へ適用していない。

**自動受信:** pin127では、Nativeが開いている文書の3秒周期に頼り、資料未選択では初回以降に受信しない経路を修正した。既存のLibrary単位のownerで、進行中の処理と保留tailが終了してから5秒後に次を予約し、停止・認可失効・世代を保護する。通常Web UIからのfolder作成が、手動Sync／delivery／reloadも資料controllerも使わずNativeの一覧・SQLiteバッチ・実peerのdurable receiptへ届くことをChromium／WebKitで確認した。[追加2件と終了監査](../checkpoints/shared-app/2026-10-30-p4-workspace/provider-composition-r1/native-library-auto-receive-r126-r1/pair-r1/state.json)。実Google・設置版GUI・削除／利用不能／非アクティブ表示の残matrixは未完。次の配布と最終同一source検証にはこの変更と追加2件も含める。

**追加の状態検証:** pin129の6件は4成功・2失敗。現在Markdown削除／Chromium、PDF読込み失敗／Chromium、Markdown保存応答保留／両engineが成功した。応答保留ではNativeのfolder変更受信前後に、同じsession／editor・本文・保存中の離脱guardを観測し、応答解放後も同じ内容で完了した。連続観測の証拠とは区別する。残る2件はWebKitのNative初期PDF表示で操作前に停止し、非アクティブviewも未検証。pin130はE2Eの観測だけを変更し、実Suspense子のlazy状態と完了済みresource timingを読む限定起動2件が成功した。停止未再現のため製品修正とは扱わず、起動検査の反復を一区切りにしてP6.2bの隔離バックアップ解析へ進む。[状態matrix](../checkpoints/shared-app/2026-10-30-p4-workspace/provider-composition-r1/native-library-state-matrix-r127-r1/failed-run-r2-independent-readback.json)・[限定起動観測](../checkpoints/shared-app/2026-10-30-p4-workspace/provider-composition-r1/native-reader-lazy-discriminator-r129-r1/startup-r1/state.json)。最終B4.7は元の必須13結果・通常54件に加え、自動受信2件・状態matrix6件を同じ最終sourceで満たす。

**バックアップ解析の区切り:** 作業ソースはpin132。`core/migrations/`へ、既存のInputSet・退避plan／manifestに結び付くNotebook入力抽出を追加した。使い捨てコピー上でページとink／bookmarkの全該当行を対応付け、未知列・生成列・未知テーブルやWAL／SHM不足を拒否する。通常テスト67件が成功し、別の確認で実抽出結果から既存TypeScript変換まで接続した。backend504成功／既知skip1・API5・全Python型／lintも成功。frontend入力と成果物は以前の検証から変わっていない。既存の通常保存先や移行入口には接続しておらず、writer停止・全Libraryの変換・text／PDFの完全性・公開／切替は未完。[適用と実行の読戻し](../checkpoints/shared-app/2026-10-30-p4-workspace/provider-composition-r1/p6-notebook-backup-analysis-r130-r1/root-readback.json)。次のまとまりはP5.2cの編集中Markdownへの実peer更新で、P6は実ownerの停止・全入力の収集条件を続ける。

**peer競合の一巡:** 作業ソース133にはE2Eを1ファイルだけ追加し、型検査・project lintは成功。本体・bundleは132と同じ。新しい4件は3成功・1失敗で、Chromiumの両保留側とWebKitのNative保留側では、通常UIの別本文保存→下書き／元base保持→両枝の耐久保存→比較／採用→両hostの実peer receipt・収束を確認した。最後のWebKit／Web保留側は準備中のNative初期Markdown表示25秒で、本体操作前に停止した。内側lazyの実`DesktopMarkdownLibrary`は取得時点で解決済みだったが、停止原因は未確定。後続のlegacy保留画面をこの失敗原因と混同しない。元ログ・全ソース・成果物・残存0は独立照合済みで、全4件の成功にはしていない。[4件の読戻し](../checkpoints/shared-app/2026-10-30-p4-workspace/provider-composition-r1/markdown-peer-conflict-r132-r1/independent-readback.json)。最終B4.7にはこの4件も追加し、既存54件や追加2／6件を置き換えない。次はprovider一覧取得障害中の編集・outbox保持と復帰を進める。

**障害復旧と次の整理:** pin134で、選択したproviderの一覧取得503障害中に通常UIで編集し、端末の耐久保存・未送信保持・復旧後の同一batchと両hostの実peer receipt・本文・失敗表示の解除まで4件すべて成功した。完全offline／cold-cache unlockや133の競合失敗の解消とは扱わない。[4件の独立読戻し](../checkpoints/shared-app/2026-10-30-p4-workspace/provider-composition-r1/provider-list-outage-r133-r1/independent-readback.json)。その区切りでpin135に移行専用ソース5本を`core/migrations/`へ移し、Core直下92→87本、37内部参照と5文書リンクを更新。24原本の逆変換・静的依存graph・関連67件・全収集3,188件が一致し、backend504成功／既知skip1・API5・Python型／lint・E2E型／project lintも成功した。PyInstaller収集APIで7moduleを発見したが、新しい配布物はまだ作っていない。[整理の読戻し](../checkpoints/shared-app/2026-10-30-p4-workspace/provider-composition-r1/legacy-core-organization-r134-r1/root-readback.json)。最終B4.7は元の13結果・54件と、追加の自動受信2・状態6・peer競合4・障害復旧4を同じ最終sourceで確認する。

**後着枝の検証とoffline実装:** pin136の両engine×dirty側Native／Webで、比較から両方保持、選んだ枝をparentとする通常UI再編集、実際に届いた子版で古い比較の採用を無効化、再比較した現在headからの採用と両hostのpeer receiptまで全4件成功した。[独立読戻し](../checkpoints/shared-app/2026-10-30-p4-workspace/provider-composition-r1/markdown-late-branch-r135-r1/independent-readback.json)。133の初期表示失敗は解消扱いにしない。最終B4.7へこの4件も追加する。次は[offline解除の設計契約](shared-app-offline-unlock-design.md)に従い、Browser／Nativeの登録・解除・失効、通常UI、実編集・未送信保持・同本人による再送をまとめて進める。候補はcheckpoint内で実装中で、本体へ未採用。同期停止中の表示とSync操作の抑止も含む。

既存のShared Trialは以前のB4.6（pin39）のまま保持し、通常版Papeerも保護する。新しいDiagnosticは別製品として配置済み。実Google同意・最新Native実画面・実機確認・全67要件の完了は、個別の証拠がそろうまで未完のまま管理する。

以下は以前の引継ぎ詳細を保存したもの。各時点の「現在」「次」は履歴であり、現在のTODOより優先しない。冒頭の更新前原文も[履歴として保存](../checkpoints/shared-app/2026-10-30-p4-workspace/provider-composition-r1/handover-prefix-before-r104-root.md)した。

## 1. 最初に読むこと

- **元の計画全体は未完了。通常起動の共通経路はrootへ正式統合済み。** Web／Windows実Tauriで通常UIからノート作成・A/B保存・Undo(B)・完全再起動を確認し、保存／作成応答消失の回復と旧入力の起動保留を追加した。P2のローカル区切りは§17までで完了。残る全機能接続・同期・実データ移行・旧責務撤去・最終受入はP3〜P7で扱う。
- **P1初回正式統合の記録は`p1-root-integration-manifest-r3.json`の129path。** 追加69／変更60／削除0、当時のroot全1,939fileとbefore／after ZIPを独立照合。続く変更やP5をそのmanifestに含めない。
- **現在の作業元はroot。** `output/shared-app-integration`と旧T1/T2/T3／Desktop／Native treeは凍結した採用履歴・比較元。古い候補を再適用しない。P1整理直後のfrontend1,536成功／1 skip等は当時の検証であり、現在のP5検証とは別に保全する。
- 受入台帳は **67要件: accepted 0 / partial 47 / unverified 20**。実装や狭い試験の成功を、機能全体の最終受入へ昇格させていない。
- 当時の分担はTerra実装・Sol検証・Astra設計・Root統合だった。これは履歴であり、今後の担当・モデルは現在のユーザー指示を優先する。今回の調査はSol 6.1×2／Terra 6.1×1で実施した。
- 実ユーザーのLibrary・Driveは移行していない。試験は隔離DB・一時data root・合成資料を使用した。

以前の詳細な経緯は[旧引継ぎ記録](shared-app-handover-history-2026-10-27.md)へ全文保存した。旧記録内の「現在」「最新」「未検証」は各時点の記述であり、本書の現況より優先しない。

## 2. 作業ツリーと保存上の注意

| 項目 | 引継ぎ時点 |
| --- | --- |
| workspace | `<repo>` |
| branch | `feature/notes-foundation` |
| HEAD | `b54054a47a9450946b6ff82df602abc83ebac3a9` |
| 状態 | 大量の未コミット変更・未追跡ファイルあり。既存のユーザー差分を含む |
| 実装担当 | `gpt-6.1-terra` |
| review / 実行担当 | `gpt-6.1-sol` |
| 設計担当 | `gpt-6-astra` |

HEADやGit管理ファイルだけでは現在の実装を再現できない。**未追跡ファイルを含むworktreeと、Git管理外の `output/` を保全すること。** `reset`・`clean`・機械的な旧ファイル復元・未依頼のcommitや依存更新を行わない。

差分台帳のファイル名は歴史的に `output/shared-app-f20-staged-integration-changes.json` のまま。`after: null` は意図された削除・不在を表す。存在することを一律に要求しない。

| 10-27統合時点の識別子（現在hashではない） | SHA-256 |
| --- | --- |
| 144項目の統合差分台帳 | `acdaf6d30fc522b1fc25774a297c76e255055b43c2fef7aca536a7a97e06f5f3` |
| `frontend/src/runtime/sharedEntries.json` | `1d4228ce675f632cef42f75027022e1fbd723eca073e41a18178a7407aed46ec` |
| `tests/fixtures/canonical-bootstrap.json` | `90dcb0973191d98e41f83a7c22ec3b8e97001916bd2537933809b185ad47ac46` |
| `tests/fixtures/canonical-local-owner-grant.json` | `183686e8f4c44c6166ff7d0566556f40863afe7767b56ae056e3dd7945a34585` |

## 3. 正式統合した内容と検証範囲

`[x]`はその行に書いた範囲を実施済みという意味。通常起動・全機能受入の完了を意味しない。

- [x] 共通編集・保存・Libraryの縦接続を実装
  - [x] 安定ID、canonical snapshot/batch、因果履歴、journal、同ID再送、競合枝・resourceの基礎を実装
  - [x] 共通DocumentEditSession・Undo/Redo・toolbar・図形／文字／消去等の基本経路を新構成へ接続
  - [x] 共通Libraryの階層、タグ、添付、関連、書誌、削除回復、検索、注釈一覧・追記などを実装（範囲は台帳・旧記録参照）
  - [x] Markdownの編集session、autosave、失敗時draft保持、画像・引用の共通処理を接続
- [x] Reader・PDF共通処理を実装
  - [x] fit-page縮小下限、400%上限、入力所有、通常step先頭／PageUp等末尾、位置・履歴・原訳対応を実装
  - [x] 共通PDF描画・text readiness・managed本文選択・本文highlight CRUD・固定readonly参照を実装
  - [x] paperのtouch-action差、pinchと選択handle、terminal swipe、cross-pane drain等を修正し、代表ケースを検証
  - [x] 原訳の異寸法、未対応訳文、左右一つのtoolbar等を明示bindingの画面で確認
- [x] canonical初期化と空Libraryの基礎を実装
  - [x] profile／peer／固定初期request／durable intentをTS・Python共通契約へ追加
  - [x] SQLiteのatomic初期化と通常readonly repositoryからのreadbackを恒久testへ追加
  - [x] 同一IndexedDBでschema v6→v7→v8を整理し、bootstrap providerとlocal grant保存を実装
  - [x] scope-only binding、初回null navigation、空Library shell、scope form guardを実装
  - [x] BootstrapSession・固定request builder・再認可／終了時の世代fenceを実装
  - [x] BootstrapConnectionでlocked中も同じsubtree／入力値を保持し、pageshow後に新admissionを取得する処理を実装
- [x] 共通RuntimeIoGateの純粋な基盤を正式統合
  - [x] `frontend/src/runtime/lifecycle/RuntimeIoGate.ts` と純unitを移設
  - [x] operation capture、失効前後の検査、terminal close、handoff取消／drain、runSyncを実装
  - [x] gate unit7件、型・lint・境界・全frontend単体・両buildを通す
  - [x] browser/nativeの実authorityとproduction factoryをこのgateへ接続する（10-29のP1正式統合。現在の証拠は§12）

### 検証証拠

| checkpoint | 結果 | 要約ファイル（`output/` 配下） |
| --- | --- | --- |
| actual144 / T0 | gate7、型4project、lint、境界45、frontend1,430成功＋benchmark1 skip、両build成功 | `shared-app-runtime-io-gate-quick-summary-r1.json`、`shared-app-runtime-io-gate-standard-summary-r1.json` |
| actual142 / B3b UI | 関連62、Chromium/WebKit UI2/2、入力DOM・値・hidden/inert・fresh admissionを確認。fake host | `shared-app-bootstrap-connection-ui-{quick-summary-r1,runner-quick-summary-r1,browser-summary-r1,standard-summary-r1}.json` |
| actual134 | 関連TS103／Python47、browser13、backend17 file164/164。UI空LibraryはChromiumのPC/Web両mount | `shared-app-local-grant-scope-{quick-summary-r2,browser-summary-r1,standard-summary-r1}.json` |
| isolated T1 | unchanged ES2020/DOMの型、6 suite60/60。native・fullApp未検証 | `shared-app-repository-plan-validation-summary-r2.json` |
| isolated T1+T2 | 協調型、同じ6 suite60/60、実IndexedDB Chromium1/WebKit1。real grant、fixture seedのみfake、quotaは注入 | `shared-app-indexeddb-plan-validation-summary-r2.json` |
| isolated T1+T2+T3 + Desktop | Web協調型、6 suite60/60、実IndexedDB両engine2/2、DesktopDriver両engine2/2、旧fixture適応6/6両engine12/12成功 | `shared-app-authority-coordinated-validation-summary-r1.json` |
| isolated D1b+D2+Physical | Native協調Python隔離、4 suite50/50成功（authority hooks、routes全経路認可、hold失効、物理identity破損防護） | `shared-app-authority-coordinated-validation-summary-r1.json` |

別runの成功件数は合算しない。pure gateはproduction graphへ未到達の `staged`。isolated T1/T2の成功を、本番factory・全App・provider認可・通常起動の証拠へ流用しない。以前の型失敗・lint失敗・各r1ログも保存している。

## 4. 旧候補と採用履歴（現rootへ再適用しない）

下表は採用前の履歴。現在は必要差分をP1の129pathへ集約・正式統合済みであり、「未統合」は当時の状態を表す。SHAは各候補の `draft-hashes.json` 等の**manifestファイル**に対するもの。候補内のREADME・baseline・checkpoint・hash一覧はrepo rootへコピーしない。

| 候補 | ディレクトリ（`output/` 配下） | 現況／manifest SHA-256 |
| --- | --- | --- |
| T0 browser rebase一式 | `shared-app-runtime-io-gate-draft` | source review済み。generic gateとunitだけactual144へ統合。browser authority等は未統合。`8af7a9cbf08a1dc20e659aace4f5b568018009ba262935f1c7273cc9625cf20d` |
| T1 Core plan＋memory | `shared-app-repository-plan-draft` | source review・隔離型／60件成功。13 frontend候補、metadata含め15 entry。`3f439259ebd641b849ee485501c3c9f30b85eed37e445611d81151985ce32187` |
| T2 IndexedDB capture/CAS | `shared-app-indexeddb-plan-draft` | source review・協調型／60件／両engine2件成功。6候補。`0eb3383e7d865625fc12fdb15561d6ab0075c743428f2559ea796ec54b1ca4cb` |
| T3 browser全経路の認可接続 | `shared-app-browser-authority-integration-draft` | 隔離型・Core60件・実IDB両engine・旧fixture適応6件すべて成功。38候補。`2bf105b958d65c78c4020af60deee54aac3fcfd409b5f58ad873d854b8491f9d` |
| D1b native transaction hook | `shared-app-native-authority-hooks-draft` | D2・physicalと重ねて隔離Python treeにて全50件成功。`a2c1074c1bfff8a1642062814ea4429d0e65cc2baf44f41cda04376273aac1a2` |
| D2 native server/API | `shared-app-native-bootstrap-driver-draft` | D1b・physicalと重ねて隔離Python treeにて全50件成功。`694d6dcc7d78865b4fec7fb8e4c6874006ef550f219ba580dba76b064bd7ac62` |
| native physical identity | `shared-app-native-physical-identity-draft` | 隔離Python treeにて全50件成功。`2a10ffa0ea5c17b1e710de401cc3f3712d0eec8302bd4c49d3d49e99e6fd52fa` |
| Desktop driver | `shared-app-native-desktop-driver-draft` | 共有RuntimeIoGateへrebase完了、型検査・Chromium/WebKit両engine成功。`c32df017915b99409ff2092888f98d19c862af0e7672debf428390bdd16d646e` |

### 上書き順・既知の注意

1. Web協調検証は **actual144コピー → T1 → T2 → T3**。T3はauthority、fixture、helperの一部を上書きするのでT2を後から戻さない。
2. Nativeは **D1b → D2 server → native physical identity**。古いD1bのrepositoryを、最終physical修正へ上書きしない。Desktop driver内の `d2-server-manifest.json` は旧 `0fc8876f…` を指すので、そのまま最新serverの証明に使わない。
3. T3では旧raw adapter6実装をe2e-onlyの `support/raw-core/` へ移している。これはCore／migration用の試験境界で、productionへ輸入・再exportしたり、real-owner認可の証拠に数えたりしない。
4. T3の全method matrixは主にadmission/captureの許可・拒否を確認するソース。全public methodの実動作、host reauthorization、通常mountの完成は未証明。
5. Nativeの `StorageIntegrityError` はValueError／sqlite.Errorの外側。破損をCoreの確定 `aborted` へ変換してintentを捨てない。正当な同ID/versionのprojection再構築は許容する。
6. Gateの `started` はaction開始の補助情報で、耐久結果ではない。privateな同operationのnative証拠をouter delivery fenceまで保持し、commit後の配送失効はunknownへ分類する。
7. snapshot／hash／PDF検証はIDBのwrite transaction外。閉じたreadonly snapshot→Core memory plan→exact CAS＋atomic enqueueを使う。keepaliveでcryptoをwrite中へ戻さない。

## 5. 次の担当が最初にすること

現在は**P4のLibrary・Workspaceを継続中**。共通frame／commandと通常Webの集中表示を実接続し、2023入力の型4・lint・単体1,681成功／1skip・両buildと、同一runのcompiled Web 20件が成功。B3.3の隔離更新・Native実測と、その集中表示前source ZIPの独立保全も完了した。最新は§24と[Workspace checkpoint](../checkpoints/shared-app/2026-10-30-p4-workspace/ACTIVE.md)。TODO正本は計画書第3節のみ。

1. 作業元はroot。移動mapと最終pinを使い、凍結した旧candidateを一括適用しない。旧原本・失敗ログは維持する。
2. B3 coreは型4・lint・単体1,645成功／1skip・両build、新規選定backend203件とAPI5件、compiled Web18件＋別PDF回帰2件が成功。旧14ZIPとB3の2,085member source ZIPを保持している。
3. B3後、注釈一覧・回復・Library主要test、reader注釈／手書き群とcatalog UI 5 moduleを整理し、共通frame／commandとWeb集中表示を接続済み。次は実際の付属note／添付side panelと残る責務整理、B3.4のNative確認へ進む。旧候補READMEの「未適用」はその作成時点で、現在地はWorkspace checkpointを優先する。
4. 設置済み`Papeer Shared Trial`はWorkspaceのB3.3。実sidecar／NSIS・独立artifact確認・隔離更新installが成功し、全1,033sidecar file／GUIの配置と旧data／profile・通常版登録保持を確認した。新Native実画面で通常起動・保存／Undo・PDF参照・設定と完全再起動を確認した。旧[B3 core](../output/shared-app-builds/2026-10-30-b3-library/README.md)の成功は歴史的基準として保持する。通常版を更新・終了しない。
5. 全67要件はaccepted0／partial47／unverified20を維持。P4の残整理／回復／引用遷移を継続し、実remote／競合はP5、旧caller・移行はP6、機器／精度境界・全受入はP7へ進む。

## 6. 全体の残作業を管理する場所

**今後のTODOの正本は[計画書第3節](shared-app-plan.md#3-実行todo大分類小分類)。本書に別のチェックリストを複製しない。**

P0整理→P1通常起動の一操作→P2 PDF／注釈／Reader→P3ノート／Markdown→P4 Library／Workspace→P5同期／provider／offline→P6実データ移行／既定切替／旧責務撤去→P7全67要件の最終受入、と進める。各段階に定期整理Cを組み込む。

P1などの中間到達点を達成しても、未確認の他host反映・全機能・実機・実データ変換を完了扱いしない。元のF01〜F38／R01〜R29と保全条件は維持し、[受入台帳](shared-app-acceptance.json)は証拠に基づく場合のみ更新する。

## 7. 正本・記録への入口

- [計画書](shared-app-plan.md)／[設計書](shared-app-design.md)／[受入台帳](shared-app-acceptance.json)
- [実装・検証記録](shared-app-implementation.md)／[review記録](shared-app-review-cycles.md)
- [通常起動・初期化](shared-app-canonical-bootstrap-design.md)／[有限接続契約](shared-app-bootstrap-connection-design.md)
- [実host driver](shared-app-local-host-driver-design.md)／[snapshot・plan・CAS・共通gate](shared-app-repository-transaction-design.md)
- [固定参照ページ](shared-reader-reference-page-design.md)／[resource runner](shared-app-resource-runner.md)
- [旧引継ぎ全文](shared-app-handover-history-2026-10-27.md): 過去のcheckpoint・失敗・診断・変更理由。現況は本書を優先する。

主要設計のhash: 共通transaction設計は232行・`fdcfe1ff23b510551e0d48ecc350a5029bbab17315809171d135c208f75d5e7d`。初期化契約／接続契約／host設計の改版と候補source baselineが一致するか、再開時に実ファイルを再確認する。

## 8. 2026-10-28 追記: 再開後の作業状況（途中経過）

本節は10-28時点の途中経過を保全したもの。現在の作業順は更新済みの§5／§6と計画書、追加調査は§9を参照する。**本節の内容は当時の途中経過で、未レビュー。本番worktree・git・依存・`frontend/openapi.json`・`frontend/src/api/schema.d.ts` は一切変更していない。** 作業はすべて `output/` 配下の隔離ツリーで行った。

### 8.1 方針と体制

- 方針: 触るファイルが重ならない作業は並列で進める。実装はSonnet 5.5、review・検証は既定モデル（メモリー `feedback-subagent-implement-review` にも記録）。
- 利用上限と再起動で、エージェントが2回止まった。**再開した各エージェントの会話記録は保存されているが、最後に確認した時点（10-28 21:45頃）で完了通知は未着。** 引き継ぐ側は、下の「生きている可能性のある処理」を確認してから動くこと。
- 古いPIDを生存とみなさない。他人のNode／browserを一括終了しない。10-28 午後に、止まったまま残っていた試験の処理ツリー（webLegacyStartup webkit後にNodeが約2時間40分終了しなかったもの）だけを手動で終了した。

### 8.2 完了した検証: Web全体検査（隔離ツリー `output/shared-app-repository-plan-validation-r1/`）

T1+T2+T3+Desktop driver を重ねたツリーで、標準の全検査が通った（要約: `output/shared-app-web-full-isolated-summary-r1.json`、説明: 同 `-README-r1.md`）。

| 検査 | 結果 |
| --- | --- |
| 型（app／node／tests／e2e） | 4つとも成功 |
| lint | 成功 |
| 依存境界 | 45/45 |
| 全frontend単体（r2） | 1,491件中 1,490成功・1 skip（既存benchmark）・失敗0。actual144の1,431件＋T1の60件 |
| PC・Web build | 両方成功（既存の500kB超警告のみ） |
| bootstrap系ブラウザー（Foundation／Fault／Connection） | Chromium・WebKitとも成功 |

- 候補コードの不具合は見つからなかった。直したのは古い単体試験1件: `frontend/tests/contentPublication.test.ts` を、ストレージ例外を `aborted` へ変換せず投げる新仕様（transaction設計158/162行）に合わせて `assert.rejects(..., /disk full/)` にした。修正前は `output/shared-app-web-full-isolated-originals-r1/` に保存。
- 本番のentry（`main.tsx`／`web/main.tsx`）から辿れる444ファイルはactual144と同一。**新しい保存・認可の経路は本番のどこからも使われていない。**

### 8.3 途中: 文書系ブラウザー試験（隔離フロントエンド × repo root の Python backend）

実行基盤は `output/shared-app-web-backend-isolated-runner-r1.mjs`・`...-batch-r1.sh`・`...-filelist-r1.txt`（71ファイル）。結果は `...-runs-r1.jsonl`（164件、ファイル×engine×tree）、各ログは `...-<名前>-r1.log`、junitは `...-junit-r1/`。

- **実行済み55／71ファイル。** 全engineで exit 0: `desktopIntent.integration`（12件成功）、webDocumentCommands、webDocumentFailures、editIntent、editRepository、pdfReaderResize、webBootstrap{Connection,IndexedDbFault,IndexedDbFoundation}、webCanonicalLocalGrant、webDatasetControl、webDatasetPublication、webEditStorageRegression、webEraserAtomic、webIndexedDbPlan、webIphone、webLegacy{Backup,DriveBackup,IndexedDbBackup,InkMigration,Inputs}。
- **未実行（17）:** webLibrary、webManagedCrossPaneInput、webManagedInkContact、webManagedSelectionInput、webNativeDesktopDriver、webNoteEditSession、webNotebookPlacement、webOffline、webPwa、webPwaStatus、webReaderInteractions、webReadingPlace、webRecovery、webResponsive、webSession、webSidebar、webWritingToolbar。`test:web` 全体も未実行。
- **失敗66件（exit≠0）。原因は未確定。回帰とも既存失敗とも結論していない。**
  - 大半は `webDocument*`（Annotation／Citations／Composition／Library系／Markdown系／Notebook／Reading系／Sticky／Tools／Translation系ほか）の1〜2件ずつ。ほかに webCanonicalPdfSurface（6件）、webLegacyStartup（Chromium・WebKitとも2件）、sharedNoteSessions・webAnnotations・webEmptyLibraryScope の `other` 枠。
  - ベースライン比較は **webDocumentLibrary（Chromium）だけ** 実施済み。**本番frontendでも失敗**した（2回）。本番は `page.goto` が25秒でタイムアウト、隔離は `locator.waitFor` が25秒でタイムアウト。つまり隔離固有とは言えない。
  - 他のエージェントが同時にpytestや単体を走らせていたためCPU競合の疑いがあるが、**未検証。** 単独実行での切り分けが要る。webDocumentCitations（Chromium）は30,414秒（約8.4時間）かかって失敗しており、止まっていた時間を含む。
- 隔離ツリーへの編集: `frontend/e2e/editRepository.browser.test.ts` のみ、元ファイルが `...-originals-r1/` にある。差分は改行コード（CRLF）だけで、内容は変えていない。assert・timeoutは変更していない。
- **次にやること:** 失敗を代表1〜2ファイルずつ単独（他の重い処理を止めて）で再実行→本番frontendで同じ試験を実行して比較→回帰だけ分類・修正。残り17ファイルと `test:web` を実行。webLegacyStartup は本番entryの移行admission順序の試験なので、特に本番との比較を取る。重いbrowser試験は単独で、ファイルごとに上限（15分）と処理ツリーの後始末を付けて走らせる。

### 8.4 途中: Native全体検査（隔離Pythonツリー `output/shared-app-native-validation-r1/`）

- ベースライン（本番Pythonの複製 `output/shared-app-native-full-baseline-r1/`）: pytest **6失敗**／2,845成功／29 skip。6失敗は既存: `test_license_inventory.py` 4件、`test_openapi_schema.py::test_committed_openapi_json_is_the_sidecars_schema`、`test_shared_app_acceptance.py` 1件。pyright 8エラー・ruff 3エラーも**ベースラインに同数ある**。
- 隔離ツリー初回（`...-pytest-initial-r1.log`）: **13失敗＋86エラー**／2,813成功。エラー86件の大半は `test_canonical_initialization_sqlite`・`test_edit_records`・`test_edit_datasets`・`test_content_publication`・`test_edit_intents`・`test_edit_dataset_control`・`test_edit_checkpoint`・`test_edit_storage_regressions`・`test_edit_repository` で、**既存のCore／APIのfixtureを新しい認可hookに合わせる未完の作業**とみなしている（確定ではない）。失敗13のうち4件は既存のlicense inventory、ほかに `test_translation_document` 2件・`test_edit_storage` 2件などがある。
- 担当エージェントはその後fixture適応に着手しており、`...-pytest-final-r1.log` が **最後に確認した時点で実行中（途中の進捗行のみ）**。`...-pyright-final-r1.log`（8エラー、すべて `canonical_initialization_sqlite.py` のNone添字）と `...-ruff-final-r1.log`（3エラー）は出ているが、ベースラインと同数のため悪化はない。**最終のpytest件数・変更ファイル一覧・全route拒否試験の有無は未確認。** 修正前の写しは `output/shared-app-native-full-isolated-before-r1/`（`sidecar`・`tests`）。
- OpenAPI（`output/shared-app-native-full-isolated-openapi-r1.json`、隔離sidecarから生成）: 本番 `frontend/openapi.json` との差は**新規11 path（`/api/edits/bootstrap/{discover,inspect,peer,release,revalidate,local-context/{provision,read},initialization/{prepare,execute,query,acknowledge}}`）の追加だけ、削除なし。** ただしJSON全体の差分行は約2,260行あるので、path以外（schema定義の並び・追加）の差は未精査。
- 次にやること: finalのpytest結果を確認→ベースラインの6失敗以外が残っていないか→fixture適応の内容をreview→全route拒否試験（欠落・他人・期限切れleaseを全canonical routeで拒否）の有無を確認→OpenAPIの差をpath外まで確認。**`frontend/openapi.json`・`schema.d.ts`・client生成は、Native側が収束しreviewされてから本番で1回だけ行う**（Web／PCの接続作業と共有する生成物のため並列にしない）。

### 8.5 途中: 通常起動の接続（Sonnet実装・どちらも未完・要約未作成）

どちらも `output/shared-app-repository-plan-validation-r1/` を2026-10-28 00:55に複製した作業ツリー（`node_modules` は本番`frontend/node_modules`へのjunction）。**`*-wiring-summary-r1.json`／`*-README-r1.md` は未作成。型・lint・境界・単体・buildの結果は未確認。** 複製元からの差分は次のとおり（`diff -rq` による）。

- Web `output/shared-app-web-entry-wiring-r1/`:
  - 新規: `src/adapters/browser/bootstrapHostDriver.ts`、`legacyHoldReadonly.ts`、`namespaceOwnerLibraries.ts`、`src/web/bootstrapComposition.ts`、`tests/browserBootstrapHostDriver.test.ts`
  - 変更: `src/adapters/browser/localHostAuthority.ts`（T2／T3の候補ファイル）、`src/web/WebApp.tsx`
- PC `output/shared-app-pc-entry-wiring-r1/`:
  - 新規: `src/adapters/desktop/bootstrapEntry.ts`、`canonicalBootstrapWire.ts`（D2 routeの狭い型付きclient。OpenAPI再生成後に生成型へ置換する）、`DesktopBootstrapApp.tsx`、`desktopWindowClose.ts`、`tests/desktopBootstrapEntry.test.ts`、`tests/desktopEntryGraph.test.mjs`
  - 変更: `src/adapters/desktop/bootstrapHostDriver.ts`（Desktop候補）、`src/App.tsx`、`src/DesktopApp.tsx`、`src/runtime/sharedEntries.json`
- **共有ファイルの注意:** 両entryの変更が重なる可能性があるのは `src/App.tsx`・`src/runtime/sharedEntries.json`（PC側は変更済み。Web側が同じファイルを変える場合は突き合わせが必要）。`sharedEntries.json` は本番のhash（§2）が識別子なので、統合時にhashを再記録する。
- 次にやること: 各コピーの差分をreview（本番が `e2e/support/raw-core` を輸入していないか、reauthorization・安定ScopeResourcesの実装範囲）→4 tsconfig・lint・境界・全単体・buildを各コピーで実行→2つの差分を統合した1本のツリーで再検証→ブラウザー試験（引数・window binding注入なしの通常起動、Google未接続の作成・編集・cold reload）。

### 8.6 生きている可能性のある処理

最後の確認（10-28 21:41〜21:43）で、`.venv` の `python -m pytest` が動いており、`...-pytest-final-r1.log` が更新されていた。これはNative担当の実行。完了通知が来ているか、ログの更新時刻とプロセスを見てから、重複実行を避けること。

### 8.7 全体の状況（変わっていない点）

- 受入台帳は**67要件: accepted 0／partial 47／unverified 20のまま。** 本節の成功を要件受入へ昇格させていない。
- 正式統合（候補の本番worktreeへの反映）は**未実施**。統合の前提は、8.3の失敗の切り分け、8.4のNative収束とreview、8.5のentry接続とreview、およびそれらを重ねた1本のツリーでの全検査＋ブラウザー再検証。
- 元の計画は未完了のまま。既定起動はまだlegacy。

## 9. 2026-10-29 再調査と実行計画の更新

本節は計画作成時点の記録。後続の実作業は§10を参照する。ユーザー依頼によりSol 6.1×2／Terra 6.1×1が、通常起動・残要件・ファイル整理を読み取り調査した。Rootが既存計画書と本書を更新。**この調査時点ではアプリsourceの変更、アプリ試験の再実行、候補の正式統合、実データ移行、ファイル移動・削除・commitはしていない。** 文書整合性の検査結果は§9.4末尾に記録した。67要件は accepted 0／partial 47／unverified 20のまま。

### 9.1 通常起動と候補の実態

| 対象 | 確認した現在のsource／結果 | 残り |
| --- | --- | --- |
| rootの通常起動 | `frontend/src/App.tsx`／`src/web/WebApp.tsx`はbindingなしでlegacy。共通部品を明示bindingで使う経路は存在 | 通常entryへの接続・実driver検証 |
| Web entry候補 | `output/shared-app-web-entry-wiring-r1/frontend/`にWebApp→bootstrapComposition→実driver、stable ScopeResources／再認可の候補がある | `src/web/main.tsx`は旧`IndexedDbLegacyBackupStore.readHold`のまま。新`legacyHoldReadonly.ts`を最外周に接続し、upgradeする旧read経路を解消する。追加unitはfake authority等で、通常起動の証明ではない |
| PC entry候補 | `output/shared-app-pc-entry-wiring-r1/frontend/`にDesktopApp→DesktopBootstrapApp→bootstrapEntry→native driver、終了guardの候補がある | 手書きwire型・実backend/OpenAPIとの整合、実Tauri／sidecarの操作確認。追加entry testはfake sidecar |
| Native候補 | `output/shared-app-native-validation-r1/`にbootstrap route／canonical hostとfixture適応がある。rootには新routeがない | このtreeを採用元の出発点に差分reviewする。PC frontendだけrootへ移しても成立しない |
| 最初の操作 | `LibraryCatalogPanel.tsx`が手書きノート作成・同ID open、`LibrarySession.ts`が白紙A4一pageを原子的に公開。両版が共通DocumentLibraryConnection／DocumentEditSessionを使う | 新UI／PDF importは不要。ペンup後の耐久完了とUndoを新driverで通す |
| cold再起動 | `BootstrapSession.ts`は初回`documentId: null` | P1は一覧で同IDを選び直す。選択の自動復元はP4で扱う |

根拠は[PC通常分岐](../frontend/src/App.tsx)、[Web通常分岐](../frontend/src/web/WebApp.tsx)、[作成UI](../frontend/src/features/library/catalog/LibraryCatalogPanel.tsx)、[白紙ノート公開](../frontend/src/features/library/LibrarySession.ts)、[共通編集session](../frontend/src/features/reader/edit/DocumentEditSession.ts)、[bootstrap session](../frontend/src/features/bootstrap/BootstrapSession.ts)。候補の型／lint／entry動作は今回実行していない。

### 9.2 検証結果の更新と未確定事項

- Native最終ログ `output/shared-app-native-full-isolated-pytest-final-r1.log` は終了している。**6 failed／2,910 passed／29 skipped／62 deselected、434 subtests passed**。6失敗はlicense inventory4・OpenAPI一致1・acceptance evidence欠落1で、baselineと失敗名が一致する。全成功や正式統合可を意味しない。
- 62 deselectedは既存slow指定5関数のparameter展開計62と一致する。`pyproject.toml`は長いproperty runを通常実行から外す方針だが、finalログにコマンドがないため、実際のCLI/env指定は未確認。P0.3で実行条件を回収する。
- pyright8／ruff3エラーも残る。旧ログと同数だけで内容同一・悪化なしの保証にしない。fixture適応の差分、OpenAPIのpath外差分、生成client整合は未レビューの残件。
- 訂正: `test_native_bootstrap_routes.py`だけを調べた当初の説明は不十分だった。同じNative候補に **`tests/test_native_all_route_authorization.py` の全route拒否matrix sourceが存在する**（SHA-256 `8b580061b19900c51542df7f8cec31862dd380a6c868568eced646eb84437f88`）。欠落／偽／異なるlease・foreign bearer・release／revoke後を扱う。対応する実行条件・結果はP0.3で照合し、sourceがない前提で作り直さない。
- Webの§8.3の失敗を今回再実行していない。CPU競合・fixture差・回帰のどれかは未確定で、P0.3の代表baseline比較を行う。全候補の成功件数を合算しない。
- entry候補のsummary未作成・全体検査未確認という状態は変わらない。現行採用sourceとrootの接続が一致したところで、同一candidateの証拠を取得する。

### 9.3 ファイル棚卸しと保全上の発見

以下は調査時点（今回の文書更新前）の観測値であり、容量・件数を達成目標にしない。

| 対象 | 観測 |
| --- | --- |
| Git | 追跡1,445、追跡差分124（M123/D1）、未追跡427 |
| 未追跡の主な内訳 | frontend365（src182/e2e90/tests89/scripts4）、papeer18、tests29、docs11 |
| output直下 | 174 directory＋1,666 file（log1,340／json249／jsonl21） |
| outputの限定集計 | 159,044 file／32,986,758,257 bytes（約30.72GiB） |
| 集計除外 | node_modules・.venv・.git・cache等、junction5本は追跡しない。ディスク総使用量ではない |
| 容量上位例 | canonical-pdf-surface-spike約5.27GiB、pwa約3.80GiB、summary-repair-20261024約1.98GiB |

**調査時点では保全とcleanが衝突していた（§10で修正済み）。** `.gitignore`はoutputを除外し、当時の`tools/clean.py`のTARGETSはoutput全体を削除対象にしていた。しかしoutputには未統合source・originals・唯一の検証根拠が含まれるため、原本保全とclean対象の修正を先行した。workspaceの一括cleanは実行していない。

特に保持するものは、§4の各draft、`shared-app-repository-plan-validation-r1/`、`shared-app-native-validation-r1/`、native baseline／before、両entry-wiring tree、Web originals、manifest／checkpoint／採用判断に使うログ。古い日付や巨大な容量だけを理由に削除しない。

### 9.4 次回の現在地

- 計画正本: [第3節P0〜P7](shared-app-plan.md#3-実行todo大分類小分類)。定期整理・検証運用は同第7節。
- 次の小分類: **P0.2 採用元の固定とP0.4の原本保全**。P0.3の結果回収を合わせ、**P0.5の第1回実整理を済ませてからP1へ進む**。P1の統合後にも整理し、P1.5で初回のビルド・インストール・利用者試用を行う。
- 今回完了したのは現状調査・計画再編・文書入口の整理。アプリの共通化進捗や最終受入状態は昇格させていない。

文書レビューは同じ3担当で実施。F10の設定復元をP2へ先行配置、P3の撤去条件を新経路へ限定、P0の上書き前保全、P1の旧データ検出／移行の分離とWeb/PCの検証対象を明確化した。更新前後のF/R全67行は同一、計画書／引継ぎ書の相対リンク36件と見出しanchorは有効、rootで `python tools/shared_app_acceptance.py --check` は成功した。これは文書・台帳の整合性確認であり、§9.2の隔離Native実行結果を成功へ変更する証拠ではない。

## 10. 2026-10-29 P0の実施: 原本保全とディレクトリ整理

本節は最初の整理時点の記録。後続の正式統合・第2回整理は§12を優先する。

ユーザーの「整理」はソースのディレクトリ構成の見直しも含む。計画書第7.6節へ責務別の配置案と担当工程を追加し、Terra 6.1が最初の移動とclean保護を実装、Sol 6.1が独立した差分レビューと候補照合を実施した。**P0.4・P0.6は完了、P0.2／P0.3／P0.5は残件あり。通常起動の候補統合・インストーラー作成・インストールはまだ行っていない。** 受入状態は67要件のまま変更していない。

### 10.1 原本と採用元

- [保全記録と復元手順](../checkpoints/shared-app/2026-10-29-p0/README.md): 整理前root sourceと`output/shared-app-*`の候補・証拠11,549fileを約98MBのZIPへ保存。CRC・全member SHA・capture後の元source一致を確認した。依存・生成build・cache・秘密設定を除外。実ユーザーのLibrary／Drive backupではない。
- `tools/clean.py`はbuild/dist/tmpだけを対象に変更し、outputとcheckpointsを保持する。実workspaceのcleanは実行せず、一時ディレクトリの実動作試験5件で確認した。
- [採用台帳](../checkpoints/shared-app/2026-10-29-p0/adoption-manifest.json): actual144の144項目、T1/T2/T3/Desktop manifestと協調treeを照合。適用順は**現在root→協調frontend55→既知単体適応1→Web entry7→PC entry10→Native最終28**。entryで2pathを更新するためunique99path。全候補hashと変更前root hashを記録したが、適用は未実施。
- Nativeは`shared-app-native-validation-r1`の最終差分を使い、古いdraftを再適用しない。候補で省略された`frontend/src-tauri`やOpenAPIを削除しない。OpenAPI生成とP1の追加修正は99pathとは別枠。

### 10.2 最初の構成整理と検証

reader直下の用語集9fileを`frontend/src/features/reader/glossary/`へ移動し、consumer9fileのimport／Vite URLを更新した。reader直下は150→141file。挙動変更や互換reexportは追加していない。[移動台帳](../checkpoints/shared-app/2026-10-29-p0/glossary-relocation.json)に旧→新pathと18fileの前後hashを記録した。

| 検証 | 結果 |
| --- | --- |
| clean保護 | 5件成功 |
| 関連単体／描画smoke | 18件／2件成功 |
| 型検査 | app/node/tests/e2eの4系統成功 |
| lint | 対象source/tests成功。fixtureは既存lint対象外、e2e型検査で確認 |
| 依存境界・module graph | 45件成功 |
| PC frontend／Web build | 両方成功。既存chunk-size警告あり |

実コマンド・初回失敗と修正・警告は[検証記録](../checkpoints/shared-app/2026-10-29-p0/validation-summary.json)を参照。raw logはtool会話内のみで、独立logを保存したとは扱わない。PC frontend buildはsidecarを含む配布パッケージのbuildではない。

独立レビューではfrontend930file、backend等635fileを保全原本と照合し、予定した移動・参照更新・clean関連以外のsource変更はなかった。移動18fileと採用99pathの交差はなく、99pathの変更前hashも維持されている。今後は**整理後root＋99pathの限定適用**とし、旧候補tree全体をコピーして移動を戻さない。

### 10.3 残りの構成整理と次の作業

調査時の直下file数はfrontend/tests197、tests171、reader150、papeer/core108、frontend/e2e97。単なる分割数を目標にせず、readerのPDF／入力／参照／編集、coreの編集保存／bootstrap、unit/e2eの機能別配置へ段階的にまとめる。P1.Cで一次再配置を行い、P2〜P5の担当機能ごとに残りを整理する。

testsの`tests/*.test.*`、tests用tsconfigの`*.ts`、test-web runnerの直下列挙、runtime/editsの境界検査にはサブディレクトリを見落とす箇所がある。移動前に収集処理を対応し、旧→新対応表で検出対象集合が減らないことを確認する。generator・fixtureの相対path・runtime registryも同じ変更で追従する。過去のmanifestは書き換えない。

次は§5の順にP0の残件を閉じる。P1では両通常起動の一操作を成立させ、P1.Cで整理してからP1.5/B1でsidecar込みのbuild・隔離環境へのinstall・再起動を確認する。その後もP2〜P7とB2〜B6を継続する。TODOは計画書第3節だけを更新する。

## 11. 2026-10-29 単一候補と通常Web起動の実証

本節は候補の組立とP1.3到達時点の記録。現在の作業元・正式統合・後続検証は§12を優先する。

### 11.1 採用先と追加修正

現在rootの1,870 source fileを基底に採用99pathだけを反映し、`output/shared-app-integration`を唯一の統合検証先とした。組立script／hashはcheckpointの`integration-assembly.json`。rootのアプリ本体へは正式統合していない。旧draft／隔離treeは履歴・比較元であり、通常作業先に戻さない。

Web mainはreadonly holdの実record/nullを起動ガードへ渡し、driverのclear/held契約と分離した。Nativeは既存型/lintエラーを修正し、有効publicationでaccount/library/epoch違い・grant失効の拒否と新認可での保存を検証した。同じbackendからOpenAPI/client型を生成。Desktopは生成型でPOST path/body/header名を制約し、schema上unknownの応答を実行時に検証する。これらは独立レビュー済みで、確認範囲のblockerはない。

API差分は新規11 pathに加え、既存25 pathの認可headerとschema追加・変更を含む。§8.4の「新規11 pathだけ」はpath集合の説明で、schema全体の差ではない。過去Nativeの6失敗名・pyright8件・ruff3件はbaselineと診断内容まで一致したが、過去pytestの実コマンド／環境は未確認のまま保持する。

### 11.2 通常Web起動と標準検査

**通常entryからUIだけでlocal setup→Library作成→白紙ノート作成→A耐久→B耐久→Undo(B)耐久→完全終了→同profile再起動→同note選択→Aのみ復元が、WebのChromium／WebKitとWindows実Tauri＋実sidecarで成功した。** window binding・fake lease・fixture seedを注入していない。Webは実IndexedDBのreadonly観測で3 durable batch、intent解消、Undo対象Bを照合。PCは実commit要求と耐久receiptを対応付け、両版で同document IDとAのID／SVGを再起動後に確認した。

| 対象 | 結果・範囲 |
| --- | --- |
| 通常Web Chromium | 最終r3実case1件成功、12.50秒全Node実行。r1の一時的DOM属性比較は同ID／描画・保存記録を使う観測へ修正。CSS変更後に再確認 |
| 通常Web WebKit | 最終r2実case1件成功、33.42秒。CSS変更後、完全ブラウザー再起動を再確認 |
| 通常Windows実Tauri | r3実case1件成功、24.71秒（runner39.62秒）。candidate-built debug exe・実sidecar・同じ隔離data/profileでcold restart。実ユーザーファイル変化／cleanup警告なし |
| Native関連 | 63件成功、pyright 0 error、指定範囲ruff成功 |
| Web hold単体／Desktop関連単体 | 23件／8件成功。それぞれ実hostブラウザー・実Tauriの代用ではない |
| OpenAPI/client整合 | 同sourceから生成し、5件成功 |
| 候補frontend全単体 | 1,519件中1,517成功・既存benchmark 1 skip・OS権限による失敗1。失敗したWindows process cleanupだけsandbox外で1件再実行し成功。別runの件数を合算しない |
| 型／lint | app/node/tests/e2eの4系統と全frontend lint成功 |
| PC frontend／Web build | 両方成功。CSS探索範囲の明示後は6.91秒／5.61秒。debug Tauri buildも成功（3分59秒）。PC配布パッケージ／インストーラーのbuildではない |

コマンド・環境・raw logは[checkpointの入口](../checkpoints/shared-app/2026-10-29-p0/README.md)から辿る。新しいbrowser runはcaseを完全一致で選択し、実case数・終了状態を記録した。過去の空filter実行を成功として流用しない。pnpm shimのuser store lockが拒否されたため、既に導入されたlocal Node CLIで同じgenerator／検査を実行し、依存の再導入はしていない。

### 11.3 残る試験と整理

- 代表比較ではrootのLibrary／Web hold各1件が成功。候補Libraryは旧fixtureがprivilegedな`/initialize`を呼び403。header追加だけでは直らず、後続receive/ackも含む旧composition fixtureの移行はP2/P5へ割り当てた。production認可を緩めない。P1はseedなしの通常entryを検証する。
- 候補Web hold試験の旧r1/r2はseed完了後のnavigationで停止した。PCの旧r1/r2もabout:blankのまま、Vite indexへのGETがtimeout。CSS探索をsrc・入口HTML・e2eへ限定し、hold testのcacheをrootと共有しない構成へ変更後、hold r3は実case1件成功（4.54秒）、PC r3も成功した。PC buildは66.16→6.91秒という観測値であり、Rust targetが単独原因とは断定していない。13代表CSS selectorの存在と独立source範囲レビューを確認したが、全面pixel同値の証明ではない。
- 実Tauriシナリオはprofile commandline・実ユーザーファイル監視・所有process限定cleanupを両起動で維持した。保存後に所有processを終了するcold restart試験であり、正常終了guardの実機受入は別に確認する。全runの結果は`integration-status.json`から辿れる。
- PC試験はrootの古いexeを使わない。candidate `.venv`とnode_modulesはroot依存へのjunctionで、Python cwdとRust targetはcandidateのまま。専用TEMPと空のresults領域、8000／1420が未使用であることを確認する。占有中の他アプリを停止しない。
- 既存license inventory／acceptance evidence問題、旧fixture移行、古い`canonical_host.py`説明文、容量整理の残りは計画書の担当P/Cで追跡する。P1.C後、P1.5/B1でsidecar込みinstallerと実installを行う。67要件の受入状態は更新していない。

最終candidateのlogical sourceは1,929file。`integration-source-state.json`に採用99pathからの追加修正16pathと全hashを記録し、rootのアプリsourceが組立時から変わっていないこと、用語集移動18fileと旧9pathの不在を再確認した。`integration-candidate-source.zip`（約21.5MB）へ全sourceを保全し、CRCと全member SHAを読戻し確認。依存・binary・build・ユーザーデータは含めない。復元は空treeへ展開してhash確認し、現在rootへ一括上書きしない。ZIP内の文書は組立時のbaselineで、現在TODOはrootの本書／計画書を優先する。

## 12. 2026-10-29 P1正式統合・第2回整理と最終検証

### 12.1 作業元をrootへ一本化

最終候補の追加修正を含む129path（追加69／変更60／削除0）をrootへ正式統合した。適用前に全root／candidateを再hashし、before ZIP1,870fileと統合後ZIP1,939fileのCRC・全member hashを読戻し確認。適用後の全root hash、既存docs42件・用語集配置・意図した旧path不在を独立レビューで再確認した。実装はSol 6.1／Terra 6.1、限定差分と証拠のレビューは別担当で行った。

採用map・適用・独立reviewは[checkpointの入口](../checkpoints/shared-app/2026-10-29-p0/README.md)の`p1-root-integration-*`。現在の開発元はrootで、`output/shared-app-integration`は凍結した比較元。統合後の再配置は別のmapで追跡し、旧ZIP／manifestを現在hashに書き換えない。

### 12.2 P1の起動・失敗保全

Webでは旧localStorage／旧IndexedDB、PCではNative保存先・pending移動設定とWebView自身の旧draft／holdをreadonly検出する。holdの実record/nullと旧入力の存在を分け、破損・不明schema・link・検証不能な入力は起動を保留する。空Libraryで旧データを隠さず、原本・保存先設定・pending記録を保持し、自動移行はP6へ残した。

Library初期化のprepare／pending／結果不明中は、終了で元requestのfenceを失効させず拒否する。ノート公開の再試行成功後は通常成功と同じく作成名とフォームguardを解放し、失敗中は保持する。実HTTP応答だけの消失、実IDB transaction abortを使い、productionへのfake owner／binding注入や認可緩和は行っていない。

| 整理後rootの検証 | 結果 |
| --- | --- |
| 全frontend単体 | 1,537件中1,536成功／既存benchmark1 skip／失敗0。Windows process cleanupも同じrunで成功 |
| 型／lint／境界 | app/node/tests/e2eの4系統・全frontend lint成功。移動対象の境界／両entry graph46件成功 |
| Native／API | 同一runで関連16file173件成功。API整合5件、pyright0 error、configured ruff成功 |
| PC frontend／Web build | 両方成功。既存chunk-size警告。root debug Tauriもoffline/locked build成功。配布版の成果物とは区別する |
| 通常起動 | Web Chromium／WebKit各1件、実Tauri1件成功。実UIでA/B耐久→Undo(B)耐久→完全再起動→同Library／noteを選びAのみを確認 |
| 保存／Undo失敗 | Web両engine各1件。実IDB abort後のintent／描画を保持し、再起動・同ID retry・Undo回復を確認 |
| PC終了／作成回復 | 実Tauri close1件／creation1件成功。保存・Library作成・ノート公開の応答消失中は終了を拒否し、同じ要求の回復後にappとsidecarが正常終了 |
| 旧入力保全 | 実Tauri legacy2件、Web Chromium1件成功。旧draft／hold／破損のbytes保持、起動保留、retryを確認。候補WebKitの同試験成功も履歴として保持 |

root実行は`integration-results/p1-root-*`のJSON／log。各runでsource不変を確認し、他runの件数は合算しない。Webのpagehide/pageshowは合成eventで実handler・同一subtree／intentを検査したもので、OSのsleep／BFCache実機確認ではない。実Tauriは専用data／device設定／WebView profile・実ユーザーファイル監視・所有process限定cleanupを維持した。

### 12.3 ディレクトリと容量の実整理

reader PDFのsource8fileを`frontend/src/features/reader/pdf/`、対応test9fileを`frontend/tests/reader/pdf/`へ移動し、import・固定path・registry・現行受入証拠のpathだけを更新した。reader直下141→133file。unitのglob／tsconfigを再帰対応し、前後207test entryが移動map適用後に同一であることをNodeのglobと明示再帰列挙で照合した。関連75件と型・境界を確認し、挙動変更・互換reexport・別session追加を混ぜていない。受入67行のrequirement／status／layersは維持した。

旧candidateのRust targetはroot実機成功後に非使用と絶対path・reparseなしを確認し、3,406生成file、論理5.09GiBを削減した。hardlink重複除外では3.45GiBで、実空き回復量は未測定。過去runが使ったdebug exeは約5.8MBのZIPへCRC／SHA確認付きで保全した。source・失敗証拠・旧manifest・root target・依存junctionは維持している。初回guardは検査shell自身のtarget文字列を検出して削除せず停止し、対象processがないことを再確認してから実施した。

移動・検証・削減の記録は`p1-pdf-relocation-applied.json`、`p1-pdf-layout-validation.json`、`p1-candidate-target-cleanup.json`。次の整理はP2.1着手前のNative／browser bootstrap小群とし、P2〜P5の各Cも計画書で追跡する。

### 12.4 B1着手時点の記録（完了結果は§13）

P1.1〜P1.4と今回のP1.Cは完了。B1の配布物作成とbuilt Webの操作確認も成功し、残る小分類は**B1.3aの同PC隔離方式の準備→B1.3bのインストール→B1.4のinstalled app操作確認**。別Windows環境はまだないとの回答を受け、同じPCで通常版と衝突しない試用方法を次に具体化する。P1全体はまだ閉じていない。

[配布物の入口](../output/shared-app-builds/2026-10-29-b1/README.md)に、sidecar同梱NSIS（57,600,370 bytes、SHA-256 `3dbf5f0e9b8c15e8e74a7dc5b8f2237a1eef9a82332f32c59637fd9bfbf7cc64`）とWeb ZIP（8,851,366 bytes）を集約した。各SHAとWeb全385memberは同directoryのmanifestへ記録し、コピー／ZIP読戻しを確認した。未署名・Google新規接続未設定のローカル試用ビルドで、インストール／release GUI起動は未実施。

`p1-b1-build.json`はPyInstaller・frozen sidecarの隔離smoke成功後、配置renameのWinError5で停止した初回記録として保持する。使用中のworkspace exeなしを確認し、通常デスクトップ権限の`p1-b1-placement-retry-r1.json`で配置・hash公開・source checkを完了した。原因をsandboxやウイルス検査と断定していない。その後のrelease NSIS成功は`p1-b1-nsis-r1.json`／log。ビルド前後のfrontend／Web hashは一致し、配置sidecarはsmoke済みdistの全fileと一致した。

Webの配布物確認は`p1-b1-built-web-chromium-r1`／`p1-b1-built-web-webkit-r1`各1case成功。既存e2eへtest-onlyのpreview選択を追加してe2e型検査を通し、変換済み`web-dist`を配信して同じUI操作・実IDB・完全再起動を確認した。app sourceとassetsは変更していない。このtest-harness1fileの変更は、先のroot全単体／通常起動runの後であり、先のsource snapshotへ遡って含めた扱いにしない。

通常識別子のrelease版はdebug用`PAPEER_E2E_DIR`を使わず、同Windows accountのknown folders／WebView profileを使用する。NSISの別directory指定だけでも既存登録・shortcutと衝突するため、当初は別Windows環境を想定した。[B1事前調査](../checkpoints/shared-app/2026-10-29-p0/p1-build-install-preflight.json)は当時の根拠を保持する。別環境がないとの回答後に用意した同PC専用版は§13。この環境でWindowsSandbox.exeが見つからなかった観測だけで、機能全体が使用不能とは断定していない。

67要件のaccepted0／partial47／unverified20は維持。既存license inventory問題はP7、旧全機能composition fixtureの新owner認可への適応はP2/P5へ追跡する。実ユーザーのLibrary／Driveの移行や全機能の完了ではない。

## 13. 2026-10-29 B1のインストール・実画面確認完了

**現在地はP1・B1技術確認完了、次はP2。** 正本TODOは計画書第3節のみ。次の大きな区切りは、Native／browser bootstrapの早期構成整理から、PDF・注釈・検索・出力の残接続／検証、P2.C、B2更新インストールまでとする。本人による試用感想はまだ未記録だが、許可済みの後続実装をそこで止めない。

同じPCに`Papeer Shared Trial`をインストールした。IDは`local.paperdesk.shared-trial`、exeは`output/shared-trial-install/papeer-shared-trial.exe`、Nativeは`output/shared-trial-runtime/`、WebView／window stateは同専用IDのknown foldersを使う。通常版は停止・更新していない。固定workspaceとmarkerを検証するentryを同じexeに組込み、shortcut／直接起動も同じguardを通す。source全体の複製を増やさず、`tools/trial/`の小overlayで通常Rust libraryと同梱sidecarを再利用した。

配布試用で二つの問題を発見・修正した。試用configのWindows絶対`frontendDist`がfile URLと解釈される問題は相対directoryへ修正。さらに本体の初回確認がsidecarのHTTP準備より早く失敗する競合を、Nativeのreadonly起動要求だけ200ms間隔で待機する修正で解消した。既存10秒deadline・キャンセル・hold／旧データ検査は維持し、HTTP 401／403／500や不正JSONは再試行せず起動を止める。配置は`adapters/desktop/startup/`。起動競合の再現・再試行成功は`startup-diagnosis-r2`、修正は`startup-fix-r1`。

修正後の型4系統・lint・全単体1,543成功／1 skip／失敗0、Desktop build、NSISは`build-r4/result.json`。独立source／compile input／installer reviewも成功。NSISは57,608,718 bytes、SHA-256 `04c1934ef92b4fa45df71cab4c3578f5c08ec7bb98a68a37d969efe459f04643`。インストール済みGUIは既知NSIS markerの3bytesだけをrawから変えた完全一致を確認し、sidecar全1,033fileも照合した。結果は`replace-r4/result.json`。

実画面の`gui-r7/result.json`は成功（118.30秒）。再試行なしの初回起動→Library／白紙ノート作成→A耐久→B耐久→Undo(B)耐久→所有processを完全終了→同じ保存先／profileで再起動→同scope／note／3batch／receipt／AのIDとSVGを読戻し照合した。最後はWM_CLOSEでapp／同梱sidecar／portが強制cleanup前に消えることを確認。復元画面も目視確認した。通常版のNative／設定／IDB／localStorage等25,785保護対象fileのmetadataは不変。稼働中の通常版が更新する固定6群のHTTP／GPU cacheは別に記録し、全metadataが不変とはしていない。

試用版・データ・profileは残し、検査用processは終了済み。[起動方法と対象操作](../output/shared-app-builds/2026-10-29-b1-trial/README.md)、[checkpointの入口](../checkpoints/shared-app/2026-10-29-b1-trial/README.md)を参照する。旧runの失敗、旧manifest、通常IDのNSIS／Web ZIP、前source ZIPは書き換えず保持した。Webの配布物と両engineでのB1成功も維持。本体変更はDesktop entryと新helperだけで、Native／Web app sourceは変更していない。Google新規接続・AI操作・実データ移行・全67要件・別Windows機の検査はこの完了範囲に含めない。

## 14. 2026-10-29 P2の共通PDF経路・構成整理とB2更新

現在のsourceはroot。Sol 6.1／Terra 6.1で実装・独立レビュー・通常entry検査を分担し、[P2 checkpoint](../checkpoints/shared-app/2026-10-29-p2/README.md)に証拠を集約した。P2全体を完了とはしていない。大分類／小分類の正本は計画書第3節で、確認済みの部分だけを小項目で完了にした。

### 14.1 接続と実ファイルの構成整理

通常UIからPDFを取り込み、実resourceのbytes／hash／CropBox・Rotate・UserUnit等の物理情報を使って保存・公開する。全7toolと選択／copy／paste／部分消去／Undo、色・太さ・favorite・指描画設定の永続化、lock／非表示、Unicode検索・目次・安全なlinkを既存共通sessionへ接続した。検索markはtext item単位。指描画は既定off、二指目でpreviewを取消してpinchへ移り、残contactをdrainする。実機pen受入とは区別する。

共通snapshotは全pageの確定済みローカル編集を出力開始時に固定し、workerとhostから注入したfont／保存／clipboard portへ渡す。UIからWorker／storage／fetchを直接取得しない。元PDFの文字・vector・物理情報と注釈、日本語、PNG切抜きを実出力で確認した。付箋／highlight commentはPDF Text noteで、Highlight subtypeではない。UserUnitによるtext layerの0.8倍ずれを実選択から修正。CFF埋込の実font障害を保全し、静的Noto TrueType2書体の全体埋込へ変更、PyMuPDFの文字抽出・raster・警告なしを確認した。

早期整理ではbrowser ownership9moduleを`adapters/browser/ownership/`、Native bootstrap5moduleを`papeer/core/bootstrap/`へ移した。前後の関連75件／74件、原本hashとpath mapを照合。続いてPDF surface／document／rendering3moduleを`reader/pdf/`へ移し、consumer等20pathと7起点のmodule graphの同値を確認した。新しい出力責務は`reader/output/`と`reader/pdf/export/`。直下の大量sourceを任意の数で分割せず、次はreference群5module＋対応test3fileを整理候補にした。残るink／input／navigation／編集sessionと旧callerはP2.Cb・P6で追跡する。

### 14.2 検証済みのsourceと配布物

`standard-r2/result.json`は全単体1,586成功／1skip／失敗0、型4系統・lint・Desktop／Web build成功。`native-r2`は197件とAPI整合5件、pyright／ruff成功。後続frontend2pathのみの変更は`native-final-compatible-proof.json`で全backend bytes／bundle version不変を明示した派生証明にしており、Native再実行と混同しない。

開発中の通常Webは一つのrunで12case成功。さらに変換済み`web-dist`の両engineで12case成功し、console errorはmanifestも含め例外なし。Desktop400／Web401fileと入力pin1,755pathが前後不変。全tool／設定と同ID再起動、実PDF metadata、検索anchor、trusted touch／pen、全注釈／日本語出力、PNG pixelとChromiumの実clipboard拒否時downloadを確認した。

B2初回入力pinは`b2-build-r2/frozen-inputs-final2.json`、SHA-256 `959f2654d5957708de711af0b4bf88e1aa8f3e3c4877f096df830955fe3d5974`。frozen sidecarのbuild／smoke／notice確認後の配置WinError5は旧sidecarを戻した失敗stageに保全し、同じsmoke済みbundleを通常ユーザー環境で配置してNSISを完成させた。通常版のinstallerは不変。

試用NSISは65,277,473 bytes、SHA-256 `e2fd45cadc31c47e1297ffaa12d58d18d386c7e944b5068407cdecd75393d03b`。独立artifact review2件と親のbyte照合を確認。旧試用版だけを`/S /UPDATE`で外し、runtime／profileの前後完全一致後、同じ固定pathへ新しい試用版を入れた。GUIはrawの固有NSIS marker3bytesだけが異なる完全一致（installed SHA `3962d7a1724a4d3b05dc774dabe1baf4dd193281d93e65cbc41ceee4355b32b4`）、同梱sidecar全1,033fileも一致した。

インストール後の最初の検査はWebView profileの直下だけを許したため、実際の`EBWebView`子directoryを誤拒否した。旧失敗を残し、厳密な既定rootまたはその固定子directoryだけを認め、installer→GUI→WebView／sidecarの実PID・作成時刻・portと通常版registryを読み取りで再照合した。再インストールもprocess停止も行わず、`install-r1-reconcile`でmanifestを公開した。

installerの`/R`による自動起動と、本物のStart Menu shortcutのShellExecuteEx起動を別々に確認。両方で実画面のLibrary pickerと以前の`Installed trial library`を確認し、computer-useのAlt+F4後にGUI／sidecar／専用profile process／portが自然消滅することを記録した。通常版は停止・更新していない。

### 14.3 配布版固有のCSP修正と実操作の完了

最初のNative PDF検査は、取込後のverified Blob URLをPDF.jsが読む際に`connect-src`が拒否し、canvas表示に失敗した。`installed-pdf-r1/run-r2`のconsole／requestfailedとsource経路で原因を確定した。rootと試用overlayのCSPへ`blob:`を一つずつ追加し、他のJSON値は同一。Rustの既存CSP検査にBlob許可と実port限定維持のassertionを追加し、offline1件とfmt checkが成功した。

最終pinは`frozen-inputs-final3.json`、SHA-256 `67cfd2e81363231d9d83cdb07bb4c0da47568fa44d61a1aedabaa7a1d2860a34`。差分はCSP2fileとRust検査1fileだけ。frontend source／全配布asset／Python同梱物は同一で、`csp-final3-*-compatible-proof.json`で標準検査への派生証明を明示した。再実行と称して以前の件数を流用していない。同じsmoke済みsidecarを再利用し、試用Rust／NSISを再ビルドした。

最終NSISは65,284,767 bytes、SHA-256 `4683892c459f30f911afcce7bf064effaa8a8a0501dea00db4a89eff8a8c5aa0`。独立artifact review後に既存試用データを残して更新。installed GUIのSHAは`089485a742edc32a9ea1cb96dcc3cd2252b2b91e6dd38c1353188fd9418a91c5`、同梱sidecar全1,033fileを照合。起動中のWebView cacheの共有lockでpost-launch全hash読取だけが失敗したため、旧失敗を残し、pre／post-uninstall完全一致・実payload・親子process・専用profile・通常版registryを再照合してmanifestを公開した。通常終了後の全inventoryも取得し、library不変とinstance記録・cache／window stateの起動終了による変化を区別した。再インストールを繰返した扱いにはしていない。

`installed-pdf-r1/run-r3`は**実case1件成功（239.91秒）**。通常UIでPDF取込→線・日本語・付箋を耐久保存→Windows native dialogでPDFとPNGを新規保存→PDF保存をcancel→全所有processを終了したcold restart→同scope／document／resource hash／全batch・receipt・注釈を復元→通常終了を確認。dialogと最後のAlt+F4はcomputer-useで実操作し、検査用ackで代用していない。出力PDFの物理page情報、日本語抽出と付箋commentを独立読取し、PNGも目視確認した。失敗したURI指定のrun-r1とCSP拒否のrun-r2はそのまま残す。

`installed-navigation-r1/run-r1`は**別の実case1件成功（132.25秒）**。通常UIで取り込んだPDFのUnicode4hit・同pageの2anchor・目次・内部link・安全な外部link属性を確認し、閲覧中のedit batchは0。続けてA保存→B保存→Undo(B)の3batch／receiptを耐久化し、完全再起動後に同ID・同resource・Aだけを確認。実外部URLは開いていない。checkpoint scenarioは既存harnessのowner／profile／保護metadata検査を再利用し、実行したscenario・runner・preloaderのhashを追加して前後照合した。constructor用source anchorを実行したという主張はしていない。

最終artifactでもinstaller自動起動と実OS shortcut起動を確認し、Library pickerにP1および今回の成功libraryが保持されていることを目視確認。いずれもAlt+F4後にapp／sidecar／profile process／portが自然終了した。検査用processは残していない。通常版のGUI PID27744とsidecar PID1544は元のpath／作成時刻のまま稼働、registryも不変。実操作2caseの通常版25,785保護fileのmetadataは不変で、固定6群のcache変化は別記録。試用版と試用データは残す。[起動・試用手順](../output/shared-app-builds/2026-10-29-b2-trial/README.md)と[source保全manifest](../checkpoints/shared-app/2026-10-29-p2/source-snapshot-r1/p2-final-source-manifest.json)を参照する。

### 14.4 次の大きな区切り

次はP2の残る通常entry証拠と構成整理を一まとまりに進めてからP3へ移る。[残件map](../checkpoints/shared-app/2026-10-29-p2/remaining-evidence-r1/README.md)にREF01〜12の既存unit／旧fixtureと不足する実操作を対応付けた。通常PDFの固定参照・独立zoom・clear・guard・再読込、引用／画像／注釈追記の同ID retry、原訳・混在page・翻訳filter・検索の遅延／失敗、reference群の構成整理が次の対象。Windows navigationの今回確認分は残件から除いた。旧privileged replication fixtureの403はP5.1へ連携し、認可を緩めない。

P3/P4でノート／Markdown・Library／設定、B3で再び試用更新。その後もP5/B4の同期、P6/B5の移行と旧責務撤去、P7/B6の全受入へ続く。各Cでsourceと対応testの構成を実際に見直す。67要件はaccepted0／partial47／unverified20を維持し、本人の感想・別Windows機・実機入力・Google新規接続・実データ移行・fontkit内包依存を含む完全license inventoryを未確認として残す。

## 15. 2026-10-30 固定参照・訳文PDF・追記と追加B2更新

**今回のWeb20case・更新install・新しいinstalled実1caseと通常終了は成功。** 正本TODOは計画書第3節。現在の証拠索引は[2026-10-29-p2-references](../checkpoints/shared-app/2026-10-29-p2-references/README.md)。日付名は着手日の10-29を維持している。§14のWindows実2caseは先行B2で、今回の実1caseと分けて保存している。

### 15.1 共通実装と早期の構成整理

reference5moduleを`frontend/src/features/reader/reference/`、対応3testを`frontend/tests/reader/reference/`へ実移動した。17pathのbefore hash／map、9起点の依存graph同値、再帰収集216→216、同じ関連55件の前後成功を確認。台帳はpath2箇所のみ更新し、要件と状態を変えていない。Reader直下は131→126file。現在の再帰169fileには後続の訳文追加も含むため、移動だけの前後比較とは扱わない。大量sourceは残っており、navigation等の次の限定群と対応testをP2.Cb／各PのCで整理する。

通常入口に訳文PDFのproducerがなかったため、`reader/translation/`へ取込session・hook・controlsを追加した。repositoryでPDF metadata／bytes／hashを検査し、各訳文ページの対応先または対応なしを明示する。既存DocumentEditSessionの一回の編集とjournalを使い、準備時の原文版・head集合、同ID retry、入替え前のpool／注釈とUndo、draft／離脱guardを維持する。9件の実repository単体試験を追加。独立reviewで二重submit競合、実WebKitで保存後refresh中のready待ち不足を見つけて修正した。AI翻訳serviceの接続とは別の手動PDF取込である。

### 15.2 凍結sourceと実際の検証

`b2-update-r1/frozen-inputs-final2.json`は1,765path、SHA-256 `ccc8ad8764347525b50e0beed8745931e494fbf7b915837edb7568fe67669ad8`。`standard-r2/result.json`でfrontend単体1,595成功／1skip／失敗0、型4系統・lint・両build、Web401／Desktop400assetを確認した。backendは同一source／bundleを照合した派生証明で、先行Native197件・API5件の新規実行ではない。最初のlint失敗と修正前pinも保存している。

`built-web-r1/result.json`は一回のcompiled corpusでChromium／WebKit計20case成功、失敗／cancel／skip0、442.45秒。前後の全pin／両assetが不変、13個のPDF／PNGを実読戻し・hash照合した。console／page errorの除外はない。固定参照のpin／replace／独立zoom／resize／mainとback・forwardのroute ID保持（place情報を除く）／draft中の解除・Library離脱拒否／再起動での破棄、疎な原訳mappingと訳文検索／書込み／入替えUndo／再起動、引用・画像・注釈追記の実IDB失敗・同ID retry／publication再起動回復、目次なし・resource取得失敗とretry・pending queryの切替を含む。worker内部parse開始を独立観測したことにはしない。

### 15.3 更新installと画面ツールによる保留

新しいNSISは65,304,258bytes、SHA-256 `abf12c1de9cfeb7b268bac65275ceaaed2137fd367b5d6004fc3fb8162d9edc4`。凍結sidecar／bundle全1,033fileは同一性を確認して再利用した。独立artifact review後、試用版のみを更新しpre／post-uninstallのデータ／profile保持を照合。最初のinstall runnerは更新後の広いWebView path確認で失敗し、原因processは特定できていない。再install・killはせず、独立review済みの所有範囲照合で`install-r1-reconcile/result.json`を作成し、manifestを公開した。インストール済みGUI全bytesのSHA-256は`5349134efbc22a42cb4979ccdcf86e5e59e3652ba5cd6adc31fb28fbada2fe30`、payload全件と通常版registryは一致。

Skyのactivateは再選択後も `failed to activate captured window` となったが、ユーザーの手動前面化後に実Library pickerを新しく観測できた。SkyのAlt+F4で自然終了し、実owned process／port消滅と終了後full inventoryを確認。runtimeは更新前と同一、WebView／window stateは通常起動・終了による変化、通常版registryは不変だった。ロック状態を断定していない。

新しい`frontend/e2e/tests/trial/installedReferences.test.ts`のrun-r1は参照欄の可視PDF canvasと非表示canvasを区別しないselectorで失敗した。原本を残し、1行だけを絞ったtest（SHA-256 `421309fb2cc0eaaadb1f12a259a695d62a03c7686bef28fd6aba768b82f19a75`）をE2E型検査・独立review。`installed-r1/run-r2.py`がそのexact差分以外の全pin／両asset／配布物を照合し、再build／installせず実行した。**run-r2は実1case成功、124.31秒**。原訳resource／訳文注釈／固定参照／draft guard／UI作成MarkdownへのPNG追記／Native receipt／完全再起動後の同ID・bytes／通常終了を確認し、独立読戻しを完了した。PNGは白い領域の切抜きで、画像append・耐久化・decodeの証拠に限り、内容のあるPDF切抜き品質の証明にはしない。Gothic font警告も記録した。Nativeの失敗注入は未実施。

実case後のfull inventoryは`b2-update-r1/post-installed-case-r2.json`。新規test Library／編集によるruntime等の変化と、通常版registry不変、全記録process／port終了を確認した。続いて独立review済み`shortcut-r3.py`で実Start Menu shortcutを起動し、同GUI／sidecar／専用profile／CDP所有関係を照合。Skyで旧4件＋今回2件のLibrary一覧を目視し、Alt+F4で通常終了した。`shortcut-r3/normal-close.json`で全所有process／port消滅、runtimeの実case後との完全一致、GUI／sidecar全件・通常版registry一致を確認した。WebView／window stateの通常起動による変化は別記録。先行runnerの全WebView path必須条件は、実trial GUI／所有祖先／profileに限定して検査する形へ修正した。PIDは観測時点の値として扱い、以前の通常版PIDが現在も生存しているとは主張しない。

### 15.4 配布物と残る担当

[今回の試用版](../output/shared-app-builds/2026-10-30-b2-references/README.md)にinstaller・Web ZIP・全member hashを置いた。Web ZIPは401member、CRCと全hash検証済み。source保全は今回checkpointの`source-snapshot-r1/`で管理し、先行P0／P1／B1／B2の原本ZIPを維持する。

追加Native確認の後も、[REF残件map](../checkpoints/shared-app/2026-10-29-p2-references/reference-r1/scope-r2.json)のローカル組合せはP2、mixed paper／PDFの通常作成はP3、旧privileged replication fixtureの403はP5、旧caller撤去はP6、物理pen／iPad等と完全license棚卸しはP7へ残す。scope-r1は実行前の履歴として維持。全67要件はaccepted0／partial47／unverified20。大分類の各Cでdirectory構成を見直し、P3／P4後のB3、同期後B4、移行後B5、最終B6へ継続する。

## 16. 2026-10-30 navigation整理・通常遷移の追加検証と参照位置修正

現在のcheckpointは[2026-10-30-p2-completion](../checkpoints/shared-app/2026-10-30-p2-completion/README.md)。正本TODOは計画書第3節のみ。P2全体の完了や、§15のインストール済みB2と同一sourceという意味ではない。

### 16.1 実ディレクトリ整理と証拠の集約

`ContentNavigationSession`／`ContentNavigationContext`／`readerCommands`／`readerHistory`／`readingPlace`／`useDocumentReadingPlace`／`useDocumentCompanionPlace`を`reader/navigation/`へ移し、対応4testを`tests/reader/navigation/`へ移した。49pathのmap／before保全、同じ38件の移動前後成功、境界込みpost49件、unit収集217→217、9起点のgraph同値を確認。独立reviewで見つかったcomposition fixtureのdynamic importも追従した。旧store依存の`navigation.ts`はP6へ残す。後続の位置修正は別差分であり、最終sourceのgraph全体が移動前と完全同値という主張にはしない。

受入台帳は現行evidence path15箇所のみ更新し、逆path変換で元のJSON objectへ完全に戻ることを照合した。要件／状態と67件の集計は不変。Reader直下は126→119file。検証用に作ったbaseline source576fileは前回原本ZIPと一致することを確認し、全member hash／CRC検証済みの単一ZIPへ集約して元の重複treeを削減した。49件のtargeted backup・旧map／graph／collector証拠は保持し、再現時の展開手順をcheckpointへ記録。誤ってfrontend配下にできた空directoryも検証後に除いた。

### 16.2 参照位置の不具合と限定した修正

自然なWebKit操作で、native scrollTop350の直後にviewportをresizeすると参照がtop0へ戻るケースを観測した。一方、通知の間に合った自然実行は成功しており、常時再現とは扱わない。旧measurementが無効になる前にscroll通知が届かない順序を、同じ参照scrollerの通知だけを限定保留して固定した。trusted wheelと実scrollTopは変更せず、synthetic scrollやprivate writer／sessionへ操作していない。

修正は`referenceRestoreDecision.ts`と`useDocumentReferencePlace.ts`。受理済みsettled PaneViewを保持し、新しいcurrent measurementでresizeを検知したとき、旧geometryと最新native offsetから位置を再構成する。lease／landing target／releaseでcacheを破棄し、pending zoom／restoreへ割り込まない。target／pane／producer／zoom／generationの拒否条件は維持。旧geometryなし・無効値・layout clamp・独立axisの3単体caseを加え、関連10件成功を確認した。

同一test hashのWebKit通知保留caseで、修正前は51.74秒で失敗（top350→0）、修正後は24.56秒で成功（新しいheightでtop312、正規化した位置を保持）。[独立fix review](../checkpoints/shared-app/2026-10-30-p2-completion/fast-resize-r1/independent-fix-review.json)に記録した。未通知の移動と新しいscroll上限でのclampを完全には区別できるという主張はせず、実機・全clamp境界は残す。

### 16.3 通常画面の追加caseと最終検証

source-devの追加caseで、別参照resourceの実IDB read abort／retry、draft中の資料切替拒否と成功後の参照破棄、実edit abort中の参照／資料／Library guard・同一batch retryと一回の耐久保存を両engineで確認した。原訳遷移は32page原文／2page訳文をUI取込し、pending読取中の両方向pool切替、最新poolの検索結果、疎／複数候補／全対応なしと空filter、入替えとUndo、古いpinへの自動再binding拒否・明示repin、5操作／receiptの完全再起動復元を確認した。worker内部parse段階の観測とは別である。

初回固定入力1,769項目の`standard-r1/result.json`で単体1,598成功／1skip／失敗0、型4系統・lint・両buildが成功。Web401／Desktop400asset。その後E2E2本の診断・準備完了待ちだけを変更し、現在の入力は同じ1,769項目、SHA-256 `dc0e005741ab49a72d9e8b593dc92153e2f0bbf0274f35dd9e9319357336d540`。`std-compatible-r2.json`で残る1,767入力／全asset不変と新しいE2E型検査成功を結び、全標準検査の新規再実行とは扱わない。非frontend483項目とbundleも同一で、Native197／API5は派生証明であり新規実行ではない。

関連する7suite／compiled16caseの初回は14成功／2失敗。既存PDF navigationのWebKitは4hit待ち、追加lifecycleのChromiumは訳文canvas待ちでtimeoutした。catch診断を加えた単独compiled実行では各caseが成功し、初回原因は未確定のまま保存した。PDF描画／訳文登録の完了後に対象操作へ進む準備条件を明示し、hit／anchor／guard等の判定は維持した。**新しい固定入力の`built-web-r2`は全16case成功、305.21秒、失敗／cancel／skip0**。全入力・両asset map不変とstrict console（manifest除外なし）を確認し、独立reviewも完了した。初回失敗を成功へ書き換えず、今回も実機／新しいNative installerの受入とは扱わない。

### 16.4 次の区切り

今回のcompiled検証は完了。次はP2.1jのpin中の通常catalog論理削除と入力所有、input／ink群の限定整理へ進み、P2出口を判定する。競合head selectorは複数headがある場合にだけ現れ、single-headのUndoをcheckoutの証拠に使わない。混在pageと同一IDの原文背景入替えはP3、remote head／mergeはP4／P5、旧責務撤去はP6、物理機器はP7へ残す。

今回は両frontend buildとcompiled Web検証を行い、NSISは更新していない。インストール済み試用版は§15のsourceで通常終了済み。次の予定更新installはP3／P4後のB3で、配布固有の障害・大きなUI変更があれば計画§7.5の中間packageへ前倒しする。本人の試用感想と全67要件の最終受入は未完のまま。

## 17. 2026-10-30 入力／inkの構成整理とP2ローカル区切り

最新checkpointは[2026-10-30-p2-input](../checkpoints/shared-app/2026-10-30-p2-input/README.md)。TODOの正本は計画書第3節。今回もSol 6.1／Terra 6.1で実装・検証・独立レビューを分担した。

### 17.1 責務別の実移動

input9module／3testを`reader/input/`／`tests/reader/input/`、PDF・ノート共通のink geometry／draft／interactionの3module／3testを`features/ink/`／`tests/ink/`へ移した。29／41pathのmapとtargeted backup、同じ43／57関連caseの移動前後成功、13／7起点graph同値、合成path mapでunit収集217→217を確認した。inputのpost collectorはink移動も反映した時点のため、input単独snapshotとは扱わない。独立reviewで全backupと現在source、dynamic import・境界・受入pathを照合し、同じpointer owner／sessionを維持している。受入台帳はpathのみ追従し、要件／状態は不変。Reader直下119→107file。

全baselineの作業コピーは増やさず、必要pathだけを保全した。編集session／履歴のdirectory整理は未完であり、P3開始直後のP3.Caへ継続する。legacy callerはP6で撤去し、source全体の整理完了とはしない。

### 17.2 通常画面の有限な追加操作

UI取込したpin対象のcatalog論理削除を、文字draftによる拒否→cancel後の成功→完全browser再起動まで確認した。editor／参照は消え、文書root／batch／receipt／PDF bytesと論理削除記録は保持した。左右の原文／訳文／readonly参照ではChromiumの実trusted pen／touchと全接触の解放待ち、touch cancelで誤保存しないことを確認。WebKitはmouse保持中のfocus／keyboard切替拒否と解放後の描画のみで、同時pen／touchや物理penの受入ではない。

参照page1の赤線・主page2の緑線を出力し、PDFは正確に2page・赤／緑pathは各該当pageに一つずつ、主page PNGは緑あり・赤なしの非白画像と独立読戻しした。pinを開いたまま主page2の本文をMarkdownへ一回だけ引用し、citationとhighlightもpage2だけへ保存した。参照にwriterはない。source-devの初回passage selector失敗は残し、portalの状態表示の探索範囲だけを修正して両engineで確認した。実本文選択の主page限定は維持している。

### 17.3 凍結sourceと実際の最終検証

初回固定入力は1,773項目、SHA-256 `d55cc60c4858a1d49252b566f78cb31b77dc1c9ee11ee04aafc79933b09ff122`。`standard-r1/result.json`で型4系統・lint・全単体1,598成功／1skip／失敗0・両frontend buildが成功。Desktop400／Web401asset。その後E2E一本だけに準備条件・診断を追加し、最終pinは同じ1,773項目、SHA-256 `c3d3abc3fcff6b2d25311ffb6a3e841332a34eeae3b1e16933a8bf1dab80f859`。`std-compatible-r2.json`で残る1,772入力・全asset同一性と新しいE2E型検査・追加の単独lintを結んだ。app／node／unit型・configured lint・全単体・両buildは初回成功から継承し、新しい全標準検査の実行とは扱わない。

`built-web-r1/result.json`は8suite・実15case中13成功／2失敗、327.13秒。失敗は両engineとも引用後の二度目の選択開始でtimeoutした。全1,773入力と両asset mapの前後不変を確認し、失敗をそのまま保持した。診断追加だけのcompiled2caseは成功したがcatchが発火せず、最初の原因は未確定。dialogの消滅待ちと主page text layerの実focus確認を準備条件に加え、本文8文字・正しいcitation／一度の追記・highlight保存先・参照readonlyの判定は維持した。

`built-web-r2/result.json`は変更したpassageの2caseだけを再実行し、2成功／失敗・cancel・skip0、39.08秒。最終pin全1,773入力／両asset map不変、strict console（manifest除外なし）を確認した。先行13成功のsuiteは変更がなく、上述の完全同一性で継承している。単一runの15成功とは記録せず、旧16／20case・source-dev・診断の成功件数とも合算しない。実4個のPDF／PNGは初回runの成果物で、独立読戻し済み。

`backend-compatibility.json`で非frontend483入力とbundle／sidecar1,033fileの同一性を確認した。Native197／API5は先行成功からの派生証明で、新規実行ではない。新しいNSISやインストール版で今回sourceを操作した証拠はない。原本は`source-snapshot-r1/`のsource-only ZIPとmanifestへ保全し、前回までの11原本ZIPを保持する。

### 17.4 区切りと次の予定

有限なP2出口レビューの条件を満たし、次はP3.1と早期P3.Caへ進む。混在paper／PDF・同一IDの原文背景変更はP3、競合head／remote採用はP4／P5、旧privileged fixture403はP5.1a、unknown保存と参照commandの未確認組合せは共通recovery／P5.2b・P7、旧callerはP6、物理機器・精度境界・完全license監査はP7に残す。P1の実Native応答消失と今回Web IDB abortは別証拠で、abortをunknownと扱わない。全67要件の状態は不変。

小分類ごとには止めず、通常ノート作成・page構成と早期の構成整理を一まとまりにする。その後Markdown／編集所有、P3末尾の両frontend build、P4.C後のB3（sidecar込みbuild→隔離試用版のデータ／profile保持更新→通常起動・保存・再起動）へ続く。現在のインストール済み試用版は§15の追加B2 source。配布固有の問題・大きなUI変更は計画§7.5の中間packageで前倒しする。

## 18. 2026-10-30 ノート構成・用紙・PDF混在と早期の構成整理

[今回のcheckpoint](../checkpoints/shared-app/2026-10-30-p3-notebooks/README.md)を入口にする。大分類・小分類TODOは計画書第3節のみ。Sol 6.1／Terra 6.1で実装・操作検証・独立レビューを分担した。

### 18.1 構成整理と実装

文書の編集sessionとhistoryを`reader/edit/`、対応2testを`tests/reader/edit/`へ移した。36pathをtargeted backupとmapで保全し、同じ79件の前後成功、収集217→217、6起点graph同値、型3系統と独立reviewを確認。広いscopeのregistryと競合sessionは別責務として残し、owner／journal／履歴は増やしていない。後続producerの依存追加は移動前graph同値性とは区別した。Reader直下107→105file。

ノート内の原文poolへ、検証済みPDFの指定物理pageを追加、または同じpage IDで背景を差し替える入口を接続した。resourceのbytes・SHA・解析metadataを保存し読戻した後、既存DocumentEditSessionへ一操作を渡す。scope／generation／version／head集合／page expectation／contactを再検査し、準備中の離脱・二重submit・stale・cancelを保護する。ink／付箋の実寸を保持する実装で、本文highlightがある場合と新しい寸法からはみ出す場合は差し替えを拒否する。古い原訳mappingは自動更新しない。6つの単体でink保持／overflow・highlight拒否・resource読戻し失敗からのretry・stale・競合submit・cancel等を確認した。新規の付箋fixtureはなく、全注釈組合せの実行証明とは扱わない。

### 18.2 通常画面の実操作

両Web engineでノートをUI作成し、描画A→ページ複製（page／annotation ID新規）→追加→並替→描画B→内容のあるpage削除→6回Undo／6回Redo→実IDB構成transaction abort→全intent保持・同batch／historyのretry→完全browser再起動を確認。全19耐久操作の順序・ID・内容・削除pageの保持と、部分適用がないことを照合した。

用紙の罫線・色変更は物理座標とstyleを保持。負寸法とA5縮小によるoverflow拒否は耐久状態を変えず、明示fitは等方縮小を実データから検査し、Undo／Redo・再起動後の寸法と設定を確認した。混在ノートでは紙・PDFの別page、実resourceのhash、PDF上のink、同ID背景変更、古いpinを新背景へ付け替えないこと、Undo／Redo、再起動後の両resource・全batch・pageごとのinkを確認した。

source-dev初回は4成功／2失敗、259.73秒。両失敗は最後の紙page確認でmainとreadonly参照の2要素をglobal selectorが拾ったstrict違反。原本を残し、最後の2selectorだけを主ペインへ絞った。判定値や製品実装は変更していない。source-devのmanifest診断除外は開発起動限定で、以下のcompiled検証へ適用していない。

### 18.3 固定sourceの検証と保全

固定1,780入力のSHA-256は`adb233ee1f08b655507bf5756bcd7323f2732252597d76e490733756d57981c3`。`standard-r1/result.json`で型4系統・lint・単体1604成功／1skip／失敗0、Desktop／Web buildが成功。assetはDesktop400／Web401。今回は同じ最終pinに対する標準検査の全実行で、互換証明による省略ではない。

`built-web-r1/result.json`は新規ノート3suiteと既存固定参照の計4suite・実8case、216.58秒、全8成功／失敗・cancel・skip0。通常のbuilt previewとstrict console（manifest除外なし）、全source入力／両asset mapの前後同一性と独立読戻しを確認した。旧P2の16／20caseや先行13＋2caseとは合算しない。

backendは非frontend483項目と同梱sidecar1,033fileの同一性による派生証明。Native197件／API5件の新規実行や、今回のNative installer／設置済み版の操作確認ではない。最終文書を含む原本は`source-snapshot-r1/`へ保全し、前回までの12原本ZIPも保持する。全baselineの作業コピーは増やさず、今回の36path backupを保持する。

### 18.4 残る範囲とインストール予定

今回はノート内PDFページに限定した入口で、単独PDF資料の背景更新や全page一括取込を完成したとは扱わない。残る用紙の向き／境界・複数注釈の組合せ、Markdownのautosave／remote競合、中央／panelの所有はP3.1c／d・P3.2／P3.3へ継続する。notes群のdirectory整理もP3.2着手時に挟む。全67要件の状態は不変。

今回の両frontend buildと、Nativeの更新installは別の区切り。P3全体の出口でも必要なbuildを確認し、P4.C後のB3でsidecar込みbuild→隔離試用版のデータ／profile保持更新→通常起動・保存・再起動を行う。現在の試用版は§15の追加B2 sourceで、今回の変更を含まない。大きなUI変更や配布固有の問題は計画§7.5に従って中間packageを前倒しする。

## 19. 2026-10-30 単独PDF背景・一括取込・用紙検証とP3.1の区切り

[最新checkpoint](../checkpoints/shared-app/2026-10-30-p3-background/README.md)に実result・source hash・独立reviewを集約した。TODOの正本は計画書第3節。全P3や67要件の受入は未完。

### 19.1 共通の取込責務と通常操作

ノート専用だったPDF取込のsession／hook／controlsを`reader/pdf/import/`へ移し、DocumentPdfImportの役割名へ変更した。対応testも同じ責務へ移動。7pathのbefore保全、同じ17件前後成功、収集218→218・6起点graph同値を記録し、beforeからhistorical after全7件を再構成してSHAを独立照合した。背景変更／bulk追加後の挙動差分は、移動時の同値性と分けてレビューしている。新しいwriterは作らず、既存DocumentEditSessionとresource repositoryを使う。

単独PDFは原文poolの現在pageの背景だけを差し替える。ノートは指定pageまたは全PDFpageを後へ追加でき、全pageは一つのordered batch・履歴へまとめる。source／head／scope／contact等のguard、verified bytes／metadata／readback、stable ID、500page上限、既存ink／付箋の実寸保持を維持。本文highlightのあるpageと新寸法の範囲外annotationは差し替えを拒否する。9つの取込単体が成功した。

通常画面では両engineで単独PDFのink／page ID・全resource保持、古いpinと原訳対応を新背景へ自動で付け替えないこと、明示再対応付け、対応と背景のUndo／Redo・8耐久操作・完全browser再起動を確認。一括追加は実IDB transaction abortで両pageとも部分適用されず、同batch／historyをretryして一度だけ耐久化し、両page一括Undo／Redo・4耐久操作と再起動を確認した。

### 19.2 用紙の向き・境界と診断

ペン・日本語ink文字・付箋を持つ用紙で、横向き変更のoverflow拒否と明示fit、zero／下限未満拒否、実annotation境界でのcustom寸法、物理線幅・座標保持、2回Undo／2回Redo・9耐久操作と再起動を確認した。quad／anchorの順序・centeringと拡大先でのno-upscaleは2つの追加単体で検証した。紙highlightには通常UIのproducerがなく、単体のquadsを通常操作の証拠へ読み替えない。

source-dev初回は4成功／2用紙失敗、196.078秒。新規用紙595.28×841.89ptと、A4 presetの厳密なmm換算との差を無視してtestが210／297固定比率を期待していた。実際の値で観測差を正確に再現できたため、testはUIの送信寸法と保存済み元寸法から期待scale／dx／dyを算出するよう修正した。1e-7の許容誤差と全annotation判定は維持し、製品コードは変更していない。修正後の用紙2caseのsource-dev実行は別記録。開発限定のmanifest診断除外はcompiledへ適用していない。

### 19.3 最終固定sourceの検証と保全

最終1,784入力、pin SHA-256 `57fdbf76ba66c4002af86eecfa51b8c0aa60dd638a607706df0b7096e71c0ee3`。`standard-r1/result.json`で型4系統・lint・単体1,609成功／1skip・失敗0・両frontend buildが成功した。Desktop400／Web401asset。今回は同じ最終pinへの全標準検査で、過去のfrontend成功からの互換省略ではない。

`built-web-r1/result.json`は新規3suiteと先行のノート内PDF回帰、計4suite／実8caseが全件成功、207.01秒、失敗／cancel／skip0。strict built preview、manifest除外なしのconsole／page error、全pinと両asset mapの前後一致を確認し、独立読戻しした。別runや旧P2／P3のcase数は合算しない。

backend483入力とsidecar1,033fileの同一性は派生証明。Native197／API5は新規実行ではなく、今回のNative installer・設置済みアプリでの操作も未実施。最終文書を含むsourceは`source-snapshot-r1/`へ保全し、前回までの13原本ZIPも保持する。唯一のsourceと必要証拠を残し、全baseline treeは増やしていない。

### 19.4 次の一まとまり

有限なP3.1を完了し、次はP3.2／P3.3のMarkdown編集・保存・編集所有へ進む。[notes配置・入口調査](../checkpoints/shared-app/2026-10-30-p3-background/next-markdown-audit.md)でnotes直下35fileを確認し、開始時の限定整理としてMarkdownEditSession／MarkdownDraftPortと対応2testを選んだ。append・広いregistryは別群に残す。remote／競合やlegacy、全機器は担当工程で継続し、67要件はaccepted0／partial47／unverified20のまま。

P3全体の末尾でも必要な両buildを確認し、P4.C後にB3のsidecar込みbuild・隔離試用版のデータ／profile保持更新・通常起動・保存・再起動を実施する。現在の試用版は追加B2の古いsource。配布固有の問題・大きなUI変更は計画§7.5に従い中間packageを前倒しする。

## 20. 2026-10-30 Markdown・テンプレート・競合接続（検証中）

現在の作業は[Markdown checkpoint](../checkpoints/shared-app/2026-10-30-p3-markdown/ACTIVE.md)。全TODOのgoalは継続中で、P3.2/P3.3・P4以降の完了宣言ではない。

Markdown session/draftと対応2testを責務別directoryへ実移動し、前後53件・6起点graph・再帰収集と独立reviewを確認した。画像は読込失敗再試行・読込toggleによる取得とURL解放・lightbox・canonical URL policyを接続。Library内テンプレートは既存LibrarySessionの原子的publicationと既存MarkdownEditSessionを使い、作成・複製・編集・挿入・論理削除を接続した。旧globalテンプレートの変換はP6に残る。

テンプレートの予約metadata・名前・役割・親子制約はTS/Python両validatorに追加した。実repositoryで重複transactionがprojection／receipt／outboxを残さないことを含む両言語各6件が成功。backendの契約・repository・新規testをまとめた実行は36件成功。過去のbackend source同一性による省略は本batchへ継承しない。

MarkdownとDocumentの競合解決は同じtargetのjournalとBatchCommitSessionに接続し、unknown復元・同ID再試行・全headの原子的照合を契約試験で確認中。Library解決のwriterはまだ未接続。実際のproviderによる枝到着・端末間同期はP5で確認し、contract fixtureを通常同期の証明にはしない。

通常Webからの自動保存・履歴・失敗保持、画像、テンプレートの計6caseを検証中。最新の実resultが揃うまで全frontend標準検査・compiled成功とは扱わない。通常版とインストール済み試用版B2を変更していない。P4は階層表示・folder UIの早期整理と通常CRUD、Library競合の保存回復から進める。

## 21. 2026-10-30 Markdownのlocal検証完了とP4の実装

P3の最終製品入力は`standard-r2`で型4・lint・単体1627成功／1skip（opt-in geometry benchmark）・両frontend build成功。後続はE2Eだけを2修正＋1追加し、新しい全E2E型検査を実施した。[compiled coverage](../checkpoints/shared-app/2026-10-30-p3-markdown/compiled-coverage.json)は実8 distinct caseを画像r1／template CRUD r2／編集保存r3／標準・画像template r4へ対応付け、各両engineの成功とraw log・pin・assetを独立読戻しした。単一runの8成功とはしない。古い失敗は保持した。製品修正は作成直後の古い一覧参照、保存前validation、通常資料openへのtemplate混入等で、後続の失敗はUI表示状態や非同期完了を待つE2Eの修正だった。

Desktop399／Web400assetは同じ実buildを使った。TailwindがE2Eもscanするため、最新E2E pinからassetを再生成した証明とは区別し、P4/B3では新sourceから両buildする。backendの実36件と422入力の同一性も別記録。新しいNative build／installや実provider同期の成功ではない。

現在は[P4 checkpoint](../checkpoints/shared-app/2026-10-30-p4-library/ACTIVE.md)。treeの3module＋1testを責務別directoryへ移動し、9path前後・7graph・収集220→220と独立reviewを確認した。続けてchildren More／root paging／可変高windowing／focus・reveal／階層move・reorder、同じLibrarySession journalによるcatalog競合解決・unknown復元とscope-wide writer leaseを実装している。

Rootは表示設定を`features/workspace/`へ配置し、両hostのgateを通すLibrary単位のlocal preferenceで配色・UI倍率・catalog開閉・編集幅・一覧高さを復元する経路を追加した。検索条件は別cacheで保存し、壊れたcacheを勝手に上書き・検索拡大しない。検索3moduleと対応testも`library/query/`へ移し、収集222→222と依存graphを照合した。

P4の最初のまとまりを1,983fileで固定し、`standard-r1`で型4系統・lint・単体1,645成功／1skip・両frontend build成功。今回のbackendは新規選定203件とAPI5件・schema export・Pyright・Ruffを実行し成功した。全backend suiteの実行とはしない。`built-web-r1`は9項目×Chromium／WebKitの実18件すべて成功（512.67秒）、入力と両asset不変。通常CRUD／添付失敗再試行／Undo・再起動、検索条件・階層・表示復元、Markdown／template／notebook回帰を含む。pure componentの大規模tree試験は通常18件と別記録。

大きなUI変更の区切りとして、計画§7.5に従いB3を前倒しした。fresh sidecarのsmoke／notice・NSIS・artifact独立reviewが成功し、試用版だけを更新installした。GUIとsidecar全1,033file・既存data／profile保持・通常版registryを確認した。[配布物と起動方法](../output/shared-app-builds/2026-10-30-b3-library/README.md)。同じWeb assetの主要PDF回帰も別2case成功。

元のbuild runnerはCLIのCargo改行正規化でpostcheck失敗したため、元result／package sealを保持したままCRLF→LF限定同値と保護対象の再照合を別proofへ記録した。検証scriptを実行中に更新した誤りも実行版と後版を補足で区別し、独立artifact reviewへ結合済み。

実画面は最初ロック画面で停止し、本人の解除回答後に再開。新Library／folder／Markdown／Notebookを通常UIで作成し、Markdown A→B→Undoと一筆→Undoを保存した。ダーク・125%・幅60%・一覧高さ55%、右側MarkdownとUndo履歴を完全再起動後に確認。正常終了後のSQLite読戻しでMarkdown3batch・Notebook2batchと全receipt／root／本文hashが前後一致し、GUI／sidecar／profileは自然終了した。`b3-update-r1/gui-r1/result.json`と独立reviewに記録。これはB3 core sourceの実証で、本人の感想や後続frontendのNative成功ではない。

後続local-r2は1,986file、型4・lint・単体1,650成功／1skip・両buildと**13suite／30caseのcompiled Webが同一runで全成功**（858.94秒）。入力とDesktop397／Web400assetが前後一致し、独立readback済み。backendは425 source一致で先の実203件／API5件へ対応付け、再実行とはしない。注釈・回復の計9moduleと6testの整理は前後map／collector／graph・関連検査で確認した。新しいpin、証拠、保全先は[P4 checkpoint](../checkpoints/shared-app/2026-10-30-p4-library/ACTIVE.md)。

P4の選択復元・まとめ操作／service入口の残確認を継続する。P5ではlocal namespaceとprovider principalを区別し、最初は新provider-linked Library作成／別host joinを縦につなぐ。既存local scopeを書き換えず、保存bindingやremote JSONだけでowner権限を再発行しない。旧privileged HTTPの403は維持する。旧データ移行／legacy撤去はP6、性能／機器と全受入はP7。全67要件はaccepted0／partial47／unverified20を維持する。

後続の現在地は`frozen-inputs-local-r5.json`の1,993入力、SHA-256 `f257eb383275ae1823e956c8454e99f76a657f519d4a96bd84b84a7a83ab342e`。`standard-r6`で型4・lint・単体1,661成功／1skip・両build、`built-web-r4`で17suite／38caseが同一runですべて成功（1,035.20秒）。Chromium／WebKit各19件、strict console、前後sourceとDesktop397／Web400asset不変を独立readbackした。backendは425 sourceと先の203件／API5件への同一性照合であり、新規実行ではない。

今回追加した通常検証は、PDF2件のまとめtag／既読・書誌5項目・関連追加／解除・UndoRedo・exact restart、同scopeの資料／folder／本文復元、欠落／削除／別scopeの拒否、実readonly IDB遅延中の明示選択優先。復元途中のkind解決用loaderとSuspense loaderを同じ非編集ownerにし、正当なcontroller/errorへのhandoffだけ新guardと全readを一度再確認する。一般のcontroller交代・scope失効を通す変更ではない。

当初のcompiled38は30成功／8失敗で保持した。Tree／referenceの検査は復元済み開閉状態を冪等に扱い、Selectionはheadingだけでなく実CodeMirrorの編集可能状態と本文を確認する。未読込sessionのscope退出拒否は維持し、実験した初期化待ちの製品変更は元byteへ戻した。標準検査のWindows process制限による失敗と、追加E2Eの型エラーも別記録に残し、後の成功へ書き換えていない。

用紙が910px画面で約1447pxまで伸びる問題と、600px／125%で操作列が本文を0pxにする問題を修正。共通操作領域のscroll／keyboard・倍率操作、紙／Markdown／PDF・右配置を両engineで確認した。注釈／手書きの10source＋5testも移動し、34pathのbyte保全・8依存graph・223testのpath inventory・関連43成功／1skip・型検査と改行維持を確認した。

このまとまりのsource保全手順と読戻し結果は`source-snapshot-r4/`を参照する。次の共通frame／Workspace command候補は未適用で、ownerと非同期guardの独立review・通常操作を経てから導入する。B3.3は同期導入前に実build・隔離更新install・Nativeの保存／Undo・設定／資料切替・狭幅を確認する。P4全体、他host同期、移行、実機・全67要件の完了とは扱わない。

## 22. 共通Workspace接続とB3.3（r1当時の途中経過）

以下の「修正中」「未確認」「作成中」はr1当時の状態。r2の完了結果と次の作業は§23を参照する。

作業と証拠は`checkpoints/shared-app/2026-10-30-p4-workspace/`。前§21のlocal-r5・source ZIPを保全したまま、4つの通常viewから共通`features/workspace/CanonicalReaderFrame.tsx`を使用し、旧adapter frame2本を削除した。legacy shellは残るconsumerのため保全。commandは既存navigationと編集controllerへ委譲し、別writer／journal／authorityを追加しない。

独立レビューで、遅延move中のA→B→Aや対象無効→有効によって古いticketが復活する問題を再現した。通常接続のnavigation／registry／catalog通知を移動中だけ監視し、一度失効したticketを復活させずfinallyで購読を解放する。通知を省略する別callerには途中変化の検出能力がない。対象7unit・型・lintが成功し、rootは18pathを独立レビューした。実controllerのretry応答遅延seamはChrome1件成功だが、通常受入やoptional refresh分岐の強制検証とは扱わない。

新collectorはschema／frontend scripts／CI／build設定を追加で固定する。`frozen-inputs-workspace-r1.json`は2,015入力、SHA `f38eecf3a6c4d12ac5f59bbef8d64d435d1df65f04f5c878da89c22e1a6a68ac`。`standard-r1`は型4・lint・単体1,669成功／1skip・両buildが成功。source geometry両engine2件とreference／原訳Chrome2件も成功。compiled38は37成功／1失敗で完走した。WebKit annotationの2つ目のPDFの表示待ちで、診断では保存済みstatusを拾った後も実保存が未完の時点を観測した。元の失敗は保持し、E2Eの実耐久待ちだけを修正中。新Nativeは未確認。初回44px CSS失敗も保持した。

当該E2E1fileだけの差分をr2 pin（SHA `2d5ebbc1777c00857d6c7e396e492f943db7cd3f41da9ac6f13a4aa87442d59d`）に固定し、新E2E型・両buildとannotation4件が成功した。E2EはCSS scanの入力でもあるため、全Desktop397／Web400assetの完全同一を実buildで確認し、旧runの残る34成功を継承した。独立coverageは38unique／42実行で、単一runの38件成功や単体全件の新規実行ではない。`workspace-compatible-r2.json`はSHA `4ce956b98e29fe84677d68a37afbcaaefc24a740dbeb0e0b9285b1a1c968a0e3`。初回writerはCRLFだけのbyte差で失敗し、元file／scriptを保全してbinary出力へ修正、最終byteは事前予測値と一致し独立照合済み。B3.3のhelper／事前照合も成功し、実sidecar／NSISを作成中。

B3.3はこの同じsourceと成果物から実sidecar／NSIS build→独立artifact確認→隔離試用版のデータ／profile保持更新installを行い、通常起動・編集・Undo・選択／設定・完全再起動を確認した。通常版を更新／終了していない。実Workspaceの集中表示・panel／serviceは次の有限作業案に分け、定期整理とP5〜P7・全受入を継続する。

## 23. 2026-10-30 B3.3 Workspace 実配布と次の整理

実source r2 pin `2d5ebbc1777c00857d6c7e396e492f943db7cd3f41da9ac6f13a4aa87442d59d` に結び付けたB3.3を隔離更新した。compiled Webは旧34成功＋新4成功の38 unique／42実行で、旧37成功／1失敗を保持し、単一38成功runとは扱わない。両再buildの397／400 assetは旧standardと一致した。

実設置版の通常UIでMarkdown A→B→Undo、Notebook一筆→Undo、PDFページ／固定参照、右配置、設定と操作領域のキー／scrollを確認。完全再起動後、同scopeのMarkdown A／右配置とfolder・設定を復元し、対象graph／batch／receiptは前後一致、旧B3 graphも維持した。Native最小1000×680 client・125%ではNotebook、Markdown右配置に加え、別addendumでPDF用紙の右／中央配置と操作領域のscroll・倍率キーを確認した。通常版は終了・更新していない。[配布記録](../output/shared-app-builds/2026-10-30-b33-workspace/README.md)、[checkpoint](../checkpoints/shared-app/2026-10-30-p4-workspace/ACTIVE.md)。

source ZIPは2,070 member・29,704,624 bytes、SHA `3bdc579ace6d98a1181038d59c4036d2c7a63fb287eb2721250c50e1fd18f675`で独立readbackを完了し、旧17 ZIPも保持した。このZIPはcatalog移動前のr2 sourceとB3.3に対応する。続けてcatalog UI 5 moduleをpath-only移動し、前後の80件・5 graph・224 test収集と型3系統を確認、独立reviewも受けた。移動後のsourceは設置済みB3.3とは異なる。

## 24. 通常Webの集中表示と次の実panel

editor・controllerと一覧をmountしたまま集中表示を切り替え、フォーム／modal／contactの拒否、focusと一覧scrollの復帰を両engineで確認した。2023入力の標準検証は型4・lint・単体1,681成功／1skip・両build、compiled Webは8 suite・20 caseが単一runで成功。初回source 1成功／3失敗、診断の失敗、scroll前2件の失敗は保持する。[集中表示の証拠](../checkpoints/shared-app/2026-10-30-p4-workspace/focus-r1/README.md)。

設置済みB3.3は集中表示前のr2 sourceであり、新機能のNative成功やOS chooser取消はまだ主張しない。次は実在する付属note／添付をeditor横のpanelから中央へ開く一まとまりと責務整理、その後B3.4でのNative確認。P4親、P5の実provider／同期、P6移行、P7機器・全受入は未完。
## 現在の進捗：付属ノート・添付パネルとMarkdown整理

通常Webの実panelはsource実行で両engine計4件が成功し、独立確認済み。初回の2成功／2失敗と、対象editorの準備待ちを追加したtest-only修正は別に保全した。Markdownの表示・編集7 moduleと画像testを責務先へ移し、17 path前後保全、同じ76件・10 graph・unit収集228・実driver収集117・型3系統を独立照合した。旧callerと論理診断labelは維持する。

現source 2,027入力のfresh standardは型4・lint・単体1,686成功／1 skip・両build成功。compiled Webは単一runで24件すべて成功（両engine各12件、607.84秒）し、独立確認済み。B3.4の限定Native確認も完了した。旧B3.3のsource ZIPは集中表示より前のr2に対応する。append／添付の残群、serviceとP4全体も未完了。証拠はWorkspace checkpoint内の`newpanel-r2/compiled-web-r1/`と`markdown-organization-r1/`に保持する。
## B3.4 限定Native確認と次の修正

pin 55cbe の隔離試用版で、通常UIの集中表示、付属ノート・添付panel、Markdown／Notebook編集とUndo、5つのchooser取消、再起動後の本文・配置・設定復帰と自然終了を確認した。再起動前後の対象graph／batch／receiptは一致し、旧B3／B3.3の対象も保持した。Webはfresh standardの単体1,686成功／1 skipと両build、compiled単一24件の成功を独立確認済み。詳細と制限は`b3-4-update-r1/gui-r1/`を参照する。

最小1000×680・125%ではheaderが3行となり、catalog展開時に本文領域が圧迫される。修正候補は`header-layout-r2/`に保全した未適用案で、次の実測と検証が必要。Native訳文chooser、物理接触中のguard、添付binary、実serviceやP5〜P7・全67要件は未完了。旧B3.3とそのsource ZIPは当時の証拠として保持する。
## 現在：ヘッダー修正の検証中

B3.4の隔離試用版と当時のsource ZIP（2,082 members、SHA `ba688…`）は保全・独立確認済み。B3.5のheader修正後・append移動前のpinは `b4c4c3012a1ad8ba5c364d96ae9ffb69c9a49e9b90bfc5c108b58b3a24e534e5`。現sourceはその後append責務を移動しており、pinとの全byte一致や移動後sourceのNative確認は主張しない。

1000×680・125%のChromium実測は、旧用紙ペイン0px、ヘッダー横並びのみ42.94px、高さ配分追加後134.5pxで対象1件成功。最後の実行は失敗再現用runnerを再利用したためresult欄が `unexpected-result` のままだが、生ログは1成功・終了0を示す。その後source 6件、fresh standard 8コマンド、compiled単一24件が成功し、独立確認済み。B3.5 build・隔離installとGUI前読戻しは成功、実Native確認は未実施。B3.4 source ZIPは旧ヘッダー時点の記録で、旧18 ZIPと合わせ19件を保持する。全67要件の完了は主張しない。
## 履歴：B3.5 再buildと次の作業

B3.5 の `build-r1` は実行元processが消失し、終了結果を推測せず保持した。保護状態の読戻し `3558e9fb…` 後、`build-r2`・独立artifact確認・隔離更新install・GUI前の全1,035ファイル読戻しが成功した。Native UI操作ツールは起動時にpath not foundとなり、reset後の再試行も同じエラーだったため、B3.5の実Native操作・source ZIPは未確認。配布記録は `output/shared-app-builds/2026-10-31-b35-header/README.md`。

検証済みWebは2,027入力のヘッダー修正後source、fresh standardの単体1,686成功／1 skip・両build、compiled単一24件成功。以前の2,023入力・1,681成功・20件は集中表示時点の履歴。その後append責務の4 sourceと1 testを移動し、前後68件・10 graph・収集集合・型4系統と21 pathの独立reviewが完了した。次に通常引用producerからの遷移を進める。Library競合解決の旧proposalは現在のjournal実装より前の履歴で、予約template metadataと削除状態を含む追加契約候補 `checkpoints/shared-app/2026-10-30-p4-library/resolution-contract-r1/` は未実行。通常remote競合はP5に残る。
## 2026-10-31 現在地：P4限定検証とP5準備

P4.3aは通常引用producerから原文／訳文の位置・履歴・配置・保存失敗retryをcompiled Web 4件で確認した。P4.2bは実IndexedDB 2件とNativeAuthorityのdisk SQLite・3 process component 1件を確認。先行combined 4件の1失敗は保持し、issuerの別run 2件成功と区別する。Native frontend、実transport応答消失とremoteは未完。

append責務は4 source＋1 testを移動し、前後68件・10 graph・型4を確認。P5早期CではPython validator 5本＋4 testを移動し、前後109件・ruff／pyright・全収集2,975件・静的import 411 nodes／4,217参照を照合した。収集IDのうち生成ZIP時刻に依存する3件だけを明示正規化した。

P5 phase1はissuer／decisionの限定内部経路でNode 48件・Python 111件・API 5件・両buildおよびissuer Web 2件が成功。phase2はdescriptorの共通13 vector、Python 125件、Node 61件・型4・lint、内部JOINとblocked後の遅延upgrade拒否を両engineで確認した。先行fixture失敗と修正前の4失敗は保全。全unitは1,704成功／1失敗／1 skipで、権限に関係する同一1件はsandbox外の別runで成功した。単一clean runとは扱わない。両buildと通常built Web 6件、provider test／fixtureの整理後8件も成功した。

通常providerの初回create／joinは旧local v8にversionchangeを送らない固定cloud cacheを採用方針としたが、実装は候補中。次は実認証→新規Library公開／join→atomic activation→通常編集→両host同期。実OAuth、Native、実transport、large resource streaming、offlineと既存local linkは未完。詳細は `provider-integration-r1/`・`provider-integration-r2/`・`provider-organization-r1/` と `p5-early-organization-r1/`。

設置済みB3.5は後続整理とprovider追加より前のsourceに対応する。実Native UIとsource ZIPは未確認で、UI操作runtimeはpath not foundとなりreset後の再試行も同じだった。P4残項目、P5〜P7、定期C／Bと全67要件の受入を継続する。

## 2026-11-12 作業B6（P6の入力側）完了時点: 標準検査と未確認の整理

**この節はP6の親項目（P6.1／P6.1a／P6.1b／P6.2／P6.2b）が未完であることを前提にした記録で、成功の宣言ではない。** 「作業B6」はセッション内の番号で、計画書§7.5のB6（最終パッケージ）とは別。製品の変更を伴う区切りはB6-a〜B6-d・B6-f（pin162〜167）で、B6-eはコードを変えない標準検査と記録だけ（pin168はpin167と同一内容）。

- **追加したもの（すべて合成Library・隔離環境で検証、どこからも通常操作に接続していない）:** 中止の終了を確認できない状態の診断保持の固定（B6-a）、隔離コピーの全領域棚卸し部品（B6-b）、棚卸しとNotebook抽出を結ぶ変換入力のsidecar側（B6-c）とTypeScript側（B6-d）、旧Library走査stampの冷えたNTFSフォルダーの`st_size`問題の修正（B6-f。製品の`legacy_backup.py`を変更）。全体変換は常に拒否される（`messages-not-converted`・`uncollected-source`など）。
- **標準検査（pin167、隔離・per-file直列）:** 全pytestは202 file／4,013 tests／3,983成功／**失敗2**／skip28。前回（196 file／3,893／3,863／2／28）との差の+120成功はB6の新規6 fileの件数と一致し、既存196 fileの件数は不変。**失敗2件は前回と同じ**（interopテストの環境変数`PAPEER_INTEROP_RUNNER`未設定と、受入台帳の欠落evidence35パス）で新しい失敗は0だが、**成功ではない**。frontendの型4系統・eslint、全unit（基準runnerで1,933件中1,932成功・skip1）、Ruff、Pyright（エラー0・既知警告3）、openapi／`schema.d.ts`の再生成差分なしは成功。受入台帳は動かしていない。実ユーザー領域のstat比較は変更0。
- **未確認のまま:** 実Library・実データでの棚卸し／変換入力、実Native画面・実WebView2・実機、WebView／Drive等の収集、stagingへの書込み・公開・切替・rollback（P6.2本体・P6.3）、Diagnostic（インストール済みはpin161のまま。pin167は未build）、低メモリでのcaptureの直接確認、FAT／exFAT／SMB。
- **次（B7）の前提になる残課題:** 実Libraryでバックアップ全体の読取り上限256MiBをほぼ確実に超える（1つの検証済みcopyを共有する設計が先）、WAL終了のLibraryがそのまま拒否される規則、Library側の用語集表（`paper_glossary`等3表と`glossary.json`）の分類漏れ、manifestの永続化方式、TSでblockedにした冊の全体理由への反映、Diagnostic（pin161）更新時は中断中のrunを中止して取り直す（`observationSha256`の定義が変わったため）、fixtureの`rects`の不正JSON、実ユーザー領域`PapeerSync/instances`の古いlock file（statだけで`.lock`を5件確認。外部writer検査は実データでは常に拒否になる）。一覧と根拠は`checkpoints/shared-app/2026-10-30-p4-workspace/IMPL-r161-b6e.md`の第6〜7節。

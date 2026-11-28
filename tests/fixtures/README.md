# Test fixture provenance

On 2026-10-18, the repository owner confirmed that the existing `sample.pdf` is
their own work and may be publicly distributed. The original two-page synthetic
test document is retained. It uses the PDF standard Helvetica font by reference,
without embedding a downloaded font file. No replacement fixture is needed.

OCR fixture images in `ocr/` are synthesized by `tools/make_ocr_fixtures.py`.
Other JSON fixtures contain test cases maintained in the repository.

## PC・Web編集契約の共通fixture

`shared-edits.json`はTypeScriptとPythonの同じdomain/保存試験で使います。`shared-coordinate-pages.pdf`のSHA-256と実際のページ寸法、PDF・ノート・Markdown・添付の作成bundleも含みます。この小さなPDFは原点の異なるCropBox、全4方向のRotate、UserUnitと小数のboxを含む決定的なfixtureです。実ユーザーの資料は使いません。

再生成は`uv run python tools/build_edit_fixtures.py`、型と構造validatorの再生成は`python tools/generate_edit_contracts.py`です。ブラウザ側はPDF.js、Python側はPyMuPDFで背景の寸法を独立に解析し、検証済みの公開元metadataを保持します。

`checkpoint`には初期root、完全batch、親待ちの枝、作成bundleと履歴を含め、SQLiteと実IndexedDBの初回取込・再起動・途中失敗の共通corpusにしています。

`translation`は原文3pageと、物理page4/5を参照する別IDの訳文2pageを持ちます。原文2の対応は欠落のままとし、訳文への描画・訳文差替え・旧編集の後着を同じ文書DAGで検証します。TypeScriptの共通履歴が生成するUndo/Redo batchもPythonの実SQLiteへ受け入れる試験を行います。

`intents`には送信前・送信した可能性あり・Undo待ち・逆batch固定の4段階を持たせます。同じcorpusをCAS/単調な更新の規則、native abort・再起動・実HTTP応答消失の回復試験に使います。

`editRecords`は通常編集・Undo・Redoの完全な転送記録です。履歴actionを含む同じcorpusをTS・Python・実IndexedDB/APIへ逆順でも渡し、親待ちからの復元・native abort・再起動を検証します。checkpointなしの通常同期でも文書履歴が復元できることを確認します。

`datasetManifest`はscope・固定checkpointの内容digest・全依存resourceを結び付ける完成manifestです。TypeScript/Python/実IndexedDB/APIで同じ内容を取り込み、取込markerの最後の書込で失敗しても本文・項目・履歴・receiptが残らないことを確認します。`contentHashes`はJSONの表記差へ依存しない照合用encodingのcorpusです。binary64の上下限・小数・±0・Unicode key順序・型境界を含めます。実ユーザーのデータを変換するfixtureではありません。

`datasetControls`は初回有効化と、別epochへの切替/rollbackのcontrol recordです。prepared/published/activated/rolled-backとactive pointer・epoch履歴・固定planの同じcorpusをTSとPythonへ渡します。native abort時にpointerだけ、またはoutboxだけが切り替わらないこと、再起動と応答消失後に同じplanを再開できることを確認します。

`shared-migration-ids.json`は一回変換の安定IDの固定golden値です。Pythonのversion付きcontent codecで計算したhashを、TypeScriptのconverterでも照合します。IDはlibrary・種類・source key配列から作る独自UUIDv8で、UUIDv5として扱いません。原文/訳文、Unicode、区切り文字の曖昧性を含み、run ID・epoch・列挙順に依存しません。通常のfixture再生成では書き換えず、ID規則の変更が必要な場合に意図的に更新します。

全7種の旧筆跡は`frontend/tests/support/legacyInkFixture.ts`で旧生成/handle実装から作ります。portrait/landscape、回転・拡縮、横幅が変更された複数行の文字、短軸/ページ端の矢頭を含み、TS単体とPC実HTTP/SQLite・Chromium/WebKitの実IndexedDB試験で共通converterへ渡します。ユーザーの元データや実Driveへは書き込みません。

`shared-edits.json`の`annotations`は、付箋・本文highlightの共通契約です。文字offsetが既知/未索引の場合、分類/コメント/引用、未知の日時/色、UTC日付境界と最大6桁の秒小数、壊れたrange/quad/metadata/ID/色を含みます。TypeScriptとPythonで同じvalid/invalid値を検証します。

`frontend/e2e/fixtures/legacyAnnotations.py`は専用の一時libraryだけへ旧APIで2pageと全注釈を作り、read-only SQLで元記録を読み出します。SQLiteのrects JSON文字列・UTC日時・64bit IDとNotebook安定page IDを実際の形式で共通変換へ渡します。新保存/再起動/Undo/Redo後も旧table行・fileが変化しないことを検証します。これは本番の全領域backup/停止gateの代用ではありません。

`legacyBackup`はraw入力退避plan/manifestのPython生成golden値です。空body/container、WAL/journal、階層key、Unicode scalar順（補助平面文字とU+E000の順差）と同じinventory digestをTS/Pythonで確認します。native試験は実SQLite WAL/SHMの別コピーでの回復、失敗/並行capture/応答消失と固定planを検証します。browser試験は実IndexedDBのabort/reload・欠落bodyとの原子的判定・破損検出と、localStorageの未送信/ack/壊れたJSON/UTF-16保全を確認します。nativeのsourceには一時test libraryだけを渡し、APIのfixtureもdata directoryと新保存接続を隔離します。

`shared-legacy-drive.json`は同じbuilderから生成するGET専用のDrive入力catalogです。実sample.pdfのbytes、公開manifestと元ledger JSON、空/入れ子folder、旧blob、公開folder外の参照file・ink/note操作・note blob、属性のない場所へ移動したnote本文、不正JSON、別libraryの除外対象、binary64で丸められるint64のversion文字列を含みます。`tools/legacy_drive_fixture.py`とbrowser HTTP fixtureは同じcatalogを2件ずつpaginationして返し、実ユーザーのGoogleへ接続しません。共通collectorをPCの実HTTP/file storeとChromium/WebKitの実IndexedDBへ渡し、固定plan・部分失敗/応答消失/再起動、後着操作・account変更を検証します。Driveのraw body取得は操作の採用や全領域変換の証跡とは区別します。

`legacyMigrationHolds`は起動admission recordのTS/Python共通corpusです。UUID/newline、versionのboolean/別値、欠落field、不明なautoReleaseを両言語で同じく拒否します。実UI試験は両本番entryを使い、recordの確認前に旧composition/storeをimportしないこと、元のlocalStorageとsession grantが変わらないこと、IDB v1 artifactの保持・hold追加abort/reload/競合を検証します。recordがあることを、起動済みwriterの停止完了や全領域移行の証跡にはしません。

`legacyMigrationInputs`は明示した参加端末/sourceと全backup planを固定する共通corpusです。欠落/重複/余分なsource、順序、run IDのbackupへの転用、未知field、boolean version、同じDrive sourceを見た端末間の一致/不一致をTS/Pythonで検証します。実HTTPと両browserはhold確認、入力集合の耐久化前abort・応答消失、部分capture、同一IDでの再起動/再開、後着データ拒否と元入力の不変性を確認します。未申告端末の発見や全writer停止を完了したfixtureではありません。

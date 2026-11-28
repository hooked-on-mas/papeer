# PC / Web共通UIとsidecarの責務

> 本書は既存の部分共通化の記録です。今後の目標構造は[PC・Web共通アプリケーション設計書](shared-app-design.md)、移行・受入条件は[実装計画書](shared-app-plan.md)を参照してください。本書中の機能制限・責務分割・単一mount等の記述は、調査で未達や不整合が確認された項目も含むため、目標設計や実装完了の保証として扱いません。

2026-10-25の追加実装は[実装記録](shared-app-implementation.md)を参照する。ノート編集の共有session・Markdown編集view、PC PDF/Web PDF/手書きノートの共通図形draft・選択肢と、新保存契約の基盤を追加した。Web PDFにも全4種の図形作成入口を接続した。新保存方式の本番有効化とPDF editor全置換は未完了であり、以下の旧経路がすべて撤去済みという意味ではない。

更新日: 2026-10-24。Web版はPCで翻訳した文書の閲覧、PDF追記、Markdown・手書きノートの作成・編集を提供する。Web翻訳・AIへの新規質問・AI接続設定は提供しない。

## 採用した構成

画面、ライブラリの読み取り、成果物の取得、注釈の同期、PCの翻訳実行を分ける。別サーバーやマイクロサービスは追加せず、同じアプリ内のmodule境界として実装する。

```mermaid
flowchart TB
    Desktop[Desktop host: 起動・終了・PC操作]
    Web[Web host: Googleログイン・snapshot選択]
    UI[共通React部品: 枠・階層行・左右パネル・タブ・PDF表示・線の描画]
    Model[表示DTO・閲覧capabilities]
    Query[ReadonlyLibraryQuery / ArtifactStore]
    Drive[Drive API: snapshot・blob・追記]
    Sidecar[PC sidecar: SQLite・文書処理・翻訳job]
    Provider[PCのAI provider]
    Desktop --> UI
    Web --> UI
    UI --> Model
    Web --> Query
    Query --> Drive
    Desktop --> Sidecar
    Sidecar --> Provider
    Sidecar --> Drive
```

`AppShell`をそのままWebへimportして機能を無効化する方式は採らない。Desktop hostにはTauri終了、保存待機、job監視、ファイル操作と設定画面を残す。Web hostにはGoogleログインと公表済みsnapshotの寿命管理を置く。

## 共通化したもの

| 部品・契約 | 利用箇所・責務 |
| --- | --- |
| `components/WorkspaceChrome.tsx` | PC/Web共通の画面枠、幅変更可能な左パネル、折りたたみrail、ヘッダー、タブ枠 |
| `features/library/LibraryRows.tsx` | 同じフォルダー・論文・持ち物の行。DesktopはDND/編集をhostに保持、Webは階層閲覧・検索・選択だけを供給 |
| `features/library/treeKeys.ts` | PC/Webの矢印移動、Tab位置、文字入力による行移動。ノート優先の並び順は同じ`kindCapabilities`を使う。検索対象・空フォルダー・取り込み待ち行の供給はhost別 |
| `components/ui/MarkdownContent.tsx` | GFM・数式・正規化・コード/Mermaid・安全な標準リンク描画。PCの引用移動・認証画像とWebの保存画像解決は呼出側が供給 |
| `features/reader/layout/ReaderDock.tsx` / `SidePanelChooser.tsx` | PDF横のサマリー/チャット/メモの選択、左右配置、幅変更。両hostの実行経路で同じ部品を使用 |
| `index.css` | PC/Web共通のフォント、色、明暗テーマ、基本タイポグラフィ |
| `features/reader/PageNavigatorView.tsx` | 同じページ入力・前後移動部品。commandとショートカットの案内はhostが指定 |
| `features/reader/PdfDocument.tsx` | legacy pdf.js worker、CMap、フォント、読み込み失敗の扱いを統一。認証headerはPC hostだけが渡す |
| `features/reader/WritingToolbar.tsx` | 文書ごとの操作対象登録・切り替え、共通ツールバー配置・幅計測、対象選択、Undo/Redoボタン。保存方式とコマンド実行はhostが供給 |
| `features/reader/layout/ReaderSplit.tsx` | 原文/訳文の同じ左右分割レイアウトと幅変更 |
| `features/reader/InkDrawing.tsx` / `inkGeometry.ts` | 手書きの描画・座標・当たり判定。保存と編集可能範囲はhost別 |
| `runtime/libraryItems.ts` | 項目の表示名・種類・親・フォルダーを同じDTOへ変換。PC一覧の表示名とWebの一覧が利用 |
| `runtime/contracts.ts` | 通信hook、Tauri、DriveのIDやローカルパスに依存しない閲覧契約 |
| `runtime/capabilities.ts` | 種類の能力、hostの権限、保存済みデータを合成するパネル可用性。PCの右パネルとWebのタブ・右パネルが同じselectorを使う。保存済みチャットの閲覧と新規生成を区別 |

Webの左一覧はフォルダー階層・開閉・持ち物・専用ノートを表示し、メタデータとメモ名を検索する。行はタイトルを優先し、著者/年を含む完全な表示名はtooltipに保持する。右パネルは本文と同時表示し、閉じ開き後も幅を保持する。別タブに移っている間は本文の寸法・倍率を保持し、同じメモを二重mountしない。狭いWeb画面だけはdockを上下配置にする。

PCの整理・翻訳・付箋編集等と、Webで提供する操作には違いがある。サイドバーの整理操作やPDFの全編集機能まで同じものとして公開しない。共有する見た目・表示部品と、hostの利用可能な操作を分ける。

### 入力・状態の共通化の境界

ページ移動・倍率の要求は`ReaderCommandPort`を通し、`useReaderInput`がwheel・キーの判定を共有する。PCのstore・履歴・ノート編集中判定、Webの下書き確保・原文ページと訳文PDFの対応はhostの接続処理に残す。指スワイプの判定は`touchSwipe`を共有する。Pointer Eventsでパン・再描画するPCの処理と、Touch/SafariイベントでプレビューするWebの処理には実装差が残っている。

`pageWidthFor`が各PDF面の寸法からページ全体の縮小下限を計算し、両版の描画とピンチに適用する。前後移動はページ先頭、PageUp等は前ページ末尾、再表示は保存位置へ戻す。左右の同期は`usePairedReaderScroll`が入力元・描画完了・ピンチ・復元を調停する。

`NoteEditSession`はNoteDocument形式の未保存内容・保存失敗・再試行をPC/Webで共有し、`useNoteAutosave`はMarkdownの保存間隔と状態表示を共有する。API revision更新とDrive操作履歴はhost側に残す。

現在はPDF面・閲覧位置の復元・編集履歴の全体を単一sessionへ統合していない。共有済みの判定と表示部品を両hostで使い、入力と保存のadapterを接続する段階である。PCの既存ノートは`NotebookView`経路、NoteDocument形式はPC/Web共通の`HandwrittenNote`経路を持つため、両者のページ・保存形式を同一と見なさない。

### PDF書き込みツールの配置

PCとWebは`WritingToolbarProvider`を文書ごとに持ち、対象PDFの登録・選択・片側欠落時の切り替え・幅計測を共有する。`WritingToolbarSlot`と`WritingToolbarPortal`が本文上部の1か所にツールバーを配置する。対象選択とUndo/Redoボタンも共通部品を使う。PCの操作対象をアプリ全体のstoreに置かず、別の文書やノートのマウント・解除から独立させる。

PCの`InkToolbar`はローカルの全編集機能、Webの`PdfWritingTools`と`PdfReader`はDrive追記を担当する。共通部品にはTauri、API、Drive、編集履歴の実装を持ち込まない。Webの色・太さ・指入力設定とページ別のUndo/Redo履歴は文書内で保持し、単独/左右表示の切り替えやページ移動によるPDF面の再マウントで失わない。履歴のキーにはライブラリ、論文、原文/訳文、PDFのhash、ページ番号を含め、別版へ履歴を持ち越さない。

対象切り替えでツールバーの描画元が変わってもキーボードフォーカスを選択欄へ戻す。登録解除は登録者ごとに行い、StrictModeや同じ側の再マウントで後続の登録を消さない。非操作側の保存エラーも省略しない。

## 閲覧・成果物の契約

`LibraryItemView`は項目ID、表示名、種類、親ID、フォルダー名を保持する。`ArtifactView`はopaqueな資料ID、所有項目、表示名、ファイル名、media type、原文/訳文/添付等の役割を保持する。

`ReadonlyLibraryQuery`は一覧・資料一覧・保存済み付箋/チャット・対訳ページ対応を返す。`ArtifactStore`は資料IDからBlobを返し、埋め込み画像の相対参照を同じ項目内だけで解決する。UIはGoogle file IDやローカルファイルパスを組み立てない。取得したBlobから作るobject URLは表示側が解放する。

Webの`createDriveLibraryRuntime`は既存の`DriveSession`をtransportとして使用する。認証・Drive API全体をsidecar互換APIへ作り替えず、必要な閲覧機能だけをadapterにする。PCの既存HTTP query/jobは維持し、使わない汎用Desktop runtimeは作らない。

項目の資料一覧では正規の原文・訳文を優先し、review-backups内の再翻訳前の保存履歴を除外する。同名PDFでも保存履歴や添付は正規文書のrole・注釈対象を持たない。「ライブラリ全体のファイル」では保存履歴を相対パスで区別して残す。

runtimeはlogin epoch、library ID、snapshot revisionを持つ。資料IDはruntimeごとに異なり、別runtimeへ持ち越せない。切替・ログアウト時はdisposeで読込を中止し、transportや本文解析が遅れても古い応答を返さない。query keyにもこのscopeを含める。

## 対訳ページ対応

PCはsnapshotへ`web-reading.json` version 1を追加する。`reading_state`と同じ情報から、原文ページ番号ごとの訳文artifactと、そのPDF内のページ番号を公表する。これにより、途中まで翻訳した単ページPDFも正しい原文と対応する。

```json
{
  "version": 1,
  "items": {
    "<item-id>": {
      "pageCount": 3,
      "translatedPages": {
        "1": null,
        "2": {"artifactPath": "papers/<item-id>/translation-pages/<run>/page-2.pdf", "page": 1},
        "3": null
      }
    }
  }
}
```

raw pathはDrive adapter内でopaqueなartifact IDへ変換する。欠けた資料・別項目への参照を訳文として使わない。訳文がないページは未保存と表示し、同番号の別PDFを推測で表示しない。

古いsnapshotに対応情報がなければ、従来どおり資料を1つずつ表示する。更新したPCアプリは`web_reading_version`を公表済みstateに保持し、ライブラリに変更がなくても旧snapshotを一度更新する。形状不正の旧翻訳metadataはその文書の対応情報だけを省略し、元ファイルや正常文書の転送を妨げない。

## Webで提供する操作

| 操作 | Web |
| --- | --- |
| 原文・保存済み訳文・手書きノート | 閲覧 |
| 原文と日本語訳 | 対応情報がある文書で左右表示・同時ページ移動 |
| 保存済みサマリー・メモ・付箋・チャット | 閲覧 |
| 正規原文/訳文PDFへのペン・蛍光ペン・図形・文字 | 追記、Web追記の消去・undo/redo、Drive保存 |
| 翻訳・AIへの新規質問 | 提供しない |
| Codex・AI provider・端末設定 | 読込・表示しない |
| Markdown・手書きノート | 作成・編集・整理・削除、競合時のコピー保持 |
| 公開済みPDFの既存付箋・PCライブラリ全体の整理 | 閲覧のみ。Webから既存PDFやPCのsnapshotを上書きしない |

`runtime/capabilities.ts`は閲覧と生成を別々に持ち、Webのtranslation.generate、chat.generate、provider.configureは恒常falseとする。AI認証を閲覧の条件にしない。注釈対象はsource hashを持つ正規PDFに限定する。

## sidecarに残す責務

- SQLiteとローカル文書の正式な編集、バックアップ、復元。
- 既存Python coreのPDF抽出、OCR、数式・段組・フォント、翻訳検証、PDF組版。
- PCの翻訳計画、jobの排他・進捗・取消・再開、providerの起動と推論。
- WindowsのOAuth資格情報保護、Google token更新、snapshot公表とWeb追記の取り込み。

既存のPython provider registryは維持する。将来PCのAI認証・API providerを追加する際も、共通UIやDrive側を変更する前提にはしない。PDF表示がブラウザーで動くことを根拠に、PythonのPDF生成engineをWebへ移植しない。

## 注釈と保存の整合性

既存annotation-v1の不変操作、source PDF hash、UUID、取り込み済みledgerを維持する。WebはPCのsnapshotやPDFを上書きせず、追記だけを別ファイルで送る。通信失敗時はブラウザー内の下書きから再送し、PCは次のアップロードで検証して取り込む。

Web翻訳を提供しないため、複数executorによる翻訳結果の採用・merge・分散jobといった未使用の仕組みは実装しない。現在のPC単一snapshot writerを保つ。

## 検証の境界

- 共通DTO・capabilitiesとDrive adapter: schema、資料の整合性、相対参照、旧snapshot、取消、dispose、遅延応答、login/library/revision分離。
- Python snapshot: 途中訳の正確なページ対応、旧snapshotの自動更新、不正metadataでも正常文書を公表できること。
- Web E2E: 原文/日本語訳の表示、保存済み資料・履歴、sandbox HTML、左右対訳、注釈保存・通信失敗・再読込・複数端末・PC取り込み。
- PC: 共通部品への変更がページ操作・左右表示・既存翻訳を損なわないこと。Python翻訳engineは変更しない。
- Web build: sidecar/Tauri・AI接続設定・秘密資格情報を含めない。Pagesのサブパスでworker・CMap・フォントを読み込めること。

iPad幅・Pointer Eventsのブラウザー試験と、iPad実機Safari/Apple Pencil試験は区別する。実機で行っていない確認を完了扱いにしない。

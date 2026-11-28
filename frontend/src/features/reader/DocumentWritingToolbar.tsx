import { useRef, useState } from 'react';
import {
  Copy, Eraser, Lasso, Lock, MoreHorizontal, MousePointer2, PenLine, RefreshCw,
  RotateCw, Scan, Scissors, SquareDashed, Star, StickyNote, Trash2, Type, Unlock, ZoomIn, ZoomOut,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { NativeSelect } from '../../components/ui/native-select';
import { DocumentPdfImportControls } from './pdf/import/DocumentPdfImportControls';
import type { DocumentLibraryView } from './DocumentLibraryConnection';
import { PageNavigatorView } from './PageNavigatorView';
import { WritingHistoryButtons } from './WritingToolbar';
import { DrawingKindSelect } from './DrawingKindSelect';
import { CanonicalNotebookControls } from '../notebooks/CanonicalNotebookControls';
import { NoteAppendDialog } from '../notes/append/NoteAppendDialog';
import { CanonicalAnnotationEditor } from './annotations/CanonicalAnnotationEditor';
import { CanonicalPdfSearch } from './pdf/CanonicalPdfSearch';
import { DocumentOutputControls } from './output/DocumentOutputControls';
import { TranslationPdfImportControls } from './translation/TranslationPdfImportControls';
import { DocumentConflictPanel } from './edit/DocumentConflictPanel';

const INK_COLORS = [['#dc2626', '赤'], ['#2563eb', '青'], ['#16a34a', '緑'], ['#18181b', '黒'], ['#facc15', '黄']] as const;

const WIDTH_LABELS: Record<number, string> = {
  0.0015: '極細 (1.5)',
  0.003: '細 (3)',
  0.006: '中 (6)',
  0.015: '太 (15)',
  0.025: '極太 (25)',
  0.04: '特太 (40)',
};

export function DocumentWritingToolbar({ view }: { view: DocumentLibraryView }) {
  const lifecycleBusy = view.loading || view.state.inputActive || !view.editable;
  const busy = lifecycleBusy || view.editor.locked || !view.editor.visible;
  const selected = view.editor.selected.length > 0;
  const run = (command: () => void) => { view.editor.beforeCommand.current?.(); command(); };
  const [writingBarOpen, setWritingBarOpen] = useState(true);
  const [outputOpen, setOutputOpen] = useState(false);
  const notebookPdfTrigger = useRef<(() => void) | null>(null);
  const translationPdfTrigger = useRef<(() => void) | null>(null);

  const navDisabled = view.loading || view.state.inputActive || view.state.phase !== 'idle';
  const currentColor = view.editor.selected[0]?.color ?? view.editor.color;
  const currentWidth = view.editor.selected[0]?.width ?? view.editor.width;
  const isDrawingOrText = ['pen', 'highlighter', 'line', 'arrow', 'rectangle', 'ellipse', 'text'].includes(view.editor.tool);
  const showStyleRow = writingBarOpen && (isDrawingOrText || selected);
  const showEraserRow = writingBarOpen && view.editor.tool === 'eraser';
  const showSelectionRow = writingBarOpen && (selected || view.editor.hasClipboard);
  const showPdfSelectionRow = view.page?.background.kind === 'pdf' && view.pdfTextCommands.canBegin;
  const placementDisabled = view.loading || view.state.phase !== 'idle'
    || Object.values(view.state.surfaces).some(surface => surface.textDraft)
    || (view.state.inputActive && !view.annotation.canReposition());
  const buttonClass = 'inline-flex h-7 items-center gap-1 rounded px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40';

  return <>
    <div className="document-writing-toolbar ink-tools flex w-full flex-col border-b bg-background" role="toolbar"
      aria-label={view.kind === 'notebook' ? 'ノートの操作' : 'PDFの操作'}
      data-ink-toolbar-slot=""
      onPointerDownCapture={event => {
        if (!(event.target instanceof Element) || !event.target.closest('[data-reference-command]')) view.editor.activate(event);
      }}
      onFocusCapture={event => {
        if (!(event.target instanceof Element) || !event.target.closest('[data-reference-command]')) view.editor.activate(event);
      }}>
      {/* 1段目: リーダー操作バー */}
      <div className="flex min-h-9 w-full flex-wrap items-center gap-1 px-2 py-1 text-xs">
        <PageNavigatorView paperId={view.documentId} currentPage={view.pageIndex + 1} count={view.pageCount} compact
          atStart={!view.canPrevious} atEnd={!view.canNext} disabled={navDisabled}
          onMove={amount => { if (amount === -1 || amount === 1) view.move(amount); }} onJump={view.jump} />

        {view.kind === 'notebook' && <CanonicalNotebookControls view={view} onImportPdf={() => notebookPdfTrigger.current?.()} />}

        {view.kind === 'pdf' && <>
          <div className="inline-flex items-center rounded-md border bg-muted/40 p-0.5" role="group" aria-label="表示切替">
            {([['original', '原文'], ['translated', '訳文'], ['split', '左右']] as const).map(([mode, label]) => (
              <button key={mode} type="button" aria-pressed={view.display === mode} disabled={navDisabled}
                className={`h-6 rounded px-2 text-xs transition-colors disabled:opacity-40 ${view.display === mode ? 'bg-primary text-primary-foreground font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                onClick={() => view.changeDisplay(mode)}>{label}</button>
            ))}
          </div>
          <CanonicalPdfSearch {...view.pdfSearch} />
        </>}

        <NativeSelect aria-label="倍率" className="h-7 w-auto min-w-24 text-xs"
          disabled={view.state.inputActive || view.state.phase !== 'idle'} value={view.zoom}
          onChange={event => view.changeZoom(Number(event.target.value), true)}>
          <option value={0}>ページ全体</option><option value={1}>幅に合わせる</option>
          {[1.25, 1.5, 2, 2.5, 3, 4].map(zoom => <option key={zoom} value={zoom}>{zoom * 100}%</option>)}
          {view.zoom > 0 && ![1, 1.25, 1.5, 2, 2.5, 3, 4].includes(view.zoom) && <option value={view.zoom}>{Math.round(view.zoom * 100)}%</option>}
        </NativeSelect>

        <Button type="button" variant={writingBarOpen ? 'secondary' : 'ghost'} size="sm"
          aria-pressed={writingBarOpen} aria-label="書き込みツール"
          title={writingBarOpen ? '書き込みツールを隠す' : '書き込みツールを表示'}
          onClick={() => setWritingBarOpen(value => !value)}>
          <PenLine className="size-3.5" /><span className="hidden md:inline">書き込み</span>
        </Button>

        <div className="ml-auto flex items-center gap-1">
          {view.status && <span role="status" className="px-1 text-xs text-muted-foreground whitespace-nowrap">{view.status}</span>}
          <Button type="button" variant="ghost" size="sm" aria-label="同期" title="同期" disabled={view.syncDisabled} onClick={view.sync}>
            <RefreshCw className="size-3.5" /><span className="hidden lg:inline">同期</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger aria-label="リーダーのその他" title="表示・配置・書き出し"
              className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground">
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-max min-w-52">
              <DropdownMenuItem disabled={lifecycleBusy} onClick={() => { view.editor.setTool('select'); view.editor.setLocked(!view.editor.locked); }}>
                {view.editor.locked ? '編集ロックを解除' : '編集をロック'}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={lifecycleBusy} onClick={() => { view.editor.setTool('select'); view.editor.setVisible(!view.editor.visible); }}>
                {view.editor.visible ? '書き込みを非表示' : '書き込みを表示'}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={busy} onClick={() => view.annotation.setMode(view.annotation.mode === 'annotation-select' ? 'ink' : 'annotation-select')}>
                {view.annotation.mode === 'annotation-select' ? '注釈の選択を終了' : '注釈を選択'}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={placementDisabled} onClick={() => { void view.moveEditor(view.placement === 'center' ? 'right' : 'center'); }}>
                {view.placement === 'center' ? '右側で編集' : '中央で編集'}
              </DropdownMenuItem>
              {view.referenceControls.pinned ? <>
                <DropdownMenuItem data-reference-command onClick={view.referenceControls.pin}>現在のページに置き換える</DropdownMenuItem>
                <DropdownMenuItem data-reference-command onClick={view.referenceControls.clear}>固定を解除</DropdownMenuItem>
              </> : (
                <DropdownMenuItem data-reference-command onClick={view.referenceControls.pin}>このページを参照に固定</DropdownMenuItem>
              )}
              {view.kind === 'pdf' && <>
                <DropdownMenuCheckboxItem checked={view.translatedOnly} disabled={navDisabled}
                  onCheckedChange={checked => view.changeTranslatedOnly(!!checked)}>訳文があるページだけ</DropdownMenuCheckboxItem>
                {view.filterPending && (
                  <DropdownMenuItem disabled={navDisabled} onClick={() => view.retryFilter()}>更新されたページへ移動</DropdownMenuItem>
                )}
              </>}
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={view.loading || view.state.inputActive} onClick={() => setOutputOpen(true)}>書き出し・切り抜き…</DropdownMenuItem>
              {view.kind === 'pdf' && view.notebookPdfImport && (
                <DropdownMenuItem disabled={!view.notebookPdfImport.available || view.notebookPdfImport.state.phase !== 'idle'}
                  onClick={() => notebookPdfTrigger.current?.()}>原文PDFの背景を差し替える…</DropdownMenuItem>
              )}
              {view.kind === 'pdf' && view.translationImport && (
                <DropdownMenuItem disabled={!view.translationImport.available || view.translationImport.state.phase !== 'idle'}
                  onClick={() => translationPdfTrigger.current?.()}>訳文PDFを取り込む…</DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* 2段目: コンパクト書き込みバー */}
      {writingBarOpen && (
        <div className="flex w-full flex-wrap items-center gap-1 border-t bg-muted/30 px-2 py-1 text-xs">
          {([
            ['select', '読む', MousePointer2],
            ['pen', 'ペン', PenLine],
            ['eraser', '消しゴム', Eraser],
            ['text', '文字', Type],
            ['region', '範囲選択', SquareDashed],
            ['lasso', 'なげなわ', Lasso],
          ] as const).map(([tool, label, Icon]) => (
            <button key={tool} type="button"
              aria-pressed={view.annotation.mode === 'ink' && view.editor.tool === tool}
              aria-label={label} title={label} disabled={busy}
              className={`${buttonClass} ${view.annotation.mode === 'ink' && view.editor.tool === tool ? 'bg-primary text-primary-foreground font-medium' : ''}`}
              onClick={() => run(() => view.editor.setTool(tool))}>
              <Icon className="size-3.5" /><span className="hidden sm:inline">{label}</span>
            </button>
          ))}
          <DrawingKindSelect value={view.editor.tool} onChange={kind => run(() => view.editor.setTool(kind))} disabled={busy}
            className="h-7 rounded border border-input bg-background px-1.5 text-xs" />
          <button type="button" disabled={busy} aria-pressed={view.annotation.mode === 'sticky-place'}
            aria-label="付箋を貼る" title="付箋を貼る"
            className={`${buttonClass} ${view.annotation.mode === 'sticky-place' ? 'bg-primary text-primary-foreground font-medium' : ''}`}
            onClick={() => view.annotation.setMode(view.annotation.mode === 'sticky-place' ? 'ink' : 'sticky-place')}>
            <StickyNote className="size-3.5" /><span className="hidden md:inline">付箋</span>
          </button>
          {view.noteAppend && (
            <button type="button" disabled={!view.noteAppend.canBegin} aria-pressed={view.editor.tool === 'capture'}
              aria-label="範囲を画像にする" title="範囲を画像にする"
              className={`${buttonClass} ${view.editor.tool === 'capture' ? 'bg-primary text-primary-foreground font-medium' : ''}`}
              onClick={view.noteAppend.startCapture}>
              <Scan className="size-3.5" /><span className="hidden lg:inline">切り抜き</span>
            </button>
          )}
          <span className="mx-1 h-4 border-l" />
          <WritingHistoryButtons canUndo={!view.loading && view.state.canUndo && !view.state.inputActive}
            canRedo={!view.loading && view.state.canRedo && !view.state.inputActive}
            onUndo={view.undo} onRedo={view.redo} className={buttonClass} />

          {view.editor.locked && (
            <Button type="button" variant="outline" size="xs" disabled={lifecycleBusy}
              onClick={() => { view.editor.setTool('select'); view.editor.setLocked(false); }}>
              <Lock className="size-3" />ロック中（解除）
            </Button>
          )}
          {!view.editor.visible && (
            <Button type="button" variant="outline" size="xs" disabled={lifecycleBusy}
              onClick={() => { view.editor.setTool('select'); view.editor.setVisible(true); }}>
              <Unlock className="size-3" />非表示中（表示）
            </Button>
          )}
          {view.referenceControls.pinned && (
            <span className="ml-auto inline-flex items-center gap-1 rounded border bg-background px-2 py-0.5 text-xs text-muted-foreground">
              <span>参照固定中：{view.referenceControls.label}</span>
              <button data-reference-command type="button" className="underline hover:text-foreground" onClick={view.referenceControls.clear}>固定を解除</button>
            </span>
          )}
          {view.kind === 'pdf' && view.filterPending && (
            <Button type="button" variant="outline" size="xs" disabled={navDisabled} onClick={() => view.retryFilter()}>
              更新された対象 {view.filterCandidateCount}件へ移動
            </Button>
          )}
        </div>
      )}

      {/* コンテキスト行: 描画/文字スタイル */}
      {showStyleRow && (
        <div className="flex w-full flex-wrap items-center gap-2 border-t bg-muted/20 px-2.5 py-1 text-xs" role="group" aria-label="書き込みの色と太さ">
          <div className="inline-flex items-center gap-1">
            {INK_COLORS.map(([hex, name]) => (
              <button key={hex} type="button" disabled={busy} aria-label={`色: ${name}`} title={name}
                aria-pressed={currentColor.toLowerCase() === hex}
                style={{ backgroundColor: hex }}
                className={`size-5 rounded-full border transition-transform ${currentColor.toLowerCase() === hex ? 'scale-110 ring-2 ring-ring ring-offset-1' : 'border-border'}`}
                onClick={() => run(() => view.editor.style({ color: hex }))} />
            ))}
            <input type="color" aria-label="書き込みの色" title="カスタム色" disabled={busy} value={currentColor}
              className="size-6 cursor-pointer rounded border border-input bg-transparent p-0"
              onChange={event => run(() => view.editor.style({ color: event.target.value }))} />
          </div>
          <NativeSelect aria-label="線の太さ" className="h-7 w-auto text-xs" disabled={busy} value={currentWidth}
            onChange={event => run(() => view.editor.style({ width: Number(event.target.value) }))}>
            {[.0015, .003, .006, .015, .025, .04].map(value => <option key={value} value={value}>{WIDTH_LABELS[value] ?? value * 1000}</option>)}
            {![.0015, .003, .006, .015, .025, .04].includes(currentWidth) && <option value={currentWidth}>現在の太さ</option>}
          </NativeSelect>
          <label className="inline-flex items-center gap-1 whitespace-nowrap">
            <input type="checkbox" aria-label="指で描く" disabled={busy} checked={view.editor.preferences.fingerDraw ?? false}
              onChange={event => view.editor.preferences.change({ fingerDraw: event.target.checked })} />指で描く
          </label>
          <Button type="button" variant="ghost" size="xs" disabled={busy || view.editor.preferences.presets.length >= 12}
            aria-label="現在のペンをお気に入りに追加" title="現在のペンをお気に入りに追加"
            onClick={() => view.editor.preferences.change({ presets: [...view.editor.preferences.presets, { color: currentColor, width: currentWidth }] })}>
            <Star className="size-3.5" /><span className="hidden sm:inline">お気に入り登録</span>
          </Button>
          {view.editor.preferences.presets.length > 0 && (
            <NativeSelect aria-label="お気に入りのペン" className="h-7 w-auto text-xs" disabled={busy} value=""
              onChange={event => { const preset = view.editor.preferences.presets[Number(event.target.value)]; if (preset) run(() => view.editor.style(preset)); }}>
              <option value="" disabled>お気に入りから適用</option>
              {view.editor.preferences.presets.map((preset, index) => <option key={index} value={index}>設定 {index + 1}（{preset.color}・{preset.width * 1000}）</option>)}
            </NativeSelect>
          )}
        </div>
      )}

      {/* コンテキスト行: 消しゴム */}
      {showEraserRow && (
        <div className="flex w-full flex-wrap items-center gap-3 border-t bg-muted/20 px-2.5 py-1 text-xs">
          <label className="inline-flex items-center gap-1.5">大きさ
            <NativeSelect aria-label="消しゴムの大きさ" className="h-7 w-20 text-xs" disabled={busy} value={view.editor.preferences.eraserRadius}
              onChange={event => view.editor.preferences.change({ eraserRadius: Number(event.target.value) })}>
              <option value={5}>小</option><option value={10}>中</option><option value={20}>大</option>
            </NativeSelect>
          </label>
          <label className="inline-flex items-center gap-1.5"><input type="checkbox" disabled={busy} checked={view.editor.preferences.partial}
            onChange={event => view.editor.preferences.change({ partial: event.target.checked })} />部分消しゴム</label>
          <label className="inline-flex items-center gap-1.5"><input type="checkbox" disabled={busy} checked={view.editor.preferences.highlightOnly}
            onChange={event => view.editor.preferences.change({ highlightOnly: event.target.checked })} />蛍光ペンだけ消す</label>
        </div>
      )}

      {/* コンテキスト行: 選択・クリップボード */}
      {showSelectionRow && (
        <div className="flex w-full flex-wrap items-center gap-1 border-t bg-muted/20 px-2.5 py-1 text-xs" role="group" aria-label="選択中の書き込み操作">
          {selected && <>
            <Button type="button" variant="outline" size="xs" disabled={busy} onClick={() => run(view.editor.copy)}><Copy className="size-3" />コピー</Button>
            <Button type="button" variant="outline" size="xs" disabled={busy} onClick={() => run(view.editor.cut)}><Scissors className="size-3" />切り取り</Button>
            <Button type="button" variant="outline" size="xs" disabled={busy} onClick={() => run(view.editor.duplicate)}>複製</Button>
            <Button type="button" variant="outline" size="xs" disabled={busy} onClick={() => run(() => view.editor.transformSelected(1, Math.PI / 12))}><RotateCw className="size-3" />15度回転</Button>
            <Button type="button" variant="outline" size="xs" disabled={busy} onClick={() => run(() => view.editor.transformSelected(1.1))}><ZoomIn className="size-3" />書き込みを拡大</Button>
            <Button type="button" variant="outline" size="xs" disabled={busy} onClick={() => run(() => view.editor.transformSelected(1 / 1.1))}><ZoomOut className="size-3" />書き込みを縮小</Button>
            <Button type="button" variant="destructive" size="xs" disabled={busy} onClick={() => run(view.editor.remove)}><Trash2 className="size-3" />削除</Button>
          </>}
          {view.editor.hasClipboard && (
            <Button type="button" variant="outline" size="xs" disabled={busy} onClick={() => run(view.editor.paste)}>貼り付け</Button>
          )}
        </div>
      )}

      {/* コンテキスト行: PDF本文選択中のみ */}
      {showPdfSelectionRow && (
        <div className="flex w-full flex-wrap items-center gap-1.5 border-t bg-accent/40 px-2.5 py-1 text-xs">
          <Button type="button" variant="outline" size="xs" data-pdf-selection-command="copy"
            onPointerDown={event => event.preventDefault()} onClick={view.pdfTextCommands.copy}>選択した文章をコピー</Button>
          <Button type="button" variant="outline" size="xs" data-pdf-selection-command="highlight"
            disabled={!view.editable || !view.annotation.available}
            onPointerDown={event => event.preventDefault()} onClick={view.pdfTextCommands.highlight}>選択した文章をハイライト</Button>
          {view.noteAppend && <>
            <Button type="button" variant="outline" size="xs" data-pdf-selection-command="quote" disabled={!view.noteAppend.canBegin}
              onPointerDown={event => event.preventDefault()} onClick={view.noteAppend.quoteSelection}>選択した文章をノートへ追加</Button>
            <label className="ml-1 inline-flex items-center gap-1" title="付箋・本文ハイライトは含まれません。">
              <input type="checkbox" aria-label="手書き・図形を含める" checked={view.noteAppend.includeInk}
                disabled={!view.noteAppend.canBegin} onChange={event => view.noteAppend?.changeIncludeInk(event.target.checked)} />手書き・図形を含める
            </label>
          </>}
        </div>
      )}
    </div>

    {view.notebookPdfImport && (
      <DocumentPdfImportControls controller={view.notebookPdfImport} notebook={view.kind === 'notebook'} openPickerRef={notebookPdfTrigger} showTrigger={false} />
    )}
    {view.kind === 'pdf' && view.translationImport && (
      <TranslationPdfImportControls controller={view.translationImport} openPickerRef={translationPdfTrigger} showTrigger={false} />
    )}
    {(view.output.busy || view.output.canDownloadCapture || view.output.error) && !outputOpen && (
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-1.5 text-xs">
        {view.output.status && <span role="status" className="text-muted-foreground">{view.output.status}</span>}
        {view.output.error && <span role="alert" className="text-destructive">{view.output.error}</span>}
        {view.output.busy && <Button type="button" variant="ghost" size="xs" disabled={!view.output.canCancel} onClick={view.output.cancel}>出力を取り消す</Button>}
        {view.output.canDownloadCapture && <Button type="button" variant="outline" size="xs" disabled={view.output.busy || view.loading || view.state.inputActive} onClick={() => { void view.output.downloadCapture(); }}>生成した画像をダウンロード</Button>}
      </div>
    )}
    {view.annotationCandidate && <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-1.5 text-xs">
      <span>一覧で選択した注釈の場所を表示しています。</span>
      <Button type="button" variant="outline" size="xs" onClick={view.annotationCandidate.edit}>この注釈を編集</Button>
      <Button type="button" variant="ghost" size="xs" onClick={view.annotationCandidate.cancel}>注釈の編集候補を閉じる</Button>
    </div>}
    {view.editor.preferences.persistenceError && <div role="alert" className="border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
      {view.editor.preferences.persistenceError} <Button type="button" variant="link" size="xs" onClick={view.editor.preferences.retryPersistence}>書き込み設定の保存を再試行</Button>
    </div>}
    <CanonicalAnnotationEditor annotation={view.annotation} description={`${view.activeSurface === 'original' ? '原文' : '訳文'}・${view.pageIndex + 1}ページ`} />
    {view.noteAppend && <NoteAppendDialog append={view.noteAppend} />}
    {(view.state.heads.length > 1 || view.conflict.canDiscardRejected) && <DocumentConflictPanel port={view.conflict} />}
    {view.state.heads.length > 1 && <div role="status" className="flex flex-wrap items-center gap-2 border-b bg-amber-500/10 px-3 py-1.5 text-xs">
      <span>複数の端末で変更されています。確認する版を選んでください。各版の内容は保持しています。</span>
      <NativeSelect aria-label="確認する版" className="h-7 w-auto text-xs" value={view.state.selectedVersion ?? ''} disabled={view.state.inputActive || view.state.phase !== 'idle'}
        onChange={event => view.checkout(event.target.value)}>
        <option value="" disabled>版を選択</option>
        {view.state.selectedVersion && !view.state.heads.includes(view.state.selectedVersion) && <option value={view.state.selectedVersion}>現在表示中の版</option>}
        {view.state.heads.map((version, index) => <option key={version} value={version}>版 {index + 1}（{version.slice(0, 8)}）</option>)}
      </NativeSelect>
      <Button type="button" variant="outline" size="xs" disabled={!view.state.selectedVersion || view.state.inputActive || view.state.phase !== 'idle'}
        onClick={() => { if (view.state.selectedVersion) view.checkout(view.state.selectedVersion); }}>表示中の版を開く</Button>
    </div>}
    {view.error && <div role="alert" className="flex items-center gap-2 border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
      <span>{view.error}</span><Button type="button" variant="outline" size="xs" onClick={view.retry}>再試行</Button>
    </div>}

    <Dialog open={outputOpen} onOpenChange={setOutputOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>PDFの書き出し・範囲切り抜き</DialogTitle></DialogHeader>
        <DocumentOutputControls output={view.output} blocked={view.loading || view.state.inputActive}
          startCapture={() => { setOutputOpen(false); view.noteAppend?.startCapture(); }}
          captureAvailable={!!view.noteAppend?.canBegin} />
      </DialogContent>
    </Dialog>
  </>;
}

import { Columns2, ImagePlus, PanelRight, Redo2, RefreshCw, Undo2, X } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { NativeSelect } from '../../../components/ui/native-select';
import { ReaderWorkspace } from '../../reader/ReaderWorkspace';
import { MarkdownEditorPanel } from './MarkdownEditorPanel';
import type { MarkdownLibraryView } from './MarkdownLibraryConnection';
import { CanonicalMarkdownPreview } from './CanonicalMarkdownPreview';
import { MarkdownTemplates } from './MarkdownTemplates';
import { MarkdownConflictPanel } from './MarkdownConflictPanel';
import { useFocusFileChooser } from '../../workspace/useFocusFileChooser';


function Preview({ content, view }: { content: string; view: MarkdownLibraryView }) {
  return <CanonicalMarkdownPreview content={content} imageResources={view.state.imageResources} resources={view.resources} />;
}

export function CanonicalMarkdownToolbar({ view }: { view: MarkdownLibraryView }) {
  const imagePicker = useFocusFileChooser();
  const blocked = view.loading || !view.editable || view.state.editingBlocked;
  const selected = view.state.accepted?.version ?? '';
  return <>
    <div role="toolbar" aria-label="Markdownノートの操作" className="flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b bg-background px-2 py-1 text-xs">
      <Button type="button" variant="ghost" size="sm" disabled={blocked}
        onClick={() => { void view.moveEditor(view.placement === 'center' ? 'right' : 'center'); }}>
        {view.placement === 'center' ? <><PanelRight className="size-3.5" />右側で編集</> : <><Columns2 className="size-3.5" />中央で編集</>}
      </Button>
      <span className="mx-1 h-4 border-l" />
      <Button type="button" variant="ghost" size="sm" aria-label="元に戻す" title="元に戻す" disabled={blocked || !view.state.canUndo} onClick={view.undo}>
        <Undo2 className="size-3.5" /><span className="hidden sm:inline">元に戻す</span>
      </Button>
      <Button type="button" variant="ghost" size="sm" aria-label="やり直す" title="やり直す" disabled={blocked || !view.state.canRedo} onClick={view.redo}>
        <Redo2 className="size-3.5" /><span className="hidden sm:inline">やり直す</span>
      </Button>
      {view.canAppendImage && <>
        <input ref={imagePicker.attach} type="file" accept="image/*" aria-label="追加する画像" className="hidden"
          disabled={blocked || view.state.imagePending || view.state.imageSaving}
          onClick={imagePicker.begin} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; imagePicker.selected(file ? view.appendImage(file) : undefined); }} />
        <Button type="button" variant="ghost" size="sm" disabled={blocked || view.state.imagePending || view.state.imageSaving}
          onClick={imagePicker.open}>
          <ImagePlus className="size-3.5" />画像を末尾に追加
        </Button>
      </>}
      {view.state.imagePending && <Button type="button" variant="outline" size="sm" disabled={blocked} onClick={view.cancelImage}>
        <X className="size-3.5" />画像の追加を取り消す
      </Button>}
      <div className="ml-auto flex items-center gap-1.5">
        {view.status && <span role="status" className="text-xs text-muted-foreground">{view.status}</span>}
        <Button type="button" variant="ghost" size="sm" disabled={view.syncDisabled} onClick={view.sync}>
          <RefreshCw className="size-3.5" /><span className="hidden sm:inline">同期</span>
        </Button>
      </div>
    </div>
    {view.heads.length > 1 && <div role="status" className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-amber-500/10 px-3 py-1.5 text-xs">
      <span>複数の端末で変更されています。確認する版を選んでください。各版の内容は保持しています。</span>
      <NativeSelect aria-label="確認する版" className="h-7 w-auto text-xs" value={selected} disabled={view.state.dirty || view.state.saving}
        onChange={event => view.checkout(event.target.value)}>
        <option value="" disabled>版を選択</option>
        {selected && !view.heads.includes(selected) && <option value={selected}>現在表示中の版</option>}
        {view.heads.map((version, index) => <option key={version} value={version}>版 {index + 1}（{version.slice(0, 8)}）</option>)}
      </NativeSelect>
    </div>}
    {view.heads.length > 1 && <MarkdownConflictPanel port={view.conflict} />}
    {view.error && <div role="alert" className="flex shrink-0 items-center gap-2 border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
      <span>{view.error}</span><Button type="button" variant="outline" size="xs" onClick={view.retry}>再試行</Button>
    </div>}
  </>;
}

/** Exactly one editable surface; the reference always renders the current draft. */
export function CanonicalMarkdownView({ view }: { view: MarkdownLibraryView }) {
  const state = view.state;
  return <ReaderWorkspace placement={view.placement}
    editor={<div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      {view.editable ? <MarkdownEditorPanel content={state.content} dirty={state.dirty} saving={state.saving} durable={state.durable}
        error="" showStatus={false} statePort={view.session} externalVersion={state.textGeneration}
        onChange={view.editText} onBlur={() => { void view.flush(); }} onRetry={view.retry}
        renderTemplates={(content, insert) => <MarkdownTemplates binding={view.binding} currentContent={content} onInsert={insert} onOpenChange={view.setTemplateOpen} />}
        renderPreview={content => <Preview content={content} view={view} />} />
        : <div className="min-h-0 flex-1 overflow-auto p-4">
          <p role="status" className="mb-3 rounded border bg-muted/40 p-2 text-xs text-muted-foreground">{view.loading ? 'ノートを読み込んでいます…'
            : view.deleted ? 'この資料は削除されています。新しい編集はできません。'
            : !state.ready && view.heads.length > 1 ? '確認する版を選んでください。'
              : view.scopeWriteHeld ? 'ライブラリの変更を確認しています。編集は一時停止しています。'
              : state.editingBlocked ? '保存データを確認してください。' : 'このノートは別の表示面で編集中です。'}</p>
          <Preview content={state.content} view={view} />
        </div>}
    </div>}
    reference={<div className="h-full min-h-0 overflow-auto bg-background p-4"><Preview content={state.content} view={view} /></div>} />;
}

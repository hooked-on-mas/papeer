import { useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { Button } from '../../../components/ui/button';
import { MarkdownEditor } from './MarkdownEditor';
import { noteSaveStatus } from '../useNoteAutosave';

export type MarkdownEditorPanelProps = {
  content: string; dirty: boolean; saving: boolean; durable: boolean; error: string;
  externalVersion?: number; revealEnd?: number;
  statePort?: ComponentProps<typeof MarkdownEditor>['statePort'];
  onChange(content: string): void; onBlur(): void; onRetry(): void;
  renderPreview(content: string): ReactNode;
  renderTemplates?: (content: string, insert: (text: string) => void) => ReactNode;
  showStatus?: boolean; recoveredDrafts?: readonly string[]; onClearRecovered?: () => void;
  /** The connection reports failures through error; rejection suppresses the success notice. */
  saveCopy?: () => Promise<void>;
};

/** Presentation shared by Markdown connections; persistence and editor ownership stay with the caller. */
export function MarkdownEditorPanel({ content, dirty, saving, durable, error, externalVersion, revealEnd,
  statePort, onChange, onBlur, onRetry, renderPreview, renderTemplates, showStatus = true,
  recoveredDrafts = [], onClearRecovered, saveCopy }: MarkdownEditorPanelProps) {
  const [preview, setPreview] = useState(false);
  const [copyNotice, setCopyNotice] = useState('');
  useEffect(() => { if (revealEnd) setPreview(false); }, [revealEnd]);
  return <div className="flex min-h-0 flex-1 flex-col gap-2 bg-background p-3">
    {recoveredDrafts.length > 0 && <details className="rounded-lg border bg-muted/30 p-2.5 text-xs"><summary className="cursor-pointer font-medium">以前の下書きを復元しました</summary>
      <p className="mt-1 text-muted-foreground">元の版が記録されていない下書きです。内容を確認し、必要な部分をノートへコピーしてください。</p>
      {recoveredDrafts.map((draft, index) => <textarea key={index} readOnly aria-label={`復元した下書き ${index + 1}`} value={draft} className="mt-2 min-h-28 w-full rounded border bg-background p-2" />)}
      {onClearRecovered && <Button type="button" variant="outline" size="xs" className="mt-2" onClick={onClearRecovered}>確認した下書きを削除</Button>}
    </details>}
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        {showStatus && <span role="status" className="text-xs text-muted-foreground">{noteSaveStatus({ saving, dirty, durable })}</span>}
        {renderTemplates?.(content, value => { onChange(`${content.trimEnd()}\n\n${value}\n`); setPreview(false); })}
      </div>
      <div className="inline-flex items-center rounded-md border bg-muted/40 p-0.5 text-xs">
        <button type="button" className={`h-6 rounded px-2.5 transition-colors ${!preview ? 'bg-background font-medium text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'}`}
          onClick={() => setPreview(false)}>編集</button>
        <button type="button" className={`h-6 rounded px-2.5 transition-colors ${preview ? 'bg-background font-medium text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'}`}
          onClick={() => setPreview(true)}>プレビュー</button>
      </div>
    </div>
    {error && <div role="alert" className="flex flex-wrap items-center gap-2 rounded border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
      <span>{error}</span><Button type="button" variant="outline" size="xs" onClick={onRetry}>再試行</Button>
      {saveCopy && <Button type="button" variant="outline" size="xs" onClick={() => { void saveCopy().then(() => setCopyNotice('下書きを別ノートに保存しました。')).catch(() => undefined); }}>下書きを別ノートとして保存</Button>}
    </div>}
    {copyNotice && <p role="status" className="text-xs text-muted-foreground">{copyNotice}</p>}
    {preview ? <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-card p-4">{renderPreview(content)}</div>
      : <MarkdownEditor statePort={statePort} externalVersion={externalVersion} revealEnd={revealEnd} value={content} onChange={onChange} onBlur={onBlur} />}
  </div>;
}

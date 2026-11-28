import { useEffect, useState } from 'react';
import { ListTree } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../../components/ui/dropdown-menu';
import type { Page } from '../../../runtime/edits/contracts';
import type { ContentRepository } from '../../../runtime/edits/ports';
import { pdfjs, pdfRenderingOptions } from './pdfRendering';
import { canonicalPdfResourceBinding, readCanonicalPdfResource, assertCanonicalPdfDocument } from './canonicalPdfResource';
import { loadOutline, type OutlineEntry, type PdfDocumentLike } from '../pdfLinks';
import type { PdfSearchHit } from './pdfTextSearch';

export function CanonicalPdfOutline({ pages, currentPageId, resources, navigate }: { pages: readonly Page[]; currentPageId: string;
  resources: Pick<ContentRepository, 'scope' | 'readResource'>; navigate(hit: PdfSearchHit): boolean }) {
  const [open, setOpen] = useState(false), [attempt, retry] = useState(0);
  const [entries, setEntries] = useState<OutlineEntry[] | null>(null), [status, setStatus] = useState('');
  const current = pages.find(page => page.id === currentPageId);
  const key = current?.background.kind === 'pdf' ? `${current.background.resourceId}:${current.background.sourceRevision}` : '';
  useEffect(() => {
    const controller = new AbortController(); setEntries(null);
    if (!open || !current || current.background.kind !== 'pdf') { setStatus(''); return () => controller.abort(); }
    setStatus('目次を読み込み中…');
    const hide = () => { controller.abort(); setOpen(false); }; window.addEventListener('pagehide', hide);
    void (async () => {
      const binding = canonicalPdfResourceBinding(resources.scope, current);
      const resource = await readCanonicalPdfResource(binding, resources); controller.signal.throwIfAborted();
      const loading = pdfjs.getDocument({ ...pdfRenderingOptions, data: resource.bytes });
      const abort = () => { void loading.destroy().catch(() => {}); };
      controller.signal.addEventListener('abort', abort, { once: true });
      try {
        const pdf = await loading.promise; controller.signal.throwIfAborted();
        assertCanonicalPdfDocument(binding, resource.metadata, pdf.numPages);
        const outline = await pdf.getOutline(); controller.signal.throwIfAborted();
        const doc: PdfDocumentLike = { numPages: pdf.numPages, getOutline: async () => outline,
          getDestination: id => pdf.getDestination(id), getPageIndex: ref => pdf.getPageIndex(ref), getPage: n => pdf.getPage(n) };
        const found = await loadOutline(doc); controller.signal.throwIfAborted();
        setEntries(found); setStatus(found.length ? '' : '目次はありません');
      } finally { controller.signal.removeEventListener('abort', abort); await loading.destroy(); }
    })().catch(() => { if (!controller.signal.aborted) setStatus('目次を取得できませんでした'); });
    return () => { window.removeEventListener('pagehide', hide); controller.abort(); };
    // The resource key identifies the document; moving within it does not reload the outline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key, resources, attempt]);
  return <DropdownMenu open={open} onOpenChange={setOpen}>
    <DropdownMenuTrigger aria-label="目次" title="PDFの目次"
      className="inline-flex h-7 items-center gap-1 rounded px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
      <ListTree className="size-3.5" /><span className="hidden lg:inline">目次</span>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="max-h-[min(60vh,var(--available-height))] w-80 max-w-[calc(100vw-2rem)]">
      {status && <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs text-muted-foreground">
        <span role="status">{status}</span>
        {status === '目次を取得できませんでした' && <Button type="button" variant="outline" size="xs" onClick={() => retry(value => value + 1)}>再試行</Button>}
      </div>}
      {entries?.map((entry, index) => {
        const target = entry.page === undefined ? undefined : pages.find(page => page.background.kind === 'pdf'
          && current?.background.kind === 'pdf' && page.background.resourceId === current.background.resourceId
          && page.background.sourceRevision === current.background.sourceRevision && page.background.pdfPage === entry.page);
        return <DropdownMenuItem key={index} disabled={!target}
          style={{ paddingLeft: `${8 + Math.min(entry.depth, 6) * 14}px` }}
          className="gap-2 text-xs"
          onClick={() => { if (target) navigate({ pageId: target.id, backgroundRevision: target.backgroundRevision, start: 0, end: 0, y: entry.anchor_y }); }}>
          <span className="min-w-0 flex-1 truncate">{entry.title}</span>
          {entry.page !== undefined && <span className="shrink-0 tabular-nums text-muted-foreground">p.{entry.page}</span>}
        </DropdownMenuItem>;
      })}
    </DropdownMenuContent>
  </DropdownMenu>;
}

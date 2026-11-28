import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import type { Page } from '../../../runtime/edits/contracts';
import type { ContentRepository } from '../../../runtime/edits/ports';
import { canonicalPdfSearchPages } from './canonicalPdfSearchPages';
import { searchPdfPages, type PdfSearchHit } from './pdfTextSearch';
import { CanonicalPdfOutline } from './CanonicalPdfOutline';

export function CanonicalPdfSearch({ pages, currentPageId, resources, navigate, clear }: { pages: readonly Page[]; currentPageId: string;
  resources: Pick<ContentRepository, 'scope' | 'readResource'>; navigate(hit: PdfSearchHit): boolean; clear(): void }) {
  const [query, setQuery] = useState(''), [open, setOpen] = useState(false), [index, setIndex] = useState(-1);
  const [result, setResult] = useState<{ hits: PdfSearchHit[]; limited: boolean } | null>(null);
  const [status, setStatus] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setResult(null); setIndex(-1);
    if (!open || !query.trim()) { setStatus(''); return () => controller.abort(); }
    setStatus('検索中…');
    const hide = () => { controller.abort(); setOpen(false); }; window.addEventListener('pagehide', hide);
    const timer = window.setTimeout(() => {
      void searchPdfPages(canonicalPdfSearchPages(pages, resources, controller.signal), query, controller.signal).then(value => {
        if (!controller.signal.aborted) { setResult(value); setStatus(value.limited ? '結果の上限に達しました' : ''); }
      }, () => { if (!controller.signal.aborted) setStatus('本文を取得できませんでした'); });
    }, 250);
    return () => { window.clearTimeout(timer); window.removeEventListener('pagehide', hide); controller.abort(); };
  }, [pages, resources, query, open]);
  const step = (amount: number) => {
    if (!result?.hits.length) return;
    const next = index < 0 ? (amount < 0 ? result.hits.length - 1 : 0) : (index + amount + result.hits.length) % result.hits.length;
    if (navigate(result.hits[next])) setIndex(next); else setStatus('移動できませんでした');
  };
  return <>
    <CanonicalPdfOutline pages={pages} currentPageId={currentPageId} resources={resources} navigate={hit => { clear(); return navigate(hit); }} />
    <Button type="button" variant={open ? 'secondary' : 'ghost'} size="sm" aria-label="本文検索" title="PDF本文検索" aria-expanded={open}
      onClick={() => { clear(); setOpen(value => !value); }}>
      <Search className="size-3.5" /><span className="hidden lg:inline">本文検索</span>
    </Button>
    {open && <div className="inline-flex flex-wrap items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5 text-xs">
      <Input aria-label="PDF本文検索" placeholder="本文を検索…" className="h-6 w-36 text-xs" value={query}
        onChange={event => { clear(); setQuery(event.target.value); }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); } }} />
      <Button type="button" variant="ghost" size="icon-xs" aria-label="前の結果" title="前の結果" disabled={!result?.hits.length} onClick={() => step(-1)}>
        <ChevronUp className="size-3.5" />
      </Button>
      <Button type="button" variant="ghost" size="icon-xs" aria-label="次の結果" title="次の結果" disabled={!result?.hits.length} onClick={() => step(1)}>
        <ChevronDown className="size-3.5" />
      </Button>
      <span role="status" className="px-1 text-xs text-muted-foreground whitespace-nowrap">
        {status || (result ? `${result.hits.length}件${index >= 0 ? `・${index + 1}件目` : ''}` : '')}
      </span>
      <Button type="button" variant="ghost" size="icon-xs" aria-label="本文検索を閉じる" title="閉じる" onClick={() => { clear(); setOpen(false); }}>
        <X className="size-3" />
      </Button>
    </div>}
  </>;
}

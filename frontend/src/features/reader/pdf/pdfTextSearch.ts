/** Search offsets refer to the original UTF-16 text, never normalized-string offsets. */
export type PdfTextMatch = { start: number; end: number };
export const PDF_SEARCH_PAGE_LIMIT = 1_000_000;
export const PDF_SEARCH_MATCH_LIMIT = 1000;

/** Normalize complete grapheme clusters so composition and compatibility expansions retain source offsets. */
export function normalizePdfSearchText(source: string): { text: string; starts: number[]; ends: number[] } {
  const starts: number[] = [], ends: number[] = [];
  let text = '';
  const Segmenter = (Intl as unknown as { Segmenter: new (locale: string | undefined, options: { granularity: 'grapheme' }) => {
    segment(input: string): Iterable<{ segment: string; index: number }> } }).Segmenter;
  const segments = new Segmenter(undefined, { granularity: 'grapheme' }).segment(source);
  for (const segment of segments) {
    const normalized = segment.segment.normalize('NFKC').toLocaleLowerCase('und');
    text += normalized;
    for (let i = 0; i < normalized.length; i++) { starts.push(segment.index); ends.push(segment.index + segment.segment.length); }
  }
  return { text, starts, ends };
}

/** A page over the limit is rejected explicitly, rather than silently reporting incomplete results. */
export function findPdfTextMatches(source: string, query: string, limit = PDF_SEARCH_MATCH_LIMIT): { matches: PdfTextMatch[]; limited: boolean } {
  if (source.length > PDF_SEARCH_PAGE_LIMIT) throw new Error('pdf-search-page-too-large');
  if (query.length > 4096) throw new Error('pdf-search-query-too-large');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PDF_SEARCH_MATCH_LIMIT) throw new Error('pdf-search-limit');
  const needle = query.normalize('NFKC').toLocaleLowerCase('und');
  if (!needle.trim()) return { matches: [], limited: false };
  const index = normalizePdfSearchText(source), matches: PdfTextMatch[] = [];
  let from = 0;
  while (from <= index.text.length - needle.length) {
    const at = index.text.indexOf(needle, from); if (at < 0) break;
    if (matches.length === limit) return { matches, limited: true };
    matches.push({ start: index.starts[at], end: index.ends[at + needle.length - 1] });
    from = at + Math.max(1, needle.length);
  }
  return { matches, limited: false };
}

export type PdfSearchRect = { x: number; y: number; width: number; height: number };
export type PdfSearchPage = { id: string; backgroundRevision: string; text(): Promise<{ text: string; anchors: ({ start: number; end: number } & PdfSearchRect)[] }> };
export type PdfSearchHit = PdfTextMatch & { pageId: string; backgroundRevision: string; y?: number; rects?: PdfSearchRect[] };
/** Retains only bounded hits and one page of text. The caller owns aborting its PDF loading task. */
export async function searchPdfPages(pages: AsyncIterable<PdfSearchPage>, query: string, signal: AbortSignal,
  onPage?: (pageId: string) => void): Promise<{ hits: PdfSearchHit[]; limited: boolean }> {
  const hits: PdfSearchHit[] = [];
  signal.throwIfAborted();
  for await (const page of pages) {
    signal.throwIfAborted();
    const source = await page.text(); signal.throwIfAborted();
    const found = findPdfTextMatches(source.text, query, PDF_SEARCH_MATCH_LIMIT - hits.length || 1);
    for (const match of found.matches) {
      if (hits.length === PDF_SEARCH_MATCH_LIMIT) return { hits, limited: true };
      // Anchors follow text order. Binary search prevents a page with many text items and hits
      // from multiplying the work; cap visible boxes for exceptionally long matches.
      let low = 0, high = source.anchors.length;
      while (low < high) { const middle = (low + high) >>> 1; if (source.anchors[middle].end <= match.start) low = middle + 1; else high = middle; }
      const anchors: typeof source.anchors = [];
      while (low < source.anchors.length && source.anchors[low].start < match.end && anchors.length < 128) anchors.push(source.anchors[low++]);
      hits.push({ pageId: page.id, backgroundRevision: page.backgroundRevision, ...match,
        ...(anchors.length ? { y: anchors[0].y, rects: anchors.map(({ x, y, width, height }) => ({ x, y, width, height })) } : {}) });
    }
    onPage?.(page.id);
    if (found.limited) return { hits, limited: true };
  }
  signal.throwIfAborted();
  return { hits, limited: false };
}

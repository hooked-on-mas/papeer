/** pageId names the actual page in surface's collection; anchors are page-local points. */
export type CitationTarget = {
  libraryId: string;
  documentId: string;
  pageId: string;
  backgroundRevision: string;
  surface: 'original' | 'translated';
  anchor?: { xPt: number; yPt: number };
};

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const location = new RegExp(`^papeer://citation/(${uuid})/(${uuid})/(${uuid})\\?([^#\\s]+)$`);
const validId = (value: unknown): value is string => typeof value === 'string' && value.length === 36 && new RegExp(`^${uuid}$`).test(value);
const numberText = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?$/;

/** No legacy page-number URLs, percent-encoded aliases, fragments or unknown query parameters. */
export function parseMarkdownCitationUri(uri: string): CitationTarget | null {
  const match = location.exec(uri);
  if (!match || match[0] !== uri) return null;
  const query = new Map<string, string>();
  for (const part of match[4].split('&')) {
    const pair = part.split('=');
    if (pair.length !== 2 || !['backgroundRevision', 'surface', 'xPt', 'yPt'].includes(pair[0]) || query.has(pair[0])) return null;
    query.set(pair[0], pair[1]);
  }
  const backgroundRevision = query.get('backgroundRevision'), surface = query.get('surface');
  if (!validId(backgroundRevision) || (surface !== 'original' && surface !== 'translated')) return null;
  const x = query.get('xPt'), y = query.get('yPt');
  if ((x === undefined) !== (y === undefined)) return null;
  let anchor: CitationTarget['anchor'];
  if (x !== undefined && y !== undefined) {
    if (!numberText.test(x) || !numberText.test(y)) return null;
    const xPt = Number(x), yPt = Number(y);
    if (!Number.isFinite(xPt) || !Number.isFinite(yPt) || xPt < 0 || yPt < 0) return null;
    anchor = { xPt, yPt };
  }
  return { libraryId: match[1], documentId: match[2], pageId: match[3], backgroundRevision, surface, ...(anchor ? { anchor } : {}) };
}

export function formatMarkdownCitationUri(target: CitationTarget): string {
  if (![target.libraryId, target.documentId, target.pageId, target.backgroundRevision].every(validId)
    || !['original', 'translated'].includes(target.surface)
    || (target.anchor !== undefined && (!target.anchor || !Number.isFinite(target.anchor.xPt) || !Number.isFinite(target.anchor.yPt)
      || target.anchor.xPt < 0 || target.anchor.yPt < 0))) throw new Error('markdown-citation-target-invalid');
  const anchor = target.anchor ? `&xPt=${target.anchor.xPt}&yPt=${target.anchor.yPt}` : '';
  return `papeer://citation/${target.libraryId}/${target.documentId}/${target.pageId}?backgroundRevision=${target.backgroundRevision}&surface=${target.surface}${anchor}`;
}

// Literal text survives MarkdownContent's normalization, including its math delimiter repair.
function escapeText(text: string): string {
  return text.replace(/[&\\`*{}\[\]()#+.!_<>|$~=:@-]/g, value => `&#${value.charCodeAt(0)};`);
}
export function markdownCitationLink(target: CitationTarget, label = '出典'): string {
  return `[${escapeText(label.replace(/[\r\n]+/g, ' '))}](${formatMarkdownCitationUri(target)})`;
}
export function markdownQuote(text: string, target: CitationTarget, label = '出典'): string {
  const quote = text.replace(/\r\n?/g, '\n').split('\n').map(line => `> ${escapeText(line)}`).join('\n');
  return `${quote}\n\n${markdownCitationLink(target, label)}`;
}
export function appendMarkdownQuote(content: string, text: string, target: CitationTarget, label = '出典'): string {
  return `${content}\n\n${markdownQuote(text, target, label)}\n`;
}

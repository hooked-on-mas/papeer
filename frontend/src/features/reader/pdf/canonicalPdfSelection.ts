import type { Page } from '../../../runtime/edits/contracts.ts';
import { cleanPdfSelection } from '../../../lib/pdfSelection.ts';
import { formatMarkdownCitationUri, type CitationTarget } from '../../../runtime/markdown/markdownCitations.ts';

/** Only a range wholly inside this displayed PDF text layer can become a citation. */
export function selectCanonicalPdfText({ range, textLayer, page, target }: {
  range: Range; textLayer: HTMLElement; page: Page; target: CitationTarget;
}): { text: string; target: CitationTarget } | null {
  if (!textLayer.isConnected || !textLayer.classList.contains('textLayer') || range.collapsed
    || !textLayer.contains(range.startContainer) || !textLayer.contains(range.endContainer)
    || page.background.kind !== 'pdf' || target.pageId !== page.id || target.backgroundRevision !== page.backgroundRevision) return null;
  try { formatMarkdownCitationUri(target); } catch { return null; }
  const box = textLayer.getBoundingClientRect(), first = Array.from(range.getClientRects()).find(rect => rect.width > 0 && rect.height > 0);
  if (!first || ![box.width, box.height, page.widthPt, page.heightPt].every(value => Number.isFinite(value) && value > 0)) return null;
  const text = cleanPdfSelection(range.toString()); if (!text) return null;
  const x = Math.max(0, Math.min(1, (first.left - box.left) / box.width));
  const y = Math.max(0, Math.min(1, (first.top - box.top) / box.height));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { text, target: { ...target, anchor: { xPt: x * page.widthPt, yPt: y * page.heightPt } } };
}

import { useEffect, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/types/src/display/api';
import { useRef } from 'react';
import { resolveDestination, type PdfDocumentLike } from '../pdfLinks';
import { pdfLinkRect, safePdfExternalUrl } from './canonicalPdfLinks';

type Link = { id: string; rect: NonNullable<ReturnType<typeof pdfLinkRect>>; url: string | null; dest: unknown };
export function CanonicalPdfLinks({ document, page, enabled, navigate, admit }: { document: PDFDocumentProxy; page: PDFPageProxy; enabled: boolean;
  navigate(page: number, y?: number): boolean; admit(): boolean }) {
  const [links, setLinks] = useState<Link[]>([]);
  const alive = useRef(false);
  useEffect(() => {
    let live = true; alive.current = true; setLinks([]);
    void page.getAnnotations({ intent: 'display' }).then(annotations => {
      if (!live) return;
      const viewport = page.getViewport({ scale: 1 });
      setLinks(annotations.slice(0, 1000).flatMap((entry, index) => {
        if (entry.subtype !== 'Link') return [];
        const rect = pdfLinkRect(viewport, entry.rect), url = safePdfExternalUrl(entry.url);
        if (!rect || (!url && !entry.dest)) return [];
        return [{ id: String(entry.id ?? index), rect, url, dest: entry.dest }];
      }));
    }).catch(() => { if (live) setLinks([]); });
    return () => { live = false; alive.current = false; };
  }, [page, document]);
  if (!enabled) return null;
  return <div className="pointer-events-none absolute inset-0" aria-label="PDFリンク">{links.map(link => <a key={link.id}
    className="pointer-events-auto absolute focus:outline focus:outline-2 focus:outline-blue-600" style={{ left: `${link.rect.x * 100}%`, top: `${link.rect.y * 100}%`, width: `${link.rect.width * 100}%`, height: `${link.rect.height * 100}%` }}
    href={link.url ?? '#'} target={link.url ? '_blank' : undefined} rel={link.url ? 'noopener noreferrer' : undefined} aria-label={link.url ? `外部リンク ${link.url}` : 'PDF内リンク'}
    onPointerDown={event => event.stopPropagation()} onClick={event => {
      event.stopPropagation();
      if (!admit()) { event.preventDefault(); return; }
      if (!link.url) {
        event.preventDefault();
        void resolveDestination(document as unknown as PdfDocumentLike, link.dest).then(place => { if (place && alive.current && admit()) navigate(place.page, place.anchor_y); });
      }
    }} />)}</div>;
}

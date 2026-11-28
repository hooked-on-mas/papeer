import { useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import type { Page, ResourceMetadata } from '../../../runtime/edits/contracts';
import { canonicalJson } from '../../../runtime/edits/editModel';
import { PdfDocument, PdfPage } from './PdfDocument';
import { cappedPixelRatio } from '../canvasBudget';
import { assertCanonicalPdfDocument, assertCanonicalPdfPage, canonicalPdfResourceBinding, readCanonicalPdfResource,
  type CanonicalPdfResourceBinding } from './canonicalPdfResource';
import type { ComparisonResources } from '../CanonicalDocumentPagePreview';

type LoadedPdf = Parameters<NonNullable<ComponentProps<typeof PdfDocument>['onLoadSuccess']>>[0];
type LoadedPage = Parameters<NonNullable<ComponentProps<typeof PdfPage>['onLoadSuccess']>>[0];
const matches = (page: Pick<LoadedPage, 'getViewport' | 'pageNumber'>, binding: CanonicalPdfResourceBinding) => {
  try { assertCanonicalPdfPage(binding, page); return true; }
  catch { return false; }
};
/** Lazy PDF-only renderer. The parent remounts this component for every immutable page tuple. */
export function CanonicalPdfPagePreview({ page, resources, width }: { page: Page; resources: ComparisonResources; width: number }) {
  const binding = useMemo(() => canonicalPdfResourceBinding(resources.scope, page), [resources.scope, page]);
  const [resource, setResource] = useState<{ url: string; metadata: ResourceMetadata; generation: number } | null>(null);
  const [verified, setVerified] = useState(false), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  const lifetime = useRef({ generation: 0, active: false });
  useLayoutEffect(() => {
    const current = lifetime.current, generation = ++current.generation; current.active = true;
    let url: string | undefined;
    const alive = () => current.active && current.generation === generation && canonicalJson(resources.scope) === canonicalJson(binding.scope);
    setResource(null); setVerified(false); setError(false);
    void readCanonicalPdfResource(binding, resources).then(value => {
      if (!alive()) return;
      url = URL.createObjectURL(new Blob([Uint8Array.from(value.bytes)], { type: 'application/pdf' }));
      if (!alive()) { URL.revokeObjectURL(url); url = undefined; return; }
      setResource({ url, metadata: value.metadata, generation });
    }).catch(() => { if (alive()) setError(true); });
    return () => { current.active = false; current.generation++; if (url) URL.revokeObjectURL(url); };
  }, [binding, resources, attempt]);
  const alive = () => lifetime.current.active && canonicalJson(resources.scope) === canonicalJson(binding.scope);
  const resourceActive = () => alive() && resource?.generation === lifetime.current.generation;
  const loaded = (pdf: LoadedPdf) => {
    const generation = lifetime.current.generation;
    if (!resourceActive() || !resource) return;
    try { assertCanonicalPdfDocument(binding, resource.metadata, pdf.numPages); }
    catch { setError(true); return; }
    void pdf.getPage(binding.pdfPage).then(actual => {
      if (!alive() || lifetime.current.generation !== generation) return;
      if (!matches(actual, binding)) { setError(true); return; }
      setVerified(true);
    }).catch(() => { if (alive() && lifetime.current.generation === generation) setError(true); });
  };
  const ratio = cappedPixelRatio(window.devicePixelRatio || 1, width, width * page.heightPt / page.widthPt, 2 ** 22, 8192);
  if (error) return <div role="alert">PDF背景を確認できません。ページの注釈は保持しています。
    <button type="button" onClick={() => setAttempt(value => value + 1)}>PDF背景を再取得</button></div>;
  if (!resource) return <p role="status">PDF背景を取得しています…</p>;
  return <PdfDocument key={resource.url} file={resource.url} onLoadSuccess={loaded} onLoadError={() => { if (resourceActive()) setError(true); }}
    loading={<p role="status">PDF背景を読み込んでいます…</p>} error={<p role="alert">PDF背景を読み込めません。</p>}>
    {verified && <VerifiedCanvas key={`${width}:${ratio}`} binding={binding} width={width} ratio={ratio} fail={() => { if (resourceActive()) setError(true); }} />}
  </PdfDocument>;
}

function VerifiedCanvas({ binding, width, ratio, fail }: { binding: CanonicalPdfResourceBinding; width: number; ratio: number; fail(): void }) {
  const element = useRef<HTMLDivElement>(null), lifetime = useRef({ active: false });
  const [rendered, setRendered] = useState(false);
  useLayoutEffect(() => {
    const current = lifetime.current, root = element.current; current.active = true;
    return () => { current.active = false; root?.querySelectorAll('canvas').forEach(canvas => { canvas.width = 0; canvas.height = 0; }); };
  }, []);
  return <div ref={element} data-comparison-pdf-rendered={rendered ? 'true' : 'false'} style={{ pointerEvents: 'none' }}>
    <PdfPage pageNumber={binding.pdfPage} width={width} devicePixelRatio={ratio}
      renderTextLayer={false} renderAnnotationLayer={false}
      onLoadSuccess={actual => { if (lifetime.current.active && !matches(actual, binding)) fail(); }}
      onRenderSuccess={actual => {
        if (!lifetime.current.active) return;
        if (matches(actual, binding)) setRendered(true); else fail();
      }} onRenderError={() => { if (lifetime.current.active) fail(); }}
      loading={<p role="status">PDFページを描画しています…</p>} error={<p role="alert">PDFページを描画できません。</p>} />
  </div>;
}

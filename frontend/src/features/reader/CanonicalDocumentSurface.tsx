import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DocumentLibraryView } from './DocumentLibraryView';
import type { CanonicalPdfTextBinding } from './pdf/canonicalPdfHighlight';
import { PdfSurface, type PdfDocumentObservation } from './pdf/PdfSurface';
import { DocumentPaperPane } from './DocumentPaperPane';
import { InkOverlay } from './InkOverlay';
import { CanonicalPageAnnotations } from './annotations/CanonicalPageAnnotations';
import { CanonicalAnnotationLayer } from './annotations/CanonicalAnnotationLayer';
import { useCanonicalAnnotationReadiness } from './annotations/useCanonicalAnnotationReadiness';
import { useCanonicalPdfTextSelection } from './pdf/useCanonicalPdfTextSelection';
import { hasPdfPointerContact } from './input/usePdfPointerInput';
import { canonicalJson } from '../../runtime/edits/editModel';

/** Shared by both canonical hosts; the Frame is the only host presentation. */
export function CanonicalDocumentSurface({ view, onPdfTextSurface, onDocumentObserved }: {
  view: DocumentLibraryView; onPdfTextSurface?: (binding: CanonicalPdfTextBinding | null) => void;
  onDocumentObserved?: (event: PdfDocumentObservation) => void;
}) {
  const instance = useRef<object>({}), current = useRef(view); current.current = view;
  const observation = useRef(onPdfTextSurface); observation.current = onPdfTextSurface;
  const [textBinding, setTextBinding] = useState<CanonicalPdfTextBinding | null>(null);
  // Stable callback identity is required: the text binding publisher has an effect on this prop.
  const receiveTextBinding = useCallback((binding: CanonicalPdfTextBinding | null) => {
    setTextBinding(previous => previous === binding ? previous : binding); observation.current?.(binding);
  }, []);
  const sameSurface = view.pdfSelection.paneRef === view.paneRef;
  const binding = sameSurface && textBinding && view.asset && textBinding.asset.url === view.asset.url
    && textBinding.asset.binding.pageId === view.page?.id
    && textBinding.asset.binding.backgroundRevision === view.page?.backgroundRevision
    && canonicalJson(textBinding.asset.binding) === canonicalJson(view.asset.binding) ? textBinding : null;
  const selection = useCanonicalPdfTextSelection({ binding, lifetimeKey: view.pdfSelection.lifetimeKey,
    readerRootRef: view.pdfSelection.readerRootRef, pageLabel: `${view.activeSurface === 'translated' ? '訳文' : '原文'} ${view.pageIndex + 1}ページの本文`,
    available: () => current.current.pdfSelection.paneRef === current.current.paneRef && current.current.pdfSelection.available(),
    hasContact: () => hasPdfPointerContact(current.current.rootRef.current),
    isToolbarTarget: element => !!current.current.rootRef.current?.contains(element) && !!element.closest('[data-pdf-selection-command]') });
  const registered = useMemo(() => ({ readSelection: selection.readSelection, copySelection: selection.copySelection,
    clearSelection: selection.clearSelection, selectionKeyPort: selection.selectionKeyPort, readKeyEvidence: selection.readKeyEvidence }),
  [selection.readSelection, selection.copySelection, selection.clearSelection, selection.selectionKeyPort, selection.readKeyEvidence]);
  useLayoutEffect(() => {
    if (!sameSurface || view.page?.background.kind !== 'pdf') return;
    return view.pdfSelection.register(instance.current, registered);
  }, [sameSurface, view.page?.background.kind, view.pdfSelection, registered]);
  if (view.page?.background.kind === 'paper') return <DocumentPaperPane view={view} onMetrics={view.reportViewport} />;
  const { page, asset } = view;
  const matches = !!page && page.background.kind === 'pdf' && !!asset
    && asset.binding.pageId === page.id && asset.binding.backgroundRevision === page.backgroundRevision
    && asset.binding.resourceId === page.background.resourceId && asset.binding.sourceRevision === page.background.sourceRevision
    && asset.binding.pdfPage === page.background.pdfPage && asset.binding.widthPt === page.widthPt && asset.binding.heightPt === page.heightPt;
  return <div className="h-full min-h-0 min-w-0" aria-label={view.activeSurface === 'translated' ? '訳文' : '原文'}
    data-canonical-page={page?.id} data-background-revision={page?.backgroundRevision}>
    <PdfSurface inputBundle={view.inputBundle} asset={matches ? asset : null} assetError={view.assetError || (asset && !matches ? 'pdf-page-mismatch' : '')}
      retryAsset={view.retryAsset} zoom={view.zoom} paneRef={view.paneRef} scopeRef={view.editor.scopeRef}
      pointer={{ zoom: { get: () => view.zoom, set: view.changeZoom }, allowTouch: view.allowTouch,
        inkGesture: view.inkGesture, lifetimeKey: view.pointerLifetimeKey,
        onPageSwipe: view.editor.tool === 'select' ? view.swipe : undefined, activate: view.editor.activate }}
      textSelection={sameSurface && view.pdfSelection.managedTextSelection ? selection.pointerPort : undefined}
      textSelectionOverlay={sameSurface && view.pdfSelection.managedTextSelection ? selection.overlay : undefined}
      links={page && sameSurface ? { enabled: view.editor.tool === 'select' && view.annotation.mode === 'ink',
        admit: () => current.current.pdfLinks.admit(page), navigate: (physicalPage, y) => current.current.pdfLinks.navigate(page, physicalPage, y) } : undefined}
      onMetrics={view.reportViewport} onPdfTextSurface={receiveTextBinding} onDocumentObserved={onDocumentObserved}
      renderOverlay={({ ratio, rasterReady }) => <CanonicalPdfAnnotations view={view} ratio={ratio} ready={rasterReady} />} />
  </div>;
}

function CanonicalPdfAnnotations({ view, ratio, ready }: { view: DocumentLibraryView; ratio: number; ready: boolean }) {
  const page = view.page;
  useCanonicalAnnotationReadiness({ page, ready, available: view.annotation.available,
    generation: view.annotationRenderGeneration, report: view.reportAnnotationReady });
  if (!page) return null;
  return <>
    {view.pdfSearchHit?.pageId === page.id && view.pdfSearchHit.backgroundRevision === page.backgroundRevision && view.pdfSearchHit.rects?.map((rect, index) =>
      <div key={index} data-pdf-search-hit="" className="pointer-events-none absolute bg-yellow-400/40" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }} />)}
    {view.editor.visible && <CanonicalPageAnnotations page={page} includeInk={!ready || !view.editable} omitAnnotationId={view.annotation.draft?.annotation.id} />}
    {ready && view.editable && <InkOverlay key={page.id} editor={view.editor} aspectRatio={ratio} onCapture={view.capture} gestureReadRef={view.inkGestureRef} />}
    {view.editor.visible && <CanonicalAnnotationLayer page={page} annotation={view.annotation} ready={ready} />}
  </>;
}

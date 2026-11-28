import type { DocumentPdfImportController } from './pdf/import/useDocumentPdfImport';
import type { DocumentConflictPort } from './edit/DocumentConflictPanel';
import type { RefObject } from 'react';
import type { DocumentOutputController } from './output/useDocumentOutput';
import type { TranslationPdfImportController } from './translation/useTranslationPdfImport';
import type { TerminalSwipeProof } from './input/usePdfPointerInput';
import type { DocumentReferenceView } from './reference/DocumentReferenceSurface';
import type { Page, PageExpectation, PaperSpec } from '../../runtime/edits/contracts';
import type { InkEditor } from './inkEditor';
import type { DocumentEditState, DocumentCommandResult } from './edit/DocumentEditSession';
import type { ReaderViewport } from './ReaderSession';
import type { CaptureBounds } from './pdf/canonicalPdfCapturePlan';
import type { NoteAppendState } from '../notes/append/NoteAppendSession';
import type { CanonicalAnnotationFacade } from './annotations/CanonicalAnnotationEditor';
import type { CanonicalPdfAsset } from './pdf/canonicalPdfResource';
import type { CanonicalPdfTextBinding } from './pdf/canonicalPdfHighlight';
import type { ReaderSelectionKeyPort } from './input/readerSelectionKeys';
import type { PdfInkGestureReadPort } from './pdf/pdfTextGesture';
import type { SurfaceActivationOrigin } from './input/surfaceGestureGate';
import type { CanonicalManagedInputBundle } from './input/canonicalManagedInput';
import type { ContentRepository } from '../../runtime/edits/ports';
import type { PdfSearchHit } from './pdf/pdfTextSearch';

/** Ephemeral read-only controller registration, never an editing or position authority. */
export type DocumentPdfSelectionController = {
  readSelection(): { binding: CanonicalPdfTextBinding; range: Range } | null;
  copySelection(): Promise<boolean>;
  clearSelection(): void;
  selectionKeyPort: ReaderSelectionKeyPort;
  readKeyEvidence(): ReadonlyArray<{ key: string; trusted: boolean; ctrl: boolean; meta: boolean; alt: boolean; shift: boolean; intent: string; result: string; anchor: number | null; focus: number | null; collapsed: boolean | null; quote: string | null; keyCurrent: boolean | null }>;
};
export type DocumentPdfSelectionSurface = {
  managedTextSelection: boolean;
  lifetimeKey: unknown;
  readerRootRef: RefObject<HTMLDivElement | null>;
  paneRef: RefObject<HTMLDivElement | null>;
  available(): boolean;
  register(instance: object, controller: DocumentPdfSelectionController): () => void;
};

export type DocumentSurfaceView = Pick<DocumentLibraryView,
  'inputBundle' | 'page' | 'asset' | 'assetError' | 'retryAsset' | 'zoom' | 'editor' | 'annotation' | 'pdfSelection' | 'inkGesture' | 'inkGestureRef' | 'pointerLifetimeKey' | 'paneRef' | 'reportViewport' | 'changeZoom' | 'swipe' | 'editable' | 'allowTouch' | 'capture'> & {
  surface: 'original' | 'translated'; active: boolean; status: 'ready' | 'missing' | 'ambiguous';
};

/** One shared presentation contract. Resource identity travels with its verified URL. */
export type DocumentLibraryView = {
  conflict: DocumentConflictPort;
  inputBundle: CanonicalManagedInputBundle;
  reference: { status: 'ready'; view: DocumentReferenceView } | { status: 'unavailable'; reason: string };
  referenceControls: { pinned: boolean; label: string; pin(): boolean; clear(): boolean };
  surfaces: { original: DocumentSurfaceView; translated: DocumentSurfaceView };
  display: 'original' | 'translated' | 'split'; activeSurface: 'original' | 'translated'; translatedOnly: boolean;
  filterPending: boolean; filterCandidateCount: number; retryFilter(): boolean;
  changeDisplay(mode: 'original' | 'translated' | 'split'): boolean;
  activateSurface(surface: 'original' | 'translated', origin?: SurfaceActivationOrigin): boolean; changeTranslatedOnly(value: boolean): boolean;
  documentId: string; title: string; loading: boolean; error: string; status: string;
  kind: 'pdf' | 'notebook'; placement: 'center' | 'right'; moveEditor(placement: 'center' | 'right'): Promise<boolean>;
  notebookPdfImport: DocumentPdfImportController | null;
  notebook: null | {
    insert(): Promise<DocumentCommandResult>; duplicate(): Promise<DocumentCommandResult>; remove(): Promise<DocumentCommandResult>;
    reorder(amount: -1 | 1): Promise<DocumentCommandResult>;
    applyPaper(request: { pageId: string; expected: PageExpectation; widthPt: number; heightPt: number; spec: PaperSpec; fit?: boolean }): Promise<DocumentCommandResult>;
  };
  page: Page | null; asset: CanonicalPdfAsset | null; assetError: string; retryAsset(): void; pageIndex: number; pageCount: number;
  canPrevious: boolean; canNext: boolean;
  zoom: number; editor: InkEditor; state: DocumentEditState; editable: boolean;
  annotation: CanonicalAnnotationFacade;
  pdfSelection: DocumentPdfSelectionSurface;
  inkGesture: PdfInkGestureReadPort;
  inkGestureRef: RefObject<PdfInkGestureReadPort | null>;
  pointerLifetimeKey: unknown;
  pdfTextCommands: { canBegin: boolean; copy(): void; highlight(): void };
  pdfSearch: { pages: readonly Page[]; currentPageId: string; resources: Pick<ContentRepository, 'scope' | 'readResource'>; navigate(hit: PdfSearchHit): boolean; clear(): void };
  pdfSearchHit: PdfSearchHit | null;
  pdfLinks: { admit(page: Page): boolean; navigate(page: Page, physicalPage: number, y?: number): boolean };
  annotationCandidate: null | { edit(): void; cancel(): void };
  annotationRenderGeneration: number;
  reportAnnotationReady(pageId: string, backgroundRevision: string, ready: boolean, generation: number): void;
  rootRef: RefObject<HTMLDivElement | null>; paneRef: RefObject<HTMLDivElement | null>; referencePaneRef: RefObject<HTMLDivElement | null>;
  landing: { id: number; toEnd: boolean };
  reportViewport(metrics: ReaderViewport): void;
  swipe(amount: -1 | 1, proof: TerminalSwipeProof): void;
  move(amount: -1 | 1): void; jump(page: number): void; changeZoom(zoom: number, keepPlace?: boolean): void;
  undo(): void; redo(): void; retry(): void; syncDisabled: boolean; sync(): void;
  checkout(version: string): void;
  allowTouch(): boolean;
  capture(bounds: CaptureBounds): void;
  output: DocumentOutputController;
  translationImport?: TranslationPdfImportController;
  noteAppend: null | {
    state: NoteAppendState; canCancel: boolean; canBegin: boolean; includeInk: boolean;
    changeIncludeInk(value: boolean): void;
    quoteSelection(): void; startCapture(): void; submit(noteId: string): void; retry(): void;
    cancel(): void; dismiss(): void; openTarget(): void;
  };
};

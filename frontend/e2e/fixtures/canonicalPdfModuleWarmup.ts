import { createRoot } from 'react-dom/client';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { PdfSurface } from '../../src/features/reader/pdf/PdfSurface';
import { useDocumentPdfAsset } from '../../src/features/reader/useDocumentPdfAsset';
import { ReaderSession } from '../../src/features/reader/ReaderSession';
import { BrowserReaderStatePort } from '../../src/adapters/browser/readerState';
import { CanonicalPageAnnotations } from '../../src/features/reader/annotations/CanonicalPageAnnotations';
import { captureCanonicalPdfHighlight, canonicalPdfHighlightCaptureProblem } from '../../src/features/reader/pdf/canonicalPdfHighlight';
import '../../src/index.css';

// Import the real graph without constructing a Reader, Document, root, resource or canvas.
if (![createRoot, useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  PdfSurface, useDocumentPdfAsset, ReaderSession, BrowserReaderStatePort, CanonicalPageAnnotations,
  captureCanonicalPdfHighlight, canonicalPdfHighlightCaptureProblem].every(Boolean)) throw new Error('warmup-export-missing');
document.body.dataset.pdfModuleWarmup = 'ready';

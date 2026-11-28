import type { ResourceMetadata } from '../../src/runtime/edits/contracts.ts';
import type { ReaderState, SavedReaderState } from '../../src/features/reader/ReaderSession.ts';

export type PdfSpikeOracle = {
  version: 1; file: string; metadata: ResourceMetadata;
  pages: { physicalPage: number; rotation: number; userUnit: number; canonicalBand?: number[];
    canonicalAxis?: number[]; requiredActualText?: string[] }[];
  tolerances: { advancePt: number; bandPt: number; overlayClientPx: number };
};
export type PdfSpikeCapture = { status: 'ready'; quote: string; quads: { x: number; y: number }[][];
  anchor: { x: number; y: number }; pageId: string; backgroundRevision: string; range: { kind: 'unindexed' } }
  | { status: 'refused'; reason: string };
type PdfSpikeSourceTuple = { scope: string; attempt: number | null; pageId: string | null; backgroundRevision: string | null;
  physicalPage: number; sourceHash: string; url: string | null };
export type PdfSpikeLiveDom = { pages: number; layers: number; ends: number; spans: number; breaks: number; marked: number; text: string;
  canvasWidth: number; canvasHeight: number; dpr: number; pixelRatio: number;
  pageNode: number | null; layerNode: number | null;
  layerStructure: { id: number; parent: number | null; kind: string; text: string | null }[];
  paneClient: { width: number; height: number }; surfaceInlineWidth: string; canvasInlineWidth: string; previewZoom: string };
type PdfSpikeFontFace = { family: string; status: string; style: string; weight: string };
export type PdfSpikeSnapshot = {
  scenario: string; scope: string; attempt: number; expectedHash: string; physicalPage: number;
  asset: null | { url: string; scope: string; pageId: string; physicalPage: number; sourceHash: string }; assetError: string;
  reader: ReaderState; persisted: SavedReaderState; writes: SavedReaderState[];
  metrics: { pageId: string; fitWidth: number; fitPageWidth: number; drawnWidth: number }[];
  reads: { sequence: number; scope: string; resourceId: string; held: boolean; completed: boolean }[];
  pendingReads: number; documentCallbacks: number; documentInstances: number; documentResourceKeys: string[];
  urls: string[]; readyByPage: Record<string, number>; textReady: boolean; rasterReady: boolean; fonts: string;
  textItems: { str: string; dir: string; hasEOL: boolean; transform: number[] }[];
  dom: PdfSpikeLiveDom;
  diagnostics: { tuple: PdfSpikeSourceTuple; textSurface: 'absent' | 'current' | 'stale';
    bindingTuple: PdfSpikeSourceTuple | null;
    domMutations: number; domHistory: { sequence: number; at: number; mutations: number; tuple: PdfSpikeSourceTuple; dom: PdfSpikeLiveDom }[];
    captureProbes: Record<string, unknown>[];
    callbacks: { at: number; kind: 'document-observed' | 'text-surface'; value: string;
      drawing?: { drawnWidth: number; pixelRatio: number; viewportWidth: number; viewportHeight: number } }[];
    fontEvents: { at: number; kind: string; status: string; faces: PdfSpikeFontFace[]; affected: PdfSpikeFontFace[] }[] };
  capture: PdfSpikeCapture | null; captureAttempts: number; admission: string | null; admissionChecks: number;
  admissionHistory: { check: number; captureAttempt: number; problem: string | null }[]; overlays: number;
  injectedFaults: string[]; fontErrors: string[];
};

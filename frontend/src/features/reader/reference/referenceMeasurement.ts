import type { ReaderViewport } from '../ReaderSession';
/** Captured where fit metrics are calculated, not at callback delivery. */
export type ReferenceMeasurement = { pane: HTMLDivElement; width: number; height: number; dpr: number; zoom: number;
  generation: number; isSettled(): boolean; metrics: ReaderViewport; isCurrent(): boolean };

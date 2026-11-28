import type { DocumentPdfSelectionController } from './DocumentLibraryView';

export type HighlightDiagnostic = { attempts: number; stage: string; refusal: string | null; problem: string | null; draftCreated: boolean | null; selectionAdmitted: boolean | null };
export type HighlightSnapshot = { highlight: HighlightDiagnostic; commandError: string; keys: ReturnType<DocumentPdfSelectionController['readKeyEvidence']> };
const highlightDiagnostic: unique symbol = Symbol('highlight-diagnostic');
type HighlightPane = HTMLElement & { [highlightDiagnostic]?: () => HighlightSnapshot | null };
export function readHighlightDiagnostic(root: HTMLElement | null, pane: HTMLElement | null): HighlightSnapshot | null {
  if (!root?.isConnected || !pane?.isConnected || pane.closest('[data-reader-root]') !== root || !root.contains(pane)) return null;
  return (pane as HighlightPane)[highlightDiagnostic]?.() ?? null;
}

export function installHighlightDiagnostic(pane: HTMLElement, getter: () => HighlightSnapshot | null): () => void {
  const target = pane as HighlightPane; target[highlightDiagnostic] = getter;
  return () => { if (target[highlightDiagnostic] === getter) delete target[highlightDiagnostic]; };
}

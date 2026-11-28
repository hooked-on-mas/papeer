import type { ReactNode, RefObject } from 'react';
import type { Bounds, InkStroke, InkTool, Point } from '../ink/inkGeometry';
import type { CanonicalInkOperation } from './ink/canonicalInkOperations';

export type InkSide = 'original' | 'translated';
export type InkPreset = { color: string; width: number };
export type InkPreferenceValues = {
  color: string; width: number; highColor: string; highWidth: number; straight: boolean;
  partial: boolean; eraserRadius: number; highlightOnly: boolean; fingerDraw: boolean; presets: InkPreset[];
};
export type InkPreferences = InkPreferenceValues & { change(values: Partial<InkPreferenceValues>): void; persistenceError?: string | null; retryPersistence?(): void };

/** Gestures and toolbar commands retain their meaning until the document owner applies them. */
export type InkOperationPort = {
  preview(operation: CanonicalInkOperation): InkStroke[] | undefined;
  commit(operation: CanonicalInkOperation): boolean;
  cancel(): void;
  copy(ids: string[]): void;
  paste(duplicateIds?: string[]): string[];
  hasClipboard: boolean;
};
export type InkTextPort = {
  draft: { id: string; at: Point; text: string; previous?: InkStroke } | null;
  begin(at: Point, previous?: InkStroke): boolean;
  change(text: string): void;
  save(): boolean;
  cancel(): void;
};

export type InkActivationEvent = { type?: string; nativeEvent?: Event; pointerId?: number; preventDefault?(): void; stopPropagation?(): void };

/** The drawing surface receives operations and state, never a concrete host hook/store. */
export interface InkEditor {
  tool: InkTool;
  setTool(tool: InkTool): void;
  lastPen: InkTool; lastShape: InkTool; lastRange: InkTool;
  preferences: InkPreferences;
  strokes: InkStroke[]; selected: InkStroke[]; selectedIds: string[];
  setSelectedIds(ids: string[]): void;
  selection: Bounds | null;
  visible: boolean; setVisible(value: boolean): void;
  locked: boolean; setLocked(value: boolean): void;
  listOpen: boolean; setListOpen(value: boolean): void;
  change(strokes: InkStroke[]): void;
  replaceSelected(strokes: InkStroke[]): void;
  transformSelected(scale?: number, angle?: number, delta?: Point): void;
  remove(): void; copy(): void; cut(): void; paste(): void; duplicate(): void;
  hasClipboard: boolean;
  style(values: { color?: string; width?: number }): void;
  scopeRef: RefObject<HTMLDivElement | null>;
  beforeCommand: RefObject<(() => void) | null>;
  activate(event?: InkActivationEvent): void;
  deactivate(event?: InkActivationEvent): void;
  onDrawingChange?(drawing: boolean): boolean | void;
  registerFinalizer?(finalize: () => void): () => void;
  renderStroke?(stroke: InkStroke, ratio: number, inkColor: (color: string) => string): ReactNode;
  operations?: InkOperationPort;
  text?: InkTextPort;
  color: string; width: number;
}

/** Temporary adapter contract for the existing persistence toolbar. The surface
 * uses InkEditor alone; new document sessions do not implement the old save API.
 */
export interface PersistedInkEditor extends InkEditor {
  ink: {
    entry: {
      readonly paperId: string; readonly side: InkSide;
      load(): Promise<void>; undo(): void; redo(): void;
    } | null;
    strokes?: InkStroke[]; ready?: boolean; dirty?: boolean; saving?: boolean;
    error?: string; canUndo?: boolean; canRedo?: boolean;
  };
}

import type { EditScope } from '../../runtime/edits/ports.ts';

export type ReaderPlacement = 'center' | 'right';
export type SavedMarkdownReaderState = { version: 1; kind: 'markdown'; placement: ReaderPlacement };
export interface ReaderPlacementStatePort {
  readonly scope: EditScope;
  read(documentId: string): unknown;
  write(documentId: string, state: SavedMarkdownReaderState): void;
}
export type ReaderPlacementState = { placement: ReaderPlacement; error: string };
const sameScope = (a: EditScope, b: EditScope) => a.accountId === b.accountId && a.libraryId === b.libraryId && a.epoch === b.epoch;
function readSaved(raw: unknown): SavedMarkdownReaderState | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid-markdown-reader-state');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== 3 || value.version !== 1 || value.kind !== 'markdown'
    || (value.placement !== 'center' && value.placement !== 'right')) throw new Error('invalid-markdown-reader-state');
  return { version: 1, kind: 'markdown', placement: value.placement };
}

/** Pageless reading preferences. Content durability and editor ownership belong to the caller. */
export class ReaderPlacementSession {
  readonly scope: EditScope;
  readonly documentId: string;
  private readonly persistence: ReaderPlacementStatePort;
  private readonly canMove: () => boolean;
  private state: ReaderPlacementState;
  private readonly listeners = new Set<() => void>();
  private dirty = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor({ scope, documentId, persistence, canMove }: {
    scope: EditScope; documentId: string; persistence: ReaderPlacementStatePort; canMove: () => boolean;
  }) {
    if (!sameScope(scope, persistence.scope)) throw new Error('reader-state-scope');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(documentId)) throw new Error('reader-document-id');
    this.scope = Object.freeze({ ...scope }); this.documentId = documentId;
    this.persistence = persistence; this.canMove = canMove;
    let saved: SavedMarkdownReaderState | undefined, error = '';
    try { saved = readSaved(persistence.read(documentId)); } catch (cause) { error = String(cause); }
    this.state = Object.freeze({ placement: saved?.placement ?? 'center', error });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(fields: Partial<ReaderPlacementState>) {
    this.state = Object.freeze({ ...this.state, ...fields }); this.listeners.forEach(listener => listener());
  }
  setPlacement(placement: ReaderPlacement): boolean {
    if (!this.canMove() || (placement !== 'center' && placement !== 'right') || placement === this.state.placement) return false;
    // Only an explicit placement change authorizes replacing an unreadable preference record.
    this.dirty = true; this.update({ placement });
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 150);
    return true;
  }
  flush(): void {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.dirty) return;
    try {
      if (!sameScope(this.scope, this.persistence.scope)) throw new Error('reader-state-scope');
      this.persistence.write(this.documentId, { version: 1, kind: 'markdown', placement: this.state.placement });
      this.dirty = false;
      if (this.state.error) this.update({ error: '' });
    } catch (cause) { this.update({ error: String(cause) }); }
  }
}

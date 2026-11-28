import type { EditScope } from '../../runtime/edits/ports.ts';
export type WorkspaceSelection = { version: 1; documentId: string | null; folderId: string | null };
export interface WorkspaceSelectionPort { readonly scope: EditScope; read(): unknown; write(value: WorkspaceSelection): void }
const valid = (value: unknown): value is string | null => value === null || typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export function decodeWorkspaceSelection(raw: unknown): WorkspaceSelection | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('workspace-selection-invalid');
  const v = raw as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'documentId,folderId,version' || v.version !== 1 || !valid(v.documentId) || !valid(v.folderId)) throw new Error('workspace-selection-invalid');
  return { version: 1, documentId: v.documentId, folderId: v.folderId };
}
/** Disposable scope-owned hint, never a document writer or a catalog authority. */
export class WorkspaceSelectionSession {
  readonly scope: Readonly<EditScope>;
  private readonly port: WorkspaceSelectionPort;
  private readonly active: () => boolean;
  private value: WorkspaceSelection | null = null;
  private generation = 0;
  private interacted = false;
  readonly readError: string;
  constructor(port: WorkspaceSelectionPort, active: () => boolean) {
    this.port = port; this.scope = Object.freeze({ ...port.scope }); this.active = active;
    let error = ''; try { this.value = decodeWorkspaceSelection(port.read()); } catch (cause) { error = String(cause); }
    this.readError = error;
  }
  available() { return this.active() && this.scope.accountId === this.port.scope.accountId && this.scope.libraryId === this.port.scope.libraryId && this.scope.epoch === this.port.scope.epoch; }
  candidate() { return this.available() && !this.interacted && this.value ? { value: { ...this.value }, generation: this.generation } : null; }
  sameTicket(generation: number) { return generation === this.generation; }
  isCurrent(generation: number) { return this.available() && this.sameTicket(generation); }
  invalidate() { this.interacted = true; this.generation++; }
  select(patch: Partial<Pick<WorkspaceSelection, 'documentId' | 'folderId'>>) {
    this.invalidate(); if (!this.available()) return false;
    const next = decodeWorkspaceSelection({ version: 1, documentId: this.value?.documentId ?? null, folderId: this.value?.folderId ?? null, ...patch })!;
    this.value = next; try { this.port.write({ ...next }); return true; } catch { return false; }
  }
}

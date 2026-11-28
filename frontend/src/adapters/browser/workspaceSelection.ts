import type { EditScope } from '../../runtime/edits/ports.ts';
import type { WorkspaceSelection, WorkspaceSelectionPort } from '../../features/workspace/WorkspaceSelectionSession.ts';
export class BrowserWorkspaceSelection implements WorkspaceSelectionPort {
  readonly scope: Readonly<EditScope>; private readonly key: string; private readonly storage?: Pick<Storage, 'getItem' | 'setItem'>;
  constructor(scope: EditScope, storage?: Pick<Storage, 'getItem' | 'setItem'>) { this.scope = Object.freeze({ ...scope }); this.storage = storage; this.key = `paper-desk.selection.v1:${JSON.stringify([scope.accountId, scope.libraryId, scope.epoch])}`; }
  read(): unknown { const raw = (this.storage ?? globalThis.localStorage).getItem(this.key); return raw === null ? null : JSON.parse(raw); }
  write(value: WorkspaceSelection): void { (this.storage ?? globalThis.localStorage).setItem(this.key, JSON.stringify(value)); }
}

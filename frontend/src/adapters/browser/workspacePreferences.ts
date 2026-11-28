import type { EditScope } from '../../runtime/edits/ports.ts';
import type { WorkspacePreference, WorkspacePreferencePort } from '../../features/workspace/WorkspaceSession.ts';

/** Same disposable preference adapter for ordinary browser and desktop WebView. Host gates wrap it. */
export class BrowserWorkspacePreferences implements WorkspacePreferencePort {
  readonly scope: Readonly<EditScope>;
  private readonly key: string;
  private readonly storage?: Pick<Storage, 'getItem' | 'setItem'>;
  constructor(scope: EditScope, storage?: Pick<Storage, 'getItem' | 'setItem'>) {
    this.storage = storage;
    this.scope = Object.freeze({ ...scope });
    this.key = `paper-desk.workspace.v1:${JSON.stringify([scope.accountId, scope.libraryId, scope.epoch])}`;
  }
  read(): unknown {
    const raw = (this.storage ?? globalThis.localStorage).getItem(this.key);
    return raw === null ? null : JSON.parse(raw);
  }
  write(value: WorkspacePreference): void {
    (this.storage ?? globalThis.localStorage).setItem(this.key, JSON.stringify(value));
  }
}

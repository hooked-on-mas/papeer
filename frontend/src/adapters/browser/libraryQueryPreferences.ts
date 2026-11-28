import type { EditScope } from '../../runtime/edits/ports.ts';
import type { LibraryQuery, LibraryQueryPreferencePort } from '../../features/library/query/LibraryQuerySession.ts';

/** Display conditions are a local, scoped cache, separate from catalog metadata and appearance. */
export class BrowserLibraryQueryPreferences implements LibraryQueryPreferencePort {
  readonly scope: Readonly<EditScope>;
  private readonly key: string;
  private readonly storage?: Pick<Storage, 'getItem' | 'setItem'>;
  constructor(scope: EditScope, storage?: Pick<Storage, 'getItem' | 'setItem'>) {
    this.scope = Object.freeze({ ...scope }); this.storage = storage;
    this.key = `paper-desk.library-query.v1:${JSON.stringify([scope.accountId, scope.libraryId, scope.epoch])}`;
  }
  read(): unknown {
    const raw = (this.storage ?? globalThis.localStorage).getItem(this.key);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (value === null) throw new Error('library-query-preference-invalid');
    return value;
  }
  write(value: LibraryQuery): void {
    (this.storage ?? globalThis.localStorage).setItem(this.key, JSON.stringify(value));
  }
}

import type { EditScope } from '../../runtime/edits/ports.ts';
import type { ReaderStatePort, SavedReaderPreference } from '../../features/reader/ReaderSession.ts';

/** Tiny local reading preferences; both desktop WebView and browser compositions use the same adapter. */
export class BrowserReaderStatePort implements ReaderStatePort<SavedReaderPreference> {
  readonly scope: EditScope;
  private readonly storage?: Pick<Storage, 'getItem' | 'setItem'>;
  constructor(scope: EditScope, storage?: Pick<Storage, 'getItem' | 'setItem'>) {
    this.scope = Object.freeze({ ...scope }); this.storage = storage;
  }
  private key(documentId: string) { return `paper-desk.reader.v1:${JSON.stringify([this.scope.accountId, this.scope.libraryId, this.scope.epoch, documentId])}`; }
  read(documentId: string): unknown {
    const raw = (this.storage ?? globalThis.localStorage).getItem(this.key(documentId));
    return raw === null ? null : JSON.parse(raw);
  }
  write(documentId: string, state: SavedReaderPreference): void {
    (this.storage ?? globalThis.localStorage).setItem(this.key(documentId), JSON.stringify(state));
  }
}

import type { EditScope } from '../../runtime/edits/ports.ts';
import type { NoteAppendDraftPort, SavedAnnotationAppend } from '../../features/notes/append/NoteAppendDraftPort.ts';

/** The retained list export belongs to the selected account/library/dataset, never Reader preferences. */
export class BrowserAnnotationAppendDraftPort implements NoteAppendDraftPort {
  readonly scope: EditScope;
  private readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  constructor(scope: EditScope, storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {
    this.scope = Object.freeze({ ...scope }); this.storage = storage;
  }
  private key() { return `paper-desk.annotation-append.v1:${JSON.stringify([this.scope.accountId, this.scope.libraryId, this.scope.epoch])}`; }
  read(): unknown {
    const raw = (this.storage ?? globalThis.localStorage).getItem(this.key());
    return raw === null ? undefined : JSON.parse(raw);
  }
  write(value: SavedAnnotationAppend): void {
    (this.storage ?? globalThis.localStorage).setItem(this.key(), JSON.stringify(value));
  }
  remove(): void { (this.storage ?? globalThis.localStorage).removeItem(this.key()); }
}

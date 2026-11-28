import type { EditScope } from '../../runtime/edits/ports.ts';
import type { MarkdownDraft, MarkdownDraftPort } from '../../features/notes/markdown/MarkdownDraftPort.ts';

/** Unsent text is content, separate from disposable Reader preferences. */
export class BrowserMarkdownDraftPort implements MarkdownDraftPort {
  readonly scope: EditScope;
  private readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'length' | 'key'>;
  constructor(scope: EditScope, storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'length' | 'key'>) {
    this.scope = Object.freeze({ ...scope }); this.storage = storage;
  }
  private prefix() { return `paper-desk.markdown-draft.v1:${JSON.stringify([this.scope.accountId, this.scope.libraryId, this.scope.epoch])}:`; }
  private key(documentId: string) { return this.prefix() + documentId; }
  targets(): string[] {
    const storage = this.storage ?? globalThis.localStorage, prefix = this.prefix(), targets: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('markdown-draft-key');
      targets.push(id);
    }
    return targets.sort();
  }
  read(documentId: string): unknown {
    const raw = (this.storage ?? globalThis.localStorage).getItem(this.key(documentId));
    return raw === null ? undefined : JSON.parse(raw);
  }
  write(documentId: string, draft: MarkdownDraft): void {
    if (draft.documentId !== documentId) throw new Error('markdown-draft-target');
    (this.storage ?? globalThis.localStorage).setItem(this.key(documentId), JSON.stringify(draft));
  }
  remove(documentId: string): void { (this.storage ?? globalThis.localStorage).removeItem(this.key(documentId)); }
}


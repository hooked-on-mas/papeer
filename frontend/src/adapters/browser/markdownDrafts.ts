import { validateNoteDocument, type NoteDocument } from '../../runtime/noteDocuments.ts';

/** One-time scratch migration. Old text-only drafts have no base, so never invent a remote revision. */
export function loadMarkdownDraft(storage: Storage, key: string, legacyKey: string, note: NoteDocument) {
  let draft: NoteDocument | undefined;
  const raw = storage.getItem(key);
  if (raw) {
    draft = validateNoteDocument(JSON.parse(raw));
    if (draft.id !== note.id || draft.kind !== 'markdown') throw new Error('下書きの対象が不正です。');
  }
  const recoveryKey = `${key}:recovered`;
  const stored = storage.getItem(recoveryKey);
  const recoveries: string[] = stored ? JSON.parse(stored) : [];
  if (!Array.isArray(recoveries) || recoveries.some(text => typeof text !== 'string')) throw new Error('復元した下書きの形式が不正です。');
  const legacy = storage.getItem(legacyKey);
  if (legacy !== null) {
    if (legacy !== note.content && !recoveries.includes(legacy)) {
      recoveries.push(legacy);
      // Only remove the old scratch after the complete, unbased recovery copy is durable.
      storage.setItem(recoveryKey, JSON.stringify(recoveries));
    }
    storage.removeItem(legacyKey);
  }
  return { draft, recoveries, clearRecoveries: () => storage.removeItem(recoveryKey) };
}

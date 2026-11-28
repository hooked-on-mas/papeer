import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Locator, Page } from 'playwright-core';
import type { CanonicalLibraryProfile, MarkdownSnapshot, EditIntentRecord } from '../../src/runtime/edits/contracts.ts';
import type { StoredEdit } from '../../src/runtime/edits/repository.ts';
import { applyBatch } from '../../src/runtime/edits/editModel.ts';

/** Read-only inspection of UI-created content; never seeds a grant, session or write. */
export async function ordinaryMarkdown(page: Page, targetId: string) {
  return page.evaluate(async targetId => {
    type Row<T> = { key: string; scope: string; value: T };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('papeer-shared-edits');
      opening.onupgradeneeded = () => { opening.transaction?.abort(); reject(new Error('existing canonical database required')); };
      opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error);
    });
    try {
      return await new Promise<{ identity: CanonicalLibraryProfile['identity']; namespace: string; root: MarkdownSnapshot;
        edits: StoredEdit[]; intents: EditIntentRecord[] }>((resolve, reject) => {
        const tx = db.transaction(['canonicalProfiles', 'roots', 'edits', 'intents'], 'readonly');
        const profiles = tx.objectStore('canonicalProfiles').getAll(), roots = tx.objectStore('roots').getAll();
        const edits = tx.objectStore('edits').getAll(), intents = tx.objectStore('intents').getAll();
        tx.oncomplete = () => {
          const root = (roots.result as Row<MarkdownSnapshot>[]).find(row => row.value.id === targetId);
          if (!root || root.value.kind !== 'markdown' || profiles.result.length !== 1) { reject(new Error('exactly one UI-created Library and Markdown required')); return; }
          resolve({ identity: (profiles.result as Row<CanonicalLibraryProfile>[])[0].value.identity, namespace: root.scope, root: root.value,
            edits: (edits.result as Row<StoredEdit>[]).filter(row => row.scope === root.scope && row.value.batch.targetId === targetId).map(row => row.value),
            intents: (intents.result as Row<EditIntentRecord>[]).filter(row => row.scope === root.scope && JSON.parse(row.key)[1] === targetId).map(row => row.value) });
        };
        tx.onabort = () => reject(tx.error ?? new Error('observation aborted'));
      });
    } finally { db.close(); }
  }, targetId);
}

export function ordinaryMarkdownSnapshot(value: Awaited<ReturnType<typeof ordinaryMarkdown>>): MarkdownSnapshot {
  let current = value.root; const rest = [...value.edits];
  while (rest.length) {
    const index = rest.findIndex(edit => edit.batch.parents.length === 1 && edit.batch.parents[0] === current.version);
    assert.ok(index >= 0, 'this ordinary case requires a complete linear durable history');
    current = applyBatch(current, rest.splice(index, 1)[0].batch) as MarkdownSnapshot;
  }
  return current;
}

export async function ordinaryMarkdownSaved(page: Page, id: string, content: string, count?: number) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await ordinaryMarkdown(page, id);
    if (value.intents.length === 0 && (count === undefined || value.edits.length === count)
      && value.edits.every(edit => edit.receipt.durable && edit.history) && ordinaryMarkdownSnapshot(value).content === content) return value;
    assert.ok(Date.now() < deadline, `Markdown content/history did not settle (${value.edits.length} edits, ${value.intents.length} intents)`);
    await delay(50);
  }
}

/** Exact visible CodeMirror lines for a small fully rendered document; innerText adds layout breaks. */
export async function assertOrdinaryMarkdownText(editor: Locator, expected: string) {
  const lines = await editor.locator('.cm-line').evaluateAll(elements => elements.map(element => element.textContent ?? ''));
  assert.equal(lines.length, expected.split('\n').length, 'every expected source line must be rendered');
  assert.deepEqual(lines, expected.split('\n'), 'rendered source lines preserve all whitespace exactly');
}

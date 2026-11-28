import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import type { CanonicalLibraryProfile, ResourceMetadata, Snapshot } from '../../../../src/runtime/edits/contracts.ts';
import type { StoredEdit } from '../../../../src/runtime/edits/repository.ts';

type Row<T> = { key: string; scope: string; value: T };
type Ink = { id: string; drawing: string };

/** Storage observation only: no repository/session import, grant injection, seeding or write transaction. */
export async function committed(page: Page, documentId: string) {
  return page.evaluate(async documentId => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papeer-shared-edits');
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('canonical database absent')); };
      request.onblocked = () => reject(new Error('canonical observation blocked'));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      const rows = await new Promise<{
        profiles: Row<CanonicalLibraryProfile>[]; roots: Row<Snapshot>[]; edits: Row<StoredEdit>[]; intents: Row<unknown>[];
      }>((resolve, reject) => {
        const tx = db.transaction(['canonicalProfiles', 'roots', 'edits', 'intents'], 'readonly');
        const profiles = tx.objectStore('canonicalProfiles').getAll(), roots = tx.objectStore('roots').getAll();
        const edits = tx.objectStore('edits').getAll(), intents = tx.objectStore('intents').getAll();
        tx.oncomplete = () => resolve({ profiles: profiles.result, roots: roots.result, edits: edits.result, intents: intents.result });
        tx.onabort = () => reject(tx.error ?? new Error('canonical observation aborted'));
      });
      if (rows.profiles.length !== 1) throw new Error('expected exactly one UI-created Library');
      const root = rows.roots.find(row => row.value.id === documentId);
      if (!root || root.value.kind !== 'document') throw new Error('UI-created notebook root absent');
      return {
        identity: rows.profiles[0].value.identity, namespace: root.scope, rootVersion: root.value.version, root: root.value,
        edits: rows.edits.filter(row => row.scope === root.scope && row.value.batch.targetId === documentId).map(row => row.value),
        pendingIntents: rows.intents.filter(row => row.scope === root.scope && (JSON.parse(row.key) as string[])[1] === documentId).length,
      };
    } finally { db.close(); }
  }, documentId);
}

export const inks = (page: Page) => page.locator('[data-ink-id]').evaluateAll(elements => elements.map(element => ({
  id: element.getAttribute('data-ink-id')!, drawing: element.innerHTML,
}))) as Promise<Ink[]>;

export async function durable(page: Page, documentId: string, ids: string[], count: number) {
  await page.waitForFunction(expected => {
    const actual = [...document.querySelectorAll('[data-ink-id]')].map(element => element.getAttribute('data-ink-id')).sort();
    return JSON.stringify(actual) === JSON.stringify([...expected].sort());
  }, ids);
  await page.getByRole('status').filter({ hasText: /^端末保存済み/ }).waitFor();
  const deadline = Date.now() + 30_000;
  let observation = await committed(page, documentId);
  while (observation.edits.length !== count || observation.pendingIntents !== 0 || observation.edits.some(edit => !edit.receipt.durable)) {
    assert.ok(Date.now() < deadline, `durability not observed: ${JSON.stringify(observation)}`);
    await delay(50); observation = await committed(page, documentId);
  }
  return observation;
}

export async function draw(page: Page, y: number) {
  const layer = page.getByLabel('ノート書き込みレイヤー', { exact: true });
  await layer.scrollIntoViewIfNeeded();
  const box = await layer.boundingBox(); assert.ok(box && box.width > 0 && box.height > 0);
  await page.mouse.move(box.x + box.width * .2, box.y + box.height * y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .5, box.y + box.height * y, { steps: 12 });
  await page.mouse.up();
}

/** Verify actual durable resource bytes through a readonly transaction, without app internals. */
export async function resource(page: Page, namespace: string, resourceId: string) {
  return page.evaluate(async ({ namespace, resourceId }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('papeer-shared-edits');
      opening.onupgradeneeded = () => { opening.transaction?.abort(); reject(new Error('resource database absent')); };
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => resolve(opening.result);
    });
    try {
      const tx = db.transaction(['resources', 'resourceBytes'], 'readonly');
      const metadata = tx.objectStore('resources').get(JSON.stringify([namespace, resourceId]));
      const bytes = tx.objectStore('resourceBytes').index('scope').getAll(namespace);
      const values = await new Promise<{ metadata: ResourceMetadata; bytes: Row<Uint8Array>[] }>((resolve, reject) => {
        tx.oncomplete = () => resolve({ metadata: metadata.result.value, bytes: bytes.result });
        tx.onabort = () => reject(tx.error);
        tx.onerror = () => reject(tx.error);
      });
      const stored = values.bytes.find(row => (JSON.parse(row.key) as string[])[1] === values.metadata.sha256);
      if (!stored) throw new Error('resource bytes absent');
      const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(stored.value));
      return { metadata: values.metadata, byteLength: stored.value.byteLength,
        actualSha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') };
    } finally { db.close(); }
  }, { namespace, resourceId });
}


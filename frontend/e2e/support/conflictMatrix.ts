// Shared helpers for the B11 conflict / unknown-outcome matrix (new file; no product code).
// Every property is read from what actually exists: the page's own repository (durable state), the mock Drive's edit records
// (what really reached the provider) and the intercepted Native commit requests; never from a client-side flag alone.
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import type { EditBatch, EditRecord, ResolutionBatch } from '../../src/runtime/edits/contracts.ts';
import type { BatchReceipt, RepositoryState } from '../../src/runtime/edits/ports.ts';
import { sync } from './documentComposition.ts';
import { waitForSnapshot } from './waitForSnapshot.ts';

/** Repository read on one host's own page (Native over HTTP, Web over IndexedDB). */
export const readOn = (page: Page, id: string): Promise<RepositoryState> => page.evaluate(id => (window as unknown as {
  compositionRepository(method: string, args: unknown[]): Promise<RepositoryState>;
}).compositionRepository('read', [id]), id);

/** A real, ordinary durable commit on that host (the host's repository, not a UI gesture). */
export const commitOn = (page: Page, batch: EditBatch): Promise<{ status: string }> => page.evaluate(batch => (window as unknown as {
  compositionRepository(method: string, args: unknown[]): Promise<{ status: string }>;
}).compositionRepository('commit', [batch]), batch);

export const receiptOn = (page: Page, id: string): Promise<BatchReceipt | null> => page.evaluate(id => (window as unknown as {
  compositionRepository(method: string, args: unknown[]): Promise<BatchReceipt | null>;
}).compositionRepository('receipt', [id]), id);

/** Native, Web, Native, Web: every host pushes what it has and then pulls what the other pushed. */
export async function converge(pages: Page[]) {
  for (const page of [...pages, ...pages]) { await page.bringToFront(); await sync(page); }
}

export const sortedHeads = (state: RepositoryState) => [...state.heads].sort();

/** Records for one target that really reached the mock Drive, by batch id (an id must appear exactly once to be "delivered once"). */
export function driveCount(records: EditRecord[], batchId: string) { return records.filter(record => record.batch.id === batchId).length; }
export const driveResolutions = (records: EditRecord[], targetId: string) =>
  records.filter(record => record.batch.kind === 'resolution' && record.batch.targetId === targetId).map(record => record.batch as ResolutionBatch);

/** Both hosts hold a durable, peer-imported receipt for each id (never a flag from the UI). */
export async function assertReceipts(pages: Page[], ids: string[]) {
  for (const page of pages) {
    const peer = await page.evaluate(() => (window as unknown as { compositionAdmittedPeer(): string }).compositionAdmittedPeer());
    const receipts = await waitForSnapshot(() => Promise.all(ids.map(id => receiptOn(page, id))),
      value => value.every(receipt => !!receipt?.durable && receipt.importedBy.includes(peer)));
    assert.equal(receipts.length, ids.length);
  }
}

/** True when a cancelable beforeunload is prevented (the product's unsaved / unknown guard). */
export const beforeUnloadPrevented = (page: Page) => page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })));

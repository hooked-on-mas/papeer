import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import type { DocumentSnapshot } from '../../src/runtime/edits/contracts.ts';
import { applyBatch } from '../../src/runtime/edits/editModel.ts';
import { committed } from '../tests/reader/p2/ordinaryStorage.ts';

export type OrdinaryDocumentObservation = Awaited<ReturnType<typeof committed>>;

/** Pure projection of a real, read-only observed linear edit chain; grants no writer authority. */
export function ordinarySnapshot(value: OrdinaryDocumentObservation): DocumentSnapshot {
  let current = value.root;
  const remaining = [...value.edits];
  while (remaining.length) {
    const index = remaining.findIndex(edit => edit.batch.parents.length === 1 && edit.batch.parents[0] === current.version);
    assert.ok(index >= 0, 'ordinary case requires one complete linear durable chain');
    current = applyBatch(current, remaining.splice(index, 1)[0].batch) as DocumentSnapshot;
  }
  return current;
}

export async function ordinarySaved(page: Page, documentId: string, count: number) {
  const until = Date.now() + 30_000;
  for (;;) {
    const value = await committed(page, documentId);
    if (value.edits.length === count && value.pendingIntents === 0 && value.edits.every(edit => edit.receipt.durable && edit.history)) {
      await page.getByRole('status').filter({ hasText: /^端末保存済み/ }).first().waitFor();
      return value;
    }
    assert.ok(Date.now() < until, `expected ${count} exact durable operations`);
    await delay(50);
  }
}

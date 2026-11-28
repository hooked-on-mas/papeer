import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import type { LibrarySnapshot } from '../../src/runtime/edits/contracts.ts';
import type { LibrarySessionState } from '../../src/features/library/LibrarySession.ts';
import type { RepositoryState } from '../../src/runtime/edits/ports.ts';
import { EditGraph } from '../../src/runtime/edits/editGraph.ts';
import { waitForSnapshot } from './waitForSnapshot.ts';

type Memory = { identity: string; session: LibrarySessionState; selected: LibrarySnapshot | null };
type Witness = { state: RepositoryState; session: LibrarySessionState; selected: LibrarySnapshot | null;
  pending: unknown[]; replication: { running: boolean } };

/** Session readiness is only a preliminary predicate; one real witness must agree within the same budget. */
export async function waitForLibraryWitness(page: Page, accepts: (selected: LibrarySnapshot, session: LibrarySessionState) => boolean): Promise<Witness> {
  const deadline = Date.now() + 25_000;
  const acceptable = (value: Memory | null): value is Memory & { selected: LibrarySnapshot } => !!value?.selected
    && value.session.ready && !value.session.busy && !value.session.pendingId
    && value.session.selectedVersion === value.selected.version && accepts(value.selected, value.session);
  const memory = await waitForSnapshot(() => page.evaluate(() => (window as unknown as {
    compositionLibraryMemory(): Memory | null;
  }).compositionLibraryMemory()), acceptable, Math.max(0, deadline - Date.now()));
  assert.ok(acceptable(memory));
  const remaining = deadline - Date.now();
  assert.ok(remaining > 0, 'library witness deadline exceeded');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let witness: Witness;
  try {
    witness = await Promise.race([
      page.evaluate(({ identity, version }) => (window as unknown as {
        compositionLibraryWitness(identity: string, version: string): Promise<Witness>;
      }).compositionLibraryWitness(identity, version), { identity: memory.identity, version: memory.selected.version }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('library witness deadline exceeded')), remaining); }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
  assert.ok(Date.now() <= deadline, 'library witness deadline exceeded');
  const version = witness.session.selectedVersion;
  const actual = version ? new EditGraph(witness.state.checkpoint).snapshot(version) : undefined;
  assert.ok(actual?.kind === 'library' && witness.selected && version === memory.selected.version, 'selected version missing from real graph');
  assert.deepEqual(actual, witness.selected, 'selected in-memory snapshot differs from real graph');
  assert.ok(acceptable({ identity: memory.identity, session: witness.session, selected: witness.selected }), 'library witness predicate changed');
  return witness;
}

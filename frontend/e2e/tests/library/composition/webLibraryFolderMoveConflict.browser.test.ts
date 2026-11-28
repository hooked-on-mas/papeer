import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { Page } from 'playwright-core';
import type { ContentPublication, Folder, LibraryEditBatch, LibraryItem, LibrarySnapshot, ResolutionBatch } from '../../../../src/runtime/edits/contracts.ts';
import type { LibrarySessionState } from '../../../../src/features/library/LibrarySession.ts';
import type { RepositoryState } from '../../../../src/runtime/edits/ports.ts';
import { EditGraph } from '../../../../src/runtime/edits/editGraph.ts';
import { moveLibraryFolder } from '../../../../src/features/library/canonicalLibraryOperations.ts';
import { openComposition } from '../../../support/documentComposition.ts';
import { assertReceipts, commitOn, converge, driveCount, driveResolutions, readOn, sortedHeads } from '../../../support/conflictMatrix.ts';
import { renderedRows } from '../../../support/ordinaryCatalog.ts';
import { waitForSnapshot } from '../../../support/waitForSnapshot.ts';

// B13-e (plan regression R26, second half): two hosts move folder A into B and folder B into A at the same time.
// Limits (inherited from B11): the two competing heads are made by a direct durable commit of each host's own repository (the product move operation
// `moveLibraryFolder` builds the changes), not by dragging in the UI. The hosts are the real sidecar (Native frontend, SQLite) and the real IndexedDB
// (Web frontend) behind the mock Drive; this is not real Google, not the Native GUI (WebView2), not an installed app. From the heads on,
// everything is the ordinary UI: the "資料一覧の競合" panel, the "一覧の版" selector, the folder tree, and "この内容を採用".
type Catalog = { state: RepositoryState; session?: LibrarySessionState; pending: unknown[]; replication: { running: boolean } };
const catalog = (page: Page): Promise<Catalog> => page.evaluate(() => (window as unknown as { compositionLibraryEvidence(): Promise<Catalog> }).compositionLibraryEvidence());
const panel = (page: Page) => page.getByRole('region', { name: '資料一覧の競合', exact: true });
const TREE = '[role="tree"][aria-label="資料の階層"]';
async function expand(page: Page) {
  const button = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
}
const view = (state: RepositoryState) => new EditGraph(state.checkpoint).getView();
const librarySnapshot = (state: RepositoryState, id: string) => { const value = new EditGraph(state.checkpoint).snapshot(id); assert.ok(value?.kind === 'library'); return value as LibrarySnapshot; };
const headsOf = (page: Page, want: string[]) => waitForSnapshot(() => catalog(page), value => JSON.stringify(sortedHeads(value.state)) === JSON.stringify([...want].sort())
  && !!value.session?.ready && !value.session.busy && !value.session.pendingId);
/** Independent walker: acyclic when every folder reaches the top in at most folders.length steps. */
const acyclic = (value: LibrarySnapshot) => value.folders.every(folder => {
  let at: string | null = folder.parentId, steps = 0;
  while (at !== null) { if (++steps > value.folders.length) return false; at = value.folders.find(other => other.id === at)?.parentId ?? null; }
  return true;
});
type Parents = Record<string, string | null>;
const folderParents = (value: LibrarySnapshot): Parents => Object.fromEntries(value.folders.map(folder => [folder.id, folder.parentId]));
const itemFolders = (value: LibrarySnapshot): Parents => Object.fromEntries(value.items.map(item => [item.id, item.folderId]));
/** Open every collapsed row of the real tree (only the row toggles inside the tree). */
async function openAll(page: Page) {
  const toggles = page.locator(TREE).getByRole('button', { name: /^「.+」を開く$/ });
  for (let index = 0; index < 12 && await toggles.count(); index++) await toggles.first().click();
}
/** Parent of every rendered folder and item row, read from the DOM (aria-level nesting), never from the repository. */
async function domParents(page: Page): Promise<Parents> {
  const out: Parents = {}, stack: { level: number; key: string }[] = [];
  for (const row of await renderedRows(page)) {
    const key = row.folderId ?? row.id; if (!key) continue;
    while (stack.length && stack[stack.length - 1].level >= row.level) stack.pop();
    out[key] = stack.length ? stack[stack.length - 1].key : null; stack.push({ level: row.level, key });
  }
  return out;
}
async function expectTree(page: Page, expected: Parents, what: string) {
  const sorted = (value: Parents) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1));
  const actual = await waitForSnapshot(async () => { await openAll(page); return domParents(page); }, value => sorted(value) === sorted(expected), 30_000)
    .catch(async () => { await openAll(page); return domParents(page); });
  assert.deepEqual(actual, expected, what);
}
const noAlert = async (page: Page) => assert.equal(await page.getByRole('alert').count(), 0);

type Outcome = { ok: boolean; status?: string; message?: string };
const tryCommit = (page: Page, batch: ResolutionBatch): Promise<Outcome> => page.evaluate(async value => {
  try { const result = await (window as unknown as { compositionRepository(method: string, args: unknown[]): Promise<{ status: string; reason?: string }> })
    .compositionRepository('commit', [value]); return { ok: result.status === 'durable', status: result.status, message: result.reason }; }
  catch (error) { return { ok: false, message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }; }
}, batch);

const additionalPublications = (pdf: ContentPublication) => {
  const change = pdf.libraryBatch.changes.find(value => value.type === 'put-item'); assert.ok(change?.type === 'put-item');
  const note = { ...structuredClone(change.item), id: crypto.randomUUID(), kind: 'markdown' as const, title: 'Move conflict note', position: 1, tags: [], metadata: {} };
  delete note.resourceId;
  const publication: ContentPublication = { libraryBatch: { ...structuredClone(pdf.libraryBatch), id: crypto.randomUUID(), parents: [pdf.libraryBatch.id],
    changes: [{ type: 'put-item', item: note }] }, content: { kind: 'markdown', id: note.id, version: crypto.randomUUID(),
    content: '# Folder move conflict keeps this body', appendIds: [], imageResources: [] } };
  return { publications: [publication], initialDocumentId: pdf.content!.id };
};

/** adoptOn: the host whose ordinary panel adopts; choose: which competing head it adopts ('native' = A into B from Native, 'web' = B into A from Web). */
async function scenario(t: TestContext, engine: 'chromium' | 'webkit', adoptOn: 'native' | 'web', choose: 'native' | 'web') {
  const setup = await openComposition(t, engine, undefined, { additionalPublications });
  const { native, web, pages, repository, finish, driveRecords } = setup;
  const libraryId = repository.scope.libraryId;
  let phase = 'initial';
  try {
    const first = await readOn(native, libraryId); assert.equal(first.heads.length, 1);
    const seed = librarySnapshot(first, first.heads[0]), seedIds = first.checkpoint.batches.map(batch => batch.id);
    assert.equal(seed.items.length, 2); assert.equal(seed.folders.length, 0);
    const pdf = seed.items.find(item => item.kind === 'pdf')!, note = seed.items.find(item => item.kind === 'markdown')!;
    assert.ok(pdf && note);
    const [A, B, A1, C] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const folder = (id: string, title: string, parentId: string | null, position: number): Folder => ({ id, title, parentId, position });
    const recordsBefore = driveRecords().length;

    phase = 'a shared base with folders A, B, A1 (in A), C and an item in each of A and B';
    const baseBatch: LibraryEditBatch = { kind: 'library', id: crypto.randomUUID(), libraryId, targetId: libraryId, parents: [first.heads[0]], changes: [
      { type: 'put-folder', folder: folder(A, 'Move A', null, 100) }, { type: 'put-folder', folder: folder(B, 'Move B', null, 101) },
      { type: 'put-folder', folder: folder(A1, 'Move A child', A, 0) }, { type: 'put-folder', folder: folder(C, 'Move C', null, 102) },
      { type: 'put-item', item: { ...structuredClone(note), folderId: A, position: 0 } satisfies LibraryItem },
      { type: 'put-item', item: { ...structuredClone(pdf), folderId: B, position: 0 } satisfies LibraryItem }] };
    assert.equal((await repository.commit(baseBatch)).status, 'durable');
    await converge(pages);
    const nativeBase = await headsOf(native, [baseBatch.id]), webBase = await headsOf(web, [baseBatch.id]);
    const baseSnapshot = librarySnapshot(nativeBase.state, baseBatch.id);
    assert.deepEqual(folderParents(librarySnapshot(webBase.state, baseBatch.id)), { [A]: null, [B]: null, [A1]: A, [C]: null });
    const baseItems: Parents = { [pdf.id]: B, [note.id]: A };
    assert.deepEqual(itemFolders(baseSnapshot), baseItems);

    phase = 'two hosts move A into B and B into A before either sees the other';
    const x = { kind: 'library', id: crypto.randomUUID(), libraryId, targetId: libraryId, parents: [baseBatch.id], changes: moveLibraryFolder(baseSnapshot, A, B) } satisfies LibraryEditBatch;
    const y = { kind: 'library', id: crypto.randomUUID(), libraryId, targetId: libraryId, parents: [baseBatch.id], changes: moveLibraryFolder(baseSnapshot, B, A) } satisfies LibraryEditBatch;
    assert.notEqual(x.id.slice(0, 8), y.id.slice(0, 8));
    assert.equal((await repository.commit(x)).status, 'durable'); assert.equal((await commitOn(web, y)).status, 'durable');
    assert.deepEqual(sortedHeads(await readOn(native, libraryId)), [x.id], 'Native holds only its own move before any exchange');
    assert.deepEqual(sortedHeads(await readOn(web, libraryId)), [y.id], 'Web holds only its own move before any exchange');
    const nativePeer = await native.evaluate(() => (window as unknown as { compositionAdmittedPeer(): string }).compositionAdmittedPeer());
    const webPeer = await web.evaluate(() => (window as unknown as { compositionAdmittedPeer(): string }).compositionAdmittedPeer());
    assert.ok(nativePeer && webPeer && nativePeer !== webPeer, 'the two hosts are different devices (different admitted peer ids)');
    t.diagnostic(JSON.stringify({ nativePeer, webPeer }));
    await converge(pages);
    const nativeState = await headsOf(native, [x.id, y.id]), webState = await headsOf(web, [x.id, y.id]);
    const wantParentsX: Parents = { [A]: B, [B]: null, [A1]: A, [C]: null }, wantParentsY: Parents = { [A]: null, [B]: A, [A1]: A, [C]: null };
    for (const state of [nativeState.state, webState.state]) {
      assert.deepEqual(view(state), { heads: [x.id, y.id].sort(), waiting: [], rejected: {} }, 'both moves are kept as competing heads, none rejected, none waiting');
      assert.deepEqual(folderParents(librarySnapshot(state, x.id)), wantParentsX); assert.deepEqual(folderParents(librarySnapshot(state, y.id)), wantParentsY);
      assert.ok(acyclic(librarySnapshot(state, x.id)) && acyclic(librarySnapshot(state, y.id)));
      assert.deepEqual(itemFolders(librarySnapshot(state, x.id)), baseItems); assert.deepEqual(itemFolders(librarySnapshot(state, y.id)), baseItems);
      assert.deepEqual(state.checkpoint.batches.map(batch => batch.id).sort(), [...seedIds, baseBatch.id, x.id, y.id].sort(), 'no merged version was invented');
    }
    assert.equal(driveCount(driveRecords(), x.id), 1); assert.equal(driveCount(driveRecords(), y.id), 1);
    assert.equal(driveResolutions(driveRecords(), libraryId).length, 0);

    phase = 'the ordinary conflict panel and the version selector show each move as its own acyclic folder tree';
    for (const page of pages) { await page.bringToFront(); await expand(page); await panel(page).waitFor(); }
    for (const page of pages) {
      await page.bringToFront();
      const selector = page.getByRole('combobox', { name: '一覧の版', exact: true });
      await selector.selectOption(x.id); await expectTree(page, { ...wantParentsX, ...baseItems }, 'tree of the A-into-B head');
      await selector.selectOption(y.id); await expectTree(page, { ...wantParentsY, ...baseItems }, 'tree of the B-into-A head');
    }

    phase = 'a hand-built resolution that merges both moves is a cycle and is refused by both hosts';
    const merged: LibrarySnapshot = { ...baseSnapshot, version: crypto.randomUUID(), folders: baseSnapshot.folders.map(value =>
      value.id === A ? { ...value, parentId: B } : value.id === B ? { ...value, parentId: A } : value) };
    assert.equal(acyclic(merged), false);
    const union: ResolutionBatch = { kind: 'resolution', id: merged.version, libraryId, targetId: libraryId, parents: [x.id, y.id], snapshot: merged };
    const batchesBefore = (await readOn(native, libraryId)).checkpoint.batches.length;
    const refusals: Record<string, Outcome> = {};
    for (const [name, page] of [['native', native], ['web', web]] as const) {
      refusals[name] = await tryCommit(page, union);
      assert.equal(refusals[name].ok, false, `${name} refused the merged resolution: ${JSON.stringify(refusals[name])}`);
      assert.equal(refusals[name].status, 'aborted'); assert.match(refusals[name].message ?? '', /folder-cycle/, `${name} refused it because of the folder cycle`);
      const after = await readOn(page, libraryId);
      assert.deepEqual(sortedHeads(after), [x.id, y.id].sort(), `${name} heads unchanged`);
      assert.equal(after.checkpoint.batches.length, batchesBefore, `${name} stored nothing`);
      assert.ok(!after.checkpoint.batches.some(batch => batch.id === union.id));
    }
    t.diagnostic('refusal of the merged resolution: ' + JSON.stringify(refusals));
    assert.equal(driveCount(driveRecords(), union.id), 0, 'the refused resolution never reached the provider');

    phase = `adopt the ${choose} move on ${adoptOn} through the ordinary panel`;
    const chosen = choose === 'native' ? x : y, other = choose === 'native' ? y : x;
    const wantParents = choose === 'native' ? wantParentsX : wantParentsY;
    const host = adoptOn === 'native' ? native : web, peerHost = adoptOn === 'native' ? web : native;
    await host.bringToFront();
    await panel(host).getByRole('button', { name: '版を比較', exact: true }).click();
    const article = (page: Page, id: string) => panel(page).locator('article').filter({ hasText: `版 ${id.slice(0, 8)}` });
    await article(host, x.id).waitFor(); await article(host, y.id).waitFor();
    assert.equal(await panel(host).locator('article').count(), 2);
    for (const [id, want] of [[x.id, wantParentsX], [y.id, wantParentsY]] as const) {
      const shown = JSON.parse(await article(host, id).locator('pre').innerText()) as { folders: Folder[]; items: LibraryItem[] };
      assert.deepEqual(Object.fromEntries(shown.folders.map(value => [value.id, value.parentId])), want, 'the panel shows each head folders as stored');
      assert.deepEqual(Object.fromEntries(shown.items.map(value => [value.id, value.folderId])), baseItems);
    }
    await article(host, chosen.id).getByRole('button', { name: 'この内容を採用', exact: true }).click();
    const resolved = await waitForSnapshot(() => catalog(host), value => value.state.heads.length === 1 && !!value.session?.ready && !value.session.busy && !value.session.pendingId);
    const resolutionId = resolved.state.heads[0];
    const resolution = resolved.state.checkpoint.batches.find(batch => batch.id === resolutionId);
    assert.ok(resolution?.kind === 'resolution'); assert.deepEqual([...resolution.parents].sort(), [x.id, y.id].sort());
    assert.ok(resolution.snapshot.kind === 'library');
    assert.deepEqual({ ...resolution.snapshot, version: '' }, { ...librarySnapshot(resolved.state, chosen.id), version: '' }, 'the adopted catalog is exactly the chosen head');
    assert.deepEqual(folderParents(resolution.snapshot), wantParents);
    assert.ok(acyclic(resolution.snapshot), 'the adopted catalog has no folder cycle');
    assert.deepEqual(resolution.snapshot.folders.map(value => value.id).sort(), [A, B, A1, C].sort());
    assert.deepEqual(resolution.snapshot.items.map(value => value.id).sort(), [pdf.id, note.id].sort(), 'no item was lost');
    assert.deepEqual(itemFolders(resolution.snapshot), baseItems);
    assert.notDeepEqual(folderParents(resolution.snapshot), folderParents(librarySnapshot(resolved.state, other.id)), 'the other move is not silently merged into the adopted catalog');

    phase = 'convergence, both host trees and the provider';
    await converge(pages);
    const peerResolved = await headsOf(peerHost, [resolutionId]);
    assert.deepEqual(peerResolved.state.checkpoint.batches.find(batch => batch.id === resolutionId), resolution);
    for (const page of pages) { await panel(page).waitFor({ state: 'detached' }); await noAlert(page); }
    for (const state of [(await catalog(host)).state, peerResolved.state]) {
      assert.deepEqual(view(state), { heads: [resolutionId], waiting: [], rejected: {} });
      for (const id of [baseBatch.id, x.id, y.id]) assert.ok(state.checkpoint.batches.some(batch => batch.id === id), 'competing branch preserved in the graph');
      const final = librarySnapshot(state, resolutionId);
      assert.deepEqual(folderParents(final), wantParents); assert.ok(acyclic(final)); assert.deepEqual(itemFolders(final), baseItems);
    }
    for (const page of pages) { await page.bringToFront(); await expand(page); await expectTree(page, { ...wantParents, ...baseItems }, 'tree after resolution'); }
    assert.deepEqual(driveResolutions(driveRecords(), libraryId).map(value => value.id), [resolutionId]);
    for (const id of [baseBatch.id, x.id, y.id, resolutionId]) assert.equal(driveCount(driveRecords(), id), 1);
    assert.equal(driveRecords().length - recordsBefore, 4, 'base, the two moves and one resolution reached the provider; nothing else');
    await assertReceipts(pages, [baseBatch.id, x.id, y.id, resolutionId]);
  } catch (error) { t.diagnostic(`folder move conflict phase: ${phase}`); throw error; }
  finally { await finish(); }
}

for (const engine of ['chromium', 'webkit'] as const) {
  test(`Native A-into-B and Web B-into-A stay a conflict, never a cycle; Native adopts the Web move (${engine})`, { timeout: 600_000 },
    t => scenario(t, engine, 'native', 'web'));
  test(`Native A-into-B and Web B-into-A stay a conflict, never a cycle; Web adopts the Native move (${engine})`, { timeout: 600_000 },
    t => scenario(t, engine, 'web', 'native'));
}

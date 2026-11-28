import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { LibrarySnapshot } from '../../../../src/runtime/edits/contracts.ts';
import type { RepositoryState } from '../../../../src/runtime/edits/ports.ts';
import { openComposition } from '../../../support/documentComposition.ts';
import { waitForSnapshot } from '../../../support/waitForSnapshot.ts';

type Memory = {
  session: { ready: boolean; busy: boolean; pendingId: string | null; error: string; selectedVersion: string | null };
  selected?: LibrarySnapshot;
};
const memory = (page: Page): Promise<Memory | null> => page.evaluate(() => (window as unknown as {
  compositionLibraryMemory(): Memory | null;
}).compositionLibraryMemory());

async function assertNoContentController(page: Page) {
  const state = await page.evaluate(() => (window as unknown as {
    compositionNavigationEvidence(): { navigation: { documentId: string | null }; documentId: string | null; observedDocuments: string[]; observedMarkdown: string[] };
  }).compositionNavigationEvidence());
  assert.equal(state.navigation.documentId, null);
  assert.equal(state.documentId, null);
  assert.deepEqual(state.observedDocuments, []);
  assert.deepEqual(state.observedMarkdown, []);
  assert.equal(await page.locator('[data-content-document]').count(), 0);
}

// Real Native HTTP/SQLite and Web IDB owners with synthetic provider transport.
// No explicit sync/delivery, view controller, or reload may cause the landing.
for (const engine of ['chromium', 'webkit'] as const) test(`Library-only automatic Web upload and Native receive (${engine})`, { timeout: 300_000 }, async t => {
  const setup = await openComposition(t, engine, undefined, { emptyScope: true });
  const { native, web, pages, repository } = setup;
  try {
    for (const page of pages) {
      const toggle = page.getByRole('button', { name: '資料一覧', exact: true });
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
      await assertNoContentController(page);
      await waitForSnapshot(() => memory(page), value => !!value?.session.ready && !value.session.busy && !value.session.pendingId);
    }
    const title = `Automatic folder ${engine}`;
    const before = await memory(native);
    assert.ok(before?.selected);
    assert.equal(before.selected.folders.some(folder => folder.title === title), false);

    await web.bringToFront();
    await web.getByRole('button', { name: 'フォルダーを作成', exact: true }).click();
    await web.getByRole('textbox', { name: 'フォルダー名', exact: true }).fill(title);
    await web.getByLabel('親フォルダー', { exact: true }).selectOption('');
    await web.getByRole('button', { name: 'フォルダーを保存', exact: true }).click();
    const saved = await waitForSnapshot(() => memory(web), value => !!value?.session.ready && !value.session.busy && !value.session.pendingId
      && !!value.selected?.folders.some(folder => folder.title === title));
    assert.ok(saved?.selected);
    const folders = saved.selected.folders.filter(folder => folder.title === title);
    assert.equal(folders.length, 1);
    const folder = folders[0];
    const webDurable = await web.evaluate(() => (window as unknown as {
      compositionLibraryEvidence(): Promise<{ state: RepositoryState }>;
    }).compositionLibraryEvidence());
    const batches = webDurable.state.checkpoint.batches.filter(batch => batch.kind === 'library'
      && batch.changes.some(change => change.type === 'put-folder' && change.folder.id === folder.id));
    assert.equal(batches.length, 1);
    const batch = batches[0];
    assert.equal(batch.libraryId, repository.scope.libraryId);
    assert.equal(batch.targetId, repository.scope.libraryId);

    // Only foregrounding the Library; no receiver command starts replication.
    await native.bringToFront();
    const received = await waitForSnapshot(() => memory(native), value => !!value?.session.ready && !value.session.busy && !value.session.pendingId
      && !!value.selected?.folders.some(value => value.id === folder.id && value.title === title), 30_000);
    assert.ok(received?.selected);
    assert.notEqual(received.selected.version, before.selected.version);
    await native.getByRole('button', { name: `「${title}」を選択`, exact: true }).waitFor({ timeout: 25_000 });
    const durable = await repository.read(repository.scope.libraryId);
    assert.deepEqual(durable.checkpoint.batches.find(value => value.id === batch.id), batch);
    const receipt = await repository.receipt(batch.id);
    assert.equal(receipt?.id, batch.id);
    assert.equal(receipt?.durable, true);
    assert.equal(receipt?.targetId, repository.scope.libraryId);
    const peer = await native.evaluate(() => (window as unknown as { compositionAdmittedPeer(): string }).compositionAdmittedPeer());
    assert.ok(receipt?.importedBy.includes(peer));
    for (const page of pages) await assertNoContentController(page);
    t.diagnostic(`Automatic Library receipt ${batch.id}, Native peer ${peer}; no content controller or explicit sync after setup.`);
  } finally {
    // emptyScope cleanup does not inject a delivery pass.
    await setup.finish();
  }
});

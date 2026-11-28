import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright-core';

for (const engine of ['chromium', 'webkit'] as const) {
test(`real IndexedDB: four contracts, native abort, restart, parent waiting, receipts and scope isolation (${engine})`, { timeout: 90_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, '..');
  const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), logLevel: 'error',
    cacheDir: 'node_modules/.vite-edit-repository', optimizeDeps: { entries: ['e2e/fixtures/editRepository.html'] },
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  await server.listen(); t.after(() => server.close());
  const browser = engine === 'chromium' ? await chromium.launch({ channel: 'msedge', headless: true }) : await webkit.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route(url => url.pathname.startsWith('/api/'), route => route.abort());
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/editRepository.html`);
  const fixture = JSON.parse(readFileSync(path.resolve(frontend, '../tests/fixtures/shared-edits.json'), 'utf8'));
  const pdfBytes = [...readFileSync(path.resolve(frontend, '../tests/fixtures', fixture.resource.file))];
  const result = await page.evaluate(async ({ fixture, pdfBytes }) => {
    // @ts-expect-error -- Vite browser import of the explicit raw Core/migration fixture.
    const { IndexedDbEditDatabase } = await import('/e2e/support/raw-core/indexedDbEdits.ts');
    // @ts-expect-error -- Vite browser import.
    const { DurableEditRepository } = await import('/src/runtime/edits/repository.ts');
    // @ts-expect-error -- Vite browser import; object key order is not wire identity.
    const { canonicalJson } = await import('/src/runtime/edits/editModel.ts');
    // @ts-expect-error -- Shared document session on the real native browser repository.
    const { DocumentEditSession } = await import('/src/features/reader/edit/DocumentEditSession.ts');
    // @ts-expect-error -- Vite browser import; real PDF.js inspection in both engines.
    const { pdfResourceInspection } = await import('/src/adapters/browser/pdfResources.ts');
    const inspected = await pdfResourceInspection.inspectPdf(Uint8Array.from(pdfBytes));
    if (inspected.length !== fixture.resource.metadata.pdfPages.length || inspected.some((value: { widthPt: number; heightPt: number }, index: number) =>
      Math.abs(value.widthPt - fixture.resource.metadata.pdfPages[index].widthPt) > .001 || Math.abs(value.heightPt - fixture.resource.metadata.pdfPages[index].heightPt) > .001)) {
      throw new Error('PDF.js/PyMuPDF CropBox/Rotate/UserUnit mismatch: ' + JSON.stringify({ inspected, expected: fixture.resource.metadata.pdfPages }));
    }
    const scope = { accountId: 'fixture-account', libraryId: fixture.libraryId, epoch: 'fixture-epoch' };
    const name = `papeer-edits-test-${crypto.randomUUID()}`;
    let database = new IndexedDbEditDatabase(scope, name);
    let repository = new DurableEditRepository(scope, database);
    const numberId = (number: number) => `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
    const batch = (number: number) => fixture.batches.find((batch: { id: string }) => batch.id === numberId(number));
    const expect = (value: unknown, message: string) => { if (!value) throw new Error(message); };
    const evidence: string[] = [];
    for (const key of ['document', 'markdown', 'library']) await repository.initialize(fixture[key]);
    let failProjection = true;
    const faulty = new DurableEditRepository(scope, { transaction: (run: (tx: any) => Promise<unknown>) => database.transaction((tx: any) => run({ ...tx,
      putProjection: (snapshot: any) => { tx.putProjection(snapshot); if (failProjection) throw new Error('simulated storage failure'); },
    })) });
    let commitFailed = false;
    try { const res = await faulty.commit(batch(201)); commitFailed = res.status === 'aborted' || res.status === 'unknown'; } catch { commitFailed = true; }
    expect(commitFailed, 'native failure must abort');
    expect((await repository.pending()).length === 0 && !await repository.receipt(numberId(201)), 'abort leaked receipt/outbox');
    expect((await repository.read(fixture.document.id)).heads[0] === numberId(100), 'abort leaked projection');
    evidence.push('atomic abort');
    failProjection = false;
    const history = { operationId: numberId(201), beforeVersion: fixture.document.version, afterVersion: numberId(201), undoRequested: false };
    expect((await repository.commit(batch(201), history)).status === 'durable', 'commit failed');
    await database.close();
    const documentScope = { ...scope, epoch: 'translation-session' };
    database = new IndexedDbEditDatabase(documentScope, name);
    repository = new DurableEditRepository(documentScope, database, pdfResourceInspection);
    await repository.storeResource({ ...fixture.resource.metadata, bytes: Uint8Array.from(pdfBytes), expected: fixture.resource.metadata });
    await repository.initialize(fixture.translation.root);
    let documentSaveFails = true;
    const documentRepository = new DurableEditRepository(documentScope, { transaction: (run: (tx: any) => Promise<unknown>) => database.transaction((tx: any) => run({ ...tx,
      putProjection: (snapshot: any) => { tx.putProjection(snapshot); if (documentSaveFails) throw new Error('document quota'); },
    })) }, pdfResourceInspection);
    const ids = fixture.translation.batches.map((batch: any) => batch.id);
    let documentSession = new DocumentEditSession(documentRepository, fixture.translation.root.id, () => ids.shift() ?? crypto.randomUUID());
    expect(await documentSession.refresh(), 'document session did not load');
    const translatedPageId = fixture.translation.root.translation.pages[0].id, token = Symbol('surface');
    expect(documentSession.claimPage(translatedPageId, token), 'translated owner missing');
    expect(!documentSession.claimPage(translatedPageId, Symbol('other')), 'second surface stole ownership');
    documentSession.setInput(translatedPageId, token, 'drawing');
    expect(!documentSession.canNavigate(), 'active drawing did not guard navigation');
    documentSession.setInput(translatedPageId, token, 'idle');
    await documentSession.editPage(translatedPageId, token, fixture.translation.batches[0].changes);
    expect(['aborted', 'unknown'].includes(documentSession.getSnapshot().phase) && !documentSession.canNavigate(), 'quota did not preserve the pending edit/guard');
    expect(documentSession.getSnapshot().document.translation.pages[0].annotations.length === 1, 'quota lost the visible ink');
    documentSaveFails = false; await documentSession.retry();
    await documentSession.editDocument(fixture.translation.batches[1].changes);
    expect(documentSession.getSnapshot().document.deletedPages[0].annotations.length === 1, 'mapping replacement lost old translated ink');
    await documentSession.undo(); await documentSession.undo();
    expect(documentSession.getSnapshot().document.translation.pages[0].annotations.length === 0, 'document Undo did not cross mapping and page editing');
    await database.close(); database = new IndexedDbEditDatabase(documentScope, name);
    repository = new DurableEditRepository(documentScope, database, pdfResourceInspection);
    documentSession = new DocumentEditSession(repository, fixture.translation.root.id); await documentSession.refresh();
    expect(documentSession.getSnapshot().canRedo, 'native restart lost document history actions');
    await documentSession.redo(); await documentSession.redo();
    expect(documentSession.getSnapshot().document.deletedPages[0].annotations.length === 1, 'Redo did not preserve the retired annotation');
    await database.close();
    database = new IndexedDbEditDatabase(scope, name); repository = new DurableEditRepository(scope, database);
    expect((await repository.pending()).length === 1, 'restart lost pending batch');
    expect((await repository.read(fixture.document.id)).history.length === 1, 'restart lost history');
    expect((await repository.commit(batch(201))).status === 'durable', 'idempotent resend failed');
    expect((await repository.read(fixture.document.id)).receipts.length === 1, 'duplicate applied twice');
    evidence.push('restart and idempotent resend');
    await repository.acknowledgeUpload(numberId(201));
    expect((await repository.pending()).length === 0, 'upload ack failed');
    expect((await repository.receipt(numberId(201))).importedBy.length === 0, 'upload incorrectly claims peer import');
    await repository.acknowledgeImport(numberId(201), 'desktop');
    expect((await repository.receipt(numberId(201))).importedBy[0] === 'desktop', 'peer ack failed');
    evidence.push('separate upload and import receipts');
    await repository.receive([batch(204)]);
    expect((await repository.read(fixture.document.id)).waiting[0] === numberId(204), 'parent did not wait');
    await repository.receive([batch(203), batch(202)]);
    expect(JSON.stringify((await repository.read(fixture.document.id)).heads) === JSON.stringify([numberId(202), numberId(204)]), 'branches lost');
    expect((await repository.commit(batch(206))).status === 'durable', 'resolution failed');
    await repository.receive([batch(205), batch(207)]);
    expect((await repository.read(fixture.document.id)).heads.length === 3, 'late/simultaneous branch lost');
    evidence.push('parent waiting, conditional resolution and late branches');
    for (const number of [501, 502, 301, 302]) expect((await repository.commit(batch(number))).status === 'durable', `family ${number} failed`);
    expect((await repository.read(fixture.markdown.id)).heads.length === 2, 'Markdown conflict lost');
    expect((await repository.read(fixture.library.id)).heads[0] === numberId(302), 'catalog restoration failed');
    evidence.push('all four contracts');
    const other = new IndexedDbEditDatabase({ ...scope, accountId: 'other' }, name);
    const isolated = new DurableEditRepository({ ...scope, accountId: 'other' }, other);
    expect((await isolated.pending()).length === 0 && !await isolated.receipt(numberId(201)), 'account leak');
    await other.close(); await database.close();
    await new Promise<void>((resolve, reject) => { const deletion = indexedDB.deleteDatabase(name); deletion.onsuccess = () => resolve(); deletion.onerror = () => reject(deletion.error); });
    evidence.push('account isolation');
    let failOpen = true;
    const retryDatabase = new IndexedDbEditDatabase(scope, name, { open: (name: string, version: number) => {
      if (failOpen) { failOpen = false; throw new DOMException('temporary storage failure', 'QuotaExceededError'); }
      return indexedDB.open(name, version);
    } });
    const retryRepository = new DurableEditRepository(scope, retryDatabase);
    let failedOpen = false;
    try { await retryRepository.initialize(fixture.document); } catch { failedOpen = true; }
    expect(failedOpen, 'first open should report its failure');
    await retryRepository.initialize(fixture.document);
    expect((await retryRepository.read(fixture.document.id)).heads[0] === numberId(100), 'open failure permanently poisoned retries');
    await retryDatabase.close();
    await new Promise<void>((resolve, reject) => { const deletion = indexedDB.deleteDatabase(name); deletion.onsuccess = () => resolve(); deletion.onerror = () => reject(deletion.error); });
    evidence.push('retry after native open failure');
    for (const entry of fixture.publications) {
      const publicationScope = { ...scope, epoch: `publication-${entry.name}` };
      database = new IndexedDbEditDatabase(publicationScope, name);
      repository = new DurableEditRepository(publicationScope, database, pdfResourceInspection);
      for (const key of ['document', 'markdown', 'library']) await repository.initialize(fixture[key]);
      const input = { id: fixture.resource.metadata.id, sha256: fixture.resource.metadata.sha256,
        mediaType: 'application/pdf', bytes: Uint8Array.from(pdfBytes), expected: fixture.resource.metadata };
      expect((await repository.publish(entry.value)).status === (entry.name === 'pdf' || entry.name === 'attachment' ? 'aborted' : 'durable'), 'resource absence publication result');
      // Use another scope for the actual transaction failure check; no first publication is reused.
      await database.close();
      const atomicScope = { ...publicationScope, epoch: `${publicationScope.epoch}-atomic` };
      database = new IndexedDbEditDatabase(atomicScope, name);
      repository = new DurableEditRepository(atomicScope, database, pdfResourceInspection);
      for (const key of ['document', 'markdown', 'library']) await repository.initialize(fixture[key]);
      const metadata = await repository.storeResource(input);
      expect(JSON.stringify(metadata) === JSON.stringify(fixture.resource.metadata), 'PDF dimensions must be parsed from the real resource');
      const faulty = new DurableEditRepository(atomicScope, { transaction: (run: (tx: any) => Promise<unknown>) => database.transaction((tx: any) => run({ ...tx,
        putProjection: (snapshot: any) => { tx.putProjection(snapshot); if (snapshot.kind === 'library') throw new Error('quota'); },
      })) }, pdfResourceInspection);
      const publication = entry.value, batch = publication.libraryBatch;
      const history = { operationId: batch.id, beforeVersion: batch.parents[0], afterVersion: batch.id, undoRequested: false };
      let publishFailed = false;
      try { const res = await faulty.publish(publication, history); publishFailed = res.status === 'aborted' || res.status === 'unknown'; } catch { publishFailed = true; }
      expect(publishFailed, 'publication failure was not atomic');
      expect((await repository.pending()).length === 0 && !await repository.receipt(batch.id), 'publication leaked its outbox or receipt');
      if (publication.content) {
        let absent = false;
        try { await repository.read(publication.content.id); } catch { absent = true; }
        expect(absent, 'failed publication leaked initial content');
      }
      expect((await repository.publish(publication, history)).status === 'durable', 'publication retry failed');
      await database.close(); database = new IndexedDbEditDatabase(atomicScope, name);
      repository = new DurableEditRepository(atomicScope, database, pdfResourceInspection);
      expect(JSON.stringify(await repository.pendingPublications()) === JSON.stringify([publication]), 'restart lost the complete publication envelope');
      expect((await repository.read(atomicScope.libraryId)).history.length === 1, 'publication history missing');
      expect((await repository.publish(publication, history)).status === 'durable', 'publication resend must be idempotent');
      const other = new IndexedDbEditDatabase({ ...atomicScope, accountId: 'other' }, name);
      const isolated = new DurableEditRepository({ ...atomicScope, accountId: 'other' }, other);
      expect(!await isolated.readResource(input.id), 'resource leaked to another account');
      await other.close();
      const resource = await repository.readResource(input.id);
      expect(resource.bytes.byteLength === pdfBytes.length && resource.metadata.sha256 === input.sha256, 'restart lost background bytes');
      await database.close();
      // A different origin/device has separate native storage but the same account/library/epoch.
      const peerDatabase = new IndexedDbEditDatabase(atomicScope, name + '-peer');
      const peer = new DurableEditRepository(atomicScope, peerDatabase, pdfResourceInspection);
      for (const key of ['document', 'markdown', 'library']) await peer.initialize(fixture[key]);
      await peer.storeResource({ ...input, expected: metadata });
      const edits = entry.name === 'markdown' ? [{ kind: 'markdown', id: crypto.randomUUID(), libraryId: atomicScope.libraryId,
        targetId: publication.content.id, parents: [publication.content.version], content: 'first remote edit', imageResources: [] }] : [];
      if (edits.length) {
        await peer.receive(edits); // Child listed before creation must remain durable and private.
        expect((await peer.receipt(edits[0].id))?.durable, 'early child edit was discarded');
      }
      const badPeer = new DurableEditRepository(atomicScope, { transaction: (run: (tx: any) => Promise<unknown>) => peerDatabase.transaction((tx: any) => run({ ...tx,
        putProjection: (snapshot: any) => {
          tx.putProjection(snapshot);
          if (edits.length ? snapshot.version === edits[0].id : snapshot.kind === 'library') throw new Error('quota');
        },
      })) }, pdfResourceInspection);
      let aborted = false;
      try { await badPeer.receivePublications([publication], edits); } catch { aborted = true; }
      expect(aborted && !await peer.receipt(batch.id), 'incoming publication leaked a receipt on abort');
      expect((await peer.read(atomicScope.libraryId)).heads[0] === fixture.library.version, 'incoming publication leaked catalog metadata on abort');
      if (publication.content) {
        let absent = false; try { await peer.read(publication.content.id); } catch { absent = true; }
        expect(absent, 'incoming publication leaked content on abort');
      }
      await peer.receivePublications([publication], edits);
      expect((await peer.pending()).length === 0 && (await peer.pendingPublications()).length === 0, 'import incorrectly creates an upload obligation');
      if (publication.content) expect((await peer.read(publication.content.id)).heads[0] === (edits[0]?.id ?? publication.content.version), 'creation and first edit did not arrive together');
      await peerDatabase.close();
    }
    const recordScope = { ...scope, epoch: 'ordinary-records' };
    database = new IndexedDbEditDatabase(recordScope, name);
    repository = new DurableEditRepository(recordScope, database);
    await repository.initialize(fixture.document);
    await repository.receiveRecords([fixture.editRecords[2]]);
    const badRecords = new DurableEditRepository(recordScope, { transaction: (run: (tx: any) => Promise<unknown>) => database.transaction((tx: any) => run({ ...tx,
      putEdit: (edit: any) => { tx.putEdit(edit); throw new Error('record quota'); },
    })) });
    let recordAborted = false;
    try { await badRecords.receiveRecords(fixture.editRecords.slice(0, 2)); } catch { recordAborted = true; }
    expect(recordAborted && !await repository.receipt(fixture.editRecords[0].batch.id), 'failed record import leaked a receipt');
    expect((await repository.read(fixture.document.id)).history.length === 1, 'failed import leaked history');
    expect((await repository.read(fixture.document.id)).heads[0] === fixture.document.version, 'failed import leaked a projection');
    await repository.receiveRecords(fixture.editRecords.slice(0, 2));
    await database.close(); database = new IndexedDbEditDatabase(recordScope, name);
    repository = new DurableEditRepository(recordScope, database);
    expect(canonicalJson((await repository.checkpoint()).edits) === canonicalJson(fixture.editRecords), 'ordinary record restart lost action metadata');
    const importedSession = new DocumentEditSession(repository, fixture.document.id); await importedSession.refresh();
    expect(importedSession.getSnapshot().canUndo && !importedSession.getSnapshot().canRedo, 'imported Redo did not restore history');
    await importedSession.undo();
    expect(importedSession.getSnapshot().document.pages[0].annotations.length === 0, 'imported operation could not be undone after restart');
    const inverseRecords = await repository.pendingRecords();
    expect(inverseRecords.length === 1 && inverseRecords[0].history.action.kind === 'undo', 'native outbox lost the inverse action');
    const conflicting = structuredClone(fixture.editRecords[0]); conflicting.history.undoRequested = true;
    let conflictRejected = false; try { await repository.receiveRecords([conflicting]); } catch { conflictRejected = true; }
    expect(conflictRejected && (await repository.read(fixture.document.id)).history.length === 4, 'conflicting metadata changed durable history');
    await database.close();
    evidence.push('ordinary records: reverse arrival, atomic native abort, history import, restart and document Undo');
    const checkpointScope = { ...scope, epoch: 'checkpoint' };
    database = new IndexedDbEditDatabase(checkpointScope, name);
    repository = new DurableEditRepository(checkpointScope, database, pdfResourceInspection);
    await repository.storeResource({ ...fixture.resource.metadata, bytes: Uint8Array.from(pdfBytes), expected: fixture.resource.metadata });
    const badCheckpoint = new DurableEditRepository(checkpointScope, { transaction: (run: (tx: any) => Promise<unknown>) => database.transaction((tx: any) => run({ ...tx,
      putEdit: (edit: any) => { tx.putEdit(edit); throw new Error('checkpoint quota'); },
    })) }, pdfResourceInspection);
    let checkpointAborted = false;
    try { await badCheckpoint.installCheckpoint(fixture.checkpoint); } catch { checkpointAborted = true; }
    expect(checkpointAborted, 'checkpoint did not abort');
    let noCatalog = false; try { await repository.read(scope.libraryId); } catch { noCatalog = true; }
    expect(noCatalog && !await repository.receipt(fixture.checkpoint.edits[0].batch.id), 'checkpoint partially exposed roots or edits');
    await repository.installCheckpoint(fixture.checkpoint);
    await database.close(); database = new IndexedDbEditDatabase(checkpointScope, name);
    repository = new DurableEditRepository(checkpointScope, database, pdfResourceInspection);
    expect(canonicalJson(await repository.checkpoint()) === canonicalJson(fixture.checkpoint), 'checkpoint restart lost roots, branches, history or publication envelope');
    await badCheckpoint.installCheckpoint(fixture.checkpoint); // Must skip the deliberately failing writer after restart.
    expect((await repository.read(fixture.document.id)).waiting.length === 1, 'checkpoint lost unresolved ancestry');
    expect((await repository.commit(batch(501))).status === 'durable', 'new local edit after bootstrap failed');
    await repository.installCheckpoint(fixture.checkpoint);
    expect((await repository.receipt(numberId(501))).upload === 'pending', 'repeated checkpoint cleared local outbox');
    await database.close();
    for (const databaseName of [name, name + '-peer']) await new Promise<void>((resolve, reject) => { const deletion = indexedDB.deleteDatabase(databaseName); deletion.onsuccess = () => resolve(); deletion.onerror = () => reject(deletion.error); });
    evidence.push('four atomic publication kinds with real PDF inspection, native abort, restart and isolated resources');
    evidence.push('atomic checkpoint bootstrap, restart, parent waiting, full history and preservation of local pending edits');
    evidence.push('shared document session: separate translated identities, quota retry, owner guard, mapping Undo/Redo and native history recovery');
    return evidence;
  }, { fixture, pdfBytes });
  assert.equal(result.length, 11);
});
}

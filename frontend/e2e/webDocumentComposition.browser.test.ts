import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openComposition, evidence, gesture, settled, sync, readLegacyDraftEvidence, captureReferenceFailure, type Diagnostics } from './support/documentComposition.ts';

// The expanded provider/PKCE/restart scenario has a recorded 600s overall budget.
// Individual UI/delivery bounds stay 25s/30s; this is not a performance acceptance.
for (const engine of ['chromium', 'webkit'] as const) test(`production PC/Web canonical PDF composition, erase batch, history, replication and reload (${engine})`, { timeout: 600_000 }, async t => {
  const started = performance.now();
  const { native, web, pages, repository, documentId, reload, committed, finish, loseNextCommitReply } = await openComposition(t, engine);
  let phase = 'native drawing and erase';
  const setPhase = (value: string) => { phase = value; console.error(`composition-phase: ${engine}: ${value} (${Math.round(performance.now() - started)}ms)`); };
  try {
  await native.getByRole('button', { name: 'ペン', exact: true }).click();
  await gesture(native, [[.2, .2], [.5, .2]]); await settled(native, 1);
  await gesture(native, [[.2, .3], [.5, .3]]); await settled(native, 2);
  const beforeErase = (await evidence(native)).state.history.length;
  setPhase('native erase of the two strokes');
  await native.getByRole('button', { name: '消しゴム', exact: true }).click();
  await gesture(native, [[.35, .15], [.35, .35]]); await settled(native, 0);
  const erased = (await evidence(native)).state;
  assert.equal(erased.history.length, beforeErase + 1, 'one erase gesture is one history batch');
  assert.equal(erased.heads.length, 1);
  const eraseBatch = erased.checkpoint.batches.find(batch => batch.id === erased.heads[0])!;
  assert.equal(eraseBatch.kind, 'page');
  if (eraseBatch.kind === 'page') assert.deepEqual(eraseBatch.changes.map(change => change.type), ['delete', 'delete']);
  await native.getByRole('button', { name: '元に戻す', exact: true }).click(); await settled(native, 2);
  await sync(native); await sync(web); await settled(web, 2);
  await web.getByRole('button', { name: 'ペン', exact: true }).click();
  await gesture(web, [[.2, .4], [.5, .4]]); await settled(web, 3);
  const webHistory = (await evidence(web)).state.history.length;
  setPhase('web erase of the two Native strokes');
  await web.getByRole('button', { name: '消しゴム', exact: true }).click();
  await gesture(web, [[.35, .15], [.35, .35]]); await settled(web, 1);
  assert.equal((await evidence(web)).state.history.length, webHistory + 1);
  await web.getByRole('button', { name: '元に戻す', exact: true }).click(); await settled(web, 3);
  await sync(web); await sync(native); await settled(native, 3);
  for (const [index, page] of pages.entries()) {
    setPhase(`reload ${index === 0 ? 'native' : 'web'} history`);
    await reload(page);
    setPhase(`observe ${index === 0 ? 'native' : 'web'} restored history`);
    await settled(page, 3);
  }
  setPhase('reloaded Undo and Redo');
  // The most recent operation is the two-object eraser, undone before restart.
  await web.getByRole('button', { name: 'やり直す', exact: true }).click(); await settled(web, 1);
  await web.getByRole('button', { name: '元に戻す', exact: true }).click(); await settled(web, 3);
  await sync(web); await sync(native); await settled(native, 3);
  await native.getByRole('button', { name: 'やり直す', exact: true }).click(); await settled(native, 1);
  await native.getByRole('button', { name: '元に戻す', exact: true }).click(); await settled(native, 3);
  await sync(native); await sync(web); await settled(web, 3);
  await web.getByRole('button', { name: '元に戻す', exact: true }).click(); await settled(web, 2);
  await web.getByRole('button', { name: 'やり直す', exact: true }).click(); await settled(web, 3);
  await sync(web); await sync(native); await settled(native, 3);
  // The native commit is durable but its response is lost. UI keeps the same intent for retry.
  setPhase('native durable response loss: dispatch');
  loseNextCommitReply();
  await native.getByRole('button', { name: 'ペン', exact: true }).click();
  await gesture(native, [[.2, .5], [.5, .5]]);
  setPhase('native durable response loss: wait for retry');
  await native.getByRole('button', { name: '再試行', exact: true }).waitFor();
  setPhase('native durable response loss: read intent');
  const retained = await repository.readIntent(documentId); assert.ok(retained);
  const lostId = committed[committed.length - 1]!;
  native.once('dialog', dialog => { void dialog.accept(); });
  setPhase('native durable response loss: reload');
  await reload(native);
  setPhase('native durable response loss: retry');
  await native.getByRole('button', { name: '再試行', exact: true }).click(); await settled(native, 4);
  assert.equal(committed[committed.length - 1], lostId, 'retry retains the original batch identity');
  assert.equal((await repository.read(documentId)).checkpoint.batches.filter(batch => batch.id === lostId).length, 1);
  await sync(native); await sync(web); await settled(web, 4);
  for (const page of pages) {
    await reload(page); await settled(page, 4);
    assert.deepEqual(await readLegacyDraftEvidence(page), ['untouched raw draft', null]);
    assert.deepEqual(await page.evaluate(() => [localStorage.getItem('paperdesk-draft-sentinel'), localStorage.getItem('papeer-draft-sentinel')]), [null, null], 'the clean profile does not adopt the held legacy draft');
    const opened = await page.evaluate(() => (window as unknown as { compositionOpenedDatabases: string[] }).compositionOpenedDatabases);
    assert.ok(opened.every(name => ['papeer-shared-cloud-v1', 'papeer-shared-edits', 'papeer-migration-backups'].includes(name)), 'only canonical databases and the readonly migration-hold probe are allowed');
    const databases = await page.evaluate(() => indexedDB.databases());
    assert.equal(databases.find(value => value.name === 'papeer-migration-backups'), undefined, 'the readonly hold probe aborts creation of an absent database');
    assert.equal(databases.find(value => value.name === 'papeer-shared-edits'), undefined, 'cloud-first startup does not create the local cache');
    const cloud = databases.find(value => value.name === 'papeer-shared-cloud-v1');
    if (page === web) assert.equal(cloud?.version, 9, 'Web uses its fixed canonical cloud cache');
    else assert.equal(cloud, undefined, 'Native keeps its owner storage in SQLite');
  }
  assert.deepEqual((await evidence(native)).session.document, (await evidence(web)).session.document);
  // Same PDF resource/page, different logical page: navigation must re-register the finalizer.
  setPhase('second logical page and unmount');
  await web.getByRole('button', { name: '次のページ', exact: true }).click();
  await web.waitForFunction(() => (document.querySelector('[aria-label="ページ番号"]') as HTMLInputElement)?.value === '2');
  await web.waitForFunction(() => document.querySelectorAll('[data-ink-id]').length === 0);
  await web.getByRole('button', { name: 'ペン', exact: true }).click();
  const box = await web.getByLabel('PDF書き込みレイヤー', { exact: true }).boundingBox(); assert.ok(box);
  await web.mouse.move(box.x + box.width * .2, box.y + box.height * .2); await web.mouse.down();
  await web.mouse.move(box.x + box.width * .5, box.y + box.height * .2, { steps: 12 });
  assert.equal((await evidence(web)).session.inputActive, true);
  await web.evaluate(() => (window as unknown as { compositionUnmount(): void }).compositionUnmount());
  await web.mouse.up();
  await web.waitForFunction(() => {
    const value = (window as unknown as { compositionDiagnostics(): Diagnostics }).compositionDiagnostics();
    return value.session.phase === 'idle' && value.session.document?.pages[1].annotations.length === 1;
  });
  assert.equal((await evidence(web)).session.document!.pages[0].annotations.length, 4);
  await reload(web);
  await web.waitForFunction(() => (document.querySelector('[aria-label="ページ番号"]') as HTMLInputElement)?.value === '2');
  await web.waitForFunction(() => document.querySelectorAll('[data-ink-id]').length === 1);
  assert.equal((await evidence(web)).session.document!.pages[0].annotations.length, 4);
  await web.getByRole('button', { name: '前のページ', exact: true }).click();
  await settled(web, 4); await sync(web); await sync(native);
  await native.waitForFunction(() => (window as unknown as { compositionDiagnostics(): Diagnostics }).compositionDiagnostics().session.document?.pages[1].annotations.length === 1);
  assert.deepEqual((await evidence(native)).session.document, (await evidence(web)).session.document);
  setPhase('finish invariants');
  await finish();
  } catch (error) {
    t.diagnostic(`composition failure stack ${phase}: ${error instanceof Error ? error.stack : String(error)}`);
    try { await captureReferenceFailure(t, pages, `pdf:${phase}`); }
    catch (cause) { t.diagnostic(`composition render evidence ${phase}: ${String(cause)}`); }
    for (const [index, page] of pages.entries()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const details = await Promise.race([page.evaluate(async () => {
          const current = window as unknown as {
            compositionEvidence(): Promise<unknown>;
            compositionStartupEvidence?(): unknown;
            compositionBootstrapStatus?(): unknown;
          };
          let durable: unknown;
          try { durable = await current.compositionEvidence(); }
          catch (cause) { durable = { readError: String(cause) }; }
          return { durable, startup: current.compositionStartupEvidence?.(), bootstrap: current.compositionBootstrapStatus?.(),
            alerts: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent),
            tools: [...document.querySelectorAll('button')].map(element => ({ name: element.getAttribute('aria-label') || element.title || element.textContent,
              pressed: element.getAttribute('aria-pressed'), disabled: element.disabled })),
            viewport: { width: innerWidth, height: innerHeight },
            layers: [...document.querySelectorAll('[aria-label="PDF書き込みレイヤー"]')].map(element => {
              const bounds = element.getBoundingClientRect();
              return { bounds: bounds.toJSON(), targets: [[.35, .15], [.35, .35]].map(([x, y]) => {
                const clientX = bounds.x + bounds.width * x, clientY = bounds.y + bounds.height * y;
                const target = document.elementFromPoint(clientX, clientY);
                return { clientX, clientY, tag: target?.tagName, label: target?.getAttribute('aria-label'), insideLayer: !!target && element.contains(target) };
              }) };
            }),
            renderedInk: [...document.querySelectorAll('[data-ink-id]')].map(element => ({ id: element.getAttribute('data-ink-id'), bounds: element.getBoundingClientRect().toJSON() })) };
        }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('composition evidence timeout')), 2_000); })])
          .finally(() => { if (timer !== undefined) clearTimeout(timer); });
        t.diagnostic(`composition failure ${phase} ${index === 0 ? 'native' : 'web'}: ${JSON.stringify(details)}`);
      } catch (cause) { t.diagnostic(`composition failure ${phase} ${index === 0 ? 'native' : 'web'}: ${String(cause)}`); }
    }
    throw error;
  }
});

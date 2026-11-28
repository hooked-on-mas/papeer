import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { createEnrolledLibrary, fillNote, openNote, openWorld, records, unlock, until, visibleText, type Engine } from '../../../support/provider/offlineOrdinary.ts';

const registration = (page: Page) => page.evaluate(async () => {
  const found = await navigator.serviceWorker?.getRegistration();
  return { supported: !!navigator.serviceWorker, registered: !!found, scope: found?.scope ?? null, controlled: !!navigator.serviceWorker?.controller };
});

for (const engine of ['chromium', 'webkit'] as const satisfies Engine[]) {
  test(`the built ordinary Web registers its service worker (${engine})`, { timeout: 120_000 }, async t => {
    const w = await openWorld(t, engine, 'pwa-reg', { built: true });
    const { page } = await w.launch(w.profile('a'), 'online', 'pwa-reg');
    await page.getByRole('button', { name: 'この端末で使い始める', exact: true }).waitFor();
    const seen = await until(() => registration(page), value => value.registered && value.controlled, 'service worker registration by the ordinary entry', 20_000);
    assert.equal(seen.registered, true);
    assert.equal(seen.controlled, true);
  });

  test(`the built ordinary Web shell starts offline and opens the enrolled Library (${engine})`, { timeout: 480_000 }, async t => {
    const w = await openWorld(t, engine, 'pwa-shell', { built: true }), profile = w.profile('a');
    const library = `Shell Library ${engine}`, note = `Shell note ${engine}`; let phase = 'online-prepare';
    try {
      let a = await w.launch(profile, 'online', 'pwa-shell-a');
      const id = await createEnrolledLibrary(a.page, library, note, 'online initial');
      const before = new Set((await records(a.page, id)).map(row => row.batch.id));
      phase = 'verify-worker';
      await until(() => registration(a.page), value => value.registered && value.controlled, 'service worker control', 20_000);
      const worker = await a.page.evaluate(async () => {
        const reg = await navigator.serviceWorker.ready;
        const names = await caches.keys();
        const shell = names.find(name => name.startsWith('papeer-shell:'));
        return { scope: reg.scope, caches: names, cached: shell ? (await (await caches.open(shell)).keys()).length : 0 };
      });
      t.diagnostic(`worker registered by the app: ${JSON.stringify(worker)}`);
      assert.ok(worker.caches.some(name => name.startsWith('papeer-shell:')) && worker.cached > 8);
      await w.close(a.context); await w.stopServer();

      phase = 'offline-cold-start'; a = await w.launch(profile, 'offline', 'unused');
      const state = await registration(a.page); t.diagnostic(`offline start: ${JSON.stringify(state)}`);
      assert.equal(state.controlled, true, 'the shell was served by the worker');
      await unlock(a.page, library); await openNote(a.page, note);
      assert.equal(await visibleText(a.page), 'online initial');
      await fillNote(a.page, 'offline durable edit from the cached shell');
      await until(() => records(a.page, id), rows => rows.some(row => !before.has(row.batch.id) && row.receipt.durable && row.receipt.upload === 'pending'), 'offline durable outbox');
      assert.deepEqual(w.outside, []);
    } catch (error) { await w.diagnose(t, phase); throw error; }
  });
}

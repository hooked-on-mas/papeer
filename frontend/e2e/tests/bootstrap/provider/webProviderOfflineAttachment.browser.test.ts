import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { connect, createEnrolledLibrary, openNote, openWorld, stashRetainedRuntime, uiSnapshot, unlock, until, type Engine } from '../../../support/provider/offlineOrdinary.ts';

const attachmentName = 'reference.md', attachmentText = '# 添付\nExact attachment bytes; not the owner note.\n';
const stoppedStatus = '同期停止中（未送信の変更は保持されます）';
const view = (page: Page) => page.locator('[data-attachment-id]');
const syncButton = (page: Page) => view(page).getByRole('button', { name: '同期', exact: true });
const expandCatalog = async (page: Page) => {
  const toggle = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
};
async function attach(page: Page, owner: string) {
  await expandCatalog(page);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 25_000 }), page.getByRole('button', { name: `「${owner}」にファイルを添付`, exact: true }).click()]);
  await chooser.setFiles({ name: attachmentName, mimeType: 'text/markdown', buffer: Buffer.from(attachmentText) });
}
async function openAttachment(page: Page) {
  // A just-created attachment is opened by the product itself; otherwise open it from the catalog.
  const shown = await view(page).waitFor({ timeout: 5_000 }).then(() => true, () => false);
  if (!shown) { await expandCatalog(page); await page.getByRole('button', { name: attachmentName, exact: true }).click(); await view(page).waitFor(); }
  await until(() => view(page).locator('pre').textContent(), text => text === attachmentText, 'attachment text');
}
/**
 * Telling the click from the periodic passes. The view polls every 3 s (`startReplicationPolling`) and the host auto-flushes every 5 s (`providerReplication`), so a sync seen in a time
 * window may come from either. `quiesce` makes the click the only possible starter: it drops every new 3 s / 5 s timer (the callbacks scheduled before it fire during the 6 s drain
 * and, once their pass ends, cannot schedule another), waits for an idle sender, a painted enabled button and a finished view pass. Then `clickAndObserve` clicks once (optionally
 * suspending in the same task first, while the button is still enabled in the DOM) and watches `windowMs` (the same for every call), and puts the timers back.
 * The periodic chains do not come back: use these at the end of a page's life.
 */
const quiesce = (page: Page) => page.evaluate(async () => {
  const w = window as unknown as { __b9Runtime: { binding: { replication: { getSnapshot(): { running: boolean } } } }; __b9Timeout?: typeof window.setTimeout };
  const real = window.setTimeout; w.__b9Timeout = real;
  window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => timeout === 3000 || timeout === 5000 ? 0 : real.call(window, handler as () => void, timeout, ...args)) as typeof window.setTimeout;
  const sleep = (ms: number) => new Promise(resolve => real.call(window, resolve, ms));
  await sleep(6_000);
  const replication = w.__b9Runtime.binding.replication, button = () => [...document.querySelectorAll('[data-attachment-id] button')].find(node => node.textContent === '同期') as HTMLButtonElement;
  for (let waited = 0; (replication.getSnapshot().running || button().disabled) && waited < 10_000; waited += 20) await sleep(20);
  await sleep(1_000);
  return { running: replication.getSnapshot().running, disabled: button().disabled };
});
const clickAndObserve = (page: Page, stopFirst: boolean, windowMs: number, click = true) => page.evaluate(async ({ stopFirst, windowMs, click }) => {
  type Replication = { suspend(): void; getSnapshot(): { running: boolean; suspended: boolean }; subscribe(listener: () => void): () => void };
  const w = window as unknown as { __b9Runtime: { binding: { replication: Replication } }; __b9Timeout: typeof window.setTimeout };
  const replication = w.__b9Runtime.binding.replication, button = [...document.querySelectorAll('[data-attachment-id] button')].find(node => node.textContent === '同期') as HTMLButtonElement;
  const states: boolean[] = []; const stop = replication.subscribe(() => states.push(replication.getSnapshot().running));
  const enabledBefore = !button.disabled && !replication.getSnapshot().running;
  if (stopFirst) replication.suspend();
  if (click) button.click();
  await new Promise(resolve => w.__b9Timeout.call(window, resolve, windowMs)); stop();
  window.setTimeout = w.__b9Timeout;
  return { enabledBefore, suspended: replication.getSnapshot().suspended, everRunning: states.includes(true) };
}, { stopFirst, windowMs, click });
const observationWindow = 3_000;
const driveCalls = (w: { drive: { calls: Record<string, number> } }, client: string) => Object.entries(w.drive.calls).filter(([key]) => key.startsWith(`${client}:`)).reduce((sum, [, count]) => sum + count, 0);
const status = (page: Page, text: string) => view(page).getByRole('status').filter({ hasText: text });

for (const engine of ['chromium', 'webkit'] as const satisfies Engine[]) test(`an attachment shows its exact bytes, a click right after a stop starts no sync, and after reconnecting a click alone starts a sync (${engine})`, { timeout: 480_000 }, async t => {
  const w = await openWorld(t, engine, 'attachment'), profile = w.profile('a');
  const library = `Attachment Library ${engine}`, note = `Attachment owner ${engine}`; let phase = 'online-create';
  try {
    let a = await w.launch(profile, 'online', 'attachment-a');
    await createEnrolledLibrary(a.page, library, note, 'owner body');
    phase = 'attach'; await attach(a.page, note); await openAttachment(a.page);
    await status(a.page, '同期済み').waitFor();
    assert.equal(await syncButton(a.page).isDisabled(), false);
    const href = await a.page.getByRole('link', { name: '元のファイルをダウンロード', exact: true }).getAttribute('href'); assert.ok(href?.startsWith('blob:'));

    phase = 'control-click-without-stop'; assert.equal(await stashRetainedRuntime(a.page), true);
    t.diagnostic(`quiesced: ${JSON.stringify(await quiesce(a.page))}`);
    const controlCallsBefore = driveCalls(w, 'attachment-a');
    const control = await clickAndObserve(a.page, false, observationWindow); const controlCalls = driveCalls(w, 'attachment-a') - controlCallsBefore;
    t.diagnostic(`control, one click with the periodic timers dropped: ${JSON.stringify({ ...control, driveCalls: controlCalls })}`);
    assert.deepEqual(control, { enabledBefore: true, suspended: false, everRunning: true }, 'the click alone starts a sync');
    assert.ok(controlCalls > 0, 'and that sync talks to the Drive');
    await status(a.page, '同期済み').waitFor();
    // Negative control: with no click, nothing starts a sync in the same window (the periodic passes are gone), so the click above was the cause.
    phase = 'no-click-control'; assert.deepEqual(await clickAndObserve(a.page, false, observationWindow, false), { enabledBefore: true, suspended: false, everRunning: false });
    phase = 'stop-before-click';
    t.diagnostic(`quiesced again: ${JSON.stringify(await quiesce(a.page))}`);
    const stopCallsBefore = driveCalls(w, 'attachment-a');
    const race = await clickAndObserve(a.page, true, observationWindow);
    t.diagnostic(`click right after the stop: ${JSON.stringify(race)}`);
    assert.deepEqual(race, { enabledBefore: true, suspended: true, everRunning: false });
    assert.equal(driveCalls(w, 'attachment-a'), stopCallsBefore, 'no Drive request after the stop, from the click or from anything else');
    await status(a.page, stoppedStatus).waitFor(); assert.equal(await syncButton(a.page).isDisabled(), true);
    assert.equal(await view(a.page).locator('pre').textContent(), attachmentText, 'the displayed attachment is unchanged by the stop');
    await w.close(a.context);

    phase = 'cold-offline'; a = await w.launch(profile, 'offline', 'unused'); await unlock(a.page, library); await openNote(a.page, note);
    await openAttachment(a.page);
    assert.equal(await view(a.page).locator('pre').textContent(), attachmentText, 'the exact bytes from the device store');
    await status(a.page, stoppedStatus).waitFor(); assert.equal(await syncButton(a.page).isDisabled(), true);
    assert.equal(await view(a.page).getByRole('link', { name: '元のファイルをダウンロード', exact: true }).count(), 1);
    assert.deepEqual(w.outside, []); await w.close(a.context);

    phase = 'reconnect-sync'; a = await w.launch(profile, 'online', 'attachment-a-again'); await unlock(a.page, library); await openNote(a.page, note); await openAttachment(a.page);
    await status(a.page, stoppedStatus).waitFor();
    await a.page.getByRole('button', { name: 'Googleへ再接続', exact: true }).click(); await connect(a.page);
    await status(a.page, '同期済み').waitFor(); await until(async () => syncButton(a.page).isDisabled(), disabled => !disabled, 'sync button enabled');
    assert.equal(await stashRetainedRuntime(a.page), true);
    t.diagnostic(`quiesced after the reconnect: ${JSON.stringify(await quiesce(a.page))}`);
    const callsBefore = driveCalls(w, 'attachment-a-again');
    const afterReconnect = await clickAndObserve(a.page, false, observationWindow);
    t.diagnostic(`one click after the reconnect, periodic timers dropped: ${JSON.stringify(afterReconnect)}`);
    assert.deepEqual(afterReconnect, { enabledBefore: true, suspended: false, everRunning: true }, 'after reconnecting, the click alone starts a sync');
    assert.ok(driveCalls(w, 'attachment-a-again') > callsBefore, 'and it reached the Drive');
    assert.equal(await view(a.page).locator('pre').textContent(), attachmentText);
    t.diagnostic(`final state: ${JSON.stringify(await uiSnapshot(a.page))}`);
  } catch (error) { await w.diagnose(t, phase); throw error; }
});

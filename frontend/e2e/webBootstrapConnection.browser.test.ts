import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright-core';

for (const engine of ['chromium', 'webkit'] as const) test(`fake host: setup, retained empty shell and real catalog selection (${engine})`, { timeout: 60_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, '..');
  const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } });
  await server.listen(); t.after(() => server.close());
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  const browser = engine === 'chromium' ? await chromium.launch({ channel: 'msedge', headless: true }) : await webkit.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage();
  const pageErrors: string[] = [], unhandled: string[] = [];
  page.on('pageerror', error => { pageErrors.push(error.stack ?? String(error)); });
  await page.exposeFunction('bootstrapRecordUnhandled', (reason: string) => { unhandled.push(reason); });
  await page.addInitScript(() => {
    const target = window as unknown as { bootstrapUnhandled: string[]; bootstrapRecordUnhandled(reason: string): Promise<void> };
    target.bootstrapUnhandled = [];
    window.addEventListener('unhandledrejection', event => {
      const reason = String(event.reason); target.bootstrapUnhandled.push(reason); void target.bootstrapRecordUnhandled(reason);
    });
  });
  t.after(() => { if (pageErrors.length || unhandled.length) t.diagnostic(`browser errors: ${JSON.stringify({ pageErrors, unhandled })}`); });
  await page.goto(`http://localhost:${address.port}/e2e/fixtures/bootstrapConnection.html`);
  await page.getByRole('button', { name: 'この端末で使い始める' }).click();
  await page.getByLabel('新しいライブラリの名前').fill('家の本棚');
  await page.getByRole('button', { name: '作成', exact: true }).click();
  await page.getByRole('button', { name: '確認しました' }).click();
  await page.getByRole('button', { name: '家の本棚' }).click();
  await page.getByText('資料を選択してください。').waitFor();
  const title = page.getByLabel('新しい資料の名前');
  await title.fill('保持する下書き');
  await title.evaluate(element => { (window as unknown as { retainedInput: Element }).retainedInput = element; });
  const assertLocked = async () => {
    const evidence = await title.evaluate(element => {
      const container = element.closest<HTMLElement>('[inert]');
      (element as HTMLElement).focus();
      return { same: element === (window as unknown as { retainedInput: Element }).retainedInput,
        value: (element as HTMLInputElement).value, hidden: container?.hidden, inert: container?.inert,
        ariaHidden: container?.getAttribute('aria-hidden'), focused: document.activeElement === element };
    });
    assert.deepEqual(evidence, { same: true, value: '保持する下書き', hidden: true, inert: true, ariaHidden: 'true', focused: false });
    assert.equal(await title.isVisible(), false);
  };
  await page.getByRole('button', { name: 'ライブラリを切り替える' }).click();
  await page.getByText('入力を確定または取り消し、保存を確認してから切り替えてください。').waitFor();
  const beforeLoss = await page.evaluate(() => (window as unknown as { bootstrapFixtureEvidence(): { contextReads: number; inspections: number } }).bootstrapFixtureEvidence());
  await page.evaluate(() => (window as unknown as { bootstrapFixtureLose(): void }).bootstrapFixtureLose());
  await page.getByRole('button', { name: '再確認' }).waitFor();
  await assertLocked();
  const locked = await page.evaluate(() => (window as unknown as { bootstrapFixtureEvidence(): { contextReads: number; inspections: number } }).bootstrapFixtureEvidence());
  assert.equal(locked.contextReads, beforeLoss.contextReads); assert.equal(locked.inspections, beforeLoss.inspections);
  await page.getByRole('button', { name: '再確認' }).click();
  await title.waitFor(); assert.equal(await title.inputValue(), '保持する下書き');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await assertLocked();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await title.waitFor(); assert.equal(await title.inputValue(), '保持する下書き');
  // An unabortable old discovery must settle before a fresh lease and inspection.
  const before = await page.evaluate(() => (window as unknown as { bootstrapFixtureEvidence(): { contextReads: number; inspections: number } }).bootstrapFixtureEvidence());
  await page.evaluate(() => (window as unknown as { bootstrapFixtureBlock(): void }).bootstrapFixtureBlock());
  await page.waitForFunction(() => (window as unknown as { bootstrapFixtureEvidence(): { discoveryEntered: boolean } }).bootstrapFixtureEvidence().discoveryEntered);
  await page.evaluate(() => { window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })); window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
  await assertLocked();
  const whileBlocked = await page.evaluate(() => (window as unknown as { bootstrapFixtureEvidence(): { contextReads: number; inspections: number } }).bootstrapFixtureEvidence());
  assert.equal(whileBlocked.contextReads, before.contextReads); assert.equal(whileBlocked.inspections, before.inspections);
  await page.evaluate(() => (window as unknown as { bootstrapFixtureRelease(): void }).bootstrapFixtureRelease());
  await title.waitFor(); assert.equal(await title.inputValue(), '保持する下書き');
  assert.equal(await title.evaluate(element => element === (window as unknown as { retainedInput: Element }).retainedInput), true);
  const after = await page.evaluate(() => (window as unknown as { bootstrapFixtureEvidence(): { contextReads: number; inspections: number } }).bootstrapFixtureEvidence());
  assert.ok(after.contextReads > before.contextReads); assert.ok(after.inspections > before.inspections);
  await title.fill('メモ');
  await page.getByLabel('資料の種類').selectOption('markdown');
  await page.getByRole('button', { name: '資料を作成', exact: true }).click();
  await page.getByText('テスト Markdown').waitFor();
  const selected = await page.evaluate(() => (window as unknown as { bootstrapFixtureSession: { getActiveRuntime(): { navigation: { getSnapshot(): { documentId: string | null } } } | null } }).bootstrapFixtureSession.getActiveRuntime()?.navigation.getSnapshot().documentId);
  assert.match(selected ?? '', /^[0-9a-f-]{36}$/);
  const browserUnhandled = await page.evaluate(() => (window as unknown as { bootstrapUnhandled: string[] }).bootstrapUnhandled);
  assert.deepEqual({ pageErrors, unhandled: browserUnhandled }, { pageErrors: [], unhandled: [] });
});

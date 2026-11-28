import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright-core';

// Screen operations of the read-only Notebook preview on the real NativePreparationPanel (React StrictMode).
// The facade is scripted, so nothing here reaches a server. Real extraction and shutdown order are covered by the
// Python route tests (tests/providers/drive/test_native_notebook_preview.py) and the headless round under
// checkpoints/.../p6-notebook-preview-r153-r1. A client disconnect cancelling the server worker FAILED in the first
// headless round (BaseHTTPMiddleware hid it); it is covered by the in-process and real-uvicorn Python tests added
// with the fix, and its headless result is recorded in IMPL-r153-b3b.md. A real WebView2 abort is not verified.
type Fixture = {
  mount(setup: { status: Record<string, unknown>; preview: boolean }): Promise<void>;
  setModes(list: unknown, note: unknown): void; unmount(): void;
  snapshot(): { calls: string[]; aborted: number; lifecycle: { start: number; resume: number; abandon: number } };
};
declare global { interface Window { nativePreviewFixture: Fixture } }
const RUN = '11111111-1111-4111-8111-111111111111';
const captured = { state: 'captured', runId: RUN, scope: 'native-preparation-only' };
const cold = { state: 'recovery-required', phase: 'artifacts-verified', runId: RUN, scope: 'native-preparation-only' };
const REASON_TEXT: Record<string, string> = {
  'preview-busy': 'ほかのノートを確認しています。', 'preview-shutdown-pending': 'アプリを終了しています。', 'preview-cancelled': '確認を取り消しました。',
  'preview-capacity-exceeded': '保存データが確認できる上限を超えています。', 'preview-unavailable': 'このノートを確認できません。保存データは保持しています。',
};
const SUMMARY = '2ページ・手書き1件・付箋7件';

for (const engine of ['chromium', 'webkit'] as const) test(`native notebook preview screen operations (${engine})`, { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, '..');
  const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } });
  await server.listen(); t.after(() => server.close());
  const browser = engine === 'chromium' ? await chromium.launch({ channel: 'msedge', headless: true }) : await webkit.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/nativeNotebookPreview.html`);
  await page.waitForFunction(() => 'nativePreviewFixture' in window);
  const mount = (status: Record<string, unknown>, preview = true) => page.evaluate(setup => window.nativePreviewFixture.mount(setup), { status, preview });
  const modes = (list: unknown, note: unknown) => page.evaluate(([l, n]) => window.nativePreviewFixture.setModes(l, n), [list, note]);
  const snap = () => page.evaluate(() => window.nativePreviewFixture.snapshot());
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  const section = page.locator('section[aria-label="保存したノートの確認"]');
  const note = () => page.locator('li[aria-label="ノート 1"]');
  const showNote = () => note().getByRole('button', { name: /表示する|もう一度確認する/ });
  const openNote = async () => { await button('保存したノートを確認').click(); await note().waitFor(); };

  await t.test('shows a non-empty Notebook once under StrictMode, with no editor mounted', async () => {
    await mount(captured); await page.getByText('準備したデータを確認しました。移行はまだ完了していません。').waitFor();
    await openNote(); await showNote().click();
    await note().getByText(SUMMARY).waitFor();
    assert.equal(await note().locator('[aria-label^="ページ "]').count(), 2);
    assert.equal(await note().locator('[data-ink-id]').count(), 1);
    assert.ok(await note().locator('[data-sticky-id]').count() >= 1);
    assert.ok(await note().locator('[data-highlight-id]').count() >= 1);
    assert.equal(await page.locator('.cm-editor').count(), 0);
    const calls = (await snap()).calls;
    assert.equal(calls.filter(c => c === 'list').length, 1); assert.equal(calls.filter(c => c.startsWith('note:')).length, 1);
  });

  await t.test('while a note is being read the lifecycle buttons are disabled and cancel restores them', async () => {
    await mount(captured); await openNote();
    await modes('ok', 'hold'); await showNote().click();
    await page.getByRole('status').filter({ hasText: '保存データを確認しています…' }).first().waitFor();
    assert.equal(await button('保存したノートを確認').isDisabled(), true);
    assert.equal(await showNote().isDisabled(), true);
    assert.equal(await button('準備を中止する').isDisabled(), true);
    assert.equal(await button('確認を取り消す').isEnabled(), true);
    assert.equal(await button('準備を始める').count(), 0); assert.equal(await button('準備を続ける').count(), 0);
    assert.equal((await snap()).lifecycle.abandon, 0, 'a disabled abandon button never reaches the facade');
    await button('確認を取り消す').click();
    await note().getByText(REASON_TEXT['preview-cancelled']).waitFor();
    assert.ok((await snap()).aborted >= 1, 'the in-flight request was aborted');
    assert.equal(await button('保存したノートを確認').isEnabled(), true);
    assert.equal(await button('準備を中止する').isEnabled(), true);
    assert.equal(await button('確認を取り消す').count(), 0);
    await modes('ok', 'ok'); await showNote().click();
    await note().getByText(SUMMARY).waitFor();
  });

  await t.test('cancelling the list read shows the cancelled reason and allows a retry', async () => {
    await mount(captured); await modes('hold', 'ok');
    await button('保存したノートを確認').click();
    await button('確認を取り消す').click();
    await page.getByRole('alert').filter({ hasText: REASON_TEXT['preview-cancelled'] }).waitFor();
    await modes('ok', 'ok'); await openNote();
  });

  for (const [reason, text] of Object.entries(REASON_TEXT)) await t.test(`refusal ${reason} is shown for the list and for a note`, async () => {
    await mount(captured); await modes({ blocked: reason }, 'ok');
    await button('保存したノートを確認').click();
    await page.getByRole('alert').filter({ hasText: text }).waitFor();
    assert.equal(await note().count(), 0);
    assert.equal(await button('保存したノートを確認').isEnabled(), true);
    await modes('ok', { blocked: reason }); await openNote(); await showNote().click();
    await note().getByRole('alert').filter({ hasText: text }).waitFor();
    assert.equal(await note().locator('[aria-label^="ページ "]').count(), 0);
    assert.equal(await showNote().isEnabled(), true);
  });

  await t.test('a failed read shows the unavailable text without a reason code or detail', async () => {
    await mount(captured); await modes('ok', 'throw'); await openNote(); await showNote().click();
    await note().getByRole('alert').filter({ hasText: REASON_TEXT['preview-unavailable'] }).waitFor();
    assert.doesNotMatch(await section.innerText(), /fixture-failure|preview-/);
  });

  await t.test('unmounting during a read aborts it silently', async () => {
    await mount(captured); await openNote(); await modes('ok', 'hold'); await showNote().click();
    await button('確認を取り消す').waitFor();
    const before = (await snap()).aborted;
    await page.evaluate(() => window.nativePreviewFixture.unmount());
    await page.waitForFunction(count => window.nativePreviewFixture.snapshot().aborted > count, before);
    assert.equal(await section.count(), 0);
  });

  await t.test('the preview is offered only for a captured run or a cold artifacts-verified run, and only when the host provides it', async () => {
    await mount(cold); await section.waitFor();
    await mount({ ...cold, phase: 'partial' }); await page.getByText('前回の準備が中断されました。保存された状態を確認してください。').waitFor();
    assert.equal(await section.count(), 0);
    await mount({ state: 'running', runId: RUN, scope: 'native-preparation-only' }); await page.getByText('データを保全しています。完了までお待ちください。').waitFor();
    assert.equal(await section.count(), 0);
    await mount({ state: 'cancelled', phase: 'restart-complete', scope: 'native-preparation-only' }); await button('準備を始める').waitFor();
    assert.equal(await section.count(), 0);
    await mount(captured, false); await page.getByText('準備したデータを確認しました。移行はまだ完了していません。').waitFor();
    assert.equal(await section.count(), 0);
  });

  assert.deepEqual(errors, []);
});

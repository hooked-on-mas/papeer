import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openComposition } from './support/documentComposition.ts';

// Explicit scope fixture using the existing PC and Web mounts; this is not normal startup admission.
test('scope-only empty library creates and selects actual content on both mounts', { timeout: 300_000 }, async t => {
  const setup = await openComposition(t, 'chromium', undefined, { emptyScope: true });
  try {
    for (const page of setup.pages) {
      assert.equal(await page.getByText('資料を選択してください。', { exact: true }).count(), 1);
      const before = await page.evaluate(() => (window as unknown as { compositionNavigationEvidence(): { documentId: string | null; observedDocuments: string[]; observedMarkdown: string[] } }).compositionNavigationEvidence());
      assert.equal(before.documentId, null); assert.deepEqual(before.observedDocuments, []); assert.deepEqual(before.observedMarkdown, []);
      assert.equal(await page.locator('[data-pdf-scroller]').count(), 0);
    }
    for (const [index, page] of setup.pages.entries()) {
      await page.getByLabel('新しい資料の名前', { exact: true }).fill(index ? 'Web note' : 'PC note');
      const leave = await page.evaluate(() => (window as unknown as { compositionScopeLeave(): Promise<{ status: string }> }).compositionScopeLeave());
      assert.equal(leave.status, 'refused');
      await page.getByLabel('資料の種類', { exact: true }).selectOption(index ? 'markdown' : 'notebook');
      await page.getByRole('button', { name: '資料を作成', exact: true }).click();
      if (index) await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).waitFor();
      else await page.locator('[data-paper-page]').waitFor();
      const after = await page.evaluate(() => (window as unknown as { compositionNavigationEvidence(): { documentId: string | null; observedDocuments: string[]; observedMarkdown: string[] } }).compositionNavigationEvidence());
      assert.match(after.documentId ?? '', /^[0-9a-f]{8}-[0-9a-f-]{27}$/); assert.ok((index ? after.observedMarkdown : after.observedDocuments).includes(after.documentId!));
      await page.evaluate(() => (window as unknown as { compositionUnmount(): void }).compositionUnmount());
      await page.evaluate(() => (window as unknown as { compositionRemount(): Promise<void> }).compositionRemount());
      await page.waitForFunction(id => document.querySelector('[data-content-document]')?.getAttribute('data-content-document') === id, after.documentId);
      const remounted = await page.evaluate(() => (window as unknown as { compositionNavigationEvidence(): { documentId: string | null } }).compositionNavigationEvidence());
      assert.equal(remounted.documentId, after.documentId);
    }
  } finally { await setup.finish(); }
});

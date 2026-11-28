import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ordinaryWeb } from '../reader/p2/ordinaryWeb.ts';
import { assertOrdinaryMarkdownText, ordinaryMarkdown, ordinaryMarkdownSaved } from '../../support/ordinaryMarkdown.ts';

for (const engine of ['chromium', 'webkit'] as const) test(`ordinary Markdown autosave blur history failed commit retry and restart (${engine})`, { timeout: 240_000 }, async t => {
  const app = await ordinaryWeb(t, engine), page = app.page, title = `P3 Markdown lifecycle ${engine}`;
  let phase = 'create';
  try {
    await page.getByRole('button', { name: '新規', exact: true }).click();
    const createDialog = page.getByRole('dialog', { name: '新しい資料を作成', exact: true });
    await createDialog.getByLabel('新しい資料の名前', { exact: true }).fill(title);
    await createDialog.getByLabel('資料の種類', { exact: true }).selectOption('markdown');
    await createDialog.getByRole('button', { name: '資料を作成', exact: true }).click();
    await createDialog.waitFor({ state: 'hidden' });
    let editor = page.getByRole('textbox', { name: 'Markdownノート', exact: true }); await editor.waitFor();
    const id = await page.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(id);
    phase = 'focused-autosave';
    await editor.fill('自動保存の本文\n');
    const first = await ordinaryMarkdownSaved(page, id, '自動保存の本文\n', 1);
    assert.equal(await editor.evaluate(element => element.contains(document.activeElement)), true, 'autosave completes while the editor retains focus');
    phase = 'blur-and-history';
    await delay(650); // Separate an actual CodeMirror history group.
    await editor.press('Control+End'); await page.keyboard.insertText('追記\n'); await editor.blur();
    const secondText = '自動保存の本文\n追記\n';
    await ordinaryMarkdownSaved(page, id, secondText, 2);
    await page.getByRole('button', { name: '右側で編集', exact: true }).click();
    editor = page.getByRole('complementary', { name: '右側の編集', exact: true }).getByRole('textbox', { name: 'Markdownノート', exact: true });
    await editor.waitFor(); assert.equal(await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).count(), 1);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await ordinaryMarkdownSaved(page, id, '自動保存の本文\n', 3);
    await page.getByRole('button', { name: 'やり直す', exact: true }).click();
    await ordinaryMarkdownSaved(page, id, secondText, 4);
    phase = 'actual-commit-abort';
    await page.evaluate(({ namespace, id }) => {
      const probe = { enabled: true, failures: 0, batchIds: [] as string[], retryTrusted: [] as boolean[] };
      (globalThis as unknown as { markdownCommitProbe: typeof probe }).markdownCommitProbe = probe;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, key) {
        if (this.name === 'edits' && this.transaction.mode === 'readwrite' && value?.scope === namespace && value?.value?.batch?.targetId === id && probe.enabled) {
          probe.failures++; probe.batchIds.push(value.value.batch.id); this.transaction.abort();
          throw new DOMException('actual scoped Markdown edit transaction abort', 'AbortError');
        }
        return put.call(this, value, key);
      };
    }, { namespace: first.namespace, id });
    const failedText = secondText + '失敗中も保持\n';
    await editor.fill(failedText); await editor.blur();
    await page.getByRole('alert').filter({ hasText: '入力内容を保持しています' }).waitFor();
    const failed = await ordinaryMarkdown(page, id);
    assert.equal(failed.edits.length, 4); assert.equal(failed.intents.length, 1);
    await assertOrdinaryMarkdownText(editor, failedText);
    await page.getByRole('button', { name: '中央で編集', exact: true }).click();
    assert.equal(await page.getByRole('complementary', { name: '右側の編集', exact: true }).count(), 1);
    await assertOrdinaryMarkdownText(editor, failedText);
    const afterGuard = await ordinaryMarkdown(page, id); assert.deepEqual(afterGuard.intents, failed.intents);
    phase = 'same-id-retry';
    const guardAlert = page.getByRole('alert').filter({ hasText: '保存を確認してから編集面を移動してください。' });
    await guardAlert.waitFor();
    const retry = guardAlert.getByRole('button', { name: '再試行', exact: true });
    // Keep the real storage fault active through locator/action preparation. A scheduled
    // autosave must not succeed in the gap before the user's explicit retry click.
    await retry.evaluate(button => button.addEventListener('click', event => {
      const probe = (globalThis as unknown as { markdownCommitProbe: { enabled: boolean; retryTrusted: boolean[] } }).markdownCommitProbe;
      probe.retryTrusted.push(event.isTrusted); probe.enabled = false;
    }, { capture: true, once: true }));
    const probe = await page.evaluate(() => (globalThis as unknown as { markdownCommitProbe: {
      enabled: boolean; failures: number; batchIds: string[] } }).markdownCommitProbe);
    assert.ok(probe.failures >= 1); assert.equal(new Set(probe.batchIds).size, 1, 'all failed attempts use the retained batch ID');
    await retry.click();
    assert.deepEqual(await page.evaluate(() => (globalThis as unknown as { markdownCommitProbe: { retryTrusted: boolean[] } }).markdownCommitProbe.retryTrusted), [true]);
    const recovered = await ordinaryMarkdownSaved(page, id, failedText, 5);
    assert.ok(recovered.edits.some(edit => edit.batch.id === probe.batchIds[0]));
    phase = 'typing-after-recovery';
    const finalText = failedText + '保存後の追記\n'; await editor.fill(finalText); await editor.blur();
    const final = await ordinaryMarkdownSaved(page, id, finalText, 6);
    await page.getByRole('button', { name: '中央で編集', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).count(), 1);
    phase = 'cold-restart'; const reopened = await app.restart(title);
    assert.equal(await reopened.locator('[data-content-document]').getAttribute('data-content-document'), id);
    const restored = await ordinaryMarkdownSaved(reopened, id, finalText, 6); assert.deepEqual(restored, final);
    t.diagnostic(JSON.stringify({ engine, id, focusedAutosave: true, blurFlush: true, toolbarUndoRedoAcrossPlacement: true,
      failedBatchId: probe.batchIds[0], failureAttempts: probe.failures, sameIdRetry: true, durableOperations: 6, coldRestart: true }));
  } catch (error) { console.error(JSON.stringify({ phase, error: String(error), body: await page.locator('body').innerText().catch(String) })); throw error; }
});

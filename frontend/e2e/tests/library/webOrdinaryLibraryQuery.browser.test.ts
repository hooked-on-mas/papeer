import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ordinaryWeb } from '../reader/p2/ordinaryWeb.ts';
import { ordinaryMarkdownSaved } from '../../support/ordinaryMarkdown.ts';
import type { Page } from 'playwright-core';

async function results(page: Page, expected: string[]) {
  await page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('[role="tree"] [data-library-item]')]
    .map(row => row.getAttribute('data-library-item'))) === JSON.stringify(expected), expected);
}
for (const engine of ['chromium', 'webkit'] as const) test(`ordinary metadata and saved-content search conditions survive restart (${engine})`, { timeout: 210_000 }, async t => {
  const app = await ordinaryWeb(t, engine); let current = app.page, phase = 'create';
  try {
    const makeNote = async (title: string, content: string) => {
      const toggle = current.getByRole('button', { name: '資料一覧', exact: true });
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
      const contentRoot = current.locator('[data-content-document]');
      const previous = await contentRoot.count() ? await contentRoot.getAttribute('data-content-document') : null;
      await current.getByRole('button', { name: '新規', exact: true }).click();
      const createDialog = current.getByRole('dialog', { name: '新しい資料を作成', exact: true });
      await createDialog.getByLabel('新しい資料の名前', { exact: true }).fill(title);
      await createDialog.getByLabel('資料の種類', { exact: true }).selectOption('markdown');
      await createDialog.getByRole('button', { name: '資料を作成', exact: true }).click();
      await createDialog.waitFor({ state: 'hidden' });
      await current.getByRole('heading', { name: title, exact: true }).waitFor();
      await current.waitForFunction(previous => { const id = document.querySelector('[data-content-document]')?.getAttribute('data-content-document'); return !!id && id !== previous; }, previous);
      const editor = current.getByRole('textbox', { name: 'Markdownノート', exact: true }); await editor.waitFor();
      const id = await current.locator('[data-content-document]').getAttribute('data-content-document'); assert.ok(id);
      await editor.fill(content); await editor.blur();
      return { id, saved: await ordinaryMarkdownSaved(current, id, content, 1) };
    };
    const a = await makeNote(`Zeta ${engine}`, 'needle-one saved content\n');
    const b = await makeNote(`Alpha ${engine}`, 'other saved content\n');
    phase = 'content-versus-metadata';
    await current.getByLabel('資料の検索語', { exact: true }).fill('needle-one');
    await results(current, []);
    await current.getByRole('button', { name: '検索・並び替え条件', exact: true }).click();
    await current.getByLabel('資料の検索範囲', { exact: true }).selectOption('content');
    await current.getByLabel('資料の読書状態', { exact: true }).selectOption('unread');
    await current.getByLabel('資料の並び順', { exact: true }).selectOption('title');
    await current.getByLabel('資料を降順に表示', { exact: true }).check();
    await results(current, [a.id]);
    assert.deepEqual(await ordinaryMarkdownSaved(current, a.id, 'needle-one saved content\n', 1), a.saved);
    assert.deepEqual(await ordinaryMarkdownSaved(current, b.id, 'other saved content\n', 1), b.saved);
    phase = 'restart'; current = await app.restartLibrary({ showCatalog: false });
    assert.equal(await current.getByRole('button', { name: '資料一覧', exact: true }).getAttribute('aria-expanded'), 'true');
    assert.equal(await current.getByLabel('資料の検索語', { exact: true }).inputValue(), 'needle-one');
    assert.equal(await current.getByLabel('資料の検索範囲', { exact: true }).inputValue(), 'content');
    assert.equal(await current.getByLabel('資料の読書状態', { exact: true }).inputValue(), 'unread');
    assert.equal(await current.getByLabel('資料の並び順', { exact: true }).inputValue(), 'title');
    assert.equal(await current.getByLabel('資料を降順に表示', { exact: true }).isChecked(), true);
    await results(current, [a.id]);
    phase = 'sort-and-clear';
    await current.getByLabel('資料の検索語', { exact: true }).fill('');
    await results(current, [a.id, b.id]);
    await current.getByRole('button', { name: '表示条件を解除', exact: true }).click();
    assert.equal(await current.getByLabel('資料の検索範囲', { exact: true }).inputValue(), 'metadata');
    assert.equal(await current.getByLabel('資料の読書状態', { exact: true }).inputValue(), 'all');
    assert.equal(await current.getByLabel('資料を降順に表示', { exact: true }).isChecked(), false);
    assert.deepEqual(await ordinaryMarkdownSaved(current, a.id, 'needle-one saved content\n', 1), a.saved);
    assert.deepEqual(await ordinaryMarkdownSaved(current, b.id, 'other saved content\n', 1), b.saved);
    phase = 'corrupt-preference-fault';
    // Deliberately corrupt only this disposable UI preference. Grants, catalog and content are untouched.
    await current.evaluate(namespace => localStorage.setItem(`paper-desk.library-query.v1:${namespace}`, 'null'), a.saved.namespace);
    current = await app.restartLibrary({ showCatalog: false });
    await current.getByRole('alert').filter({ hasText: '検索条件を保存または復元できません' }).waitFor();
    await results(current, []);
    assert.equal(await current.evaluate(namespace => localStorage.getItem(`paper-desk.library-query.v1:${namespace}`), a.saved.namespace), 'null');
    await current.getByRole('button', { name: '検索・並び替え条件', exact: true }).click();
    await current.getByRole('button', { name: '表示条件を解除', exact: true }).click();
    await results(current, [a.id, b.id]);
    assert.deepEqual(await ordinaryMarkdownSaved(current, a.id, 'needle-one saved content\n', 1), a.saved);
    assert.deepEqual(await ordinaryMarkdownSaved(current, b.id, 'other saved content\n', 1), b.saved);
    t.diagnostic(JSON.stringify({ engine, ids: [a.id, b.id], scope: 'saved Markdown content and metadata', restoredConditions: true,
      corruptPreferenceFault: 'literal JSON null', noAutomaticRewrite: true, explicitClearRecovers: true, exactContentUnchanged: true }));
  } catch (error) { console.error(JSON.stringify({ phase, error: String(error), body: await current.locator('body').innerText().catch(String) })); throw error; }
});

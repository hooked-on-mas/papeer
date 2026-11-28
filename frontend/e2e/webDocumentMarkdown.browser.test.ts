import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { ContentPublication } from '../src/runtime/edits/contracts.ts';
import { openComposition, markdownEvidence, markdownSync, readLegacyDraftEvidence, type MarkdownDiagnostics } from './support/documentComposition.ts';

function seed(publication: ContentPublication) {
  assert.ok(publication.content);
  publication.content = { kind: 'markdown', id: publication.content.id, version: publication.content.version,
    content: '# Canonical Markdown\n\nInitial durable body', appendIds: [], imageResources: [] };
  const item = publication.libraryBatch.changes.find(change => change.type === 'put-item'); assert.ok(item?.type === 'put-item');
  item.item.kind = 'markdown'; delete item.item.resourceId;
}
const editor = (page: Page) => page.getByRole('textbox', { name: 'Markdownノート', exact: true });
const editorText = (page: Page) => editor(page).evaluate(element => [...element.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'));
async function clean(page: Page, content?: string) {
  await page.waitForFunction(content => {
    const state = (window as unknown as { compositionMarkdownDiagnostics(): MarkdownDiagnostics }).compositionMarkdownDiagnostics().session;
    return state.ready && !state.dirty && !state.saving && state.durable && !state.editingBlocked
      && (content === undefined || state.content === content && state.accepted?.content === content);
  }, content);
}
async function fillAndSave(page: Page, content: string) {
  await editor(page).fill(content); await page.getByRole('heading', { name: 'Canonical Markdown composition', exact: true }).click();
  await clean(page, content);
}
async function converge(from: Page, to: Page) {
  await markdownSync(from); await markdownSync(to);
  assert.deepEqual((await markdownEvidence(to)).session.accepted, (await markdownEvidence(from)).session.accepted);
}
async function quota(page: Page, fail: boolean) {
  await page.evaluate(fail => (window as unknown as { compositionScratchQuota(fail: boolean): void }).compositionScratchQuota(fail), fail);
}

for (const engine of ['chromium', 'webkit'] as const) test(`production canonical Markdown body, flights, local scratch, history and one-editor placement (${engine})`, { timeout: 600_000 }, async t => {
  const { native, web, pages, reload, finish, holdNextCommitReply, loseNextCommitReply, committed, repository, documentId } = await openComposition(t, engine, seed);
  try {
    for (const [index, page] of pages.entries()) {
      t.diagnostic(`${index ? 'Web' : 'Native'} Markdown authoring, preview, durable history and placement`);
      const before = (await markdownEvidence(page)).session.content;
      const text = `# ${index ? 'Web' : 'PC'} Markdown\n\nSelection target`;
      await fillAndSave(page, text);
      await page.getByRole('button', { name: 'プレビュー', exact: true }).click();
      await page.getByRole('heading', { name: `${index ? 'Web' : 'PC'} Markdown`, exact: true }).waitFor();
      assert.equal(await editor(page).count(), 0);
      await page.getByRole('button', { name: '編集', exact: true }).click(); assert.equal(await editorText(page), text);
      await page.getByRole('button', { name: '元に戻す', exact: true }).click(); await clean(page, before);
      await page.getByRole('button', { name: 'やり直す', exact: true }).click(); await clean(page, text);

      const draft = text + '\nHeld selection';
      await editor(page).fill(draft); await editor(page).press('Control+End'); await editor(page).press('Shift+Home');
      assert.equal(await page.evaluate(() => window.getSelection()?.toString()), 'Held selection');
      await page.getByRole('button', { name: '右側で編集', exact: true }).click();
      console.error('Markdown placement after click', await page.evaluate(() => ({
        placement: document.querySelector('[data-editor-placement]')?.getAttribute('data-editor-placement'),
        alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent),
        buttons: [...document.querySelectorAll('[role="toolbar"] button')].map(node => ({ text: node.textContent, disabled: (node as HTMLButtonElement).disabled })),
      })), (await markdownEvidence(page)).session);
      await page.locator('[data-editor-placement="right"]').waitFor(); await clean(page, draft);
      assert.equal(await editor(page).count(), 1); assert.equal(await editorText(page), draft);
      assert.equal(await page.locator('[aria-label="参照表示"]').getByRole('textbox').count(), 0);
      assert.equal(await page.evaluate(() => window.getSelection()?.toString()), 'Held selection', 'CodeMirror selection survives placement remount');
      const version = (await markdownEvidence(page)).session.accepted!.version;
      await page.getByRole('button', { name: '中央で編集', exact: true }).click();
      await page.locator('[data-editor-placement="center"]').waitFor();
      assert.equal((await markdownEvidence(page)).session.accepted!.version, version, 'clean placement does not create history');
      await converge(page, pages[1 - index]);
      const remote = pages[1 - index]; await editor(remote).press('Control+z');
      assert.equal(await editorText(remote), draft, 'remote adoption is not added to the local CodeMirror Undo stack');
      assert.equal((await markdownEvidence(remote)).session.content, draft);
    }

    t.diagnostic('Native commit response held while subsequent input remains editable');
    const gate = holdNextCommitReply();
    await editor(native).fill('First dispatched Markdown body');
    await native.getByRole('heading', { name: 'Canonical Markdown composition', exact: true }).click();
    const firstId = await gate.received;
    assert.equal((await markdownEvidence(native)).session.saving, true);
    assert.equal(await editor(native).isEditable(), true);
    const later = 'First dispatched Markdown body\nAdditional input during the flight';
    await editor(native).fill(later);
    assert.equal((await markdownEvidence(native)).session.content, later);
    gate.release(); await clean(native, later);
    const flightState = await repository.read(documentId);
    const firstBatch = flightState.checkpoint.batches.find(batch => batch.id === firstId);
    assert.ok(firstBatch?.kind === 'markdown'); assert.equal(firstBatch.content, 'First dispatched Markdown body');
    assert.equal(committed.filter(id => id === firstId).length, 1);
    assert.notEqual((await markdownEvidence(native)).session.accepted!.version, firstId, 'later input uses its own durable descendant');
    await converge(native, web);

    t.diagnostic('Native durable response loss retries the exact Markdown operation');
    loseNextCommitReply();
    const lostText = 'Markdown response loss retains this body';
    await editor(native).fill(lostText);
    await native.getByRole('button', { name: '再試行', exact: true }).waitFor();
    const lostId = committed[committed.length - 1]; assert.ok(await repository.readIntent(documentId));
    assert.equal(await editorText(native), lostText);
    await native.getByRole('button', { name: '再試行', exact: true }).click(); await clean(native, lostText);
    assert.equal(committed.filter(id => id === lostId).length, 2);
    assert.equal((await repository.read(documentId)).checkpoint.batches.filter(batch => batch.id === lostId).length, 1);
    await converge(native, web);

    t.diagnostic('Web scratch quota retains body through refused placement and actual root remount');
    const beforeQuota = await markdownEvidence(web), held = 'Unsaved quota body\nDo not discard this draft';
    await quota(web, true); await editor(web).fill(held);
    await web.getByRole('heading', { name: 'Canonical Markdown composition', exact: true }).click();
    await web.getByRole('button', { name: '再試行', exact: true }).waitFor();
    assert.equal((await markdownEvidence(web)).session.dirty, true);
    assert.equal((await markdownEvidence(web)).leave.status, 'refused');
    await web.getByRole('button', { name: '右側で編集', exact: true }).click();
    assert.equal(await web.locator('[data-editor-placement="center"]').count(), 1);
    assert.equal((await markdownEvidence(web)).state.history.length, beforeQuota.state.history.length);
    await web.evaluate(() => (window as unknown as { compositionUnmount(): void }).compositionUnmount());
    await web.evaluate(() => (window as unknown as { compositionRemount(): Promise<void> }).compositionRemount());
    await editor(web).waitFor(); assert.equal(await editorText(web), held);
    assert.equal((await markdownEvidence(web)).leave.status, 'refused');
    // Keep the fault armed through focus/blur; release it at the actual trusted retry click.
    // Capture runs before the product click handler and does not invoke that handler itself.
    const retryButton = web.getByRole('button', { name: '再試行', exact: true });
    await retryButton.evaluate(button => {
      const current = window as unknown as { compositionScratchQuota(fail: boolean): void; __quotaRetryCapture?: { fired: boolean; dispose(): void } };
      const capture = (event: MouseEvent) => {
        const target = event.target instanceof Element ? event.target.closest('button') : null;
        if (!event.isTrusted || !target || target !== button || !target.closest('[role="alert"]')) return;
        current.__quotaRetryCapture!.fired = true;
        current.compositionScratchQuota(false);
        document.removeEventListener('click', capture, true);
      };
      current.__quotaRetryCapture = { fired: false, dispose: () => document.removeEventListener('click', capture, true) };
      document.addEventListener('click', capture, true);
    });
    let retryFailed = false;
    try {
      await web.getByRole('button', { name: '再試行', exact: true }).click();
      assert.equal(await web.evaluate(() => (window as unknown as { __quotaRetryCapture?: { fired: boolean } }).__quotaRetryCapture?.fired), true,
        'scratch quota is released only by the trusted retry click');
      await clean(web, held);
    } catch (error) { retryFailed = true; throw error; }
    finally {
      try { await web.evaluate(() => { const current = window as unknown as { compositionScratchQuota(fail: boolean): void; __quotaRetryCapture?: { dispose(): void } };
        current.__quotaRetryCapture?.dispose(); delete current.__quotaRetryCapture; current.compositionScratchQuota(false); }); }
      catch (cleanupError) { if (!retryFailed) throw cleanupError; t.diagnostic(`Retry cleanup error: ${String(cleanupError)}`); }
    }
    await converge(web, native);

    for (const page of pages) {
      await reload(page); await editor(page).waitFor(); await clean(page, held);
      assert.equal(await editorText(page), held);
      assert.equal((await markdownEvidence(page)).leave.status, 'allowed', 'no phantom unready DocumentSession blocks the Markdown scope');
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
    await web.getByRole('button', { name: '元に戻す', exact: true }).click(); await clean(web, lostText);
    await web.getByRole('button', { name: 'やり直す', exact: true }).click(); await clean(web, held);
    await converge(web, native);
    for (const page of pages) assert.equal((await markdownEvidence(page)).leave.status, 'allowed');

    t.diagnostic('External sibling publications require explicit head selection after a fresh registry');
    const baseVersion = (await markdownEvidence(native)).session.accepted!.version;
    const siblings = ['External Markdown branch A', 'External Markdown branch B'].map(content => ({
      kind: 'markdown' as const, id: crypto.randomUUID(), libraryId: repository.scope.libraryId,
      targetId: documentId, parents: [baseVersion], content, imageResources: [],
    }));
    // External peer arrival uses the real repository; no local editor/session mutation or history injection.
    for (const batch of siblings) assert.equal((await repository.commit(batch)).status, 'durable');
    await markdownSync(native); await markdownSync(web);
    for (const [index, page] of pages.entries()) {
      await reload(page);
      const choices = page.getByRole('combobox', { name: '確認する版', exact: true });
      await choices.waitFor();
      assert.equal(await choices.inputValue(), '');
      assert.equal(await editor(page).count(), 0, 'an ambiguous initial head must not mount a writer');
      const unselected = await markdownEvidence(page);
      assert.equal(unselected.session.ready, false);
      assert.equal(unselected.session.accepted, null);
      assert.deepEqual([...unselected.state.heads].sort(), siblings.map(batch => batch.id).sort());
      await choices.selectOption(siblings[index].id);
      await editor(page).waitFor(); await clean(page, siblings[index].content);
      assert.equal(await editorText(page), siblings[index].content);
      const selected = await markdownEvidence(page);
      assert.equal(selected.session.accepted!.version, siblings[index].id);
      assert.deepEqual([...selected.state.heads].sort(), siblings.map(batch => batch.id).sort());
      for (const sibling of siblings) {
        assert.deepEqual(selected.state.checkpoint.batches.find(batch => batch.id === sibling.id), sibling);
        assert.equal(selected.state.history.some(record => record.operationId === sibling.id), false);
      }
      assert.equal(selected.leave.status, 'allowed');
    }
    await finish();
  } catch (error) {
    t.diagnostic(`Markdown composition failure stack: ${error instanceof Error ? error.stack : String(error)}`);
    for (const page of pages) console.error('Markdown composition failure', page.url(), await markdownEvidence(page).catch(String));
    throw error;
  }
});

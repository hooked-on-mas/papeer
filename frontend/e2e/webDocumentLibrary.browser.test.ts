import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ElementHandle, Page } from 'playwright-core';
import type { LibrarySessionState } from '../src/features/library/LibrarySession.ts';
import type { MarkdownEditState } from '../src/features/notes/markdown/MarkdownEditSession.ts';
import type { DocumentEditState } from '../src/features/reader/edit/DocumentEditSession.ts';
import type { RepositoryState } from '../src/runtime/edits/ports.ts';
import { openComposition, sync } from './support/documentComposition.ts';
import { waitForSnapshot as until } from './support/waitForSnapshot.ts';

type Catalog = { state: RepositoryState; session?: LibrarySessionState; pending: unknown[]; replication: { running: boolean } };
type Content = { state: RepositoryState; markdown?: MarkdownEditState; document?: DocumentEditState };
const catalog = (page: Page): Promise<Catalog> => page.evaluate(() => (window as unknown as {
  compositionLibraryEvidence(): Promise<Catalog>;
}).compositionLibraryEvidence());
const content = (page: Page, id: string): Promise<Content> => page.evaluate(id => (window as unknown as {
  compositionObservedEvidence(id: string): Promise<Content>;
}).compositionObservedEvidence(id), id);
async function expand(page: Page) {
  const button = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
  await page.getByRole('region', { name: '資料一覧', exact: true }).waitFor();
}
async function openItem(page: Page, title: string, id: string) {
  await expand(page);
  await page.getByRole('region', { name: '資料一覧', exact: true }).getByRole('button', { name: title, exact: true }).click();
  await page.locator(`[data-content-document="${id}"]`).waitFor();
}
async function synchronize(page: Page) {
  await sync(page);
  await until(() => catalog(page), value => !value.replication.running && value.pending.length === 0 && !!value.session?.ready && !value.session.busy);
}
type CreateFormObservation = { title: string | null; kind: string | null; submitDisabled: boolean | null;
  inputConnected: boolean; preparedInputConnected: boolean; inputIsPrepared: boolean; inputFocused: boolean;
  inputDisabled: boolean | null; visible: boolean; url: string };
const preparedFormInputs = new WeakMap<Page, ElementHandle<HTMLElement | SVGElement>>();
const createFormObservation = (page: Page): Promise<CreateFormObservation> => page.evaluate(prepared => {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="\u65b0\u3057\u3044\u8cc7\u6599\u306e\u540d\u524d"]');
  const kind = document.querySelector<HTMLSelectElement>('select[aria-label="\u8cc7\u6599\u306e\u7a2e\u985e"]');
  const submit = input?.form?.querySelector<HTMLButtonElement>('button[type="submit"]') ?? null;
  return { title: input?.value ?? null, kind: kind?.value ?? null, submitDisabled: submit?.disabled ?? null,
    inputConnected: !!input?.isConnected, preparedInputConnected: !!prepared?.isConnected,
    inputIsPrepared: !!input && input === prepared, inputFocused: !!input && document.activeElement === input,
    inputDisabled: input?.disabled ?? null, visible: !!input?.getClientRects().length, url: location.href };
}, preparedFormInputs.get(page) ?? null);
async function form(page: Page, title: string, kind: 'markdown' | 'notebook') {
  await expand(page);
  await page.getByLabel('資料の種類', { exact: true }).selectOption(kind);
  const input = page.getByLabel("\u65b0\u3057\u3044\u8cc7\u6599\u306e\u540d\u524d", { exact: true });
  const prepared = await input.elementHandle();
  if (!prepared) throw new Error('genuine-library-create-input-required');
  preparedFormInputs.set(page, prepared);
  await input.fill(title);
  await until(() => createFormObservation(page), value => value.title === title && value.kind === kind && value.submitDisabled === false);
}

for (const engine of ['chromium', 'webkit'] as const) test(`production library creation, publication recovery and catalog reopening (${engine})`, { timeout: 600_000 }, async t => {
  const fixture = await openComposition(t, engine);
  const { native, web, pages, repository, documentId, reload, finish, published, publishedPayloads, setPublishReplyLoss } = fixture;
  const created: { id: string; title: string; kind: 'markdown' | 'notebook'; body?: string }[] = [];
  try {
    for (const [index, page] of pages.entries()) {
      const peer = page === native ? web : native;
      for (const kind of ['markdown', 'notebook'] as const) {
        const title = `${index ? 'Web' : 'Native'} created ${kind}`;
        const blockedSource = page === web && kind === 'notebook' ? created.find(entry => entry.title === 'Web created markdown') : undefined;
        if (blockedSource) {
          blockedSource.body += '\n\nDraft retained while a new notebook is created.';
          await page.evaluate(() => (window as unknown as { compositionScratchQuota(fail: boolean): void }).compositionScratchQuota(true));
          await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).fill(blockedSource.body!);
        }
        await form(page, title, kind);
        const lost = page === native && kind === 'markdown';
        const publishStart = published.length;
        if (lost) setPublishReplyLoss(true);
        await page.getByRole('button', { name: '資料を作成', exact: true }).click();
        let pendingId: string | null = null;
        if (lost) {
          await page.getByRole('button', { name: '作成を再試行', exact: true }).waitFor();
          const failed = await until(() => catalog(page), value => !!value.session?.pendingId && !value.session.busy && !!value.session.error);
          pendingId = failed.session!.pendingId;
          assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), documentId);
          assert.ok(await repository.readIntent(repository.scope.libraryId), 'publication intent is durable before reload');
          await reload(page); // Original host binding, not a fixture-provided newly created target.
          await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();
          await page.getByRole('button', { name: '読む', exact: true }).waitFor();
          await until(() => content(page, documentId), value => value.document?.ready === true && value.document.phase === 'idle');
          await expand(page);
          const recovered = await until(() => catalog(page), value => value.session?.pendingId === pendingId && !value.session.busy);
          assert.equal(recovered.session!.pendingId, pendingId);
          setPublishReplyLoss(false);
          await page.getByRole('button', { name: '作成を再試行', exact: true }).click();
        }
        const result = await until(() => catalog(page), value => !!value.session?.createdId && !value.session.pendingId && !value.session.busy
          && value.session.items.some(item => item.id === value.session!.createdId && item.title === title));
        const id = result.session!.createdId!;
        assert.equal(result.session!.items.filter(item => item.title === title).length, 1);
        if (blockedSource) {
          await page.getByRole('alert').filter({ hasText: '入力を確定または取り消し' }).waitFor();
          assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), blockedSource.id);
          assert.equal((await content(page, blockedSource.id)).markdown!.content, blockedSource.body);
          await page.getByRole('button', { name: '作成した資料を開く', exact: true }).waitFor();
          // Clear the storage fault and invoke the real retry handler in one event task.
          await page.evaluate(() => {
            (window as unknown as { compositionScratchQuota(fail: boolean): void }).compositionScratchQuota(false);
            const retry = [...document.querySelectorAll('button')].find(button => button.textContent === '再試行');
            if (!retry) throw new Error('actual Markdown retry button required'); retry.click();
          });
          await until(() => content(page, blockedSource.id), value => !!value.markdown?.durable && !value.markdown.dirty && !value.markdown.saving
            && value.markdown.accepted?.content === blockedSource.body);
          await page.getByRole('button', { name: '作成した資料を開く', exact: true }).click();
        }
        await page.locator(`[data-content-document="${id}"]`).waitFor();
        if (lost) {
          const attempts = published.slice(publishStart);
          assert.ok(attempts.length >= 2); assert.deepEqual([...new Set(attempts)], [pendingId]);
          const payloads = publishedPayloads.slice(publishStart).map(value => JSON.parse(value));
          for (const payload of payloads) assert.deepEqual(payload, payloads[0], 'all retries preserve every publication field and array order');
          assert.equal(result.state.checkpoint.batches.filter(batch => batch.id === pendingId).length, 1);
          assert.equal(await repository.readIntent(repository.scope.libraryId), undefined);
        }
        const entry = { id, title, kind, body: kind === 'markdown' ? `# ${title}\n\nDurable content from the production catalog.` : undefined };
        created.push(entry);
        if (entry.body) {
          await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).fill(entry.body);
          await page.getByRole('button', { name: '資料一覧', exact: true }).click();
          await until(() => content(page, id), value => !!value.markdown?.durable && !value.markdown.dirty && !value.markdown.saving
            && value.markdown.content === entry.body && value.markdown.accepted?.content === entry.body);
          if (await page.getByRole('button', { name: '資料一覧', exact: true }).getAttribute('aria-expanded') === 'true')
            await page.getByRole('button', { name: '資料一覧', exact: true }).click();
        } else {
          await page.getByRole('button', { name: 'ペン', exact: true }).click();
          const layer = page.getByLabel('ノート書き込みレイヤー', { exact: true }); const box = await layer.boundingBox(); assert.ok(box);
          await page.mouse.move(box.x + box.width * .2, box.y + box.height * .3); await page.mouse.down();
          await page.mouse.move(box.x + box.width * .6, box.y + box.height * .4, { steps: 12 }); await page.mouse.up();
          await until(() => content(page, id), value => value.document?.phase === 'idle' && value.document.document?.pages[0].annotations.length === 1);
        }
        await synchronize(page); await synchronize(peer);
        await until(() => catalog(peer), value => !!value.session?.items.some(item => item.id === id && item.title === title));
        await openItem(peer, title, id);
        await until(() => content(peer, id), value => kind === 'markdown' ? value.markdown?.accepted?.content === entry.body
          : value.document?.document?.pages[0].annotations.length === 1);
        assert.deepEqual((await content(peer, id)).state.checkpoint, (await content(page, id)).state.checkpoint);
        if (kind === 'notebook') {
          const previous = created.find(entry => entry.title === `${index ? 'Web' : 'Native'} created markdown`)!;
          await page.getByRole('button', { name: '前の資料に戻る', exact: true }).click();
          await page.locator(`[data-content-document="${previous.id}"]`).waitFor();
          await until(() => content(page, previous.id), value => value.markdown?.accepted?.content === previous.body);
          await expand(page);
          await page.getByRole('button', { name: '作成した資料を開く', exact: true }).waitFor();
          assert.equal((await catalog(page)).session!.createdId, id, 'created-item status survives history navigation');
          await openItem(page, title, id);
        }
      }
    }
    for (const page of pages) {
      await reload(page);
      await page.locator(`[data-content-document="${documentId}"]`).waitFor();
      await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();
      await page.getByRole('button', { name: '読む', exact: true }).waitFor();
      await until(() => content(page, documentId), value => value.document?.ready === true && value.document.phase === 'idle');
      for (const entry of created) {
        await openItem(page, entry.title, entry.id);
        await until(() => content(page, entry.id), value => entry.kind === 'markdown' ? value.markdown?.accepted?.content === entry.body
          : value.document?.document?.pages[0].annotations.length === 1);
      }
      const final = await catalog(page);
      assert.deepEqual(final.session!.items.map(item => item.id).sort(), [documentId, ...created.map(item => item.id)].sort());
      assert.equal(final.session!.pendingId, null);
    }
    assert.deepEqual((await catalog(native)).state.checkpoint, (await catalog(web)).state.checkpoint);
    await finish();
  } catch (error) {
    console.error('library failure error', error);
    console.error('publication attempts', JSON.stringify({ published, publishedPayloads }));
    for (const page of pages) {
      let formTimer: ReturnType<typeof setTimeout> | undefined;
      const form = await Promise.race([createFormObservation(page), new Promise<never>((_, reject) => {
        formTimer = setTimeout(() => reject(new Error('library form diagnostic timeout')), 2_000);
      })]).finally(() => { if (formTimer !== undefined) clearTimeout(formTimer); }).catch(String);
      console.error('library form', JSON.stringify(form));
      console.error('library failure', page.url(), JSON.stringify(await catalog(page).catch(String)));
      console.error('library screen', JSON.stringify(await page.evaluate(() => ({
        navigation: (window as unknown as { compositionNavigationEvidence(): unknown }).compositionNavigationEvidence(),
        alerts: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent),
        statuses: [...document.querySelectorAll('[role="status"]')].map(element => element.textContent),
        buttons: [...document.querySelectorAll('button')].map(element => ({ text: element.textContent, disabled: element.disabled })),
      })).catch(String)));
    }
    throw error;
  }
});

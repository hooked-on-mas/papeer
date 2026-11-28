import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { ContentPublication, DocumentSnapshot, ResourceMetadata, StickyNote, TextHighlight } from '../src/runtime/edits/contracts.ts';
import type { RepositoryState } from '../src/runtime/edits/ports.ts';
import type { MarkdownEditState } from '../src/features/notes/markdown/MarkdownEditSession.ts';
import { EditGraph } from '../src/runtime/edits/editGraph.ts';
import { freezeAnnotationExport, filterCanonicalAnnotations, projectCanonicalAnnotations } from '../src/features/library/annotations/canonicalAnnotationBrowser.ts';
import { openComposition, sync as deliver } from './support/documentComposition.ts';
import { waitForSnapshot } from './support/waitForSnapshot.ts';

const metadata = (JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8')) as {
  resource: { metadata: ResourceMetadata };
}).resource.metadata;
type Observed = { state: RepositoryState; markdown?: MarkdownEditState; pending: unknown[]; replication: { running: boolean } };
const observe = async (page: Page, id: string) => {
  await page.waitForFunction(() => typeof (window as unknown as { compositionObservedEvidence?: unknown }).compositionObservedEvidence === 'function');
  return page.evaluate(id => (window as unknown as {
  compositionObservedEvidence(id: string): Promise<Observed>;
  }).compositionObservedEvidence(id), id);
};
const panel = (page: Page) => page.getByRole('region', { name: '付箋・ハイライト一覧', exact: true });
const dialog = (page: Page) => page.getByRole('dialog', { name: '引用をノートへ追加', exact: true });
async function expand(page: Page) {
  const toggle = panel(page).getByRole('button', { name: /^付箋・ハイライト一覧/ });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}
async function count(page: Page, total: number) {
  await waitForSnapshot(async () => ({ rows: await panel(page).locator('li').count(), status: await panel(page).getByRole('status').first().innerText() }),
    value => value.rows === total && value.status.trim() === `${total}件`);
}
async function openItem(page: Page, title: string, id: string) {
  const toggle = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.getByRole('button', { name: title, exact: true }).click();
  await page.locator(`[data-content-document="${id}"]`).waitFor();
}
async function durable(page: Page, id: string, content: string) {
  return waitForSnapshot(() => observe(page, id), value => value.markdown?.content === content
    && value.markdown.accepted?.content === content && !value.markdown.dirty && value.markdown.durable && !value.markdown.saving);
}
async function sync(page: Page, id: string, content: string) {
  await durable(page, id, content);
  await page.getByRole('button', { name: '同期', exact: true }).click();
  await deliver(page);
  await waitForSnapshot(() => observe(page, id), value => value.markdown?.accepted?.content === content
    && !value.markdown.dirty && value.markdown.durable && !value.replication.running && value.pending.length === 0);
}
const sticky = (text: string, createdAt: string | null, label = 'keep'): StickyNote => ({ kind: 'sticky', id: crypto.randomUUID(),
  text, quote: 'selected quotation', anchor: { x: 100, y: 180 }, color: null, metadata: { label, createdAt } });

for (const engine of ['chromium', 'webkit'] as const) test(`production annotation browser fixed export, translated landing and durable recovery (${engine})`, { timeout: 360_000 }, async t => {
  const notes: string[] = [], sources: { libraryId: string; title: string; document: DocumentSnapshot }[] = [];
  let translatedId = '', translatedRevision = '', sourceTitle = '', suffix = '';
  const seed = (publication: ContentPublication) => {
    assert.ok(publication.content?.kind === 'document');
    const document = publication.content, template = document.pages[0]; assert.ok(template.background.kind === 'pdf');
    document.pages = Array.from({ length: 3 }, () => ({ ...structuredClone(template), id: crypto.randomUUID(), annotations: [] }));
    document.pages[0].annotations = [sticky('ＡＢＣ alpha first', '2026-10-26T00:00:00.000001Z')];
    const highlight: TextHighlight = { kind: 'highlight', id: crypto.randomUUID(), backgroundRevision: document.pages[1].backgroundRevision,
      range: { kind: 'unindexed' }, quote: 'ABC alpha highlighted', text: 'highlight body', color: '#ffff00', anchor: { x: 100, y: 180 },
      quads: [[{ x: 100, y: 180 }, { x: 180, y: 180 }, { x: 180, y: 195 }, { x: 100, y: 195 }]],
      metadata: { label: 'keep', createdAt: '2026-10-26T00:00:00.000002Z' } };
    document.pages[1].annotations = [highlight];
    const translated = [2, 3].map(pdfPage => ({ ...structuredClone(template), ...metadata.pdfPages![pdfPage - 1], id: crypto.randomUUID(),
      background: { ...template.background, pdfPage }, annotations: [sticky(pdfPage === 2 ? 'ABC alpha translated' : 'orphan translation', null, pdfPage === 2 ? 'keep' : 'orphan')] }));
    translatedId = translated[0].id; translatedRevision = translated[0].backgroundRevision;
    document.translation = { revision: crypto.randomUUID(), pages: translated, bindings: [{
      original: { pageId: document.pages[2].id, backgroundRevision: document.pages[2].backgroundRevision },
      candidates: [{ pageId: translatedId, backgroundRevision: translatedRevision }],
    }] };
  };
  const additionalPublications = (pdf: ContentPublication) => {
    assert.ok(pdf.content?.kind === 'document');
    const change = pdf.libraryBatch.changes.find(value => value.type === 'put-item'); assert.ok(change?.type === 'put-item');
    sourceTitle = change.item.title;
    sources.push({ libraryId: pdf.libraryBatch.libraryId, title: sourceTitle, document: structuredClone(pdf.content) });
    let parent = pdf.libraryBatch.id;
    const publications: ContentPublication[] = [];
    const other = structuredClone(pdf.content); other.id = crypto.randomUUID(); other.version = crypto.randomUUID(); delete other.translation;
    other.pages = [{ ...structuredClone(other.pages[0]), id: crypto.randomUUID(), annotations: [sticky('ABC alpha other source', null)] }];
    sources.push({ libraryId: pdf.libraryBatch.libraryId, title: 'Second source', document: other });
    for (const content of [other, ...[0, 1].map(index => ({ kind: 'markdown' as const, id: crypto.randomUUID(), version: crypto.randomUUID(),
      content: `seed note ${index}`, appendIds: [], imageResources: [] }))]) {
      const id = crypto.randomUUID(), title = content.kind === 'document' ? 'Second source' : `Annotation destination ${notes.length}`;
      const item = { ...structuredClone(change.item), id: content.id, title, kind: content.kind === 'document' ? 'pdf' as const : 'markdown' as const };
      if (content.kind === 'markdown') { delete item.resourceId; notes.push(content.id); }
      publications.push({ libraryBatch: { ...structuredClone(pdf.libraryBatch), id, parents: [parent], changes: [{ type: 'put-item', item }] }, content }); parent = id;
    }
    suffix = '\n\n' + freezeAnnotationExport(filterCanonicalAnnotations(projectCanonicalAnnotations(sources), { label: 'keep', sort: 'document' })).markdown;
    return { publications, initialDocumentId: pdf.content.id };
  };
  const setup = await openComposition(t, engine, seed, { additionalPublications });
  const { pages, repository, documentId, reload, reloadContent, finish } = setup;
  const sourceBefore = await Promise.all(sources.map(source => repository.read(source.document.id)));
  try {
    for (const [host, page] of pages.entries()) {
      t.diagnostic(`${host ? 'Web' : 'Native'} read-only filters, translated identity, retained append`);
      await expand(page); await count(page, 4);
      await panel(page).getByLabel('対象', { exact: true }).selectOption('all'); await count(page, 5);
      await panel(page).getByLabel('検索', { exact: true }).fill('abc alpha'); await count(page, 4);
      await panel(page).getByLabel('分類', { exact: true }).fill('keep'); await count(page, 4);
      await panel(page).getByLabel('種類', { exact: true }).selectOption('highlight'); await count(page, 1);
      await panel(page).getByLabel('種類', { exact: true }).selectOption('');
      await panel(page).getByLabel('順序', { exact: true }).selectOption('created-descending'); await count(page, 4);
      assert.match(await panel(page).locator('li').first().innerText(), /000002Z/);
      assert.match(await panel(page).locator('li').last().innerText(), /作成日時: 不明/);
      await panel(page).getByLabel('原訳', { exact: true }).selectOption('translated'); await count(page, 1);
      await panel(page).getByRole('button', { name: /^付箋・ハイライト一覧/ }).click(); await expand(page);
      assert.equal(await panel(page).getByLabel('検索', { exact: true }).inputValue(), 'abc alpha');
      await page.getByLabel('倍率', { exact: true }).selectOption('2');
      await panel(page).getByRole('button', { name: '場所へ移動', exact: true }).click();
      const translated = page.locator('[data-reader-surface="translated"]');
      await translated.locator(`[data-canonical-page="${translatedId}"][data-background-revision="${translatedRevision}"]`).waitFor();
      await translated.locator('[data-rendered="true"] .react-pdf__Page[data-page-number="2"] canvas').waitFor();
      assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '3');
      await waitForSnapshot(() => translated.locator('[data-pdf-scroller], .web-pdf-pane').evaluate(pane => {
        const surface = pane.querySelector('.ink-page, [data-pdf-surface]')!;
        return { y: (pane.getBoundingClientRect().top + pane.clientTop - surface.getBoundingClientRect().top) / surface.getBoundingClientRect().height,
          scroll: pane.scrollTop };
      }), value => value.scroll > 20 && Math.abs(value.y - 180 / metadata.pdfPages![1].heightPt) < .015);
      await expand(page); assert.equal(await panel(page).getByLabel('原訳', { exact: true }).inputValue(), 'translated');
      await panel(page).getByRole('button', { name: '条件を解除', exact: true }).click(); await count(page, 4);
      await panel(page).locator('li').filter({ hasText: 'orphan translation' }).getByRole('button', { name: '場所へ移動' }).click();
      await panel(page).getByRole('alert').filter({ hasText: '出典を開けません' }).waitFor();
      assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '3');
      assert.equal(await translated.getAttribute('data-active-surface'), 'true');
      await panel(page).getByLabel('対象', { exact: true }).selectOption('all');
      await panel(page).getByLabel('分類', { exact: true }).fill('keep'); await count(page, 4);
      await openItem(page, `Annotation destination ${host}`, notes[host]);
      await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).waitFor();
      await expand(page); assert.equal(await panel(page).getByLabel('分類', { exact: true }).inputValue(), 'keep'); await count(page, 4);
      const prefix = `dirty retained host ${host}`;
      await page.evaluate(() => (window as unknown as { compositionScratchQuota(value: boolean): void }).compositionScratchQuota(true));
      await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).fill(prefix);
      await waitForSnapshot(() => observe(page, notes[host]), value => value.markdown?.dirty === true && value.markdown.content === prefix);
      await panel(page).getByRole('button', { name: '絞込結果をノートへ追記', exact: true }).click();
      await dialog(page).getByRole('alert').waitFor();
      await panel(page).getByLabel('検索', { exact: true }).fill('no matching result'); await count(page, 0);
      await dialog(page).getByRole('button', { name: '再試行', exact: true }).evaluate(button => {
        (window as unknown as { compositionScratchQuota(value: boolean): void }).compositionScratchQuota(false); (button as HTMLButtonElement).click();
      });
      await dialog(page).getByLabel('追加先のノート', { exact: true }).selectOption(notes[host]);
      const commitStart = setup.committedPayloads.length;
      if (host === 0) setup.setCommitReplyLoss(true);
      await dialog(page).getByRole('button', { name: 'ノートへ追加', exact: true }).click();
      if (host === 0) {
        await dialog(page).getByRole('alert').waitFor();
        await reloadContent(page, notes[host]);
        await page.locator(`[data-content-document="${notes[host]}"]`).waitFor();
        const recoveredEditor = page.getByRole('textbox', { name: 'Markdownノート', exact: true });
        await recoveredEditor.waitFor(); assert.equal(await page.evaluate(id => (window as unknown as { compositionVisibleMarkdownEditorText(id: string): string }).compositionVisibleMarkdownEditorText(id), notes[host]), prefix + suffix);
        await dialog(page).getByRole('button', { name: '再試行', exact: true }).waitFor();
        setup.setCommitReplyLoss(false); await dialog(page).getByRole('button', { name: '再試行', exact: true }).click();
      }
      await dialog(page).getByRole('status').filter({ hasText: 'ノートに追加しました' }).waitFor();
      if (host === 0) {
        await dialog(page).getByRole('button', { name: '追加先を開く', exact: true }).click();
        await page.locator(`[data-content-document="${notes[host]}"]`).waitFor();
        const attempts = setup.committedPayloads.slice(commitStart).map(value => JSON.parse(value));
        assert.ok(attempts.length >= 2);
        const byId = new Map<string, unknown>();
        for (const attempt of attempts) {
          if (byId.has(attempt.batch.id)) assert.deepEqual(attempt, byId.get(attempt.batch.id));
          else byId.set(attempt.batch.id, attempt);
        }
        assert.ok(attempts.length > byId.size, 'a lost durable reply retries an existing exact batch');
      }
      const expected = prefix + suffix, accepted = await durable(page, notes[host], expected);
      assert.equal(accepted.markdown!.accepted!.appendIds.length, 1);
      assert.deepEqual(accepted.markdown!.accepted!.imageResources, []);
      assert.equal(expected.split('papeer://citation/').length - 1, 4);
      const appendBatches = accepted.state.checkpoint.batches.filter(batch => batch.kind === 'markdown' && batch.appendId);
      assert.equal(appendBatches.length, 1);
      const beforeAppend = new EditGraph(accepted.state.checkpoint).snapshot(appendBatches[0].parents[0]);
      assert.ok(beforeAppend?.kind === 'markdown');
      if (host !== 0) await dialog(page).getByRole('button', { name: '閉じる', exact: true }).click();
      // A dirty prefix may share the append's first durable snapshot; Undo restores its exact parent.
      const noteView = page.locator(`[data-content-document="${notes[host]}"]`);
      await noteView.getByRole('textbox', { name: 'Markdownノート', exact: true }).waitFor();
      await waitForSnapshot(() => page.evaluate(() => (window as unknown as { compositionNavigationEvidence(): { navigation: { documentId: string | null } } }).compositionNavigationEvidence().navigation.documentId), id => id === notes[host]);
      const noteToolbar = noteView.getByRole('toolbar', { name: 'Markdownノートの操作', exact: true });
      await noteToolbar.getByRole('button', { name: '元に戻す', exact: true }).click(); await durable(page, notes[host], beforeAppend.content);
      await noteToolbar.getByRole('button', { name: 'やり直す', exact: true }).click(); await sync(page, notes[host], expected);
      await reloadContent(page, notes[host]); await durable(page, notes[host], expected);
      const peer = pages[1 - host]; await reloadContent(peer, notes[host]);
      await peer.getByRole('button', { name: '同期', exact: true }).click(); await durable(peer, notes[host], expected);
      if (host === 0) await reloadContent(pages[1], documentId);
    }
    // New destination: durable publication reply loss must recover the same identity before append.
    const page = pages[0]; await reloadContent(page, documentId); await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();
    await expand(page); await panel(page).getByLabel('対象', { exact: true }).selectOption('all');
    await panel(page).getByLabel('分類', { exact: true }).fill('keep'); await count(page, 4);
    await panel(page).getByRole('button', { name: '絞込結果をノートへ追記', exact: true }).click();
    await dialog(page).getByLabel('新しいノートの名前', { exact: true }).fill('Recovered annotation destination');
    setup.setPublishReplyLoss(true); const start = setup.publishedPayloads.length;
    await dialog(page).getByRole('button', { name: 'ノートを作成して追加', exact: true }).click();
    await dialog(page).getByRole('alert').waitFor(); await reload(page);
    await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();
    await dialog(page).getByRole('button', { name: '再試行', exact: true }).waitFor(); setup.setPublishReplyLoss(false);
    await dialog(page).getByRole('button', { name: '再試行', exact: true }).click();
    await dialog(page).getByRole('status').filter({ hasText: 'ノートに追加しました' }).waitFor();
    const attempts = setup.publishedPayloads.slice(start).map(value => JSON.parse(value)); assert.ok(attempts.length >= 2);
    for (const attempt of attempts) assert.deepEqual(attempt, attempts[0]);
    await dialog(page).getByRole('button', { name: '追加先を開く', exact: true }).click();
    const newId = await waitForSnapshot(() => page.locator('[data-content-document]').getAttribute('data-content-document'),
      id => !!id && id !== documentId); assert.ok(newId);
    await sync(page, newId, suffix);
    const saved = await observe(page, newId); assert.equal(saved.markdown!.accepted!.appendIds.length, 1);
    await sync(pages[1], notes[1], `dirty retained host 1${suffix}`);
    await openItem(pages[1], 'Recovered annotation destination', newId); await durable(pages[1], newId, suffix);
    const libraryRead = await repository.read(repository.scope.libraryId), catalog = new EditGraph(libraryRead.checkpoint).snapshot(libraryRead.heads[0]);
    assert.ok(catalog?.kind === 'library'); assert.equal(catalog.items.filter(item => item.title === 'Recovered annotation destination').length, 1);
    for (const [index, source] of sources.entries()) {
      const after = await repository.read(source.document.id);
      assert.deepEqual(after.checkpoint, sourceBefore[index].checkpoint); assert.deepEqual(after.history, sourceBefore[index].history);
    }
    await finish();
  } catch (error) {
    console.error('Annotation browser error', error);
    for (const page of pages) console.error('Annotation browser failure', page.url(), await page.locator('body').innerText().catch(String));
    throw error;
  }
});

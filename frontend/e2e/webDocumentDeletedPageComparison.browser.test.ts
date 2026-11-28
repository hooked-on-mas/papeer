import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Locator, Page as BrowserPage, Route } from 'playwright-core';
import type { ContentPublication, DocumentEditBatch, DocumentSnapshot, LibrarySnapshot, Page, ResourceMetadata } from '../src/runtime/edits/contracts.ts';
import type { LibrarySessionState } from '../src/features/library/LibrarySession.ts';
import type { RepositoryState } from '../src/runtime/edits/ports.ts';
import { EditGraph } from '../src/runtime/edits/editGraph.ts';
import { applyBatch } from '../src/runtime/edits/editModel.ts';
import { openComposition, sync as deliver } from './support/documentComposition.ts';
import { waitForSnapshot } from './support/waitForSnapshot.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8')) as { resource: { file: string; metadata: ResourceMetadata } };
type Catalog = { state: RepositoryState; session?: LibrarySessionState; pending: unknown[]; replication: { running: boolean } };
const catalog = (page: BrowserPage): Promise<Catalog> => page.evaluate(() => (window as unknown as {
  compositionLibraryEvidence(): Promise<Catalog>;
}).compositionLibraryEvidence());
async function settled(page: BrowserPage, predicate: (snapshot: LibrarySnapshot, state: LibrarySessionState) => boolean) {
  return waitForSnapshot(() => catalog(page), value => {
    const state = value.session, snapshot = state?.selectedVersion ? new EditGraph(value.state.checkpoint).snapshot(state.selectedVersion) : null;
    return !!state?.ready && !state.busy && !state.pendingId && snapshot?.kind === 'library' && predicate(snapshot, state);
  });
}
async function expand(page: BrowserPage) {
  const button = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
}
async function sync(page: BrowserPage) {
  await waitForSnapshot(() => catalog(page), value => !value.replication.running);
  await page.getByRole('button', { name: '同期', exact: true }).click(); await deliver(page);
  await waitForSnapshot(() => catalog(page), value => !value.replication.running && value.pending.length === 0);
}
function annotations(page: Page): Page {
  page.annotations = [
    { kind: 'ink', id: crypto.randomUUID(), geometry: { kind: 'path', points: [{ x: 25, y: 35 }, { x: 100, y: 70 }] },
      transform: { x: 0, y: 0, rotationRad: 0, scaleX: 1, scaleY: 1 }, style: { color: '#ee1122', widthPt: 4, opacity: 1, highlighter: false } },
    { kind: 'ink', id: crypto.randomUUID(), geometry: { kind: 'rect', widthPt: 60, heightPt: 40 },
      transform: { x: 90, y: 100, rotationRad: .2, scaleX: 1, scaleY: 1 }, style: { color: '#2233ee', widthPt: 3, opacity: 1, highlighter: false } },
    { kind: 'sticky', id: crypto.randomUUID(), text: 'Preserved sticky', anchor: { x: 70, y: 80 }, color: '#ffcc00', metadata: { label: '', createdAt: null } },
    { kind: 'highlight', id: crypto.randomUUID(), backgroundRevision: page.backgroundRevision, range: { kind: 'unindexed' }, quote: 'Preserved quote',
      text: 'Preserved highlight', anchor: { x: 30, y: 130 }, quads: [[{ x: 30, y: 130 }, { x: 170, y: 130 }, { x: 170, y: 150 }, { x: 30, y: 150 }]],
      color: '#ffff00', metadata: { label: '', createdAt: null } },
  ];
  return page;
}
function pdfPage(physical: number, metadata = fixture.resource.metadata): Page {
  const version = crypto.randomUUID();
  return annotations({ id: crypto.randomUUID(), backgroundRevision: version, lifecycleVersion: version, annotationVersion: version,
    ...metadata.pdfPages![physical - 1], background: { kind: 'pdf', resourceId: metadata.id, sourceRevision: metadata.sha256, pdfPage: physical }, annotations: [] });
}
function paperPage(widthPt: number, heightPt: number, template: 'grid5' | 'cornell' | 'dot5' | 'ruled7'): Page {
  const version = crypto.randomUUID();
  return annotations({ id: crypto.randomUUID(), backgroundRevision: version, lifecycleVersion: version, annotationVersion: version,
    widthPt, heightPt, background: { kind: 'paper', spec: { template, color: 'cream' } }, annotations: [] });
}
const expectation = (page: Page) => ({ pageId: page.id, backgroundRevision: page.backgroundRevision,
  lifecycleVersion: page.lifecycleVersion, annotationVersion: page.annotationVersion });
function replacementBackground(page: Page, version: string): Page {
  return { ...page, backgroundRevision: version, annotations: page.annotations.map(annotation => annotation.kind === 'highlight'
    ? { ...annotation, backgroundRevision: version } : annotation) };
}
const pageKey = (collection: 'original' | 'translated' | 'deleted', page: Page) => JSON.stringify({ collection, pageId: page.id });
async function displayed(side: Locator, page: Page, pdf = true) {
  const frame = side.locator(`[data-comparison-page="${page.id}"][data-background-revision="${page.backgroundRevision}"]`);
  await frame.waitFor();
  if (pdf) await frame.locator('[data-comparison-pdf-rendered="true"] canvas').waitFor();
  const dimensions = await frame.evaluate(element => {
    const frame = element.getBoundingClientRect(), svg = element.querySelector('svg[aria-label="保存された注釈"]')!.getBoundingClientRect();
    const canvas = element.querySelector('canvas');
    return { width: frame.width, height: frame.height, svgWidth: svg.width, svgHeight: svg.height,
      svgX: svg.left - frame.left, svgY: svg.top - frame.top, pixels: canvas ? canvas.width * canvas.height : 0,
      physical: element.querySelector('.react-pdf__Page')?.getAttribute('data-page-number'),
      textLayers: element.querySelectorAll('.textLayer, .annotationLayer').length };
  });
  assert.ok(Math.abs(dimensions.height / dimensions.width - page.heightPt / page.widthPt) < .002);
  assert.ok(Math.abs(dimensions.svgWidth - dimensions.width) < 1 && Math.abs(dimensions.svgHeight - dimensions.height) < 1);
  assert.ok(Math.abs(dimensions.svgX) < 1 && Math.abs(dimensions.svgY) < 1);
  assert.ok(dimensions.pixels <= 2 ** 22 + 8192, 'comparison canvas obeys the pixel budget');
  assert.equal(dimensions.textLayers, 0);
  if (page.background.kind === 'pdf') assert.equal(dimensions.physical, String(page.background.pdfPage));
  for (const annotation of page.annotations) assert.equal(await frame.locator(`[data-${annotation.kind}-id="${annotation.id}"]`).count(), 1);
  return frame;
}

for (const engine of ['chromium', 'webkit'] as const) test(`production deleted PDF and paper comparison uses fixed pages, validated bytes and complete annotations (${engine})`, { timeout: 360_000 }, async t => {
  const originals: DocumentSnapshot[] = [], papers: DocumentSnapshot[] = [];
  const seed = (publication: ContentPublication) => {
    assert.ok(publication.content?.kind === 'document');
    Object.assign(publication.content, { pages: [pdfPage(1), pdfPage(2)], deletedPages: [pdfPage(3)],
      translation: { revision: crypto.randomUUID(), pages: [pdfPage(4)], bindings: [] } });
    originals.push(structuredClone(publication.content));
  };
  const additionalPublications = (initial: ContentPublication) => {
    const item = initial.libraryBatch.changes.find(change => change.type === 'put-item'); assert.ok(item?.type === 'put-item');
    const publications: ContentPublication[] = []; let parent = initial.libraryBatch.id;
    for (let index = 0; index < 2; index++) {
      if (index) {
        const document: DocumentSnapshot = { kind: 'document', id: crypto.randomUUID(), version: crypto.randomUUID(),
          pages: [pdfPage(1), pdfPage(2)], deletedPages: [pdfPage(3)], translation: { revision: crypto.randomUUID(), pages: [pdfPage(4)], bindings: [] } };
        const libraryBatch = { ...structuredClone(initial.libraryBatch), id: crypto.randomUUID(), parents: [parent],
          changes: [{ type: 'put-item' as const, item: { ...item.item, id: document.id, position: 1, title: 'Comparison second PDF' } }] };
        originals.push(structuredClone(document)); publications.push({ libraryBatch, content: document }); parent = libraryBatch.id;
      }
      const paper: DocumentSnapshot = { kind: 'document', id: crypto.randomUUID(), version: crypto.randomUUID(),
        pages: [paperPage(500, 2000, 'grid5'), paperPage(420, 1600, 'cornell')], deletedPages: [] };
      const paperItem = { ...item.item, id: paper.id, kind: 'notebook' as const, title: `Comparison paper ${index + 1}`, ownerId: originals[index].id, folderId: null };
      delete paperItem.resourceId;
      const libraryBatch = { ...structuredClone(initial.libraryBatch), id: crypto.randomUUID(), parents: [parent], changes: [{ type: 'put-item' as const, item: paperItem }] };
      papers.push(structuredClone(paper)); publications.push({ libraryBatch, content: paper }); parent = libraryBatch.id;
    }
    return { publications, initialDocumentId: initial.content!.id };
  };
  const { native, web, pages, repository, finish } = await openComposition(t, engine, seed, { additionalPublications, allowAttachmentResources: true });
  const alternateBytes = Buffer.concat([readFileSync(new URL(`../../tests/fixtures/${fixture.resource.file}`, import.meta.url)), Buffer.from('\n% comparison resource two\n')]);
  const alternate = await repository.storeResource({ id: crypto.randomUUID(), sha256: createHash('sha256').update(alternateBytes).digest('hex'),
    mediaType: 'application/pdf', bytes: alternateBytes });
  try {
    for (const [index, page] of pages.entries()) {
      const original = originals[index], paper = papers[index], pdfTitle = index ? 'Comparison second PDF' : 'Canonical PDF composition';
      const allIds = [...originals, ...papers].map(value => value.id);
      await expand(page);
      await page.getByRole('button', { name: `「${pdfTitle}」を削除`, exact: true }).click();
      await page.getByLabel('子ノートの扱い', { exact: true }).selectOption('delete');
      await page.getByRole('button', { name: '削除を確定', exact: true }).click();
      await settled(page, (_, state) => state.deletedItems.some(item => item.id === original.id) && state.deletedItems.some(item => item.id === paper.id));
      const latePdfId = crypto.randomUUID(), pdfReplacement = replacementBackground({ ...pdfPage(2, alternate), id: original.pages[0].id }, latePdfId);
      const latePdf: DocumentEditBatch = { kind: 'document', id: latePdfId, libraryId: repository.scope.libraryId, targetId: original.id,
        parents: [original.version], changes: [{ type: 'replace', expected: expectation(original.pages[0]), page: pdfReplacement },
          { type: 'remove', expected: expectation(original.pages[1]) }, { type: 'insert', index: 1, page: pdfPage(5) }] };
      // Translation replacement is an independent canonical command; expected versions come from the real model.
      const translation: DocumentEditBatch = { kind: 'document', id: crypto.randomUUID(), libraryId: repository.scope.libraryId, targetId: original.id,
        parents: [latePdf.id], changes: [{ type: 'translation', expectedRevision: original.translation!.revision,
          translation: { pages: [pdfPage(3, alternate)], bindings: [] } }] };
      const canonicalPdf = applyBatch(applyBatch(original, latePdf), translation); assert.equal(canonicalPdf.kind, 'document');
      if (canonicalPdf.kind !== 'document') throw new Error('document fixture required');
      const updatedPdf = canonicalPdf.pages[0], addedPdf = canonicalPdf.pages[1], translated = canonicalPdf.translation!.pages[0];
      for (const batch of [latePdf, translation]) {
        const result = await repository.commit(batch); assert.equal(result.status, 'durable', JSON.stringify(result));
      }
      const latePaperId = crypto.randomUUID(), paperReplacement = replacementBackground({ ...paperPage(360, 1600, 'dot5'), id: paper.pages[0].id }, latePaperId);
      const latePaper: DocumentEditBatch = { kind: 'document', id: latePaperId, libraryId: repository.scope.libraryId, targetId: paper.id,
        parents: [paper.version], changes: [{ type: 'replace', expected: expectation(paper.pages[0]), page: paperReplacement },
          { type: 'remove', expected: expectation(paper.pages[1]) }, { type: 'insert', index: 1, page: paperPage(400, 1800, 'ruled7') }] };
      const canonicalPaper = applyBatch(paper, latePaper); assert.equal(canonicalPaper.kind, 'document');
      if (canonicalPaper.kind !== 'document') throw new Error('paper fixture required');
      const updatedPaper = canonicalPaper.pages[0], addedPaper = canonicalPaper.pages[1];
      const paperResult = await repository.commit(latePaper); assert.equal(paperResult.status, 'durable', JSON.stringify(paperResult));
      await sync(native); await sync(web);
      await page.getByRole('button', { name: '一覧を更新', exact: true }).click();
      const panel = page.getByRole('region', { name: '削除した資料の比較', exact: true });
      const left = panel.getByRole('region', { name: '削除時点の版', exact: true }), right = panel.getByRole('region', { name: '現在の版', exact: true });
      await page.getByRole('button', { name: `削除された「${pdfTitle}」を削除時点と比較`, exact: true }).click();
      await displayed(left, original.pages[0]); await displayed(right, updatedPdf);
      assert.equal(await panel.locator('[aria-label$="書き込みレイヤー"]').count(), 0);
      const selectLeft = left.getByLabel('削除時点の版のページを選択', { exact: true }), selectRight = right.getByLabel('現在の版のページを選択', { exact: true });
      await selectLeft.selectOption(pageKey('translated', original.translation!.pages[0])); await displayed(left, original.translation!.pages[0]);
      await selectRight.selectOption(pageKey('translated', translated)); await displayed(right, translated);
      await selectLeft.selectOption(pageKey('deleted', original.deletedPages[0])); await displayed(left, original.deletedPages[0]);
      await left.getByRole('status').filter({ hasText: '削除済ページを表示しています' }).waitFor();
      await selectRight.selectOption(pageKey('original', addedPdf)); await displayed(right, addedPdf);
      assert.equal(await right.getByLabel('現在の版を選択', { exact: true }).inputValue(), translation.id);
      await selectRight.selectOption(pageKey('deleted', original.pages[1])); await displayed(right, original.pages[1]);
      await right.getByRole('status').filter({ hasText: '削除済ページを表示しています' }).waitFor();
      await selectRight.selectOption(pageKey('original', addedPdf)); await displayed(right, addedPdf);
      await selectLeft.selectOption(pageKey('original', original.pages[1])); await displayed(left, original.pages[1]);
      await left.getByLabel('削除時点の版を選択', { exact: true }).selectOption(original.version);

      if (!index) {
        const missing = (route: Route) => route.request().postDataJSON()?.resourceId === alternate.id ? route.fulfill({ json: null }) : route.continue();
        await page.route('**/api/edits/read-resource', missing);
        await selectRight.selectOption(pageKey('original', updatedPdf));
        await right.getByRole('alert').filter({ hasText: 'PDF背景を確認できません' }).waitFor();
        assert.equal(await right.locator('[data-ink-id]').count(), 2);
        await page.unroute('**/api/edits/read-resource', missing);
        await right.getByRole('button', { name: 'PDF背景を再取得', exact: true }).click(); await displayed(right, updatedPdf);
        await selectRight.selectOption(pageKey('original', addedPdf)); await displayed(right, addedPdf);
        const corrupt = async (route: Route) => {
          if (route.request().postDataJSON()?.resourceId !== alternate.id) { await route.continue(); return; }
          const response = await route.fetch(), body = await response.json();
          await route.fulfill({ response, json: { ...body, dataBase64: 'QUFB' + body.dataBase64.slice(4) } });
        };
        await page.route('**/api/edits/read-resource', corrupt);
        await selectRight.selectOption(pageKey('original', updatedPdf));
        await right.getByRole('alert').filter({ hasText: 'PDF背景を確認できません' }).waitFor();
        await page.unroute('**/api/edits/read-resource', corrupt);
        await selectRight.selectOption(pageKey('original', addedPdf)); await displayed(right, addedPdf);
        let received!: () => void, release!: () => void, completed!: () => void;
        let delayedError: unknown, primaryError: unknown, cleanupError: unknown;
        const arrival = new Promise<void>(resolve => { received = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
        const completion = new Promise<void>(resolve => { completed = resolve; });
        const delay = async (route: Route) => {
          if (route.request().postDataJSON()?.resourceId !== alternate.id) { await route.continue(); return; }
          try {
            const response = await route.fetch(); received(); await held; await route.fulfill({ response });
          } catch (error) { delayedError = error; received(); } finally { completed(); }
        };
        await page.route('**/api/edits/read-resource', delay);
        try {
          await selectRight.selectOption(pageKey('original', updatedPdf)); await arrival;
          await selectRight.selectOption(pageKey('original', addedPdf)); await displayed(right, addedPdf);
        } catch (error) { primaryError = error; } finally {
          release(); await completion;
          try { await page.unroute('**/api/edits/read-resource', delay); } catch (error) { cleanupError = error; }
        }
        if (primaryError || delayedError || cleanupError) {
          console.error('delayed-resource-primary-route-cleanup', { primaryError, delayedError, cleanupError });
          throw primaryError ?? delayedError ?? cleanupError;
        }
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await displayed(right, addedPdf);
        assert.equal(await right.locator(`[data-comparison-page="${updatedPdf.id}"]`).count(), 0);
      }
      await panel.getByRole('button', { name: '比較を閉じる', exact: true }).click();
      await page.getByRole('button', { name: `削除された「Comparison paper ${index + 1}」を削除時点と比較`, exact: true }).click();
      await displayed(left, paper.pages[0], false); await displayed(right, updatedPaper, false);
      assert.ok(await left.locator('svg[aria-hidden="true"] pattern').count() > 0);
      assert.ok(await right.locator('svg[aria-hidden="true"] pattern').count() > 0);
      const leftBody = left.getByLabel('削除時点の版の本文', { exact: true }), rightBody = right.getByLabel('現在の版の本文', { exact: true });
      await leftBody.evaluate(element => { element.scrollTop = 180; }); await rightBody.evaluate(element => { element.scrollTop = 220; });
      await waitForSnapshot(() => rightBody.evaluate(element => element.scrollTop), top => top >= 210);
      await right.getByLabel('現在の版のページを選択', { exact: true }).selectOption(pageKey('original', addedPaper)); await displayed(right, addedPaper, false);
      await right.getByLabel('現在の版のページを選択', { exact: true }).selectOption(pageKey('original', updatedPaper)); await displayed(right, updatedPaper, false);
      await waitForSnapshot(() => rightBody.evaluate(element => new Promise<number[]>(resolve => {
        requestAnimationFrame(() => { const first = element.scrollTop; requestAnimationFrame(() => resolve([first, element.scrollTop])); });
      })), positions => positions.every(top => top >= 210));
      const replacementPaper = paperPage(300, 900, 'grid5');
      const following: DocumentEditBatch = { kind: 'document', id: crypto.randomUUID(), libraryId: repository.scope.libraryId, targetId: paper.id,
        parents: [latePaper.id], changes: [{ type: 'remove', expected: expectation(addedPaper) }, { type: 'insert', index: 1, page: replacementPaper }] };
      assert.equal((await repository.commit(following)).status, 'durable'); await sync(native); await sync(web);
      await panel.getByRole('button', { name: '比較を再取得', exact: true }).click();
      await panel.getByRole('status').filter({ hasText: '新しい版が届きました' }).waitFor();
      assert.equal(await right.getByLabel('現在の版を選択', { exact: true }).inputValue(), latePaper.id);
      assert.ok(await leftBody.evaluate(element => element.scrollTop) >= 170); assert.ok(await rightBody.evaluate(element => element.scrollTop) >= 210);
      // Selecting a different version preserves the exact pool/page key and reports its absence.
      await right.getByLabel('現在の版のページを選択', { exact: true }).selectOption(pageKey('original', addedPaper));
      await right.getByLabel('現在の版を選択', { exact: true }).selectOption(following.id);
      await right.getByRole('status').filter({ hasText: '選択していたページはこの版にはありません' }).waitFor();
      assert.equal(await right.locator('[data-comparison-page]').count(), 0);
      await right.getByLabel('現在の版のページを選択', { exact: true }).selectOption(pageKey('original', replacementPaper)); await displayed(right, replacementPaper, false);
      const beforeGraphs = await Promise.all(allIds.map(id => repository.read(id)));
      const beforeResources = await Promise.all([fixture.resource.metadata.id, alternate.id].map(id => repository.readResource(id)));
      await panel.getByRole('button', { name: '比較した資料を復元', exact: true }).click();
      await settled(page, (_, state) => state.items.some(item => item.id === original.id) && state.items.some(item => item.id === paper.id));
      await panel.waitFor({ state: 'hidden' }); await sync(native); await sync(web);
      for (const [position, id] of allIds.entries()) {
        const after = await repository.read(id); assert.deepEqual(after.checkpoint, beforeGraphs[position].checkpoint);
        assert.deepEqual(after.heads, beforeGraphs[position].heads); assert.deepEqual(after.history, beforeGraphs[position].history);
      }
      assert.deepEqual(await Promise.all([fixture.resource.metadata.id, alternate.id].map(id => repository.readResource(id))), beforeResources);
    }
    await finish();
  } catch (error) {
    console.error('reference-case-error', JSON.stringify({ suite: 'deleted-page', error: error instanceof Error ? { name: error.name.slice(0,80), message: error.message.slice(0,500), stack: error.stack?.slice(0,1600) } : { name: typeof error, message: typeof error === 'string' ? error.slice(0,500) : 'non-Error exception' } }));
    for (const [host, page] of pages.entries()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const state = await Promise.race([page.evaluate(() => {
          const port = window as unknown as {
            compositionBootstrapStatus?: () => { state?: { phase?: string; locked?: boolean; error?: string }; provider?: { phase?: string; connected?: boolean; busy?: boolean; error?: string } | null };
            compositionStartupEvidence?: () => { nativeTransport?: unknown; trace?: { sequence?: number; at?: number; event?: string; lifecycleGeneration?: number; detail?: unknown }[] };
          };
          const status = port.compositionBootstrapStatus?.(), startup = port.compositionStartupEvidence?.(), trace = startup?.trace ?? [];
          const lifecycle = trace.filter(entry => ['pagehide','pageshow','registry.initialize.start','registry.initialize.settled','registry.initialize.error','registry.state'].includes(entry.event ?? '')).slice(-8).map(entry => {
            const detail = entry.detail && typeof entry.detail === 'object' ? entry.detail as Record<string, unknown> : {};
            const registry = detail.state && typeof detail.state === 'object' ? detail.state as Record<string, unknown> : detail;
            return { sequence: entry.sequence, at: entry.at, event: entry.event, lifecycleGeneration: entry.lifecycleGeneration,
              persisted: typeof detail.persisted === 'boolean' ? detail.persisted : undefined,
              ready: typeof registry.ready === 'boolean' ? registry.ready : undefined, active: typeof registry.active === 'boolean' ? registry.active : undefined,
              error: typeof registry.error === 'string' ? registry.error.slice(0,256) : typeof detail.error === 'string' ? detail.error.slice(0,256) : undefined };
          });
          return { bootstrap: status?.state && { phase: status.state.phase, locked: status.state.locked, error: status.state.error?.slice(0,256) },
            provider: status?.provider && { phase: status.provider.phase, connected: status.provider.connected, busy: status.provider.busy, error: status.provider.error?.slice(0,256) }, lifecycle, nativeTransport: startup?.nativeTransport };
        }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('reference lifecycle diagnostic timeout')), 2000); })]);
        console.error('reference-lifecycle-state', JSON.stringify({ host: host === 0 ? 'native' : 'web', state }));
      } catch (diagnosticError) { console.error('reference-lifecycle-state-unavailable', host === 0 ? 'native' : 'web', diagnosticError instanceof Error ? diagnosticError.message.slice(0,256) : 'non-Error diagnostic failure'); }
      finally { if (timer !== undefined) clearTimeout(timer); }
    }
    console.error('deleted-pages-comparison', error);
    for (const page of pages) console.error(page.url(), JSON.stringify(await catalog(page).catch(String)));
    throw error;
  }
});

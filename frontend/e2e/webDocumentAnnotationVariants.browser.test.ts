import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page, Route } from 'playwright-core';
import type { ContentPublication, DocumentSnapshot, LibraryEditBatch, PageEditBatch, StickyNote } from '../src/runtime/edits/contracts.ts';
import type { RepositoryState } from '../src/runtime/edits/ports.ts';
import type { DocumentEditState } from '../src/features/reader/edit/DocumentEditSession.ts';
import { EditGraph } from '../src/runtime/edits/editGraph.ts';
import { pageExpectation } from '../src/runtime/edits/documentPages.ts';
import { openComposition, sync as deliver } from './support/documentComposition.ts';
import { waitForSnapshot } from './support/waitForSnapshot.ts';

type Observed = { state: RepositoryState; document?: DocumentEditState };
const observe = (page: Page, id: string) => page.evaluate(id => (window as unknown as {
  compositionObservedEvidence(id: string): Promise<Observed>;
}).compositionObservedEvidence(id), id);
const panel = (page: Page) => page.getByRole('region', { name: '付箋・ハイライト一覧', exact: true });
const row = (page: Page, text: string) => panel(page).locator('li').filter({ has: page.getByText(text, { exact: true }) });
async function expand(page: Page) {
  const toggle = panel(page).getByRole('button', { name: /^付箋・ハイライト一覧/ });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}
async function count(page: Page, expected: number) {
  await waitForSnapshot(async () => ({ count: await panel(page).locator('li').count(), status: await panel(page).getByRole('status').first().innerText() }),
    value => value.count === expected && !value.status.includes('取得中'));
}
async function options(page: Page, text: string) {
  return row(page, text).getByLabel('出典の版', { exact: true }).locator('option').evaluateAll(elements =>
    elements.map(element => (element as HTMLOptionElement).value).filter(Boolean).sort());
}

for (const engine of ['chromium', 'webkit'] as const) test(`production annotation variants, explicit source/catalog heads and partial arrivals (${engine})`, { timeout: 240_000 }, async t => {
  let noteId = '', original!: DocumentSnapshot;
  const seed = (publication: ContentPublication) => {
    assert.ok(publication.content?.kind === 'document');
    original = publication.content;
    original.pages[0].annotations = Array.from({ length: 24 }, (_, index): StickyNote => ({ kind: 'sticky', id: crypto.randomUUID(),
      text: index === 0 ? 'variant initial' : `shared ${String(index).padStart(2, '0')}`, anchor: { x: 80, y: 100 + index * 5 },
      color: null, metadata: { label: 'variants', createdAt: null } }));
    original.pages[1].annotations = [];
  };
  const additionalPublications = (pdf: ContentPublication) => {
    const change = pdf.libraryBatch.changes.find(value => value.type === 'put-item'); assert.ok(change?.type === 'put-item');
    noteId = crypto.randomUUID(); const item = { ...structuredClone(change.item), id: noteId, kind: 'markdown' as const, title: 'Variant navigation home' };
    delete item.resourceId;
    return { initialDocumentId: noteId, publications: [{ libraryBatch: { ...structuredClone(pdf.libraryBatch), id: crypto.randomUUID(), parents: [pdf.libraryBatch.id],
      changes: [{ type: 'put-item' as const, item }] }, content: { kind: 'markdown' as const, id: noteId, version: crypto.randomUUID(),
      content: 'Read-only navigation home', appendIds: [], imageResources: [] } }] };
  };
  const { pages, repository, publishThirdPeerRecord, beginContentNavigation, finish } = await openComposition(t, engine, seed, { additionalPublications });
  beginContentNavigation();
  const branches = ['A', 'B'].map((name): PageEditBatch => ({ kind: 'page', id: crypto.randomUUID(), libraryId: repository.scope.libraryId,
    targetId: original.id, parents: [original.version], expected: pageExpectation(original.pages[0]),
    changes: [{ type: 'update', annotation: { ...original.pages[0].annotations[0] as StickyNote, text: `variant ${name}` } }] }));
  try {
    for (const batch of branches) assert.equal((await repository.commit(batch)).status, 'durable');
    await deliver(pages[0]); await deliver(pages[1]);
    const branched = await repository.read(original.id), graph = new EditGraph(branched.checkpoint);
    assert.deepEqual([...branched.heads].sort(), branches.map(batch => batch.id).sort());
    for (const [host, page] of pages.entries()) {
      t.diagnostic(`${host ? 'Web' : 'Native'} equal-payload head merge, distinct variants, explicit checkout and scroll`);
      await expand(page); await panel(page).getByLabel('対象', { exact: true }).selectOption('all');
      await panel(page).getByRole('button', { name: '一覧を更新', exact: true }).click(); await count(page, 25);
      assert.deepEqual(await options(page, 'shared 18'), branches.map(batch => batch.id).sort());
      assert.deepEqual(await options(page, 'variant A'), [branches[0].id]);
      assert.deepEqual(await options(page, 'variant B'), [branches[1].id]);
      assert.equal(await row(page, 'variant A').getByRole('button', { name: '場所へ移動' }).isDisabled(), true);
      assert.equal(await row(page, 'variant B').getByRole('button', { name: '場所へ移動' }).isDisabled(), true);
      for (const branch of branches) {
        const selected = row(page, 'shared 18');
        await selected.getByLabel('出典の版', { exact: true }).selectOption(branch.id);
        await selected.scrollIntoViewIfNeeded();
        const scroller = panel(page).getByLabel('注釈の検索結果', { exact: true });
        const beforeWitness = await scroller.evaluate(element => {
          const pane = element as HTMLElement;
          (window as unknown as { __annotationDiagnosticPane?: HTMLElement }).__annotationDiagnosticPane = pane;
          const outer = pane.closest('#workspace-catalog-chrome') as HTMLElement | null;
          const box = (item: Element) => { const r = item.getBoundingClientRect(); return { top:r.top, bottom:r.bottom, height:r.height }; };
          const measure = (item: HTMLElement | null) => item && ({ top:item.scrollTop, height:item.scrollHeight, client:item.clientHeight, box:box(item), connected:item.isConnected });
          const rows = [...pane.querySelectorAll('li')];
          const describe = (item: Element | undefined) => item && ({ box:box(item), offset:box(item).top - box(pane).top - pane.clientTop, label:(item.textContent ?? '').trim().slice(0,80) });
          const visible = () => rows.find(item => item.getBoundingClientRect().bottom > pane.getBoundingClientRect().top + pane.clientTop);
          const selected = () => rows.find(item => [...item.querySelectorAll('*')].some(child => child.textContent?.trim() === 'shared 18'));
          const snapshot = () => ({ inner:measure(pane), outer:measure(outer), firstVisible:describe(visible()), selected:describe(selected()) });
          (window as unknown as { __annotationClickWitness?: unknown }).__annotationClickWitness = undefined;
          pane.addEventListener('pointerdown', () => { (window as unknown as { __annotationClickWitness?: unknown }).__annotationClickWitness = snapshot(); }, { once:true, capture:true, passive:true });
          return { ...snapshot(), rows:rows.slice(0,8).map(item => describe(item)), count:rows.length };
        });
        const beforeScroll = beforeWitness.inner!.top; assert.ok(beforeScroll > 100);
        await selected.getByRole('button', { name: '場所へ移動', exact: true }).click();
        await page.locator(`[data-content-document="${original.id}"]`).waitFor();
        const actual = await waitForSnapshot(() => observe(page, original.id), value => value.document?.selectedVersion === branch.id && value.document.ready);
        assert.deepEqual(actual.document!.document, graph.snapshot(branch.id), 'navigation opens the full explicitly chosen variant');
        await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();
        await expand(page); await count(page, 25);
        const departure = await page.evaluate(() => (window as unknown as { __annotationClickWitness?: { inner?: { top?: number } } }).__annotationClickWitness?.inner?.top);
        assert.ok(typeof departure === 'number' && Number.isFinite(departure) && departure > 100, 'actual pointerdown scroll baseline required');
        try {
          await waitForSnapshot(() => scroller.evaluate(element => element.scrollTop), value => Math.abs(value - departure) < 2);
        } catch (error) {
          try {
            const afterWitness = await scroller.evaluate(element => {
              const pane = element as HTMLElement, prior = (window as unknown as { __annotationDiagnosticPane?: HTMLElement }).__annotationDiagnosticPane;
              const outer = pane.closest('#workspace-catalog-chrome') as HTMLElement | null;
              const box = (item: Element) => { const r = item.getBoundingClientRect(); return { top:r.top, bottom:r.bottom, height:r.height }; };
              const measure = (item: HTMLElement | null | undefined) => item && ({ top:item.scrollTop, height:item.scrollHeight, client:item.clientHeight, box:box(item), connected:item.isConnected });
              const rows = [...pane.querySelectorAll('li')];
              const describe = (item: Element | undefined) => item && ({ box:box(item), offset:box(item).top - box(pane).top - pane.clientTop, label:(item.textContent ?? '').trim().slice(0,80) });
              const visible = rows.find(item => item.getBoundingClientRect().bottom > pane.getBoundingClientRect().top + pane.clientTop);
              const selected = rows.find(item => [...item.querySelectorAll('*')].some(child => child.textContent?.trim() === 'shared 18'));
              return { samePane:pane === prior, prior:measure(prior), inner:measure(pane), outer:measure(outer), firstVisible:describe(visible), selected:describe(selected), rows:rows.slice(0,8).map(item => describe(item)), count:rows.length, click:(window as unknown as { __annotationClickWitness?: unknown }).__annotationClickWitness ?? null };
            }, undefined, { timeout: 2000 });
            t.diagnostic(`annotation-scroll ${JSON.stringify({ before:beforeWitness, after:afterWitness, savedAnchor:'not exposed' })}`);
          } catch (diagnosticError) { t.diagnostic(`annotation-scroll diagnostic unavailable: ${String(diagnosticError)}`); }
          throw error;
        }
        assert.equal(await selected.getByLabel('出典の版', { exact: true }).inputValue(), branch.id);
        await page.getByRole('button', { name: '前の資料に戻る', exact: true }).click();
        await page.locator(`[data-content-document="${noteId}"]`).waitFor();
        await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).waitFor(); await expand(page);
      }
    }
    // A and B disagree about source visibility. The annotation UI must use the catalog selection B,
    // even though the navigation owner still holds its earlier unpinned Markdown location.
    const catalogRead = await repository.read(repository.scope.libraryId), catalog = new EditGraph(catalogRead.checkpoint).snapshot(catalogRead.heads[0]);
    assert.ok(catalog?.kind === 'library'); const sourceItem = catalog.items.find(item => item.id === original.id)!;
    const catalogA: LibraryEditBatch = { kind: 'library', id: crypto.randomUUID(), libraryId: catalog.id, targetId: catalog.id, parents: [catalog.version],
      changes: [{ type: 'put-deletion', deletion: { id: crypto.randomUUID(), itemIds: [original.id],
        observed: [{ targetId: original.id, heads: branched.heads }], active: true } }] };
    const catalogB: LibraryEditBatch = { ...catalogA, id: crypto.randomUUID(), changes: [
      { type: 'put-item', item: { ...sourceItem, title: 'Source visible in catalog B' } },
    ] };
    const committedA = await repository.commit(catalogA); assert.equal(committedA.status, 'durable', JSON.stringify(committedA));
    const committedB = await repository.commit(catalogB); assert.equal(committedB.status, 'durable', JSON.stringify(committedB));
    await deliver(pages[0]); await deliver(pages[1]);
    for (const [host, page] of pages.entries()) {
      const toggle = page.getByRole('button', { name: '資料一覧', exact: true });
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
      try {
        await page.getByLabel('一覧の版', { exact: true }).selectOption(catalogA.id); await count(page, 0);
      } catch (error) {
        try {
          const evidence = await page.getByLabel('一覧の版', { exact: true }).evaluate(element => {
            const select=element as HTMLSelectElement;
            const port=window as unknown as { compositionStartupEvidence?:()=>{library?:unknown}; compositionAnnotationBrowserEvidence?:()=>{rows:unknown[];loading:boolean;error:string;missingIds:string[];partialIds:string[];staleIds:string[]} };
            const annotation=port.compositionAnnotationBrowserEvidence?.();
            return { chosen:select.value, options:[...select.options].slice(0,8).map(option=>({value:option.value,selected:option.selected})), library:port.compositionStartupEvidence?.().library,
              annotation:annotation && {rows:annotation.rows.length,loading:annotation.loading,error:annotation.error.slice(0,256),missing:annotation.missingIds.length,partial:annotation.partialIds.length,stale:annotation.staleIds.length},
              documentId:document.querySelector('[data-content-document]')?.getAttribute('data-content-document') ?? null };
          }, undefined, { timeout:2000 });
          t.diagnostic(`annotation-catalog-selection ${JSON.stringify({engine,host:host===0?'native':'web',requestedA:catalogA.id,requestedB:catalogB.id,evidence})}`);
        } catch (diagnosticError) { t.diagnostic(`annotation-catalog-selection unavailable ${JSON.stringify({engine,host:host===0?'native':'web',requestedA:catalogA.id,requestedB:catalogB.id,error:String(diagnosticError).slice(0,256)})}`); }
        throw error;
      }
      await page.getByLabel('一覧の版', { exact: true }).selectOption(catalogB.id); await count(page, 25);
      const selected = row(page, 'variant B'); await selected.getByLabel('出典の版', { exact: true }).selectOption(branches[1].id);
      await selected.getByRole('button', { name: '場所へ移動', exact: true }).click();
      await page.locator(`[data-content-document="${original.id}"]`).waitFor();
      await page.getByRole('heading', { name: 'Source visible in catalog B', exact: true }).waitFor();
      const actual = await waitForSnapshot(() => observe(page, original.id), value => value.document?.selectedVersion === branches[1].id);
      assert.deepEqual(actual.document!.document, graph.snapshot(branches[1].id));
      await expand(page);
      // A catalog can only contain content roots that passed repository admission. Simulate a real
      // read failure instead of publishing an impossible dangling content item. Leave the source
      // controller first, so the injected failure exercises the read-only corpus independently.
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
      await page.getByLabel('一覧の版', { exact: true }).selectOption(catalogB.id);
      await page.getByRole('button', { name: 'Variant navigation home', exact: true }).click();
      await page.locator(`[data-content-document="${noteId}"]`).waitFor();
      await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).waitFor();
      await expand(page); await count(page, 25);
      const beforeFault = await observe(page, original.id);
      const readUrl = new URL('/api/edits/read', page.url()).href;
      const failSourceRead = async (route: Route) => {
        const request = route.request();
        if (request.method() === 'POST' && request.postDataJSON()?.targetId === original.id)
          await route.fulfill({ status: 503, contentType: 'text/plain', body: 'fixture source read unavailable' });
        else await route.continue();
      };
      try {
        if (host === 0) await page.route(readUrl, failSourceRead);
        else await page.evaluate(id => {
          const holder = window as unknown as { annotationRootGetForTest?: typeof IDBObjectStore.prototype.get };
          if (holder.annotationRootGetForTest) throw new Error('read fault already installed');
          const get = IDBObjectStore.prototype.get; holder.annotationRootGetForTest = get;
          IDBObjectStore.prototype.get = function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
            if (this.name === 'roots' && typeof key === 'string') {
              let parts: unknown;
              try { parts = JSON.parse(key); } catch { /* Unrelated keys retain the original implementation. */ }
              if (Array.isArray(parts) && parts[1] === id) throw new DOMException('fixture source root unavailable', 'UnknownError');
            }
            return get.call(this, key);
          };
        }, original.id);
        await panel(page).getByRole('button', { name: '一覧を更新', exact: true }).click(); await count(page, 25);
        await panel(page).getByRole('status').filter({ hasText: '未取得 1資料' }).waitFor();
        await panel(page).getByRole('status').filter({ hasText: '以前の結果 1資料' }).waitFor();
        assert.equal(await panel(page).getByRole('button', { name: '場所へ移動', exact: true }).count(), 25);
        assert.equal(await panel(page).getByRole('button', { name: '場所へ移動', exact: true }).evaluateAll(buttons =>
          buttons.every(button => (button as HTMLButtonElement).disabled)), true);
        assert.equal(await panel(page).getByRole('button', { name: '絞込結果をノートへ追記', exact: true }).isDisabled(), true);
        assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), noteId);
      } finally {
        if (host === 0) await page.unroute(readUrl, failSourceRead);
        else await page.evaluate(() => {
          const holder = window as unknown as { annotationRootGetForTest?: typeof IDBObjectStore.prototype.get };
          if (holder.annotationRootGetForTest) IDBObjectStore.prototype.get = holder.annotationRootGetForTest;
          delete holder.annotationRootGetForTest;
        });
      }
      await panel(page).getByRole('button', { name: '一覧を更新', exact: true }).click(); await count(page, 25);
      await waitForSnapshot(() => panel(page).getByRole('status').first().innerText(), text => !text.includes('未取得') && !text.includes('以前の結果') && !text.includes('取得中'));
      const afterFault = await observe(page, original.id);
      assert.deepEqual(afterFault.state.checkpoint, beforeFault.state.checkpoint);
      assert.deepEqual(afterFault.state.heads, beforeFault.state.heads); assert.deepEqual(afterFault.state.history, beforeFault.state.history);
      await row(page, 'variant B').getByLabel('出典の版', { exact: true }).selectOption(branches[1].id);
      try {
        await waitForSnapshot(async () => ({ selected:await row(page, 'variant B').getByLabel('出典の版', { exact: true }).inputValue(),
          enabled:!await row(page, 'variant B').getByRole('button', { name: '場所へ移動', exact: true }).isDisabled(),
          appendEnabled:!await panel(page).getByRole('button', { name: '絞込結果をノートへ追記', exact: true }).isDisabled() }),
          value => value.selected === branches[1].id && value.enabled && value.appendEnabled);
      } catch (error) {
        try {
          const evidence = await panel(page).evaluate(element => {
            const state=(window as unknown as { compositionAnnotationBrowserEvidence?:()=>{rows:unknown[];loading:boolean;error:string;missingIds:string[];partialIds:string[];staleIds:string[]} }).compositionAnnotationBrowserEvidence?.();
            return { statuses:[...element.querySelectorAll('[role="status"], [role="alert"]')].slice(0,8).map(item=>(item.textContent??'').slice(0,160)),
              selected:[...element.querySelectorAll<HTMLSelectElement>('select')].slice(0,8).map(item=>item.value),
              annotation:state && {rows:state.rows.length,loading:state.loading,error:state.error.slice(0,160),missing:state.missingIds.length,partial:state.partialIds.length,stale:state.staleIds.length} };
          }, undefined, { timeout:2000 });
          t.diagnostic(`annotation-version-readiness ${JSON.stringify({engine,host:host===0?'native':'web',expected:branches[1].id,evidence})}`);
        } catch (diagnosticError) { t.diagnostic(`annotation-version-readiness unavailable: ${String(diagnosticError).slice(0,160)}`); }
        throw error;
      }
      assert.equal(await row(page, 'variant B').getByRole('button', { name: '場所へ移動', exact: true }).isDisabled(), false);
      assert.equal(await panel(page).getByRole('button', { name: '絞込結果をノートへ追記', exact: true }).isDisabled(), false);
      await row(page, 'variant B').getByRole('button', { name: '場所へ移動', exact: true }).click();
      await page.locator(`[data-content-document="${original.id}"]`).waitFor();
      await waitForSnapshot(() => observe(page, original.id), value => value.document?.selectedVersion === branches[1].id);
      await expand(page);
    }
    // A real received batch with an absent parent stays pending in the graph. Available heads are
    // still displayed, but the corpus must mark the source partial and reject navigation from it.
    const waiting: PageEditBatch = { ...structuredClone(branches[0]), id: crypto.randomUUID(), parents: [crypto.randomUUID()] };
    // A synthetic third peer publishes the normal provider envelope; only each
    // genuine private replica can import it into Core (no public receive RPC).
    const delivered = await publishThirdPeerRecord({ batch: waiting });
    assert.equal(delivered.status, 200);
    await deliver(pages[0]); await deliver(pages[1]);
    assert.ok((await repository.read(original.id)).waiting.includes(waiting.id));
    for (const page of pages) {
      await panel(page).getByRole('button', { name: '一覧を更新', exact: true }).click(); await count(page, 25);
      await panel(page).getByRole('status').filter({ hasText: '一部未取得 1資料' }).waitFor();
      const before = await observe(page, original.id), selected = row(page, 'variant A');
      await selected.getByLabel('出典の版', { exact: true }).selectOption(branches[0].id);
      await selected.getByRole('button', { name: '場所へ移動', exact: true }).click();
      await panel(page).getByRole('alert').filter({ hasText: '出典の版・場所・注釈が変わったか、取得できません' }).waitFor();
      const after = await observe(page, original.id);
      assert.equal(after.document?.selectedVersion, before.document?.selectedVersion);
      assert.deepEqual(after.document?.document, before.document?.document);
      assert.equal(await page.locator('[data-content-document]').getAttribute('data-content-document'), original.id);
    }
    const final = await repository.read(original.id);
    assert.equal(final.checkpoint.batches.length, 3); assert.deepEqual(final.history, []);
    assert.deepEqual(final.heads, branched.heads, 'read-only selection adds no content edit or head');
    await finish();
  } catch (error) {
    console.error('Annotation variant error', error);
    for (const page of pages) console.error('Annotation variant failure', page.url(), await page.locator('body').innerText().catch(String));
    throw error;
  }
});

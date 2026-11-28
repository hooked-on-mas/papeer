import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { ContentPublication, ResourceMetadata, MarkdownImageResource } from '../src/runtime/edits/contracts.ts';
import type { MarkdownEditState } from '../src/features/notes/markdown/MarkdownEditSession.ts';
import type { DocumentEditState } from '../src/features/reader/edit/DocumentEditSession.ts';
import type { RepositoryState } from '../src/runtime/edits/ports.ts';
import { parseMarkdownCitationUri } from '../src/runtime/markdown/markdownCitations.ts';
import { gesture, openComposition, sync as deliver } from './support/documentComposition.ts';
import { managedTextReady } from './support/managedPdfReady.ts';

async function armCaptureDiagnostics(page: Page) {
  await page.evaluate(() => {
    const holder=window as unknown as {__quoteCaptureTrace?:{entries:unknown[];cleanup():void}};
    holder.__quoteCaptureTrace?.cleanup();const entries:unknown[]=[];
    const names=['pointerdown','pointerup','pointercancel','gotpointercapture','lostpointercapture'];
    const rect=(element:Element)=>{const box=element.getBoundingClientRect();return {x:box.x,y:box.y,width:box.width,height:box.height};};
    const record=(event:Event)=>{
      const pointer=event as PointerEvent,target=event.target instanceof Element?event.target:null;
      const hit=document.elementFromPoint(pointer.clientX,pointer.clientY);
      entries.push({event:event.type,at:performance.now(),pointerId:pointer.pointerId,x:pointer.clientX,y:pointer.clientY,
        target:target?{tag:target.tagName,role:target.getAttribute('role'),label:target.getAttribute('aria-label'),className:(target.getAttribute('class')??'').slice(0,160)}:null,
        hit:hit?{tag:hit.tagName,label:hit.getAttribute('aria-label'),className:(hit.getAttribute('class')??'').slice(0,160)}:null,
        ink:[...document.querySelectorAll('svg[aria-label]')].filter(value=>value.getAttribute('aria-label')?.startsWith('PDF')).slice(0,4).map(value=>({label:value.getAttribute('aria-label'),rect:rect(value),containsTarget:!!target&&value.contains(target)})),
        pressed:[...document.querySelectorAll('button[aria-pressed="true"]')].map(value=>(value.textContent??'').trim().slice(0,80)).slice(0,12),
        viewport:{width:innerWidth,height:innerHeight},visibility:document.visibilityState});
      if(entries.length>64)entries.shift();
    };
    for(const name of names)window.addEventListener(name,record,{capture:true,passive:true});
    holder.__quoteCaptureTrace={entries,cleanup(){for(const name of names)window.removeEventListener(name,record,true);}};
  });
}
async function captureDiagnostics(page: Page, phase:string, bounds?:{x:number;y:number;width:number;height:number}) {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const evidence=await Promise.race([page.evaluate(()=>{
      const holder=window as unknown as {__quoteCaptureTrace?:{entries:unknown[]};compositionStartupEvidence?:()=>{inkPointerTrace?:unknown[];activeInkPointerIds?:number[]};compositionBootstrapStatus?:()=>{state:{phase?:string;locked?:boolean;error?:string}}};
      const startup=holder.compositionStartupEvidence?.(),state=holder.compositionBootstrapStatus?.().state;
      return {pointer:holder.__quoteCaptureTrace?.entries.slice(-16),inkPointer:startup?.inkPointerTrace?.slice(-16),activeInkPointerIds:startup?.activeInkPointerIds,
        bootstrap:state?{phase:state.phase,locked:state.locked,error:state.error}:null,
        dialogs:[...document.querySelectorAll('[role="dialog"]')].map(value=>value.getAttribute('aria-label')).slice(0,4),
        alerts:[...document.querySelectorAll('[role="alert"]')].map(value=>(value.textContent??'').slice(0,200)).slice(0,4)};
    }),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('quote capture diagnostic timeout')),2000);})]);
    console.error('quote-capture-diagnostic',JSON.stringify({host:new URL(page.url()).searchParams.get('host'),phase,bounds,evidence}));
  } catch(error){console.error('quote-capture-diagnostic-unavailable',phase,String(error));}
  finally{if(timer!==undefined)clearTimeout(timer);}
}

type Observed = { state: RepositoryState; markdown?: MarkdownEditState; document?: DocumentEditState; pending: unknown[]; replication: { running: boolean } };
const observe = (page: Page, id: string): Promise<Observed> => page.evaluate(id => (window as unknown as {
  compositionObservedEvidence(id: string): Promise<Observed>;
}).compositionObservedEvidence(id), id);
// Playwright waitForFunction treats an async predicate's Promise as truthy; poll awaited observations in Node.
async function untilObserved(page: Page, id: string, predicate: (value: Observed) => boolean): Promise<Observed> {
  const deadline = Date.now() + 25_000;
  for (;;) {
    const value = await observe(page, id);
    if (predicate(value)) return value;
    assert.ok(Date.now() < deadline, `canonical observation did not settle: ${JSON.stringify(value)}`);
    await page.waitForTimeout(50);
  }
}
async function syncCurrent(page: Page, id: string, expected: { content: string; imageResources: MarkdownImageResource[] }) {
  await untilObserved(page, id, value => !value.replication.running);
  await page.getByRole('button', { name: '同期', exact: true }).click();
  await deliver(page);
  const settled = await untilObserved(page, id, value => {
    return !value.replication.running && value.pending.length === 0
      && (!value.markdown || !value.markdown.dirty && !value.markdown.saving && value.markdown.durable
        && value.markdown.content === expected.content && value.markdown.accepted?.content === expected.content
        && JSON.stringify(value.markdown.imageResources) === JSON.stringify(expected.imageResources)
        && JSON.stringify(value.markdown.accepted.imageResources) === JSON.stringify(expected.imageResources));
  });
  assert.equal(settled.pending.length, 0);
}
async function accepted(page: Page, id: string, appends: number, expected?: { content: string; imageResources: MarkdownImageResource[] }) {
  const settled = await untilObserved(page, id, value => {
    const state = value.markdown;
    return !!state?.ready && !state.dirty && !state.saving && !state.imagePending && !state.imageSaving && state.durable
      && state.accepted?.appendIds.length === appends
      && (!expected || state.content === expected.content && state.accepted.content === expected.content
        && JSON.stringify(state.imageResources) === JSON.stringify(expected.imageResources)
        && JSON.stringify(state.accepted.imageResources) === JSON.stringify(expected.imageResources));
  });
  return settled.markdown!.accepted!;
}
async function preview(page: Page) {
  await page.getByRole('button', { name: /^(プレビュー|編集)$/ }).waitFor();
  const button = page.getByRole('button', { name: 'プレビュー', exact: true }); if (await button.count()) await button.click();
}

for (const engine of ['chromium', 'webkit'] as const) test(`production PDF selection quote and canonical image append (${engine})`, { timeout: 300_000 }, async t => {
  const noteIds: string[] = [];
  const additionalPublications = (pdf: ContentPublication) => {
    const original = pdf.libraryBatch.changes.find(change => change.type === 'put-item'); assert.ok(original?.type === 'put-item');
    let parent = pdf.libraryBatch.id;
    const publications = [0, 1].map(index => {
      const id = crypto.randomUUID(); noteIds.push(id);
      const item = { ...structuredClone(original.item), id, kind: 'markdown' as const, title: `Quote destination ${index + 1}` }; delete item.resourceId;
      const libraryBatch = { ...structuredClone(pdf.libraryBatch), id: crypto.randomUUID(), parents: [parent], changes: [{ type: 'put-item' as const, item }] };
      parent = libraryBatch.id;
      return { libraryBatch, content: { kind: 'markdown' as const, id, version: crypto.randomUUID(), content: '', appendIds: [], imageResources: [] } };
    });
    return { publications, initialDocumentId: pdf.content!.id };
  };
  const { pages, publication, documentId, repository, reloadContent, finish, setCommitReplyLoss, committed, committedPayloads } = await openComposition(t, engine, undefined,
    { pdfFixture: 'text', additionalPublications, allowImageResources: true });
  assert.ok(publication.content?.kind === 'document'); const source = publication.content.pages[0];
  try {
    for (const [index, page] of pages.entries()) {
      t.diagnostic(`${index ? 'Web' : 'Native'} actual PDF text selection, quote chooser, raster capture`);
      const noteId = noteIds[index];
      await page.getByRole('button', { name: '読む', exact: true }).click();
      const witness = await managedTextReady(page, documentId, publication.libraryBatch.libraryId, source);
      const layer = witness.layer;
      const expectedQuote = await layer.evaluate(element => {
        const first = [...element.querySelectorAll('span[role="presentation"]')].map(span => span.textContent ?? '').find(Boolean);
        if (!first) throw new Error('first-text-item-missing');
        if (first.length < 8 || !/^[A-Za-z0-9 ]{8}/.test(first)) throw new Error('first-eight-not-ascii');
        return first.slice(0, 8).trim();
      });
      assert.ok(expectedQuote);
      await layer.focus(); await page.keyboard.press('Enter');
      for (let step = 0; step < 8; step++) await page.keyboard.press('Shift+ArrowRight');
      await witness.dispose();
      await page.getByRole('button', { name: '選択した文章をノートへ追加', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '引用をノートへ追加', exact: true }); await dialog.waitFor();
      await dialog.getByLabel('追加先のノート', { exact: true }).selectOption(noteId);
      const start = committed.length;
      if (!index) setCommitReplyLoss(true);
      await dialog.getByRole('button', { name: 'ノートへ追加', exact: true }).click();
      if (!index) {
        await dialog.getByRole('button', { name: '再試行', exact: true }).waitFor();
        assert.ok(await repository.readIntent(noteId)); setCommitReplyLoss(false);
        await dialog.getByRole('button', { name: '再試行', exact: true }).click();
      }
      await dialog.getByRole('button', { name: '追加先を開く', exact: true }).click();
      await page.locator(`[data-content-document="${noteId}"]`).waitFor();
      const quote = await accepted(page, noteId, 1);
      const blockquote = quote.content.split('\n').filter(line => line.startsWith('> ')).map(line => line.slice(2)).join('\n');
      assert.equal(blockquote, expectedQuote); assert.deepEqual(quote.imageResources, []);
      if (!index) {
        assert.equal(new Set(committed.slice(start)).size, 1); assert.ok(committed.length - start >= 2);
        assert.equal(new Set(committedPayloads.slice(start)).size, 1);
      }
      await preview(page);
      const citation = page.locator('a[href^="papeer://citation/"]').first();
      const quoteTarget = parseMarkdownCitationUri((await citation.getAttribute('href'))!); assert.ok(quoteTarget);
      assert.equal(quoteTarget.documentId, documentId); assert.equal(quoteTarget.pageId, source.id);
      assert.equal(quoteTarget.backgroundRevision, source.backgroundRevision); assert.equal(quoteTarget.surface, 'original');
      await citation.click(); await page.locator(`[data-content-document="${documentId}"]`).waitFor();
      await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'ペン', exact: true }).click();
      await page.getByLabel('書き込みの色', { exact: true }).fill('#ff0000');
      await page.getByLabel('線の太さ', { exact: true }).selectOption('0.006');
      const priorInkVersion = (await observe(page, documentId)).document!.selectedVersion;
      const inkBox = await page.getByLabel('PDF書き込みレイヤー', { exact: true }).boundingBox(); assert.ok(inkBox);
      await page.mouse.move(inkBox.x + inkBox.width * .18, inkBox.y + inkBox.height * .27); await page.mouse.down();
      await page.mouse.move(inkBox.x + inkBox.width * .42, inkBox.y + inkBox.height * .27, { steps: 12 }); await page.mouse.up();
      await untilObserved(page, documentId, value => value.document?.phase === 'idle' && value.document.selectedVersion !== priorInkVersion);
      let expected = quote;
      const dimensions: { width: number; height: number }[] = [];
      for (const [captureIndex, includeInk] of [true, false].entries()) {
      await armCaptureDiagnostics(page);
      await page.getByLabel('手書き・図形を含める', { exact: true }).setChecked(includeInk);
      await page.getByRole('button', { name: '範囲を画像にする', exact: true }).click();
      const surface = page.locator('[aria-label="中央の編集"]').locator('.ink-page, [data-pdf-surface]').first();
      const bounds = await surface.boundingBox(); assert.ok(bounds);
      await gesture(page, [[.15, .2], [.45, .35]]);
      await captureDiagnostics(page,'after-capture',bounds);
      await dialog.waitFor(); await dialog.getByLabel('追加先のノート', { exact: true }).selectOption(noteId);
      await dialog.getByRole('button', { name: 'ノートへ追加', exact: true }).click();
      await dialog.getByRole('button', { name: '追加先を開く', exact: true }).click(); await page.locator(`[data-content-document="${noteId}"]`).waitFor();
      const captured = await accepted(page, noteId, captureIndex + 2); assert.equal(captured.imageResources.length, captureIndex + 1); assert.ok(captured.content.startsWith(expected.content));
      await preview(page); const image = page.locator('img[src^="blob:"]').last(); await image.waitFor();
      await page.waitForFunction(count => {
        const images = [...document.querySelectorAll<HTMLImageElement>('img[src^="blob:"]')];
        return images.length === count && images.every(image => image.complete && image.naturalWidth > 0);
      }, captureIndex + 1);
      const ref = captured.imageResources.find(ref => !expected.imageResources.some(old => old.resourceId === ref.resourceId)); assert.ok(ref);
      const resource = await page.evaluate(id => (window as unknown as { compositionReadResource(id: string): Promise<{ metadata: ResourceMetadata; bytes: number[] }> }).compositionReadResource(id), ref.resourceId);
      assert.equal(resource.metadata.mediaType, 'image/png'); assert.equal(createHash('sha256').update(Buffer.from(resource.bytes)).digest('hex'), ref.sha256);
      const png = Buffer.from(resource.bytes); assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
      dimensions.push({ width, height });
      assert.ok(Math.abs(width - source.widthPt * .3 * 2) <= 3); assert.ok(Math.abs(height - source.heightPt * .15 * 2) <= 3);
      assert.deepEqual(await image.evaluate(node => ({ width: (node as HTMLImageElement).naturalWidth, height: (node as HTMLImageElement).naturalHeight })), { width, height });
      // Decode the actual rendered PNG for observation only; this canvas is not a capture input or fake renderer.
      const pixels = await image.evaluate(node => {
        const image = node as HTMLImageElement, canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
        const bytes = context.getImageData(0, 0, canvas.width, canvas.height).data; let red = 0, black = 0;
        for (let i = 0; i < bytes.length; i += 4) {
          if (bytes[i + 3] < 200) continue;
          if (bytes[i] > 180 && bytes[i + 1] < 100 && bytes[i + 2] < 100) red++;
          if (bytes[i] < 90 && bytes[i + 1] < 90 && bytes[i + 2] < 90) black++;
        }
        return { red, black };
      });
      assert.ok(pixels.black > 50, 'capture includes real PDF text pixels rather than a blank image');
      if (includeInk) assert.ok(pixels.red > 100, 'saved red pen stroke is rasterized when includeInk is enabled');
      else assert.equal(pixels.red, 0, 'the same crop excludes saved red ink when includeInk is disabled');
      t.diagnostic(JSON.stringify({ host: index ? 'web' : 'native', includeInk, width, height, ...pixels }));
      const captureTarget = parseMarkdownCitationUri((await page.locator('a[href^="papeer://citation/"]').last().getAttribute('href'))!); assert.ok(captureTarget?.anchor);
      assert.equal(captureTarget.pageId, source.id); assert.equal(captureTarget.backgroundRevision, source.backgroundRevision);
      assert.ok(Math.abs(captureTarget.anchor.xPt - source.widthPt * .15) < 2); assert.ok(Math.abs(captureTarget.anchor.yPt - source.heightPt * .2) < 2);
      await page.getByRole('button', { name: '元に戻す', exact: true }).click();
      await untilObserved(page, noteId, value => {
        const state = value.markdown;
        return state?.content === expected.content && state.accepted?.content === expected.content
          && JSON.stringify(state.imageResources) === JSON.stringify(expected.imageResources)
          && JSON.stringify(state.accepted.imageResources) === JSON.stringify(expected.imageResources)
          && !state.dirty && !state.saving && state.durable;
      });
      const undone = (await observe(page, noteId)).markdown!; assert.equal(undone.content, expected.content); assert.deepEqual(undone.imageResources, expected.imageResources);
      await page.getByRole('button', { name: 'やり直す', exact: true }).click(); await accepted(page, noteId, captureIndex + 2, captured);
      assert.equal((await observe(page, noteId)).markdown!.content, captured.content);
      expected = captured;
      if (includeInk) {
        await page.locator('a[href^="papeer://citation/"]').last().click(); await page.locator(`[data-content-document="${documentId}"]`).waitFor();
        await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();
      }
      }
      await syncCurrent(page, noteId, expected); await syncCurrent(pages[1 - index], noteId, expected);
      assert.deepEqual((await observe(pages[1 - index], noteId)).state.checkpoint, (await observe(page, noteId)).state.checkpoint);
      // The host explicitly chooses the seeded note at mount; workspace selection restoration is a separate contract.
      await reloadContent(page, noteId);
      await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).waitFor();
      const reopened = await accepted(page, noteId, 3, expected); assert.equal(reopened.content, expected.content);
      assert.deepEqual(reopened.imageResources, expected.imageResources);
      await preview(page); await page.locator('img[src^="blob:"]').first().waitFor();
      await page.waitForFunction(dimensions => {
        const images = [...document.querySelectorAll<HTMLImageElement>('img[src^="blob:"]')];
        return images.length === dimensions.length && images.every((image, index) => image.complete
          && image.naturalWidth === dimensions[index].width && image.naturalHeight === dimensions[index].height);
      }, dimensions);
    }
    await finish();
  } catch (error) {
    console.error('reference-case-error', JSON.stringify({ suite: 'quote-append', error: error instanceof Error ? { name: error.name.slice(0,80), message: error.message.slice(0,500), stack: error.stack?.slice(0,1600) } : { name: typeof error, message: typeof error === 'string' ? error.slice(0,500) : 'non-Error exception' } }));
    for (const page of pages) await captureDiagnostics(page,'failure');
    for (const page of pages) for (const id of noteIds) console.error('Quote append failure', page.url(), id, await observe(page, id).catch(String));
    throw error;
  }
});

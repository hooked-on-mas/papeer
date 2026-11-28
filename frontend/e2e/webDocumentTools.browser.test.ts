import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import type { Page, Locator } from 'playwright-core';
import type { ContentPublication, InkObject, PageAnnotation, Page as CanonicalPage } from '../src/runtime/edits/contracts.ts';
import { openComposition, evidence, gesture, sync, type Diagnostics } from './support/documentComposition.ts';
import { waitForSnapshot } from './support/waitForSnapshot.ts';

const ids = { arrow: '10000000-0000-0000-0000-000000000001', text: '10000000-0000-0000-0000-000000000002',
  path: '10000000-0000-0000-0000-000000000003', sticky: '10000000-0000-0000-0000-000000000004', highlight: '10000000-0000-0000-0000-000000000005' };
function seed(publication: ContentPublication) {
  assert.equal(publication.content?.kind, 'document');
  if (publication.content?.kind !== 'document') throw new Error('document fixture required');
  const page = publication.content.pages[0];
  const style = { color: '#456789', widthPt: 3.4, opacity: .63, highlighter: false };
  const annotations: PageAnnotation[] = [
    { kind: 'ink', id: ids.arrow, geometry: { kind: 'arrow', start: { x: 0, y: 0 }, end: { x: 150, y: 25 }, head: 'both', headLengthPt: 17, preferredHeadLengthPt: 19 },
      style, transform: { x: 100, y: 100, rotationRad: .2, scaleX: 1.4, scaleY: .65 } },
    { kind: 'ink', id: ids.text, geometry: { kind: 'text', text: 'Serif source\n原文を保持', fontFamily: 'Georgia', fontSizePt: 18, widthPt: 190, heightPt: 60 },
      style, transform: { x: 450, y: 90, rotationRad: -.05, scaleX: .9, scaleY: 1.2 } },
    { kind: 'ink', id: ids.path, geometry: { kind: 'path', points: [{ x: 0, y: 0 }, { x: 140, y: 0 }, { x: 280, y: 0 }] },
      style, transform: { x: 120, y: 520, rotationRad: .2, scaleX: 1.2, scaleY: .7 } },
    { kind: 'sticky', id: ids.sticky, text: 'Non-ink sticky is retained', anchor: { x: 650, y: 600 }, color: '#abcdef', metadata: { label: 'source', createdAt: null } },
    { kind: 'highlight', id: ids.highlight, backgroundRevision: page.backgroundRevision, range: { kind: 'unindexed' }, quote: 'original quote', text: 'non-ink highlight',
      anchor: { x: 100, y: 800 }, quads: [[{ x: 100, y: 800 }, { x: 200, y: 800 }, { x: 200, y: 820 }, { x: 100, y: 820 }]], color: '#facc15', metadata: { label: 'source', createdAt: null } },
  ];
  page.annotations = annotations;
}
async function idle(page: Page, count?: number, pageIndex = 0) {
  await page.waitForFunction(({ count, pageIndex }) => {
    const value = (window as unknown as { compositionDiagnostics?: () => Diagnostics }).compositionDiagnostics?.();
    return !!value?.session.ready && value.session.phase === 'idle' && !value.session.inputActive
      && (count === undefined || value.session.document?.pages[pageIndex].annotations.length === count);
  }, { count, pageIndex });
}
async function annotations(page: Page, pageIndex = 0) { return (await evidence(page)).session.document!.pages[pageIndex].annotations; }
async function bounds(locator: Locator) {
  const page = locator.page();
  const box = await waitForSnapshot(async () => {
    if (await locator.count() !== 1) return null;
    try {
      const scrolled = await locator.evaluate(element => {
        const scroller = element.closest('[data-pdf-scroller]');
        const ink = element.closest('svg[aria-label="PDF書き込みレイヤー"]');
        if (!element.isConnected || !ink || scroller?.getAttribute('data-rendered') !== 'true') return false;
        element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        return true;
      }, undefined, { timeout: 2_000 });
      if (!scrolled) return null;
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      return await locator.evaluate(element => {
        const scroller = element.closest('[data-pdf-scroller]');
        const ink = element.closest('svg[aria-label="PDF書き込みレイヤー"]');
        if (!element.isConnected || !ink || scroller?.getAttribute('data-rendered') !== 'true') return null;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
      }, undefined, { timeout: 2_000 });
    } catch { return null; }
  }, value => value !== null);
  assert.ok(box); return box;
}
async function lassoLayout(page: Page, id: string) {
  return page.evaluate(id => {
    const layer = document.querySelector('[aria-label="PDF書き込みレイヤー"]');
    const object = document.querySelector(`[data-ink-id="${id}"]`);
    return { object: object?.getBoundingClientRect().toJSON(), layer: layer?.getBoundingClientRect().toJSON(),
      canonicalPages: [...document.querySelectorAll('[data-canonical-page]')].map(element => ({
        id: element.getAttribute('data-canonical-page'), rect: element.getBoundingClientRect().toJSON() })),
      panes: [...document.querySelectorAll('[data-pdf-scroller],.web-pdf-pane')].map(pane => ({
        top: pane.scrollTop, left: pane.scrollLeft, clientHeight: pane.clientHeight, clientWidth: pane.clientWidth })) };
  }, id);
}
async function startLassoProbe(page: Page) {
  await page.evaluate(() => {
    const events: unknown[] = [];
    const listen = (event: PointerEvent) => {
      const layer = document.querySelector('[aria-label="PDF書き込みレイヤー"]');
      const target = event.target instanceof Element ? event.target : null;
      const observation = { event: event.type, x: event.clientX, y: event.clientY,
        target: { tag: target?.tagName, label: target?.getAttribute('aria-label') }, layer: layer?.getBoundingClientRect().toJSON() };
      queueMicrotask(() => {
        const state = (window as unknown as { compositionDiagnostics(): Diagnostics }).compositionDiagnostics().session;
        events.push({ ...observation, ready: state.ready, commandPhase: state.phase, error: state.error, inputActive: state.inputActive,
          version: state.document?.version, pages: state.document?.pages.map(page => ({ id: page.id, count: page.annotations.length })),
          selected: Object.fromEntries(Object.entries(state.surfaces).map(([id, surface]) => [id, [...surface.selectedIds]])) });
      });
    };
    const names = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const;
    for (const name of names) window.addEventListener(name, listen, true);
    Object.assign(window, { compositionLassoProbe: { events, remove: () => {
      for (const name of names) window.removeEventListener(name, listen, true);
    } } });
  });
}
async function paintedBounds(page: Page, target: CanonicalPage, selector = 'svg[aria-label="PDF書き込みレイヤー"]') {
  assert.equal(target.background.kind, 'pdf');
  if (target.background.kind !== 'pdf') throw new Error('PDF drawing fixture required');
  const expected = { id: target.id, revision: target.backgroundRevision, physical: target.background.pdfPage };
  const readBox = (scroll = false) => page.evaluate(({ expected, scroll, selector }) => {
    const active = document.querySelector('[data-reader-surface][data-active-surface="true"]');
    const frame = active?.querySelector(`[data-canonical-page="${expected.id}"][data-background-revision="${expected.revision}"]`);
    const marker = frame?.querySelector('[data-rendered="true"]');
    const raster = marker?.querySelector(`.react-pdf__Page[data-page-number="${expected.physical}"] canvas`) as HTMLCanvasElement | null;
    const ink = frame?.querySelector('svg[aria-label="PDF書き込みレイヤー"]');
    if (!marker || !raster || !ink?.isConnected || !marker.contains(ink)) return null;
    const element = frame?.querySelector(selector);
    if (!element?.isConnected || (element !== ink && !ink.contains(element))) return null;
    const canvasBox = raster.getBoundingClientRect(), box = element.getBoundingClientRect(), style = getComputedStyle(ink);
    if (!(raster.width > 0 && raster.height > 0 && canvasBox.width > 0 && canvasBox.height > 0
      && box.width > 0 && box.height > 0) || style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return null;
    if (scroll) element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }, { expected, scroll, selector });
  const box = await waitForSnapshot(async () => {
    // Scroll the currently mounted layer in the same DOM turn. A fit-page
    // redraw may replace it before a pinned element's stability wait finishes.
    if (!await readBox(true)) return null;
    // A tool's controls can resize the fit-page raster. Observe its actual
    // current render after scrolling, before projecting any input coordinates.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    return readBox();
  }, value => value !== null);
  assert.ok(box);
  return box;
}
async function drawOnPaintedPage(page: Page, points: [number, number][], target: CanonicalPage) {
  const box = await paintedBounds(page, target);
  // Same single input sequence as the existing gesture helper; no resend.
  await page.mouse.move(box.x + points[0][0] * box.width, box.y + points[0][1] * box.height);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) await page.mouse.move(box.x + x * box.width, box.y + y * box.height, { steps: 12 });
  await page.mouse.up();
}
function ink(values: PageAnnotation[], id: string): InkObject {
  const value = values.find(value => value.id === id); assert.equal(value?.kind, 'ink'); return value as InkObject;
}
async function clickAt(page: Page, x: number, y: number) {
  const box = await bounds(page.getByLabel('PDF書き込みレイヤー', { exact: true }));
  await page.mouse.click(box.x + x * box.width, box.y + y * box.height);
}
async function select(page: Page, id: string) {
  await page.getByRole('button', { name: '範囲選択', exact: true }).click();
  const target = (await evidence(page)).session.document?.pages.find(value => value.annotations.some(annotation => annotation.id === id));
  assert.ok(target, `selection annotation must belong to an actual page: ${id}`);
  const object = page.locator(`[data-ink-id="${id}"]`), box = await paintedBounds(page, target, `[data-ink-id="${id}"]`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  try { await page.getByRole('button', { name: 'コピー', exact: true }).click({ trial: true }); }
  catch (error) {
    console.error('selection-failure', id, box, await object.evaluate(element => element.outerHTML), (await evidence(page)).session);
    await page.screenshot({ path: path.resolve(import.meta.dirname, '../../output/document-tools-selection.png') }); throw error;
  }
  const state = (await evidence(page)).session;
  assert.ok(Object.values(state.surfaces).some(surface => surface.selectedIds.includes(id)));
}
async function changed(page: Page, previous: string) {
  await page.waitForFunction(version => {
    const state = (window as unknown as { compositionDiagnostics(): Diagnostics }).compositionDiagnostics().session;
    return state.phase === 'idle' && !state.inputActive && state.document?.version !== version;
  }, previous);
}
async function action(page: Page, name: string) {
  const previous = (await evidence(page)).session.document!.version;
  await page.getByRole('button', { name, exact: true }).click(); await changed(page, previous);
}
async function navigate(page: Page, number: number) {
  await page.getByLabel('ページ番号', { exact: true }).fill(String(number));
  await page.getByLabel('ページ番号', { exact: true }).press('Enter');
  await page.waitForFunction(expected => (document.querySelector('[aria-label="ページ番号"]') as HTMLInputElement)?.value === String(expected), number);
  await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();
}
async function createText(page: Page, x: number, y: number, text: string) {
  await page.getByRole('button', { name: '文字', exact: true }).click(); await clickAt(page, x, y);
  await page.getByRole('textbox', { name: '書き込みテキスト', exact: true }).fill(text);
}

for (const engine of ['chromium', 'webkit'] as const) test(`production canonical drawing tools, exact imported geometry, clipboard and retained text drafts (${engine})`, { timeout: 360_000 }, async t => {
  const { native, web, pages, publication, reload, finish, loseNextCommitReply, committed, repository, documentId } = await openComposition(t, engine, seed);
  assert.equal(publication.content?.kind, 'document');
  if (publication.content?.kind !== 'document') throw new Error('document fixture required');
  const original = publication.content.pages[0].annotations;
  const originalArrow = ink(original, ids.arrow), originalText = ink(original, ids.text), originalPath = ink(original, ids.path);
  for (const page of pages) assert.deepEqual(await annotations(page), original);

  // Both hosts operate on the same canonical imported objects, never their lossy screen projection.
  for (const [index, page] of pages.entries()) {
    t.diagnostic(`${index ? 'Web' : 'Native'}: canonical seeded-object operations`);
    await page.getByRole('button', { name: 'なげなわ', exact: true }).click();
    const originalArrowBox = await bounds(page.locator(`[data-ink-id="${ids.arrow}"]`));
    const afterObjectScroll = await lassoLayout(page, ids.arrow);
    await bounds(page.getByLabel('PDF書き込みレイヤー', { exact: true }));
    const afterLayerScroll = await lassoLayout(page, ids.arrow);
    await startLassoProbe(page); const beforeGesture = await lassoLayout(page, ids.arrow);
    // Both scrolling operations are complete. Measure object and layer in one
    // browser turn so their client coordinates refer to the same layout.
    const arrowBox = beforeGesture.object, layerBox = beforeGesture.layer;
    assert.ok(arrowBox && layerBox && layerBox.width > 0 && layerBox.height > 0);
    const left = (arrowBox.x - layerBox.x - 10) / layerBox.width, right = (arrowBox.x + arrowBox.width - layerBox.x + 10) / layerBox.width;
    const top = (arrowBox.y - layerBox.y - 10) / layerBox.height, bottom = (arrowBox.y + arrowBox.height - layerBox.y + 10) / layerBox.height;
    try {
      await gesture(page, [[left, top], [right, top], [right, bottom], [left, bottom], [left, top]]);
      assert.ok(Object.values((await evidence(page)).session.surfaces).some(surface => surface.selectedIds.includes(ids.arrow)));
    } catch (error) {
      console.error('lasso-coordinate-diagnostic', JSON.stringify({ engine, index, originalArrowBox, arrowBox, layerBox, afterObjectScroll, afterLayerScroll, beforeGesture,
        events: await page.evaluate(() => (window as unknown as { compositionLassoProbe: { events: unknown[] } }).compositionLassoProbe.events).catch(String),
        afterGesture: await lassoLayout(page, ids.arrow).catch(String) }));
      throw error;
    } finally {
      await page.evaluate(() => (window as unknown as { compositionLassoProbe: { remove(): void } }).compositionLassoProbe.remove()).catch(() => {});
    }
    await select(page, ids.arrow);
    const beforeStyle = ink(await annotations(page), ids.arrow);
    let version = (await evidence(page)).session.document!.version;
    await page.getByLabel('書き込みの色', { exact: true }).fill(index ? '#228855' : '#225588'); await changed(page, version);
    version = (await evidence(page)).session.document!.version;
    await page.getByLabel('線の太さ', { exact: true }).selectOption(index ? '0.015' : '0.006'); await changed(page, version);
    let current = ink(await annotations(page), ids.arrow);
    assert.deepEqual(current.geometry, originalArrow.geometry); assert.deepEqual(current.transform, originalArrow.transform);
    assert.equal(current.style.opacity, .63); assert.equal(current.style.highlighter, false);
    assert.equal(current.style.color, index ? '#228855' : '#225588'); assert.notEqual(current.style.widthPt, beforeStyle.style.widthPt);
    assert.deepEqual(ink(await annotations(page), ids.text), originalText);
    const baseCount = (await annotations(page)).length;
    await page.getByRole('button', { name: 'コピー', exact: true }).click();
    await action(page, '貼り付け'); await idle(page, baseCount + 1);
    const pasted = (await annotations(page))[baseCount] as InkObject;
    assert.notEqual(pasted.id, ids.arrow); assert.deepEqual(pasted.geometry, current.geometry); assert.deepEqual(pasted.style, current.style);
    assert.equal(pasted.transform.scaleX, current.transform.scaleX); assert.equal(pasted.transform.scaleY, current.transform.scaleY);
    await action(page, '切り取り'); await idle(page, baseCount);
    await action(page, '貼り付け'); await idle(page, baseCount + 1);
    await action(page, '複製'); await idle(page, baseCount + 2);
    const copies = (await annotations(page)).slice(-2) as InkObject[];
    assert.equal(new Set(copies.map(value => value.id)).size, 2);
    copies.forEach(value => { assert.deepEqual(value.geometry, current.geometry); assert.equal(value.style.opacity, .63); });
    // Delete only the two new copies, leaving the imported order and objects intact.
    await action(page, '削除'); await idle(page, baseCount + 1);
    await select(page, copies[0].id); await action(page, '削除'); await idle(page, baseCount);
    await select(page, ids.arrow);
    const beforeShape = ink(await annotations(page), ids.arrow);
    const handle = await bounds(page.locator('[data-shape-handle="1"]'));
    version = (await evidence(page)).session.document!.version;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 25, handle.y + handle.height / 2 + 12, { steps: 8 }); await page.mouse.up(); await changed(page, version);
    current = ink(await annotations(page), ids.arrow);
    assert.equal(current.geometry.kind, 'arrow'); if (current.geometry.kind === 'arrow') { assert.equal(current.geometry.head, 'both'); assert.equal(current.geometry.preferredHeadLengthPt, 19); }
    assert.deepEqual(current.style, beforeShape.style); assert.deepEqual(current.transform, beforeShape.transform);
    assert.notDeepEqual(current.geometry, beforeShape.geometry);
    await action(page, '元に戻す'); assert.deepEqual(ink(await annotations(page), ids.arrow), beforeShape);
    await select(page, ids.text);
    const textBox = await bounds(page.locator(`[data-ink-id="${ids.text}"]`));
    version = (await evidence(page)).session.document!.version;
    await page.mouse.move(textBox.x + textBox.width / 2, textBox.y + textBox.height / 2); await page.mouse.down();
    await page.mouse.move(textBox.x + textBox.width / 2 + 20, textBox.y + textBox.height / 2 + 10, { steps: 8 }); await page.mouse.up(); await changed(page, version);
    assert.deepEqual(ink(await annotations(page), ids.text).geometry, originalText.geometry);
    assert.notDeepEqual(ink(await annotations(page), ids.text).transform, originalText.transform);
    await action(page, '元に戻す');
    await action(page, '15度回転'); await action(page, '書き込みを拡大'); await action(page, '書き込みを縮小');
    assert.deepEqual(ink(await annotations(page), ids.text).geometry, originalText.geometry);
    assert.deepEqual(ink(await annotations(page), ids.text).style, originalText.style);
    await action(page, '元に戻す'); await action(page, '元に戻す'); await action(page, '元に戻す');
    assert.deepEqual(ink(await annotations(page), ids.text), originalText);
    const editBox = await bounds(page.locator(`[data-ink-id="${ids.text}"]`));
    await page.mouse.dblclick(editBox.x + editBox.width / 2, editBox.y + editBox.height / 2);
    await page.getByRole('textbox', { name: '書き込みテキスト', exact: true }).fill('Edited serif\n書体を保持');
    await action(page, '確定');
    const editedText = ink(await annotations(page), ids.text);
    assert.equal(editedText.geometry.kind, 'text');
    if (editedText.geometry.kind === 'text') { assert.equal(editedText.geometry.fontFamily, 'Georgia'); assert.equal(editedText.geometry.fontSizePt, 18); assert.equal(editedText.geometry.text, 'Edited serif\n書体を保持'); }
    assert.deepEqual(editedText.style, originalText.style); assert.deepEqual(editedText.transform, originalText.transform);
    await action(page, '元に戻す'); assert.deepEqual(ink(await annotations(page), ids.text), originalText);
    // One partial eraser gesture creates two fragments in place and one shared history record.
    await page.getByRole('button', { name: '消しゴム', exact: true }).click();
    await page.getByLabel('部分消しゴム', { exact: true }).check();
    const before = await evidence(page), pathBox = await bounds(page.locator(`[data-ink-id="${ids.path}"]`));
    const x = pathBox.x + pathBox.width / 2, y = pathBox.y + pathBox.height / 2;
    await page.mouse.move(x, y - 25); await page.mouse.down(); await page.mouse.move(x, y + 25, { steps: 15 }); await page.mouse.up();
    await changed(page, before.session.document!.version); await idle(page, baseCount + 1);
    const after = await evidence(page), fragments = (await annotations(page)).filter(value => value.kind === 'ink' && value.geometry.kind === 'path') as InkObject[];
    assert.equal(after.state.history.length, before.state.history.length + 1); assert.equal(fragments.length, 2);
    fragments.forEach(value => { assert.deepEqual(value.style, originalPath.style); assert.deepEqual(value.transform, originalPath.transform); });
    assert.deepEqual((await annotations(page)).slice(-2), original.slice(-2));
    assert.deepEqual((await annotations(page)).slice(0, 3).map(value => value.id), [ids.arrow, ids.text, ids.path]);
    await action(page, '元に戻す'); await idle(page, baseCount); assert.deepEqual(ink(await annotations(page), ids.path), originalPath);
    await action(page, 'やり直す'); await idle(page, baseCount + 1); await action(page, '元に戻す'); await idle(page, baseCount);
    await sync(page); await sync(pages[1 - index]);
  }

  // Seven kinds are created through the real toolbar on each host, on a separate logical page.
  for (const [index, page] of pages.entries()) {
    t.diagnostic(`${index ? 'Web' : 'Native'}: seven drawing kinds`);
    await navigate(page, 2); const before = await annotations(page, 1), left = index ? .56 : .12;
    await startLassoProbe(page);
    try {
      for (const [offset, kind] of ['pen', 'highlighter', 'line', 'arrow', 'rectangle', 'ellipse'].entries()) {
        try {
          await page.getByLabel('描画の種類', { exact: true }).selectOption(kind);
          await drawOnPaintedPage(page, [[left, .12 + offset * .10], [left + .20, .14 + offset * .10]], publication.content.pages[1]);
          await idle(page, before.length + offset + 1, 1);
        } catch (error) {
          console.error('drawing-kind-diagnostic', JSON.stringify({ engine, index, offset, kind, expectedCount: before.length + offset + 1,
            points: [[left, .12 + offset * .10], [left + .20, .14 + offset * .10]],
            state: await page.evaluate(() => (window as unknown as { compositionDiagnostics(): Diagnostics }).compositionDiagnostics().session).catch(String),
            layout: await lassoLayout(page, ids.arrow).catch(String),
            events: await page.evaluate(() => (window as unknown as { compositionLassoProbe: { events: unknown[] } }).compositionLassoProbe.events).catch(String) }));
          throw error;
        }
      }
    } finally {
      await page.evaluate(() => (window as unknown as { compositionLassoProbe: { remove(): void } }).compositionLassoProbe.remove()).catch(() => {});
    }
    await createText(page, left, .78, `New ${index ? 'Web' : 'PC'} text\n二行目`); await action(page, '確定'); await idle(page, before.length + 7, 1);
    const created = (await annotations(page, 1)).slice(before.length) as InkObject[];
    assert.deepEqual(created.map(value => value.geometry.kind), ['path', 'path', 'line', 'arrow', 'rect', 'ellipse', 'text']);
    assert.equal(created[0].style.highlighter, false); assert.equal(created[1].style.highlighter, true);
    await page.getByRole('button', { name: '消しゴム', exact: true }).click(); await page.getByLabel('部分消しゴム', { exact: true }).uncheck();
    await page.getByLabel('蛍光ペンだけ消す', { exact: true }).check();
    await gesture(page, [[left + .10, .08], [left + .10, .26]]); await idle(page, before.length + 6, 1);
    const erased = await annotations(page, 1); assert.ok(erased.some(value => value.id === created[0].id)); assert.ok(!erased.some(value => value.id === created[1].id));
    await action(page, '元に戻す'); await idle(page, before.length + 7, 1);
    await page.getByLabel('蛍光ペンだけ消す', { exact: true }).uncheck();
    await sync(page); await sync(pages[1 - index]);
  }
  assert.deepEqual((await evidence(native)).session.document, (await evidence(web)).session.document);

  // A page-2 text draft owns navigation and survives real unmount/remount of the same binding.
  const selectedForDraft = (await annotations(web, 1)).find(value => value.kind === 'ink' && value.geometry.kind === 'text')!;
  await select(web, selectedForDraft.id); await web.getByRole('button', { name: 'コピー', exact: true }).click();
  await createText(web, .65, .88, 'Held draft across remount\n未確定の文字');
  const draftEvidence = await evidence(web), draftState = draftEvidence.session, page2 = draftState.document!.pages[1].id;
  const draft = structuredClone(draftState.surfaces[page2].textDraft); assert.ok(draft);
  await clickAt(web, .05, .05);
  assert.equal(await web.getByLabel('PDF書き込みレイヤー', { exact: true }).evaluate(element => element === document.activeElement), true);
  for (const key of ['Delete', 'ArrowRight', 'ArrowLeft', 'Control+v']) await web.keyboard.press(key);
  const afterKeys = await evidence(web);
  assert.deepEqual(afterKeys.session.document, draftState.document); assert.deepEqual(afterKeys.state.history, draftEvidence.state.history);
  assert.deepEqual(afterKeys.session.surfaces[page2].textDraft, draft);
  assert.equal(afterKeys.session.inputActive, true);
  assert.equal(await web.getByRole('button', { name: '前のページ', exact: true }).isDisabled(), true);
  assert.equal(await web.getByLabel('ページ番号', { exact: true }).inputValue(), '2');
  assert.equal(await web.getByLabel('PDF書き込みレイヤー', { exact: true }).evaluate(element =>
    element.closest('[data-canonical-page]')?.getAttribute('data-canonical-page')), page2);
  await native.getByLabel('描画の種類', { exact: true }).selectOption('pen');
  await gesture(native, [[.15, .9], [.35, .9]]); await idle(native, 15, 1); await sync(native);
  await web.getByRole('button', { name: '同期', exact: true }).click();
  await web.evaluate(() => (window as unknown as { compositionDeliver(): Promise<void> }).compositionDeliver());
  const received = await evidence(web), sent = await evidence(native);
  assert.deepEqual(received.state.heads, sent.state.heads);
  assert.notDeepEqual(received.state.heads, draftState.heads);
  assert.equal(received.session.selectedVersion, draftState.selectedVersion);
  assert.deepEqual((await evidence(web)).session.surfaces[page2].textDraft, draft);
  assert.equal((await evidence(web)).session.document!.version, draftState.document!.version);
  await web.evaluate(async () => {
    const lifecycle = window as unknown as { compositionUnmount(): void; compositionRemount(): Promise<void> };
    lifecycle.compositionUnmount(); await lifecycle.compositionRemount();
  });
  await web.getByRole('textbox', { name: '書き込みテキスト', exact: true }).waitFor();
  assert.equal(await web.getByLabel('ページ番号', { exact: true }).inputValue(), '2');
  assert.equal(await web.getByRole('textbox', { name: '書き込みテキスト', exact: true }).inputValue(), draft!.text);
  await web.getByRole('button', { name: 'キャンセル', exact: true }).click(); await idle(web);
  await sync(web); await idle(web, 15, 1);

  await createText(native, .55, .9, 'Text save survives lost response'); loseNextCommitReply();
  await native.getByRole('button', { name: '確定', exact: true }).click();
  await native.getByRole('button', { name: '再試行', exact: true }).waitFor();
  const lostId = committed[committed.length - 1]; assert.ok(await repository.readIntent(documentId));
  await native.getByRole('button', { name: '再試行', exact: true }).click(); await idle(native, 16, 1);
  assert.equal(committed.filter(id => id === lostId).length, 2);
  await sync(native); await sync(web); await idle(web, 16, 1);
  for (const page of pages) { await reload(page); await idle(page, 5); }
  assert.deepEqual((await evidence(native)).session.document, (await evidence(web)).session.document);
  assert.deepEqual((await annotations(native)).slice(-2), original.slice(-2));
  assert.deepEqual(ink(await annotations(native), ids.text), originalText); assert.deepEqual(ink(await annotations(native), ids.path), originalPath);
  assert.equal((await annotations(native, 1)).length, 16);
  await finish();
});

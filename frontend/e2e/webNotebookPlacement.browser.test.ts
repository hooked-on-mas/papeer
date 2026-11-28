import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright-core';
import type { ReadingData } from '../src/api/hooks';

for (const engine of ['chromium', 'webkit'] as const) {
test(`desktop production ReaderArea keeps one notebook writer across central/panel, Undo and restart (${engine})`, { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, '..');
  const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), logLevel: 'error',
    cacheDir: 'node_modules/.vite-notebook-placement', optimizeDeps: { entries: ['e2e/fixtures/notebookPlacement.html'] },
    server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [path.resolve(frontend, '..')] } } });
  await server.listen(); t.after(() => server.close());
  const browser = engine === 'chromium' ? await chromium.launch({ channel: 'msedge', headless: true }) : await webkit.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const owner = 'a'.repeat(32), id = 'b'.repeat(32), pageId = 'c'.repeat(32);
  const note: any = { id, kind: 'notebook', title: '同じ手書きノート', parent_id: owner, collection_name: '', note_position: 0, revision: 'base',
    document: { version: 1, revision: 1, pages: [{ id: pageId, size: 'A4', orientation: 'portrait', template: 'blank', color: 'white', width_mm: 210, height_mm: 297 }] }, ink: { [pageId]: [] } };
  const rows: Record<string, any> = { [owner]: { id: owner, title: '親資料', kind: 'pdf', pages: 1, parent_id: null, collection_name: '', original_name: 'fixture.pdf', status: 'not_translated' },
    [id]: { ...note, pages: 1, original_name: 'notebook.pdf', status: 'not_translated' } };
  const pdf = readFileSync(path.resolve(frontend, '../tests/fixtures/sample.pdf'));
  const reading = { page_count: 1, source_page_count: 1, empty_pages: [], translation_required_pages: [], ocr_pages: [], ocr_applied: [],
    completed_pages: [], preview: null, in_progress: false, report: null, translated_pages: {}, page_versions: {}, last_page: 1,
    has_translated: false, has_article: false, has_interleaved: false, original_mtime: 1, outline: [] } satisfies ReadingData;
  let revision = 0, failSave = false; const writes: string[] = [];
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request(), url = new URL(request.url()), p = url.pathname;
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status, headers });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (p.endsWith('/files/original.pdf')) return route.fulfill({ body: pdf, contentType: 'application/pdf', headers });
    if (p === `/api/notes/${id}/document`) {
      if (request.method() === 'PUT') {
        if (failSave) return reply({ detail: 'fixture storage unavailable' }, 503);
        const body = request.postDataJSON(); assert.equal(body.revision, note.revision);
        Object.assign(note, body.note, { revision: 'accepted-' + ++revision }); writes.push(p);
      }
      return reply(note);
    }
    if (request.method() !== 'GET') {
      assert.ok(!p.includes('/ink'), 'the notebook used a second page writer'); return reply({});
    }
    if (p === '/api/notes' || p === '/api/notebooks') return reply([rows[id]]);
    if (p === `/api/notebooks/${id}`) return reply(note.document);
    if (p === `/api/notebooks/${id}/ink`) return reply(Object.fromEntries(Object.entries(note.ink).map(([key, strokes]) => [key, { strokes }])));
    if (p.endsWith('/reading')) return reply(reading);
    if (/\/api\/papers\/[a-f0-9]{32}$/.test(p)) return reply(rows[p.split('/').pop()!]);
    if (p.endsWith('/ink-v2/original/1')) return reply({ strokes: [] });
    return reply([]);
  });
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/notebookPlacement.html`);
  const central = page.getByLabel('PDF書き込みレイヤー', { exact: true }).first();
  const draw = async (surface: typeof central) => {
    await surface.waitFor(); const rect = (await surface.boundingBox())!;
    await page.mouse.move(rect.x + rect.width * .3, rect.y + rect.height * .25); await page.mouse.down();
    await page.mouse.move(rect.x + rect.width * .5, rect.y + rect.height * .35, { steps: 5 }); await page.mouse.up();
  };
  const savedCount = async (count: number) => { await page.waitForFunction(count => document.querySelectorAll('[data-ink-id]').length === count, count); };
  await draw(central); await savedCount(1);
  await page.waitForFunction(() => localStorage.getItem('papeer-handwriting:' + 'b'.repeat(32)) === null);
  assert.equal(note.ink[pageId].length, 1);
  await page.getByRole('button', { name: '親資料の右ノートへ', exact: true }).click();
  const right = page.getByLabel('手書きノートの用紙', { exact: true }); await right.waitFor();
  await draw(right);
  await page.getByRole('button', { name: '中央で開く', exact: true }).click();
  await central.waitFor(); await savedCount(2);
  await draw(central); await savedCount(3);
  await page.keyboard.press('Control+z'); await savedCount(2);
  await page.waitForFunction(() => localStorage.getItem('papeer-handwriting:' + 'b'.repeat(32)) === null);
  assert.equal(note.ink[pageId].length, 2, 'Undo discarded the line from the right panel');
  await page.keyboard.press('Control+y'); await savedCount(3);
  await page.getByRole('button', { name: '親資料の右ノートへ', exact: true }).click(); await right.waitFor();
  await page.getByRole('button', { name: '元に戻す', exact: true }).click();
  assert.equal(await right.locator('polyline').count(), 2, 'the right panel used an old independent Undo stack');
  await page.waitForFunction(() => localStorage.getItem('papeer-handwriting:' + 'b'.repeat(32)) === null);
  failSave = true; await draw(right);
  await page.getByRole('alert').filter({ hasText: 'fixture storage unavailable' }).waitFor();
  await page.getByRole('button', { name: '中央で開く', exact: true }).click(); await central.waitFor(); await savedCount(3);
  assert.equal(note.ink[pageId].length, 2, 'failed save should remain a shared draft');
  failSave = false; await page.getByRole('button', { name: '再試行', exact: true }).click();
  await page.waitForFunction(() => localStorage.getItem('papeer-handwriting:' + 'b'.repeat(32)) === null);
  assert.equal(note.ink[pageId].length, 3);
  assert.ok(writes.length >= 4); assert.ok(writes.every(p => p === `/api/notes/${id}/document`));
  await page.reload(); await central.waitFor(); await savedCount(3);
  // A second input or keyboard action can move the editor while a pointer is held.
  // Parent owner cleanup must finalize the child surface before revoking its token.
  const held = (await central.boundingBox())!;
  await page.mouse.move(held.x + held.width * .3, held.y + held.height * .25); await page.mouse.down();
  await page.mouse.move(held.x + held.width * .5, held.y + held.height * .35, { steps: 5 });
  await page.getByRole('button', { name: '親資料の右ノートへ', exact: true }).evaluate(button => (button as HTMLElement).click());
  await right.waitFor(); await page.mouse.up();
  assert.equal(await right.locator('polyline').count(), 4, 'central owner release discarded its active gesture');
  const rightBox = (await right.boundingBox())!;
  await page.mouse.move(rightBox.x + 50, rightBox.y + 50); await page.mouse.down();
  await page.mouse.move(rightBox.x + 100, rightBox.y + 80, { steps: 5 });
  await page.getByRole('button', { name: '中央で開く', exact: true }).evaluate(button => (button as HTMLElement).click());
  await central.waitFor(); await page.mouse.up(); await savedCount(5);
  if (engine === 'chromium') {
    // A pen shape remains pending for 300 ms after pointerup. Keyboard navigation
    // has no outside pointerdown to flush it, but must preserve this completed shape.
    await page.evaluate(async () => { const modulePath = '/src/features/reader/useInkEditor.ts'; const module = await import(modulePath); module.useInkTools.getState().setTool('rectangle'); });
    const box = (await central.boundingBox())!, cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x + box.width * .3, y: box.y + box.height * .25, button: 'left', buttons: 1, pointerType: 'pen', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + box.width * .5, y: box.y + box.height * .35, button: 'left', buttons: 1, pointerType: 'pen' });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + box.width * .5, y: box.y + box.height * .35, button: 'left', buttons: 0, pointerType: 'pen', clickCount: 1 });
    await page.getByRole('button', { name: '親資料の右ノートへ', exact: true }).evaluate(button => (button as HTMLElement).click());
    await right.waitFor();
    await page.waitForFunction(() => localStorage.getItem('papeer-handwriting:' + 'b'.repeat(32)) === null);
    assert.equal(note.ink[pageId].length, 6, 'owner release discarded the lifted pen shape');
  }
  assert.deepEqual(errors, []);
});
}

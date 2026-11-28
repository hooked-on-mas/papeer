import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

test('PC/Web note compositions execute the same session/render entries and preserve history across remount', { timeout: 120_000 }, async t => {
  const frontend = path.resolve(import.meta.dirname, '..');
  const server = await createServer({ root: frontend, configFile: path.join(frontend, 'vite.config.ts'), logLevel: 'error',
    cacheDir: 'node_modules/.vite-shared-note-sessions', optimizeDeps: { entries: ['e2e/fixtures/sharedNoteSessions.html'] },
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, fs: { allow: [path.resolve(frontend, '..')] } } });
  await server.listen(); t.after(() => server.close());
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const mdId = 'a'.repeat(32), inkId = 'b'.repeat(32), pageId = 'c'.repeat(32);
  const base = { parent_id: null, collection_name: '', note_position: 0, revision: 'base' };
  const notes: Record<string, any> = {
    [mdId]: { ...base, id: mdId, kind: 'markdown', title: 'Markdown fixture', content: 'base' },
    [inkId]: { ...base, id: inkId, kind: 'notebook', title: 'Notebook fixture', document: { version: 1, revision: 1,
      pages: [{ id: pageId, size: 'A4', orientation: 'portrait', template: 'blank', color: 'white', width_mm: 210, height_mm: 297 }] }, ink: {} },
  };
  let revision = 0;
  let holdNextInkSave = false;
  let releaseInkSave: (() => void) | undefined;
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request(), url = new URL(request.url());
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    if (url.pathname === '/api/note-templates') { await route.fulfill({ json: [], headers }); return; }
    const match = /^\/api\/notes\/([a-f0-9]{32})(?:\/document)?$/.exec(url.pathname);
    if (!match) { await route.abort(); return; }
    const id = match[1];
    if (request.method() !== 'GET') {
      const body = request.postDataJSON();
      if (id === inkId && holdNextInkSave) {
        holdNextInkSave = false;
        await new Promise<void>(resolve => { releaseInkSave = resolve; });
      }
      assert.equal(body.revision, notes[id].revision);
      notes[id] = { ...notes[id], ...(body.note ?? { content: body.content }), revision: `saved-${++revision}` };
    }
    await route.fulfill({ json: notes[id], headers });
  });
  await page.goto(`${server.resolvedUrls!.local[0]}e2e/fixtures/sharedNoteSessions.html`);
  for (const host of ['desktop', 'web']) {
    await page.getByRole('button', { name: host, exact: true }).click();
    await page.getByRole('button', { name: 'Markdown fixture', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Markdownノート' });
    await editor.fill(`typed in ${host}`);
    await page.getByRole('button', { name: 'プレビュー', exact: true }).click();
    await page.getByRole('button', { name: '編集', exact: true }).click();
    await editor.press('Control+z');
    assert.equal(await editor.innerText(), 'base', `${host} lost CodeMirror history during preview`);
    await editor.press('Control+y'); assert.equal(await editor.innerText(), `typed in ${host}`);
    if (host === 'web') {
      await page.getByRole('status').filter({ hasText: 'Driveへ同期済み' }).waitFor();
      await page.getByRole('button', { name: '外部の本文を受信', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent === 'peer update');
      await editor.press('Control+z'); assert.equal(await editor.innerText(), 'peer update', 'remote adoption entered local Undo');
      await editor.press('Control+End'); await editor.press('x'); await editor.press('Control+z');
      assert.equal(await editor.innerText(), 'peer update', 'local typing Undo no longer works after remote adoption');
    }
    await page.getByRole('button', { name: 'Notebook fixture', exact: true }).click();
    const paper = page.getByLabel('手書きノートの用紙'); await paper.waitFor();
    const box = (await paper.boundingBox())!;
    await page.mouse.move(box.x + 50, box.y + 50); await page.mouse.down();
    await page.mouse.move(box.x + 100, box.y + 80, { steps: 4 }); await page.mouse.up();
    await page.getByRole('button', { name: '表示面を作り直す', exact: true }).click();
    await paper.waitFor(); assert.equal(await paper.locator('polyline').count(), 1);
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    assert.equal(await paper.locator('polyline').count(), 0, `${host} lost document history on remount`);
    if (host === 'desktop') {
      // A's delayed acknowledgement must not make B's owner-release finalizer stale.
      await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent?.includes('保存済み'));
      holdNextInkSave = true;
      const area = (await paper.boundingBox())!;
      await page.mouse.move(area.x + 50, area.y + 50); await page.mouse.down();
      await page.mouse.move(area.x + 100, area.y + 80); await page.mouse.up();
      for (let attempt = 0; !releaseInkSave && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(releaseInkSave, 'first stroke save did not start');
      await page.mouse.move(area.x + 80, area.y + 100); await page.mouse.down();
      await page.mouse.move(area.x + 130, area.y + 130);
      releaseInkSave();
      await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent?.includes('保存済み'));
      await page.getByRole('button', { name: '表示面を作り直す', exact: true }).evaluate(element => (element as HTMLButtonElement).click());
      await page.mouse.up();
      await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent?.includes('保存済み'));
      assert.equal(notes[inkId].ink[pageId].length, 2, 'owner transfer failed to save B after A was acknowledged');
      await page.getByRole('button', { name: '元に戻す', exact: true }).click();
      await page.getByRole('button', { name: '元に戻す', exact: true }).click();
      assert.equal(await paper.locator('polyline').count(), 0);
    }
    await page.getByRole('button', { name: '文字', exact: true }).click();
    await page.getByLabel('挿入する文字', { exact: true }).fill('hello');
    const edge = (await paper.boundingBox())!;
    await paper.dispatchEvent('pointerdown', { pointerId: 51, pointerType: 'pen', button: 0, clientX: edge.x + edge.width * .99, clientY: edge.y + edge.height * .99 });
    assert.equal(await paper.locator('text').count(), 1, `${host} could not retain text at the paper edge`);
    await page.getByText('ページ操作・用紙', { exact: true }).click();
    await page.getByLabel('用紙の向き', { exact: true }).selectOption('landscape');
    assert.equal(await page.getByLabel('用紙の向き', { exact: true }).inputValue(), 'portrait', 'overflow was silently distorted');
    await page.getByRole('checkbox', { name: '内容を等比縮小して用紙内に収める', exact: true }).check();
    await page.getByLabel('用紙の向き', { exact: true }).selectOption('landscape');
    assert.equal(await page.getByLabel('用紙の向き', { exact: true }).inputValue(), 'landscape');
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    assert.equal(await page.getByLabel('用紙の向き', { exact: true }).inputValue(), 'portrait', 'paper fit could not be undone');
    await page.getByRole('button', { name: '二重表示を切替', exact: true }).click();
    await page.getByText('このノートは別の表示面で編集中です。', { exact: true }).waitFor();
    assert.equal(await paper.count(), 1, `${host} mounted two editing owners`);
    await page.getByRole('button', { name: '二重表示を切替', exact: true }).click();
  }
  const traces = await page.evaluate(() => window.sharedNoteTrace);
  for (const host of ['desktop', 'web']) {
    const observed = traces.filter(trace => trace.host === host);
    for (const entry of ['notes.edit-session', 'notes.markdown-editor', 'notes.handwriting-editor', 'reader.ink-draft']) assert.ok(observed.some(trace => trace.entry === entry), `${host}: no execution trace for ${entry}`);
    assert.ok(observed.some(trace => trace.entry === 'notes.edit-session' && trace.action === 'undo'), `${host}: Undo bypassed the common session`);
  }
  assert.deepEqual(errors, []);
  const output = path.resolve(frontend, '../output'); mkdirSync(output, { recursive: true });
  const sources = ['features/notes/noteEditSession.ts', 'features/notes/HandwrittenNote.tsx', 'features/notes/markdown/MarkdownSessionEditor.tsx',
    'features/notes/markdown/MarkdownEditor.tsx', 'features/notes/MarkdownNote.tsx', 'features/notes/NoteDocumentEditor.tsx', 'web/WebNotes.tsx', 'features/ink/inkDraft.ts'];
  const sourceHashes = Object.fromEntries(sources.map(source => [source, createHash('sha256').update(readFileSync(path.join(frontend, 'src', source))).digest('hex')]));
  writeFileSync(path.join(output, 'shared-app-notes-trace.json'), JSON.stringify({ recordedAt: new Date().toISOString(), browser: browser.version(), os: process.platform,
    input: 'mouse/keyboard', viewport: { width: 1000, height: 1000 }, fixture: 'e2e/fixtures/sharedNoteSessions.tsx', sourceHashes, traces }, null, 2) + '\n');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { ContentPublication } from '../src/runtime/edits/contracts.ts';
import { openComposition, evidence, sync, type Diagnostics } from './support/documentComposition.ts';

function seed(publication: ContentPublication) {
  if (publication.content?.kind !== 'document') throw new Error('document fixture required');
  const item = publication.libraryBatch.changes.find(change => change.type === 'put-item');
  assert.ok(item?.type === 'put-item'); item.item.kind = 'notebook'; delete item.item.resourceId;
  for (const [index, page] of publication.content.pages.entries()) {
    page.widthPt = 595.27559; page.heightPt = 841.8898;
    page.background = { kind: 'paper', spec: { template: index ? 'ruled7' : 'grid5', color: 'cream' } };
    page.annotations = [];
  }
  const page = publication.content.pages[0];
  page.annotations = [
    { kind: 'ink', id: '20000000-0000-0000-0000-000000000001',
      geometry: { kind: 'arrow', start: { x: 0, y: 0 }, end: { x: 90, y: 20 }, head: 'both', headLengthPt: 12, preferredHeadLengthPt: 15 },
      style: { color: '#456789', widthPt: 3.4, opacity: .63, highlighter: false },
      transform: { x: 80, y: 80, rotationRad: .2, scaleX: 1.4, scaleY: .65 } },
    { kind: 'sticky', id: '20000000-0000-0000-0000-000000000002', text: 'Preserve notebook sticky', anchor: { x: 450, y: 650 },
      color: '#abcdef', quote: 'source quote', metadata: { label: 'paper fixture', createdAt: null } },
    { kind: 'highlight', id: '20000000-0000-0000-0000-000000000003', backgroundRevision: page.backgroundRevision,
      range: { kind: 'unindexed' }, quote: 'paper quote', text: 'Preserve notebook highlight', anchor: { x: 100, y: 700 },
      quads: [[{ x: 100, y: 700 }, { x: 200, y: 700 }, { x: 200, y: 720 }, { x: 100, y: 720 }]], color: '#facc15',
      metadata: { label: 'paper fixture', createdAt: null } },
  ];
}
const document = async (page: Page) => (await evidence(page)).session.document!;
async function changed(page: Page, version: string) {
  await page.waitForFunction(previous => {
    const value = (window as unknown as { compositionDiagnostics(): Diagnostics }).compositionDiagnostics().session;
    return value.phase === 'idle' && !value.inputActive && value.document?.version !== previous;
  }, version);
}
async function action(page: Page, name: string) {
  const before = await evidence(page);
  await page.getByRole('button', { name, exact: true }).click(); await changed(page, before.session.document!.version);
  const after = await evidence(page);
  assert.equal(after.state.history.length, before.state.history.length + 1, `${name} is one durable history operation`);
  return after.session.document!;
}
async function draw(page: Page, points: [number, number][]) {
  const layer = page.getByLabel('ノート書き込みレイヤー', { exact: true });
  await layer.scrollIntoViewIfNeeded(); const box = await layer.boundingBox(); assert.ok(box);
  const before = await document(page);
  await page.mouse.move(box.x + points[0][0] * box.width, box.y + points[0][1] * box.height); await page.mouse.down();
  for (const [x, y] of points.slice(1)) await page.mouse.move(box.x + x * box.width, box.y + y * box.height, { steps: 10 });
  await page.mouse.up(); await changed(page, before.version);
}
async function converge(from: Page, to: Page) {
  await sync(from); await sync(to); assert.deepEqual(await document(to), await document(from));
}
async function textDraft(page: Page, text: string) {
  await page.getByRole('button', { name: '文字', exact: true }).click();
  const layer = page.getByLabel('ノート書き込みレイヤー', { exact: true });
  await layer.scrollIntoViewIfNeeded(); const box = await layer.boundingBox(); assert.ok(box);
  await page.mouse.click(box.x + box.width * .25, box.y + box.height * .25);
  await page.getByRole('textbox', { name: '書き込みテキスト', exact: true }).fill(text);
}

for (const engine of ['chromium', 'webkit'] as const) test(`production paper notebook tools, page history, physical paper geometry and replication (${engine})`, { timeout: 300_000 }, async t => {
  const { native, web, pages, publication, reload, finish, loseNextCommitReply, committed, repository, documentId } = await openComposition(t, engine, seed);
  assert.ok(publication.content?.kind === 'document');
  const original = publication.content.pages[0];
  for (const page of pages) {
    assert.deepEqual((await document(page)).pages[0], original);
    assert.equal(await page.locator('.react-pdf__Page canvas').count(), 0);
  }
  for (const [index, page] of pages.entries()) {
    t.diagnostic(`${index ? 'Web' : 'Native'} paper notebook authoring`);
    const before = await document(page);
    await page.getByRole('button', { name: 'ペン', exact: true }).click(); await draw(page, [[.2, .3], [.45, .3]]);
    await page.getByLabel('描画の種類', { exact: true }).selectOption('rectangle'); await draw(page, [[.2, .4], [.4, .5]]);
    await page.getByRole('button', { name: '文字', exact: true }).click();
    const box = await page.getByLabel('ノート書き込みレイヤー', { exact: true }).boundingBox(); assert.ok(box);
    // The second host creates a new text object instead of clicking/editing the first host's text.
    await page.mouse.click(box.x + box.width * .2, box.y + box.height * (.55 + index * .12));
    await page.getByRole('textbox', { name: '書き込みテキスト', exact: true }).fill(`Notebook ${index}\nphysical text`);
    await action(page, '確定');
    const authored = await document(page);
    assert.deepEqual(authored.pages[0].annotations.slice(0, before.pages[0].annotations.length), before.pages[0].annotations);
    assert.deepEqual(authored.pages[0].annotations.slice(-3).map(value => value.kind === 'ink' ? value.geometry.kind : value.kind), ['path', 'rect', 'text']);
    await converge(page, pages[1 - index]);
  }
  for (const page of pages) {
    const before = await evidence(page);
    const pageNumber = await page.getByLabel('ページ番号', { exact: true }).inputValue();
    await page.getByLabel('倍率', { exact: true }).selectOption('1.25');
    await page.getByRole('button', { name: '右側で編集', exact: true }).click();
    await page.locator('[data-editor-placement="right"]').waitFor();
    assert.equal(await page.getByLabel('ノート書き込みレイヤー', { exact: true }).count(), 1, 'one active writer after docking');
    assert.equal(await page.locator('[aria-label="参照表示"]').getByLabel('ノート書き込みレイヤー', { exact: true }).count(), 0);
    assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), pageNumber);
    assert.equal(await page.getByLabel('倍率', { exact: true }).inputValue(), '1.25');
    assert.deepEqual(await document(page), before.session.document);
    assert.equal((await evidence(page)).state.history.length, before.state.history.length);
    await page.getByRole('button', { name: '範囲選択', exact: true }).click();
    const selectedObject = page.locator('[aria-label="右側の編集"] [data-ink-id="20000000-0000-0000-0000-000000000001"]');
    await selectedObject.scrollIntoViewIfNeeded(); const selectedBox = await selectedObject.boundingBox(); assert.ok(selectedBox);
    await page.mouse.click(selectedBox.x + selectedBox.width / 2, selectedBox.y + selectedBox.height / 2);
    await page.getByRole('button', { name: 'コピー', exact: true }).click();
    // A reference deactivates the global writer even while its old selection and clipboard exist.
    // Zoom can place the paper's left edge outside the viewport; click its visible scroller.
    const reference = page.locator('[aria-label="参照表示"] .document-paper-pane');
    const referenceBox = await reference.boundingBox(); assert.ok(referenceBox);
    const hit = await page.evaluate(({ x, y }) => {
      const element = globalThis.document.elementFromPoint(x, y);
      return { tag: element?.tagName, label: element?.getAttribute('aria-label'), text: element?.textContent?.slice(0, 100),
        reference: !!element?.closest('[aria-label="参照表示"]') };
    }, { x: referenceBox.x + 30, y: referenceBox.y + 30 });
    assert.equal(hit.reference, true, 'keyboard test must actually click the visible reference pane');
    await page.mouse.click(referenceBox.x + 30, referenceBox.y + 30);
    await page.keyboard.press('Delete'); await page.keyboard.press('Control+v'); await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => {
      const value = (window as unknown as { compositionDiagnostics(): Diagnostics }).compositionDiagnostics().session;
      return value.phase === 'idle' && !value.inputActive;
    });
    assert.equal(await page.getByRole('textbox', { name: '書き込みテキスト', exact: true }).count(), 0);
    assert.deepEqual(await document(page), before.session.document);
    assert.equal((await evidence(page)).state.history.length, before.state.history.length,
      'reference keyboard commands cannot delete, paste or move active annotations');
    await textDraft(page, 'Placement must retain this draft\n未確定');
    const draft = (await evidence(page)).session.surfaces;
    assert.equal(await page.getByRole('button', { name: '中央で編集', exact: true }).isDisabled(), true);
    assert.deepEqual((await evidence(page)).session.surfaces, draft);
    assert.deepEqual(await document(page), before.session.document);
    await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
    await page.getByRole('button', { name: '中央で編集', exact: true }).click();
    await page.locator('[data-editor-placement="center"]').waitFor();
    assert.equal(await page.getByLabel('ノート書き込みレイヤー', { exact: true }).count(), 1);
    assert.equal(await page.getByLabel('倍率', { exact: true }).inputValue(), '1.25');
    assert.deepEqual(await document(page), before.session.document);
    assert.equal((await evidence(page)).state.history.length, before.state.history.length);
    await page.getByLabel('倍率', { exact: true }).selectOption('0');
  }
  const beforeFailure = await evidence(native);
  await textDraft(native, 'Notebook save and placement guard'); loseNextCommitReply();
  await native.getByRole('button', { name: '確定', exact: true }).click();
  await native.getByRole('button', { name: '再試行', exact: true }).waitFor();
  const lostId = committed[committed.length - 1]; assert.ok(await repository.readIntent(documentId));
  assert.equal(await native.getByRole('button', { name: '右側で編集', exact: true }).isDisabled(), true);
  await native.getByRole('button', { name: '再試行', exact: true }).click();
  await changed(native, beforeFailure.session.document!.version);
  assert.equal(committed.filter(id => id === lostId).length, 2, 'failed notebook save retries the identical operation');
  assert.equal((await evidence(native)).state.history.length, beforeFailure.state.history.length + 1);
  await native.getByRole('button', { name: '右側で編集', exact: true }).click();
  await native.getByRole('button', { name: '中央で編集', exact: true }).click();
  await converge(native, web);
  // Each structural command is authored through the production toolbar and has one history entry.
  const beforeAdd = await document(native);
  const added = await action(native, 'ページ追加'); assert.equal(added.pages.length, beforeAdd.pages.length + 1);
  await native.getByLabel('ページ番号', { exact: true }).fill('1');
  await native.getByLabel('ページ番号', { exact: true }).press('Enter');
  const copied = await action(native, 'ページ複製'); assert.equal(copied.pages.length, added.pages.length + 1);
  const clone = copied.pages.find(page => !added.pages.some(previous => previous.id === page.id)); assert.ok(clone);
  assert.deepEqual(clone.background, added.pages[0].background);
  assert.equal(clone.widthPt, added.pages[0].widthPt); assert.equal(clone.heightPt, added.pages[0].heightPt);
  assert.equal(clone.annotations.length, added.pages[0].annotations.length);
  for (const [index, annotation] of clone.annotations.entries()) {
    const source = added.pages[0].annotations[index]; assert.notEqual(annotation.id, source.id);
    assert.deepEqual(annotation, { ...source, id: annotation.id, ...(source.kind === 'highlight' ? { backgroundRevision: clone.backgroundRevision } : {}) });
  }
  const moved = await action(native, '前へ移動');
  assert.deepEqual(new Set(moved.pages.map(page => page.id)), new Set(copied.pages.map(page => page.id)));
  await action(native, '後ろへ移動');
  const deleted = await action(native, 'ページ削除'); assert.equal(deleted.pages.length, added.pages.length);
  await converge(native, web);
  for (const page of pages) { await reload(page); await page.getByLabel('ノート書き込みレイヤー', { exact: true }).waitFor(); }
  assert.deepEqual(await document(native), deleted); assert.deepEqual(await document(web), deleted);
  assert.deepEqual(deleted.pages.find(page => page.id === original.id)!.annotations.slice(0, original.annotations.length), original.annotations);
  await native.getByLabel('ページ番号', { exact: true }).fill('1');
  await native.getByLabel('ページ番号', { exact: true }).press('Enter');
  const beforePaper = await document(native);
  await native.getByRole('button', { name: '用紙設定', exact: true }).click();
  const dialog = native.getByRole('dialog', { name: '用紙設定', exact: true });
  await dialog.getByLabel('用紙サイズ', { exact: true }).selectOption('Letter');
  await dialog.getByLabel('罫線', { exact: true }).selectOption('ruled6');
  await dialog.getByLabel('用紙色', { exact: true }).selectOption('white');
  await action(native, '適用');
  const restyled = (await document(native)).pages[0];
  assert.deepEqual(restyled.background, { kind: 'paper', spec: { template: 'ruled6', color: 'white' } });
  assert.ok(Math.abs(restyled.widthPt - 612) < .001); assert.ok(Math.abs(restyled.heightPt - 792) < .001);
  assert.notEqual(restyled.backgroundRevision, beforePaper.pages[0].backgroundRevision);
  for (const [index, annotation] of restyled.annotations.entries()) {
    const previous = beforePaper.pages[0].annotations[index];
    assert.deepEqual(annotation, previous.kind === 'highlight' ? { ...previous, backgroundRevision: restyled.backgroundRevision } : previous,
      'default paper changes preserve physical annotation positions, widths, metadata and stacking');
  }
  await native.getByRole('button', { name: '用紙設定', exact: true }).click();
  await dialog.getByLabel('用紙サイズ', { exact: true }).selectOption('A5');
  const beforeOverflow = await evidence(native);
  await dialog.getByRole('button', { name: '適用', exact: true }).click();
  await dialog.getByRole('button', { name: '縦横比を保って収める', exact: true }).waitFor();
  assert.deepEqual(await document(native), beforeOverflow.session.document);
  assert.equal((await evidence(native)).state.history.length, beforeOverflow.state.history.length);
  await action(native, '縦横比を保って収める');
  const fitted = (await document(native)).pages[0];
  assert.ok(fitted.widthPt < restyled.widthPt && fitted.heightPt < restyled.heightPt);
  assert.deepEqual(fitted.annotations.map(value => value.id), restyled.annotations.map(value => value.id));
  await action(native, '元に戻す');
  const restored = (await document(native)).pages[0];
  assert.equal(restored.widthPt, restyled.widthPt); assert.equal(restored.heightPt, restyled.heightPt);
  assert.deepEqual(restored.background, restyled.background);
  assert.deepEqual(restored.annotations, restyled.annotations.map(value => value.kind === 'highlight' ? { ...value, backgroundRevision: restored.backgroundRevision } : value));
  await converge(native, web);
  await finish();
});

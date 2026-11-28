import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ContentPublication } from '../src/runtime/edits/contracts.ts';
import { captureReferenceFailure, openComposition } from './support/documentComposition.ts';

// openComposition durably stores the verified resource before normal repository.publish.
// Both backgrounds are original pages, never an invalid paper translation.
let pdfId = '', paperId = '', pdfRevision = '', pdfPhysical = 0;
function seed(publication: ContentPublication) {
  assert.equal(publication.content?.kind, 'document');
  if (publication.content?.kind !== 'document') throw new Error('document required');
  const item = publication.libraryBatch.changes.find(value => value.type === 'put-item');
  assert.ok(item?.type === 'put-item'); item.item.kind = 'notebook'; delete item.item.resourceId;
  const [pdf, paper] = publication.content.pages;
  assert.equal(pdf.background.kind, 'pdf'); if (pdf.background.kind !== 'pdf') throw new Error('pdf required'); pdf.annotations = []; pdfId = pdf.id; pdfRevision = pdf.backgroundRevision; pdfPhysical = pdf.background.pdfPage;
  paper.background = { kind: 'paper', spec: { template: 'grid5', color: 'cream' } };
  paper.widthPt = 430; paper.heightPt = 750; paper.annotations = []; paperId = paper.id;
  delete publication.content.translation;
}
for (const engine of ['chromium', 'webkit'] as const) test(`reference mixed notebook production path (${engine})`, { timeout: 300_000 }, async t => {
  const setup = await openComposition(t, engine, seed, { pdfFixture: 'text' });
  try {
    for (const page of setup.pages) {
      const library = page.getByRole('button', { name: '資料一覧', exact: true });
      if (await library.getAttribute('aria-expanded') !== 'true') await library.click();
      await page.getByRole('button', { name: 'Canonical notebook composition', exact: true }).click();
      const root = page.locator('[data-reader-root]');
      await root.locator(`[data-canonical-page="${pdfId}"]`).first().waitFor();
      await page.getByRole('button', { name: 'このページを参照に固定', exact: true }).click();
      await page.getByRole('button', { name: '次のページ', exact: true }).click();
      const reference = root.locator('[data-reader-reference]');
      await reference.locator(`[data-canonical-page="${pdfId}"]`).waitFor();
      await root.locator(`[data-paper-page="${paperId}"]`).waitFor();
      assert.equal(await page.locator('[data-reader-root]').count(), 1);
      assert.equal(await reference.locator('[data-ink-overlay], [aria-label$="書き込みレイヤー"]').count(), 0);
      const deadline = Date.now() + 25_000;
      await page.waitForFunction(({ id, revision, physical }) => {
        const canonical = document.querySelector(`[data-reader-reference] [data-canonical-page="${id}"]`);
        const scroller = canonical?.querySelector('[data-pdf-scroller]');
        const pdf = canonical?.querySelector('.react-pdf__Page');
        const canvas = pdf?.querySelector<HTMLCanvasElement>('canvas');
        const layer = pdf?.querySelector('.textLayer');
        const surface = canonical?.querySelector<HTMLElement>('[data-pdf-surface]');
        const snapshot = (window as unknown as { compositionReferenceInputEvidence(): { active: boolean; blocked: boolean; actualZoom?: number } | null }).compositionReferenceInputEvidence();
        const cb = canvas?.getBoundingClientRect(), sb = surface?.getBoundingClientRect();
        return canonical?.getAttribute('data-background-revision') === revision && scroller?.getAttribute('data-rendered') === 'true'
          && pdf?.getAttribute('data-page-number') === String(physical) && !!layer?.querySelector('span[role="presentation"]')
          && !!canvas?.width && !!canvas.height && !!cb && !!sb && sb.width > 0 && Math.abs(cb.width - sb.width) <= 1
          && document.fonts.status === 'loaded' && !!snapshot?.active && !snapshot.blocked && !!snapshot.actualZoom;
      }, { id: pdfId, revision: pdfRevision, physical: pdfPhysical }, { timeout: Math.max(1, deadline - Date.now()) });
      await reference.focus();
      // The fixture registers its capture observer before either production app mounts.
      await page.evaluate(() => { (window as unknown as { referenceKeyObserverArmed?: boolean }).referenceKeyObserverArmed = true; });
      await page.keyboard.press('Control+Equal');
      await page.waitForFunction(() => {
        const evidence = (window as unknown as { referenceKeyEvidence?: { trusted: boolean; before: { active: boolean; blocked: boolean; actualZoom?: number } | null; after?: { actualZoom?: number } | null } }).referenceKeyEvidence;
        return !!evidence?.trusted && !!evidence.before?.active && !evidence.before.blocked && !!evidence.before.actualZoom
          && !!evidence.after?.actualZoom && evidence.after.actualZoom > evidence.before.actualZoom;
      }, undefined, { timeout: Math.max(1, deadline - Date.now()) });
      await page.waitForFunction(() => {
        const holder = window as unknown as { compositionReferenceInputEvidence(): { active: boolean; blocked: boolean; actualZoom?: number } | null; referenceKeyEvidence?: { width: number; before: { actualZoom?: number } | null } };
        const snapshot = holder.compositionReferenceInputEvidence(), evidence = holder.referenceKeyEvidence;
        const width = document.querySelector<HTMLElement>('[data-reader-reference] [data-pdf-surface]')?.getBoundingClientRect().width ?? 0;
        return !!snapshot?.active && !snapshot.blocked && !!snapshot.actualZoom && !!evidence?.before?.actualZoom
          && snapshot.actualZoom > evidence.before.actualZoom && width > evidence.width;
      }, undefined, { timeout: Math.max(1, deadline - Date.now()) });
      assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '2');
      await page.getByRole('button', { name: '現在のページに置き換える', exact: true }).click();
      await page.getByRole('button', { name: '前のページ', exact: true }).click();
      await reference.locator(`[data-paper-page="${paperId}"]`).waitFor();
      await root.locator(`[data-canonical-page="${pdfId}"]`).waitFor();
      assert.equal(await page.getByLabel('ページ番号', { exact: true }).inputValue(), '1');
      await page.getByRole('button', { name: '固定を解除', exact: true }).click();
    }
  } catch (error) {
    try { await captureReferenceFailure(t, setup.pages, 'reference-path'); } catch (cause) { t.diagnostic(`reference diagnostic error: ${String(cause)}`); }
    try { await setup.finish(); } catch (cause) { t.diagnostic(`reference cleanup error: ${String(cause)}`); }
    throw error;
  }
  await setup.finish();
});

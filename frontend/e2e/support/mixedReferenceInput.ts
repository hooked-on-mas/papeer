import assert from 'node:assert/strict';
import type { Page as BrowserPage } from 'playwright-core';
import type { ContentPublication } from '../../src/runtime/edits/contracts.ts';

/** Use the existing published PDF plus a second original paper page; never a paper translation. */
export function seedMixedReference(publication: ContentPublication) {
  assert.ok(publication.content?.kind === 'document');
  const item = publication.libraryBatch.changes.find(value => value.type === 'put-item');
  assert.ok(item?.type === 'put-item'); item.item.kind = 'notebook'; delete item.item.resourceId;
  const [pdf, paper] = publication.content.pages;
  assert.equal(pdf.background.kind, 'pdf'); pdf.annotations = [];
  paper.background = { kind: 'paper', spec: { template: 'grid5', color: 'cream' } };
  paper.widthPt = 430; paper.heightPt = 750; paper.annotations = [];
  delete publication.content.translation;
}

/** Pin original B through normal controls, then return the sole editor to original A. */
export async function openMixedReference(page: BrowserPage, publication: ContentPublication) {
  assert.ok(publication.content?.kind === 'document');
  const [pdf, paper] = publication.content.pages;
  assert.equal(pdf.background.kind, 'pdf'); assert.equal(paper.background.kind, 'paper');
  await page.getByRole('button', { name: '次のページ', exact: true }).click();
  await page.locator(`[data-reader-surface="original"][data-active-surface="true"] [data-paper-page="${paper.id}"]`).waitFor();
  await page.getByRole('button', { name: 'このページを参照に固定', exact: true }).click();
  await page.getByRole('button', { name: '前のページ', exact: true }).click();
  const root = page.locator('[data-reader-root]');
  await root.locator(`[data-reader-reference] [data-paper-page="${paper.id}"]`).waitFor();
  await root.locator(`[data-reader-surface="original"][data-active-surface="true"] [data-canonical-page="${pdf.id}"][data-background-revision="${pdf.backgroundRevision}"]`).waitFor();
  assert.equal(await root.count(), 1);
  await page.getByText(`参照固定中：原文・${paper.id}（この閲覧中）`, { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const read = (window as unknown as { compositionReferenceInputEvidence?: () => { active: boolean; blocked: boolean } | null }).compositionReferenceInputEvidence;
    const value = read?.(); return !!value?.active && !value.blocked;
  });
  assert.equal(await root.locator('[data-reader-reference] [data-ink-overlay], [data-reader-reference] [aria-label$="書き込みレイヤー"]').count(), 0);
  return { pdf, paper };
}

/** Pick an actual visible paper-page point and verify browser hit testing before input. */
export async function referencePaperPoint(page: BrowserPage, paperId: string): Promise<{ x: number; y: number }> {
  return page.evaluate(id => {
    const root = document.querySelector<HTMLElement>('[data-reader-root]');
    const pane = root?.querySelector<HTMLElement>('[data-reader-reference] .document-paper-pane');
    const paper = pane?.querySelector<HTMLElement>(`[data-paper-page="${id}"]`);
    if (!root || !pane || !paper || pane.closest('[data-reader-root]') !== root) throw new Error('reference-paper-identity');
    const a = pane.getBoundingClientRect(), b = paper.getBoundingClientRect();
    const left = Math.max(a.left, b.left, 0), top = Math.max(a.top, b.top, 0);
    const right = Math.min(a.right, b.right, innerWidth), bottom = Math.min(a.bottom, b.bottom, innerHeight);
    if (right - left < 10 || bottom - top < 10) throw new Error('reference-paper-not-visible');
    for (const fx of [.5, .35, .65]) for (const fy of [.5, .35, .65]) {
      const x = left + (right - left) * fx, y = top + (bottom - top) * fy;
      const hit = document.elementFromPoint(x, y);
      if (hit && hit.closest('.document-paper-pane') === pane && hit.closest('[data-paper-page]') === paper
        && hit.closest('[data-reader-root]') === root) return { x, y };
    }
    throw new Error('reference-paper-hit-test');
  }, paperId);
}

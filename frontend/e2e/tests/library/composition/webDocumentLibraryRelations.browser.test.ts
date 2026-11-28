import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { ContentPublication, LibrarySnapshot } from '../../../../src/runtime/edits/contracts.ts';
import type { LibrarySessionState } from '../../../../src/features/library/LibrarySession.ts';
import type { RepositoryState } from '../../../../src/runtime/edits/ports.ts';
import { EditGraph } from '../../../../src/runtime/edits/editGraph.ts';
import { openComposition, sync as deliver } from '../../../support/documentComposition.ts';
import { waitForSnapshot } from '../../../support/waitForSnapshot.ts';
import { waitForLibraryWitness } from '../../../support/waitForLibraryWitness.ts';

type Catalog = { state: RepositoryState; session?: LibrarySessionState; pending: unknown[]; replication: { running: boolean } };
const catalog = (page: Page): Promise<Catalog> => page.evaluate(() => (window as unknown as {
  compositionLibraryEvidence(): Promise<Catalog>;
}).compositionLibraryEvidence());
const content = (page: Page, id: string): Promise<{ state: RepositoryState }> => page.evaluate(id => (window as unknown as {
  compositionObservedEvidence(id: string): Promise<{ state: RepositoryState }>;
}).compositionObservedEvidence(id), id);
function snapshot(value: Catalog): LibrarySnapshot | undefined {
  const version = value.session?.selectedVersion;
  const result = version ? new EditGraph(value.state.checkpoint).snapshot(version) : undefined;
  return result?.kind === 'library' ? result : undefined;
}
async function settled(page: Page, accepts: (value: LibrarySnapshot, session: LibrarySessionState) => boolean) {
  const value = await waitForLibraryWitness(page, accepts);
  return { evidence: value, library: snapshot(value)!, session: value.session! };
}
async function expand(page: Page) {
  const button = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
}
async function collapse(page: Page) {
  const button = page.getByRole('button', { name: '資料一覧', exact: true });
  if (await button.getAttribute('aria-expanded') === 'true') await button.click();
}
async function sync(page: Page) {
  await waitForSnapshot(() => catalog(page), value => !value.replication.running);
  await deliver(page);
  await waitForSnapshot(() => catalog(page), value => !value.replication.running && value.pending.length === 0);
}
function oneBatch(before: RepositoryState, after: RepositoryState) {
  const added = after.checkpoint.batches.filter(batch => !before.checkpoint.batches.some(previous => previous.id === batch.id));
  assert.equal(added.length, 1); assert.equal(added[0].kind, 'library'); return added[0];
}
async function openRow(page: Page, title: string) {
  const open = page.getByRole('button', { name: `「${title}」を開く`, exact: true });
  if (await open.count()) await open.click();
}
const beforeUnloadPrevented = (page: Page) =>
  page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })));

for (const engine of ['chromium', 'webkit'] as const) test(`production item relations, note detachment, owner deletion modes and observed heads (${engine})`, { timeout: 600_000 }, async t => {
  const additionalPublications = (pdf: ContentPublication) => {
    const change = pdf.libraryBatch.changes.find(value => value.type === 'put-item'); assert.ok(change?.type === 'put-item');
    const secondPdfId = crypto.randomUUID(), pageId = crypto.randomUUID(), revId = crypto.randomUUID();
    const secondPdf = { ...structuredClone(change.item), id: secondPdfId, title: 'Paper B', position: 1 };
    const firstPage = pdf.content?.kind === 'document' ? pdf.content.pages[0] : undefined;
    assert.ok(firstPage && firstPage.background.kind === 'pdf');
    const pubPdfB: ContentPublication = {
      libraryBatch: { ...structuredClone(pdf.libraryBatch), id: crypto.randomUUID(), parents: [pdf.libraryBatch.id],
        changes: [{ type: 'put-item', item: secondPdf }] },
      content: { kind: 'document', id: secondPdfId, version: crypto.randomUUID(), deletedPages: [],
        pages: [{ id: pageId, backgroundRevision: revId, lifecycleVersion: revId, annotationVersion: revId,
          widthPt: firstPage.widthPt, heightPt: firstPage.heightPt,
          background: { ...firstPage.background }, annotations: [] }] },
    };
    return { publications: [pubPdfB], initialDocumentId: pdf.content!.id };
  };
  const { native, web, pages, repository, reload, finish, committed, committedPayloads, setCommitReplyLoss } =
    await openComposition(t, engine, undefined, { additionalPublications });
  const initial = (await settled(native, value => value.items.length === 2)).library;
  const pdfA = initial.items.find(item => item.title !== 'Paper B')!;
  const pdfB = initial.items.find(item => item.title === 'Paper B')!;
  const reopen = async (page: Page, expectEditablePdf = true) => {
    await waitForSnapshot(() => catalog(page), value => !value.replication.running && !value.session?.busy);
    await reload(page);
    await page.getByRole('button', { name: '読む', exact: true }).waitFor();
    if (expectEditablePdf) await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();
    await expand(page);
  };
  try {
    for (const [index, page] of pages.entries()) {
      const peer = page === native ? web : native, prefix = index ? 'Web' : 'Native';
      await expand(page);
      // 1. Create folder and move pdfA into it
      await page.getByRole('button', { name: '未分類を選択', exact: true }).click();
      const folderTitle = `${prefix} Papers`;
      await page.getByRole('button', { name: 'フォルダーを作成', exact: true }).click();
      await page.getByRole('textbox', { name: 'フォルダー名', exact: true }).fill(folderTitle);
      await page.getByRole('button', { name: 'フォルダーを保存', exact: true }).click();
      const withFolder = await settled(page, value => value.folders.some(folder => folder.title === folderTitle));
      const folder = withFolder.library.folders.find(value => value.title === folderTitle)!;
      for (const existing of withFolder.library.folders) await openRow(page, existing.title);
      const clear = page.getByRole('button', { name: '選択を解除', exact: true });
      if (await clear.isEnabled()) await clear.click();
      await page.getByRole('checkbox', { name: `「${pdfA.title}」を選択`, exact: true }).check();
      await page.getByRole('button', { name: '選択した資料を移動', exact: true }).click();
      await page.getByLabel('移動先のフォルダー', { exact: true }).selectOption(folder.id);
      await page.getByRole('button', { name: '移動する', exact: true }).click();
      await settled(page, value => value.items.find(item => item.id === pdfA.id)?.folderId === folder.id);
      await openRow(page, folder.title);
      if (await clear.isEnabled()) await clear.click();

      // 2. Create owned note under pdfA
      const ownedTitle = `${prefix} Owned Note`;
      await page.getByRole('button', { name: `「${pdfA.title}」に付属ノートを作成`, exact: true }).click();
      await page.getByRole('textbox', { name: '新しい資料の名前', exact: true }).fill(ownedTitle);
      await page.getByLabel('資料の種類', { exact: true }).selectOption('markdown');
      await page.getByRole('button', { name: '資料を作成', exact: true }).click();
      await page.getByRole('heading', { name: ownedTitle, exact: true }).waitFor();
      await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).waitFor();
      await page.getByRole('button', { name: '前の資料に戻る', exact: true }).click();
      await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();
      await expand(page);
      await openRow(page, folder.title);
      await openRow(page, pdfA.title);
      const withOwned = await settled(page, value => value.items.some(item => item.title === ownedTitle));
      const ownedNote = withOwned.library.items.find(item => item.title === ownedTitle)!;
      assert.equal(ownedNote.ownerId, pdfA.id);
      assert.equal(ownedNote.folderId, null);

      // 3. Create independent note in root
      const freeTitle = `${prefix} Free Note`;
      await page.getByRole('button', { name: '未分類を選択', exact: true }).click();
      await page.getByRole('textbox', { name: '新しい資料の名前', exact: true }).fill(freeTitle);
      await page.getByLabel('資料の種類', { exact: true }).selectOption('markdown');
      await page.getByRole('button', { name: '資料を作成', exact: true }).click();
      await page.getByRole('heading', { name: freeTitle, exact: true }).waitFor();
      await page.getByRole('button', { name: '前の資料に戻る', exact: true }).click();
      await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();
      await expand(page);
      await openRow(page, folder.title);
      const withFree = await settled(page, value => value.items.some(item => item.title === freeTitle));
      const freeNote = withFree.library.items.find(item => item.title === freeTitle)!;
      assert.equal(freeNote.ownerId, null);
      assert.equal(freeNote.folderId, null);

      // 4. Add link via dialog, verify bilateral link rows & navigation, verify duplicate no-op
      const beforeLink = await catalog(page);
      await page.getByRole('button', { name: `「${pdfA.title}」に関連を追加`, exact: true }).click();
      await page.getByLabel('関連付ける資料', { exact: true }).selectOption(freeNote.id);
      await page.getByRole('button', { name: '関連を保存', exact: true }).click();
      const linked = await settled(page, value => value.links.some(link => link.pdfId === pdfA.id && link.noteId === freeNote.id));
      oneBatch(beforeLink.state, linked.evidence.state);
      await openRow(page, pdfA.title);
      await openRow(page, freeNote.title);
      await page.getByRole('treeitem', { name: `↗ ${freeNote.title}`, exact: true }).waitFor();
      await page.getByRole('treeitem', { name: `↗ ${pdfA.title}`, exact: true }).waitFor();
      await page.getByRole('button', { name: `↗ ${freeNote.title}`, exact: true }).click();
      await page.getByRole('heading', { name: freeTitle, exact: true }).waitFor();
      await page.getByRole('button', { name: '前の資料に戻る', exact: true }).click();
      await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();
      await expand(page);
      await openRow(page, folder.title);
      await openRow(page, pdfA.title);
      await openRow(page, freeNote.title);

      // Duplicate link addition is a no-op
      const beforeDup = await catalog(page);
      await page.getByRole('button', { name: `「${pdfA.title}」に関連を追加`, exact: true }).click();
      await page.getByLabel('関連付ける資料', { exact: true }).selectOption(freeNote.id);
      await page.getByRole('button', { name: '関連を保存', exact: true }).click();
      const afterDup = await settled(page, () => true);
      assert.equal(afterDup.evidence.state.checkpoint.batches.length, beforeDup.state.checkpoint.batches.length);

      // 5. Remove link & Undo/Redo
      const beforeUnlink = await catalog(page);
      await page.getByRole('button', { name: `「${pdfA.title}」と「${freeNote.title}」の関連を解除`, exact: true }).click();
      const unlinked = await settled(page, value => !value.links.some(link => link.pdfId === pdfA.id && link.noteId === freeNote.id));
      oneBatch(beforeUnlink.state, unlinked.evidence.state);
      await page.getByRole('button', { name: '資料の変更を元に戻す', exact: true }).click();
      await settled(page, value => value.links.some(link => link.pdfId === pdfA.id && link.noteId === freeNote.id));
      await page.getByRole('button', { name: '資料の変更をやり直す', exact: true }).click();
      await settled(page, value => !value.links.some(link => link.pdfId === pdfA.id && link.noteId === freeNote.id));

      // 6. Multi-PDF drag-and-drop linking onto freeNote
      await page.getByRole('checkbox', { name: `「${pdfA.title}」を選択`, exact: true }).check();
      await page.getByRole('checkbox', { name: `「${pdfB.title}」を選択`, exact: true }).check();
      const beforeDrop = await catalog(page);
      const sourceRow = page.getByRole('treeitem', { name: pdfA.title, exact: true });
      const targetRow = page.getByRole('treeitem', { name: freeNote.title, exact: true });
      const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
      try {
        await sourceRow.dispatchEvent('dragstart', { dataTransfer });
        await targetRow.dispatchEvent('dragover', { dataTransfer });
        await targetRow.dispatchEvent('drop', { dataTransfer });
        await sourceRow.dispatchEvent('dragend', { dataTransfer });
      } finally { await dataTransfer.dispose(); }
      const dropped = await settled(page, value =>
        value.links.some(link => link.pdfId === pdfA.id && link.noteId === freeNote.id)
        && value.links.some(link => link.pdfId === pdfB.id && link.noteId === freeNote.id));
      oneBatch(beforeDrop.state, dropped.evidence.state);
      await page.getByRole('button', { name: '選択を解除', exact: true }).click();

      // 7. Detach owned note into owner's folder & Undo
      const beforeDetach = await catalog(page);
      await page.getByRole('button', { name: `「${ownedNote.title}」を独立させる`, exact: true }).click();
      const detached = await settled(page, value => value.items.find(item => item.id === ownedNote.id)?.ownerId === null);
      oneBatch(beforeDetach.state, detached.evidence.state);
      assert.equal(detached.library.items.find(item => item.id === ownedNote.id)?.folderId, folder.id);
      await page.getByRole('button', { name: '資料の変更を元に戻す', exact: true }).click();
      await settled(page, value => value.items.find(item => item.id === ownedNote.id)?.ownerId === pdfA.id);
      await openRow(page, pdfA.title);

      // 8. Local-edit guard blocks deletion while target note has an uncommitted draft
      await page.getByRole('button', { name: ownedNote.title, exact: true }).click();
      const editor = page.getByRole('textbox', { name: 'Markdownノート', exact: true });
      await editor.waitFor();
      await editor.fill(`# ${ownedTitle}\n![broken](papeer://resource/invalid)`);
      await expand(page);
      await openRow(page, folder.title);
      const beforeBlockedDelete = await catalog(page);
      await page.getByRole('button', { name: `「${pdfA.title}」を削除`, exact: true }).click();
      await page.getByLabel('子ノートの扱い', { exact: true }).selectOption('delete');
      await page.getByRole('button', { name: '削除を確定', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: '未保存または送信待ちの編集があるため削除できません' }).waitFor();
      assert.equal((await catalog(page)).state.checkpoint.batches.length, beforeBlockedDelete.state.checkpoint.batches.length);
      await page.getByRole('button', { name: '削除を取り消す', exact: true }).click();
      await collapse(page);
      await editor.fill(`# ${ownedTitle}\nClean saved body`);
      await page.getByRole('button', { name: '前の資料に戻る', exact: true }).click();
      await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();
      await expand(page);
      await openRow(page, folder.title);

      // 9. Owner deletion with default 'detach' (and reply loss recovery on native) + Undo
      const pdfHeads = (await content(page, pdfA.id)).state.heads;
      const beforeDetachDelete = await catalog(page), startCommit = committed.length;
      await page.getByRole('button', { name: `「${pdfA.title}」を削除`, exact: true }).click();
      assert.equal(await page.getByLabel('子ノートの扱い', { exact: true }).inputValue(), 'detach');
      if (page === native) setCommitReplyLoss(true);
      await page.getByRole('button', { name: '削除を確定', exact: true }).click();
      if (page === native) {
        const failed = await waitForSnapshot(() => catalog(page), value => !value.replication.running && !!value.session?.pendingId && !value.session.busy && !!value.session.error);
        const pendingId = failed.session!.pendingId;
        assert.equal(await beforeUnloadPrevented(page), true);
        assert.ok(await repository.readIntent(repository.scope.libraryId));
        await reopen(page, false);
        await waitForSnapshot(() => catalog(page), value => value.session?.pendingId === pendingId && !value.session.busy);
        setCommitReplyLoss(false);
        await page.getByRole('button', { name: '変更を再試行', exact: true }).click();
        const recovered = await settled(page, (_, session) => !session.items.some(item => item.id === pdfA.id));
        assert.equal(await page.getByLabel('PDF書き込みレイヤー', { exact: true }).count(), 0);
        assert.ok(committed.length - startCommit >= 2);
        assert.deepEqual([...new Set(committed.slice(startCommit))], [pendingId]);
        const requests = committedPayloads.slice(startCommit).map(value => JSON.parse(value));
        for (const request of requests) assert.deepEqual(request, requests[0]);
        oneBatch(beforeDetachDelete.state, recovered.evidence.state);
      }
      const afterDetachDelete = await settled(page, (_, session) => !session.items.some(item => item.id === pdfA.id));
      assert.equal(afterDetachDelete.session.items.find(item => item.id === ownedNote.id)?.ownerId, null);
      assert.equal(afterDetachDelete.session.items.find(item => item.id === ownedNote.id)?.folderId, folder.id);
      assert.equal(afterDetachDelete.library.links.some(link => link.pdfId === pdfA.id), false);
      const detachDeletion = afterDetachDelete.library.deletions.find(del => del.active && del.itemIds.includes(pdfA.id))!;
      assert.deepEqual(detachDeletion.itemIds, [pdfA.id]);
      assert.deepEqual(detachDeletion.observed.find(obs => obs.targetId === pdfA.id)?.heads, pdfHeads);

      // Undo restores pdfA, its link to freeNote, ownedNote's ownership, and PDF editability
      await page.getByRole('button', { name: '資料の変更を元に戻す', exact: true }).click();
      const restoredFromDetach = await settled(page, (_, session) => session.items.some(item => item.id === pdfA.id));
      await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor();
      assert.equal(restoredFromDetach.session.items.find(item => item.id === ownedNote.id)?.ownerId, pdfA.id);
      assert.equal(restoredFromDetach.library.links.some(link => link.pdfId === pdfA.id && link.noteId === freeNote.id), true);

      // 10. Owner deletion with explicit 'delete' (deletes child note too, switches open editor to read-only deleted state, and records both observed heads) + Undo/Redo/Undo
      await openRow(page, pdfA.title);
      await page.getByRole('button', { name: ownedNote.title, exact: true }).click();
      await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).waitFor();
      await expand(page);
      await openRow(page, folder.title);
      const noteHeads = (await content(page, ownedNote.id)).state.heads;
      const beforeFullDelete = await catalog(page);
      await page.getByRole('button', { name: `「${pdfA.title}」を削除`, exact: true }).click();
      await page.getByLabel('子ノートの扱い', { exact: true }).selectOption('delete');
      await page.getByRole('button', { name: '削除を確定', exact: true }).click();
      const afterFullDelete = await settled(page, (_, session) =>
        !session.items.some(item => item.id === pdfA.id) && !session.items.some(item => item.id === ownedNote.id));
      oneBatch(beforeFullDelete.state, afterFullDelete.evidence.state);
      await page.getByRole('status').filter({ hasText: 'この資料は削除されています。新しい編集はできません。' }).waitFor();
      assert.equal(await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).count(), 0);
      const fullDeletion = afterFullDelete.library.deletions.find(del => del.active && del.itemIds.includes(pdfA.id) && del.itemIds.includes(ownedNote.id))!;
      assert.deepEqual(fullDeletion.observed.find(obs => obs.targetId === pdfA.id)?.heads, pdfHeads);
      assert.deepEqual(fullDeletion.observed.find(obs => obs.targetId === ownedNote.id)?.heads, noteHeads);
      // Underlying content histories remain preserved in repository
      assert.deepEqual((await content(page, pdfA.id)).state.heads, pdfHeads);
      assert.deepEqual((await content(page, ownedNote.id)).state.heads, noteHeads);

      // Undo restores both pdfA and ownedNote (and re-enables editing); return to pdfA, Redo after reload re-applies logical deletion; final Undo keeps pdfA live for peer
      await page.getByRole('button', { name: '資料の変更を元に戻す', exact: true }).click();
      await settled(page, (_, session) => session.items.some(item => item.id === pdfA.id) && session.items.some(item => item.id === ownedNote.id));
      await collapse(page);
      await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).waitFor();
      const captureBackState = async (phase: string) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const evidence = await Promise.race([page.evaluate(() => {
            const value = (window as unknown as { compositionNavigationEvidence?: () => { navigation?: unknown; document?: { ready?: boolean; phase?: string; error?: string; inputActive?: boolean }; markdown?: { phase?: string; error?: string; dirty?: boolean } } }).compositionNavigationEvidence?.();
            const root = document.querySelector('[data-content-document]');
            const markdown = [...document.querySelectorAll('textarea')].filter(node => node.getAttribute('aria-label') === 'Markdown\u30ce\u30fc\u30c8').length;
            const pdf = document.querySelectorAll('[aria-label="PDF\u66f8\u304d\u8fbc\u307f\u30ec\u30a4\u30e4\u30fc"]').length;
            return { capturedAt: Date.now(), navigation: value?.navigation, documentState: value?.document && { ready: value.document.ready, phase: value.document.phase, error: value.document.error, inputActive: value.document.inputActive }, markdownState: value?.markdown && { phase: value.markdown.phase, error: value.markdown.error, dirty: value.markdown.dirty }, documentId: root?.getAttribute('data-content-document') ?? null,
              markdownTextboxes: markdown, pdfInkLayers: pdf, currentKind: pdf ? 'document' : markdown ? 'markdown' : document.querySelector('[data-attachment-id]') ? 'attachment' : null };
          }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('back-state diagnostic timeout')), 2_000); })]);
          t.diagnostic('Composition Back state: ' + JSON.stringify({ host: page === native ? 'native' : 'web', phase, evidence }));
        } catch (diagnosticError) { t.diagnostic('Composition Back state unavailable: ' + String(diagnosticError)); }
        finally { if (timer !== undefined) clearTimeout(timer); }
      };
      await captureBackState('before-back');
      await page.getByRole('button', { name: '前の資料に戻る', exact: true }).click();
      try {
        await page.getByLabel('PDF書き込みレイヤー', { exact: true }).waitFor({ timeout: 25_000 });
      } catch (error) { await captureBackState('pdf-wait-failed'); throw error; }
      await reopen(page);
      await page.getByRole('button', { name: '資料の変更をやり直す', exact: true }).click();
      await settled(page, (_, session) => !session.items.some(item => item.id === pdfA.id) && !session.items.some(item => item.id === ownedNote.id));
      await page.getByRole('button', { name: '資料の変更を元に戻す', exact: true }).click();
      const finalHostState = await settled(page, (_, session) => session.items.some(item => item.id === pdfA.id) && session.items.some(item => item.id === ownedNote.id));
      await sync(page); await sync(peer);
      const remote = await settled(peer, value => value.version === finalHostState.library.version);
      assert.deepEqual(remote.library, finalHostState.library);
    }
    for (const page of pages) await reopen(page);
    assert.deepEqual((await settled(native, () => true)).library, (await settled(web, () => true)).library);
    await finish();
  } catch (error) {
    console.error('relations failure', error, JSON.stringify({ committed, committedPayloads }));
    for (const page of pages) console.error(page.url(), JSON.stringify(await catalog(page).catch(String)));
    throw error;
  }
});


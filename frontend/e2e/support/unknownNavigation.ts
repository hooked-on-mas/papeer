// Shared helpers for B13-g (P4.3a unknown matrix): while a commit outcome is unknown, citation clicks, back / forward and switching to another
// document are refused by the content navigation leave guard, and pass after a same-ID retry has confirmed the commit.
// Test support only (no product code). Everything is read from what exists: the real DOM, the host's own repository (Native over HTTP into the
// sidecar's SQLite, Web in IndexedDB), the navigation session's own state and the requests that really reached the sidecar / the IndexedDB plan.
import assert from 'node:assert/strict';
import type { Page } from 'playwright-core';
import type { ContentPublication, StickyNote } from '../../src/runtime/edits/contracts.ts';
import { markdownCitationLink, type CitationTarget } from '../../src/runtime/markdown/markdownCitations.ts';
import type { ContentNavigationState } from '../../src/features/reader/navigation/ContentNavigationSession.ts';
import type { LibrarySessionState } from '../../src/features/library/LibrarySession.ts';
import type { ScopeLeaveResult } from '../../src/features/reader/DocumentEditSessions.ts';
import { waitForSnapshot } from './waitForSnapshot.ts';

export type Host = 'native' | 'web';
export const TITLE = { pdf: 'UN PDF', pdf2: 'UN PDF second', noteA: 'UN Note A', noteB: 'UN Note B' } as const;
export const BLOCKED_TEXT = '入力を確定または取り消し、保存を確認してから資料を変更してください。';

/** Documents of one run. `noteB` is opened first; `noteA` holds citation links into `pdf`; `pdf2` is only a switch target. */
export type Ids = { pdf: string; pdf2: string; noteA: string; noteB: string; target: CitationTarget };

export function makeSeed() {
  const ids = {} as Ids;
  const sticky = (text: string): StickyNote => ({ kind: 'sticky', id: crypto.randomUUID(), text, anchor: { x: 80, y: 100 }, color: null,
    metadata: { label: 'unknown-nav', createdAt: null } });
  const seed = (publication: ContentPublication) => {
    assert.ok(publication.content?.kind === 'document');
    publication.content.pages[0].annotations = [sticky('unknown-nav sticky A')];
    publication.content.pages[1].annotations = [];
    const item = publication.libraryBatch.changes.find(change => change.type === 'put-item');
    assert.ok(item?.type === 'put-item');
  };
  const additionalPublications = (pdf: ContentPublication) => {
    assert.ok(pdf.content?.kind === 'document');
    const change = pdf.libraryBatch.changes.find(value => value.type === 'put-item'); assert.ok(change?.type === 'put-item');
    change.item.title = TITLE.pdf;
    ids.pdf = pdf.content.id;
    const page = pdf.content.pages[1];
    ids.target = { libraryId: pdf.libraryBatch.libraryId, documentId: pdf.content.id, pageId: page.id, backgroundRevision: page.backgroundRevision,
      surface: 'original', anchor: { xPt: page.widthPt / 2, yPt: page.heightPt * .12 } };
    let parent = pdf.libraryBatch.id, position = 1;
    const make = (content: ContentPublication['content'] & object, title: string): ContentPublication => {
      const id = crypto.randomUUID();
      const item = { ...structuredClone(change.item), id: content.id, title, kind: content.kind === 'document' ? 'pdf' as const : 'markdown' as const, position: position++ };
      if (content.kind === 'markdown') delete item.resourceId;
      const publication: ContentPublication = { libraryBatch: { ...structuredClone(pdf.libraryBatch), id, parents: [parent], changes: [{ type: 'put-item', item }] }, content };
      parent = id; return publication;
    };
    const other = structuredClone(pdf.content); other.id = crypto.randomUUID(); other.version = crypto.randomUUID(); delete other.translation;
    other.pages = [{ ...structuredClone(other.pages[0]), id: crypto.randomUUID(), annotations: [sticky('unknown-nav sticky B')] }];
    other.deletedPages = [];
    ids.pdf2 = other.id; ids.noteA = crypto.randomUUID(); ids.noteB = crypto.randomUUID();
    const noteA = { kind: 'markdown' as const, id: ids.noteA, version: crypto.randomUUID(), appendIds: [], imageResources: [],
      content: '# UN note A\n\n' + [markdownCitationLink(ids.target, 'unknown 引用 上'),
        markdownCitationLink({ ...ids.target, anchor: { xPt: page.widthPt / 2, yPt: page.heightPt * .32 } }, 'unknown 引用 下')].join('\n\n') };
    const noteB = { kind: 'markdown' as const, id: ids.noteB, version: crypto.randomUUID(), appendIds: [], imageResources: [], content: '# UN note B\n\nplain second note' };
    return { publications: [make(other, TITLE.pdf2), make(noteA, TITLE.noteA), make(noteB, TITLE.noteB)], initialDocumentId: ids.noteB };
  };
  return { ids, seed, additionalPublications };
}

// ---- reading the page -------------------------------------------------------------------------------------------------------------------------
export type Nav = { navigation: ContentNavigationState; documentId: string | null };
export const nav = (page: Page): Promise<Nav> => page.evaluate(() => (window as unknown as { compositionNavigationEvidence(): Nav }).compositionNavigationEvidence());
/** How many states the navigation session has published (grows at the start and at the end of every attempt). */
export const navRevision = (page: Page) => page.evaluate(() => (window as unknown as { compositionNavigationRevision(): number }).compositionNavigationRevision());
/** The history as plain document ids (the stack contents, not just their length). */
export const history = (state: Nav) => ({ back: state.navigation.back.map(location => location.documentId), forward: state.navigation.forward.map(location => location.documentId) });
/** Which document the real DOM shows. */
export const shownId = (page: Page) => page.locator('[data-content-document]').getAttribute('data-content-document');
export const scopeLeave = (page: Page) => page.evaluate(() => (window as unknown as { compositionScopeLeave(): Promise<ScopeLeaveResult> }).compositionScopeLeave());
export const libraryState = (page: Page) => page.evaluate(() => (window as unknown as {
  compositionLibraryEvidence(): Promise<{ session?: LibrarySessionState }>;
}).compositionLibraryEvidence()).then(value => value.session);

// ---- the host's reply loss ---------------------------------------------------------------------------------------------------------------------
type Setup = { native: Page; web: Page; committed: string[]; committedPayloads: string[]; setCommitReplyLoss(fail: boolean): void };
/** Native: the sidecar commit really happens and the HTTP reply is dropped. Web: the IndexedDB commit really happens and the reply is lost at the plan boundary. */
export const setReplyLoss = (setup: Setup, host: Host, lose: boolean) => host === 'native'
  ? Promise.resolve(setup.setCommitReplyLoss(lose))
  : setup.web.evaluate(lose => (window as unknown as { compositionWebReplyLoss(lose: boolean): void }).compositionWebReplyLoss(lose), lose);
type WebCall = { operation: string; batchIds: string[]; lost: boolean };
const webCalls = (page: Page) => page.evaluate(() => (window as unknown as { compositionWebCommitCalls(): WebCall[] }).compositionWebCommitCalls());
/** Requests that really reached the host's store since `mark`: Native = the sidecar's commit requests (id + body), Web = the IndexedDB commit plans. */
export async function attemptsSince(setup: Setup, host: Host, mark: Mark) {
  if (host === 'native') return { ids: setup.committed.slice(mark.count), payloads: setup.committedPayloads.slice(mark.count), calls: setup.committed.length - mark.count };
  const calls = (await webCalls(setup.web)).slice(mark.count);
  return { ids: calls.flatMap(call => call.batchIds), payloads: [] as string[], calls: calls.length };
}
export type Mark = { count: number };
export async function markAttempts(setup: Setup, host: Host): Promise<Mark> {
  return { count: host === 'native' ? setup.committed.length : (await webCalls(setup.web)).length };
}

// ---- driving the ordinary UI -------------------------------------------------------------------------------------------------------------------
export const catalogToggle = (page: Page) => page.getByRole('button', { name: '資料一覧', exact: true });
export async function expandCatalog(page: Page) { if (await catalogToggle(page).getAttribute('aria-expanded') !== 'true') await catalogToggle(page).click(); }
export const catalogItem = (page: Page, title: string) => page.getByRole('region', { name: '資料一覧', exact: true }).getByRole('button', { name: title, exact: true });
export const headingOf = (page: Page, title: string) => page.getByRole('heading', { name: title, exact: true });
/** Opens a document from the ordinary catalog and waits for the real DOM to show it. */
export async function openFromCatalog(page: Page, title: string, id: string) {
  await expandCatalog(page);
  await catalogItem(page, title).click();
  await page.locator(`[data-content-document="${id}"]`).waitFor();
  await headingOf(page, title).waitFor();
}
/** Leaves the editor for the preview. The first click blurs the editor, which flushes the note (and re-mounts the panel while it saves), so it is repeated until the preview sticks. */
export async function showPreview(page: Page) {
  await page.getByRole('button', { name: /^(プレビュー|編集)$/ }).waitFor();
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await page.getByRole('button', { name: '編集', exact: true }).count()) return;
    await page.getByRole('button', { name: 'プレビュー', exact: true }).click();
    await page.waitForFunction(() => !(window as unknown as { compositionNavigationEvidence(): { markdown?: { saving: boolean } } }).compositionNavigationEvidence().markdown?.saving);
  }
  await page.getByRole('button', { name: '編集', exact: true }).waitFor();
}
export async function showEditor(page: Page) {
  await page.getByRole('button', { name: /^(プレビュー|編集)$/ }).waitFor();
  const toggle = page.getByRole('button', { name: '編集', exact: true });
  if (await toggle.count()) await toggle.click();
  await page.getByRole('textbox', { name: 'Markdownノート', exact: true }).waitFor();
}
export const citationLink = (page: Page, name: string) => page.getByRole('link', { name, exact: true });
export const backButton = (page: Page) => page.getByRole('button', { name: '前の資料に戻る', exact: true });
export const forwardButton = (page: Page) => page.getByRole('button', { name: '次の資料に進む', exact: true });
export const blockedAlert = (page: Page) => page.getByRole('alert').filter({ hasText: BLOCKED_TEXT });
export const retryButton = (page: Page) => page.getByRole('button', { name: /^再試行$|^変更を再試行$|^作成を再試行$/ });

/** Waits until a navigation attempt has run to its end in the navigation session: the session published new states since `revisionBefore`, it is idle again, and the attempt
 *  left an outcome (it moved to another document, or reported an error). The revision tells that the attempt started, so an error left over from an earlier attempt is not
 *  taken for this one's; requiring an outcome too keeps an unrelated state publication (an attempt whose start is delayed, e.g. the annotation list validates the
 *  location first) from ending the wait early. Judging the outcome (refused or let through) is left to the caller's asserts, so a guard that lets the navigation through
 *  fails an assert (the document moved) instead of waiting for a refusal that never comes. */
export async function waitOutcome(page: Page, before: Nav, revisionBefore: number) {
  return waitForSnapshot(async () => ({ state: await nav(page), revision: await navRevision(page) }),
    value => value.revision > revisionBefore && !value.state.navigation.busy
      && (value.state.navigation.error !== '' || value.state.documentId !== before.documentId || value.state.navigation.documentId !== before.navigation.documentId)).then(value => value.state);
}

/** An attempt that must be let through: it runs to its end, is NOT refused, lands on `id` with exactly the expected history, and the real DOM shows `id`. */
export async function proceeds(page: Page, label: string, act: () => Promise<void>, id: string, back: string[], forward: string[], ready?: () => Promise<void>) {
  const before = await nav(page), revisionBefore = await navRevision(page);
  await act();
  const state = await waitOutcome(page, before, revisionBefore);
  assert.equal(state.navigation.error, '', `${label}: not refused`);
  assert.equal(state.navigation.documentId, id, `${label}: the navigation moved to the document`);
  await page.locator(`[data-content-document="${id}"]`).waitFor();
  if (ready) await ready();
  assert.equal(await shownId(page), id, `${label}: the real DOM shows the document`);
  assert.deepEqual(history(state), { back, forward }, `${label}: history`);
}

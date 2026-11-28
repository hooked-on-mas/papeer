import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer, type ViteDevServer } from 'vite';
import { createDesktopBootstrapHostDriver } from '../src/adapters/desktop/bootstrapHostDriver.ts';
import { createRecoveryClose } from '../src/adapters/desktop/NativeRecoveryClose.ts';
import type { NativeNotebookPreview, NativePreparationFacade, NativePreparationStatus, NativePreviewBlockedReason, NativePreviewResult } from '../src/features/bootstrap/bootstrapPorts.ts';
import { createPreviewController, projectNotebookPreview } from '../src/features/bootstrap/legacy/notebookPreviewModel.ts';
import { resourceHash } from '../src/runtime/edits/contentPublication.ts';
import { legacyBookmarkFixture } from './support/legacyBookmarkFixture.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const RUN = '11111111-1111-4111-8111-111111111111', NOTE = 'fedcba9876543210fedcba9876543210', OTHER = '0123456789abcdef0123456789abcdef';
const PAGES = ['0123456789abcdef0123456789abcdef', '1123456789abcdef0123456789abcdef'];
const REASONS: NativePreviewBlockedReason[] = ['preview-busy', 'preview-shutdown-pending', 'preview-cancelled', 'preview-capacity-exceeded', 'preview-unavailable'];
const signal = () => new AbortController().signal;

let server: ViteDevServer, NotebookPreviewPages: (props: { document: never }) => unknown, NativeNotebookPreview: (props: never) => unknown;
before(async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  server = await createServer({ configFile: false, root, logLevel: 'error', appType: 'custom', resolve: { alias: [{ find: '@', replacement: `${root}src` }] },
    server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  ({ NotebookPreviewPages, NativeNotebookPreview } = await server.ssrLoadModule('/src/features/bootstrap/legacy/NativeNotebookPreview.tsx'));
});
after(async () => { await server?.close(); });

/** Real-shaped wire value: two A4 pages, 2 strokes on page 2, the full bookmark fixture (2 notes, 5 highlights) on page 1. */
async function wireValue(overrides: Partial<NativeNotebookPreview> = {}): Promise<NativeNotebookPreview> {
  const notebook = { version: 1, revision: 1, pages: PAGES.map(id => ({ id, size: 'A4', orientation: 'portrait', width_mm: 210, height_mm: 297, template: 'ruled7', color: 'white' })) };
  const bytes = new TextEncoder().encode(JSON.stringify(notebook));
  const strokes = [0, 1].map(index => ({ id: `s${index}`, color: '#000000', width: .01, points: [[.1 + index / 10, .2], [.3, .4]] }));
  return { libraryId: fixture.libraryId, sourceDocumentId: NOTE, entry: { sha256: await resourceHash(bytes), byteLength: bytes.byteLength },
    bytesBase64: Buffer.from(bytes).toString('base64'),
    annotations: [{ pageId: PAGES[0], ink: [], bookmarks: legacyBookmarkFixture(NOTE, 1) }, { pageId: PAGES[1], ink: strokes, bookmarks: [] }],
    incomplete: ['page-text-not-converted', 'original-pdf-fidelity-unverified'], coverage: { pageRows: 2, inkRows: 1, bookmarkRows: 7 }, ...overrides };
}
const okBody = (value: NativeNotebookPreview) => ({ ...value, scope: 'native-notebook-preview-only' });

function browserGlobals(token: string | undefined) {
  const target = globalThis as Record<string, unknown>, saved = { window: target.window, addEventListener: target.addEventListener, removeEventListener: target.removeEventListener };
  target.window = { __PAPEER_PORT: 4321, ...(token ? { __PAPEER_TOKEN: token } : {}) };
  target.addEventListener = () => undefined; target.removeEventListener = () => undefined;
  return { restore() { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete target[key]; else target[key] = value; } } };
}

type Reply = { status: number; body: unknown };
async function withDriver<T>(replies: Reply[], run: (facade: NativePreparationFacade, seen: { path: string; body: unknown; auth: string | null }[], invalidations: () => number) => Promise<T>): Promise<T> {
  const env = browserGlobals('unit-test-token');
  try {
    const seen: { path: string; body: unknown; auth: string | null }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      seen.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get('Authorization') });
      const reply = replies.shift(); assert.ok(reply, 'unexpected request');
      return Response.json(reply.body, { status: reply.status });
    };
    const driver = createDesktopBootstrapHostDriver(fetcher); let invalidations = 0;
    driver.subscribeInvalidation?.(() => { invalidations++; });
    return await run(driver.getNativePreparation!(), seen, () => invalidations);
  } finally { env.restore(); }
}
const blocked = (reason: string) => ({ state: 'blocked', reason, scope: 'native-notebook-preview-only' });

// ---------------------------------------------------------------- driver
test('driver returns selectors and the preview with the documented requests only', async () => {
  const value = await wireValue();
  await withDriver([{ status: 200, body: { selectors: [NOTE, OTHER], scope: 'native-notebook-preview-only', limits: { backupTotalBytes: 1 } } }, { status: 200, body: okBody(value) }], async (facade, seen, invalidations) => {
    const list = await facade.notebookSelectors!(RUN, signal()); assert.deepEqual(list, { status: 'ok', selectors: [NOTE, OTHER] });
    const preview = await facade.notebookPreview!(RUN, NOTE, signal());
    assert.equal(preview.status, 'ok'); if (preview.status === 'ok') assert.deepEqual(preview.value, value);
    assert.deepEqual(seen.map(item => [item.path, item.body, item.auth]), [
      ['/api/edits/legacy-maintenance/notebooks', { runId: RUN }, 'Bearer unit-test-token'],
      ['/api/edits/legacy-maintenance/notebook-preview', { runId: RUN, selector: NOTE }, 'Bearer unit-test-token']]);
    assert.equal(invalidations(), 0);
  });
});

for (const reason of REASONS) test(`driver returns a 409 ${reason} as a value without invalidating the host`, async () => {
  await withDriver([{ status: 409, body: blocked(reason) }, { status: 409, body: blocked(reason) }], async (facade, _seen, invalidations) => {
    assert.deepEqual(await facade.notebookSelectors!(RUN, signal()), { status: 'blocked', reason });
    assert.deepEqual(await facade.notebookPreview!(RUN, NOTE, signal()), { status: 'blocked', reason });
    assert.equal(invalidations(), 0);
  });
});

test('driver treats 401 as an authorization failure that invalidates, and other statuses as failures', async () => {
  await withDriver([{ status: 401, body: { detail: 'denied' } }, { status: 500, body: blocked('preview-busy') }, { status: 422, body: blocked('preview-busy') }], async (facade, _seen, invalidations) => {
    await assert.rejects(facade.notebookSelectors!(RUN, signal()), /native-request-failed/); assert.equal(invalidations(), 1);
    await assert.rejects(facade.notebookSelectors!(RUN, signal()), /native-request-failed/);
    await assert.rejects(facade.notebookPreview!(RUN, NOTE, signal()), /native-request-failed/);
  });
});

test('driver rejects malformed refusals and results', async () => {
  const value = await wireValue(), good = okBody(value);
  const lists: Reply[] = [
    { status: 200, body: { selectors: Array.from({ length: 257 }, (_, index) => index.toString(16).padStart(32, '0')), scope: 'native-notebook-preview-only' } },
    { status: 200, body: { selectors: [NOTE, NOTE], scope: 'native-notebook-preview-only' } },
    { status: 200, body: { selectors: ['ABC'], scope: 'native-notebook-preview-only' } },
    { status: 200, body: { selectors: [NOTE], scope: 'native-preparation-only' } },
    { status: 200, body: { selectors: 'x', scope: 'native-notebook-preview-only' } },
    { status: 200, body: [] },
    { status: 409, body: blocked('who-knows') },
    { status: 409, body: { ...blocked('preview-busy'), detail: 'extra' } },
    { status: 409, body: { state: 'blocked', reason: 'preview-busy', scope: 'native-preparation-only' } },
    { status: 409, body: { state: 'idle', scope: 'native-notebook-preview-only' } },
  ];
  const listCount = lists.length;
  await withDriver([...lists], async facade => { for (let index = 0; index < listCount; index++) await assert.rejects(facade.notebookSelectors!(RUN, signal()), /preview-invalid-response/, `list case ${index}`); });
  const previews: Reply[] = [
    { status: 200, body: { ...good, scope: 'other' } },
    { status: 200, body: { ...good, sourceDocumentId: OTHER } },
    { status: 200, body: { ...good, entry: { ...value.entry, sha256: 'xyz' } } },
    { status: 200, body: { ...good, entry: { ...value.entry, byteLength: -1 } } },
    { status: 200, body: { ...good, entry: { ...value.entry, byteLength: 1.5 } } },
    { status: 200, body: { ...good, bytesBase64: 'a'.repeat(8 * 1024 * 1024 + 4) } },
    { status: 200, body: { ...good, bytesBase64: 7 } },
    { status: 200, body: { ...good, annotations: {} } },
    { status: 200, body: { ...good, incomplete: [1] } },
    { status: 200, body: { ...good, coverage: { pageRows: -1, inkRows: 0, bookmarkRows: 0 } } },
    { status: 200, body: { ...good, coverage: { pageRows: 1, inkRows: 0 } } },
    { status: 200, body: { ...good, libraryId: '' } },
  ];
  const previewCount = previews.length;
  await withDriver([...previews], async facade => { const count = previewCount; for (let index = 0; index < count; index++) await assert.rejects(facade.notebookPreview!(RUN, NOTE, signal()), /preview-invalid-response/, `preview case ${index}`); });
});

test('driver refuses badly shaped requests before sending anything', async () => {
  await withDriver([], async (facade, seen) => {
    await assert.rejects(facade.notebookSelectors!('not-a-run', signal()), /preview-invalid-request/);
    await assert.rejects(facade.notebookPreview!(RUN, 'short', signal()), /preview-invalid-request/);
    await assert.rejects(facade.notebookPreview!(RUN, NOTE.toUpperCase(), signal()), /preview-invalid-request/);
    await assert.rejects(facade.notebookPreview!('not-a-run', NOTE, signal()), /preview-invalid-request/);
    assert.equal(seen.length, 0);
  });
});

// ---------------------------------------------------------------- close
const idle: NativePreparationStatus = { state: 'captured', runId: RUN, scope: 'native-preparation-only' };
function hung() {
  let started!: () => void; const begun = new Promise<void>(resolve => { started = resolve; });
  let observed: AbortSignal | undefined;
  const facade: NativePreparationFacade = { status: async () => idle, start: async () => idle, resume: async () => idle, abandon: async () => idle,
    notebookSelectors: async () => ({ status: 'ok', selectors: [NOTE] }),
    notebookPreview: (_run, _selector, given) => { observed = given; started();
      return new Promise<never>((_resolve, reject) => given.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true })); } };
  return { facade, begun, signalOf: () => observed };
}

test('closing during a preview aborts it and still shuts down, instead of reporting refused', async () => {
  const { facade, begun, signalOf } = hung(); const order: string[] = [];
  const recovery = createRecoveryClose({ close: async () => { order.push('session'); return { status: 'allowed' }; } }, facade,
    { shutdown: async () => { order.push(`shutdown(aborted=${signalOf()?.aborted})`); }, exit: async () => { order.push('exit'); } });
  const pending = recovery.facade.notebookPreview!(RUN, NOTE, signal()); const settled = pending.then(() => 'value', () => 'rejected');
  await begun;
  await assert.rejects(recovery.facade.start(signal()), /maintenance-preview-pending/);
  await assert.rejects(recovery.facade.resume(RUN, signal()), /maintenance-preview-pending/);
  await assert.rejects(recovery.facade.abandon(RUN, signal()), /maintenance-preview-pending/);
  await recovery.close.request();
  assert.notEqual(recovery.close.getSnapshot(), 'refused'); assert.notEqual(recovery.close.getSnapshot(), 'failed');
  assert.deepEqual(order, ['shutdown(aborted=true)', 'session', 'exit']); assert.equal(await settled, 'rejected');
  // Once the drain is confirmed, a new preview is a value, not a hang or an exception.
  assert.deepEqual(await recovery.facade.notebookSelectors!(RUN, signal()), { status: 'blocked', reason: 'preview-shutdown-pending' });
});

test('an unconfirmed shutdown keeps the exit closed, aborts the preview once, and a retry completes', async () => {
  const { facade, begun } = hung(); let shutdowns = 0, exits = 0;
  const recovery = createRecoveryClose({ close: async () => ({ status: 'allowed' }) }, facade,
    { shutdown: async () => { shutdowns++; if (shutdowns === 1) throw new Error('shutdown-incomplete'); }, exit: async () => { exits++; } });
  const pending = recovery.facade.notebookPreview!(RUN, NOTE, signal()).catch(() => 'aborted'); await begun;
  await recovery.close.request(); assert.equal(recovery.close.getSnapshot(), 'failed'); assert.equal(exits, 0); assert.equal(await pending, 'aborted');
  await recovery.close.request(); assert.equal(shutdowns, 2); assert.equal(exits, 1);
});

test('a caller abort reaches the underlying request, and a mutation in progress makes a preview busy', async () => {
  const { facade, begun, signalOf } = hung();
  const recovery = createRecoveryClose({ close: async () => ({ status: 'allowed' }) }, facade, { shutdown: async () => {}, exit: async () => {} });
  const caller = new AbortController(), pending = recovery.facade.notebookPreview!(RUN, NOTE, caller.signal).catch(() => 'aborted'); await begun;
  caller.abort(); assert.equal(signalOf()?.aborted, true); assert.equal(await pending, 'aborted');
  // The abort released the preview fence, so a mutation is allowed again.
  let release!: (value: NativePreparationStatus) => void;
  const slow = new Promise<NativePreparationStatus>(resolve => { release = resolve; });
  const second = createRecoveryClose({ close: async () => ({ status: 'allowed' }) }, { ...facade, start: () => slow }, { shutdown: async () => {}, exit: async () => {} });
  const started = second.facade.start(signal());
  assert.deepEqual(await second.facade.notebookSelectors!(RUN, signal()), { status: 'blocked', reason: 'preview-busy' });
  release(idle); await started;
  assert.equal((await recovery.facade.start(signal())).state, 'captured');
});

// ---------------------------------------------------------------- model
test('projectNotebookPreview decodes strictly and refuses mismatches and aborts', async () => {
  const value = await wireValue(), document = await projectNotebookPreview(value, signal());
  assert.equal(document.pages.length, 2);
  await assert.rejects(projectNotebookPreview({ ...value, bytesBase64: value.bytesBase64.slice(1) }, signal()), /preview-bytes-invalid/);
  await assert.rejects(projectNotebookPreview({ ...value, bytesBase64: value.bytesBase64.replace(/.$/, '*') }, signal()), /preview-bytes-invalid/);
  await assert.rejects(projectNotebookPreview({ ...value, bytesBase64: ` ${value.bytesBase64}` }, signal()), /preview-bytes-invalid/);
  await assert.rejects(projectNotebookPreview({ ...value, entry: { ...value.entry, byteLength: value.entry.byteLength + 1 } }, signal()), /preview-bytes-mismatch/);
  await assert.rejects(projectNotebookPreview({ ...value, entry: { ...value.entry, sha256: 'a'.repeat(64) } }, signal()), /notebook-entry-mismatch/);
  await assert.rejects(projectNotebookPreview({ ...value, annotations: value.annotations.slice(0, 1) }, signal()), /notebook-/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(projectNotebookPreview(value, aborted.signal));
});

function scripted(steps: { list?: () => Promise<NativePreviewResult<{ selectors: readonly string[] }>>; preview?: (selector: string, given: AbortSignal) => Promise<NativePreviewResult<{ value: NativeNotebookPreview }>> }): NativePreparationFacade {
  return { status: async () => idle, start: async () => idle, resume: async () => idle, abandon: async () => idle,
    notebookSelectors: steps.list ?? (async () => ({ status: 'ok', selectors: [NOTE, OTHER] })),
    notebookPreview: (_run, selector, given) => steps.preview!(selector, given) };
}

test('controller: per-note states, refusal reasons, one request at a time, one document kept', async () => {
  const value = await wireValue();
  const controller = createPreviewController(scripted({ preview: async selector => selector === NOTE ? { status: 'ok', value } : { status: 'blocked', reason: 'preview-capacity-exceeded' } }), RUN);
  const states: boolean[] = []; controller.subscribe(() => states.push(controller.getSnapshot().busy));
  await controller.loadNote(NOTE); assert.deepEqual(controller.getSnapshot().notes, {}, 'no note can load before the list');
  await controller.loadList(); assert.deepEqual(controller.getSnapshot().list, { kind: 'ok', selectors: [NOTE, OTHER] });
  await controller.loadNote(NOTE);
  const first = controller.getSnapshot().notes[NOTE]; assert.equal(first.kind, 'ok');
  if (first.kind === 'ok') { assert.equal(first.document.pages.length, 2); assert.equal(first.inkRows, 1); assert.equal(first.bookmarkRows, 7); }
  await controller.loadNote(OTHER);
  assert.deepEqual(controller.getSnapshot().notes[OTHER], { kind: 'blocked', reason: 'preview-capacity-exceeded' });
  assert.deepEqual(controller.getSnapshot().notes[NOTE], { kind: 'idle' }, 'the previous document is dropped');
  assert.deepEqual(Object.keys(controller.getSnapshot().notes).sort(), [NOTE, OTHER].sort(), 'a refused note stays in the list');
  assert.equal(controller.getSnapshot().busy, false); assert.ok(states.includes(true) && states[states.length - 1] === false);
});

test('controller: single flight, user cancel shows cancelled, failures become errors, dispose is silent', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0, seen: AbortSignal | undefined;
  const facade = scripted({ preview: async (_selector, given) => { calls++; seen = given;
    await Promise.race([gate, new Promise((_resolve, reject) => given.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }))]);
    return { status: 'ok', value: await wireValue() }; } });
  const controller = createPreviewController(facade, RUN); await controller.loadList();
  const first = controller.loadNote(NOTE); await Promise.resolve();
  assert.equal(controller.getSnapshot().busy, true); assert.deepEqual(controller.getSnapshot().notes[NOTE], { kind: 'loading' });
  await controller.loadNote(OTHER); await controller.loadList(); assert.equal(calls, 1, 'a second request is not started while one is running');
  controller.cancel(); await first; assert.equal(seen?.aborted, true);
  assert.deepEqual(controller.getSnapshot().notes[NOTE], { kind: 'blocked', reason: 'preview-cancelled' }); assert.equal(controller.getSnapshot().busy, false);

  const failing = createPreviewController(scripted({ list: async () => { throw new Error('/secret/path'); } }), RUN);
  await failing.loadList(); assert.deepEqual(failing.getSnapshot().list, { kind: 'error' }); assert.doesNotMatch(JSON.stringify(failing.getSnapshot()), /secret/);
  const refused = createPreviewController(scripted({ list: async () => ({ status: 'blocked', reason: 'preview-shutdown-pending' }) }), RUN);
  await refused.loadList(); assert.deepEqual(refused.getSnapshot().list, { kind: 'blocked', reason: 'preview-shutdown-pending' });
  const bad = createPreviewController(scripted({ preview: async () => ({ status: 'ok', value: await wireValue({ bytesBase64: 'AAAA' }) }) }), RUN);
  await bad.loadList(); await bad.loadNote(NOTE); assert.equal(bad.getSnapshot().notes[NOTE]?.kind, 'error');

  const late = scripted({ preview: async () => { await gate; return { status: 'ok', value: await wireValue() }; } });
  const disposed = createPreviewController(late, RUN); await disposed.loadList();
  let notified = 0; disposed.subscribe(() => { notified++; });
  const running = disposed.loadNote(NOTE); const before = notified; disposed.dispose(); release(); await running;
  assert.equal(notified, before, 'no state is published after dispose');
});

test('controller does nothing when the facade has no preview methods', async () => {
  const controller = createPreviewController({ status: async () => idle, start: async () => idle, resume: async () => idle, abandon: async () => idle }, RUN);
  await controller.loadList(); assert.deepEqual(controller.getSnapshot(), { list: { kind: 'idle' }, notes: {}, busy: false });
});

// ---------------------------------------------------------------- render
test('NotebookPreviewPages draws one labelled page per page with its ink and stickies', async () => {
  const document = await projectNotebookPreview(await wireValue(), signal());
  const html = renderToStaticMarkup(createElement(NotebookPreviewPages as never, { document }));
  assert.deepEqual([...html.matchAll(/aria-label="(ページ \d+)"/g)].map(match => match[1]), ['ページ 1', 'ページ 2']);
  const kinds = document.pages.map(page => page.annotations.map(annotation => annotation.kind));
  assert.equal((html.match(/data-ink-id="/g) ?? []).length, 2);
  assert.equal((html.match(/data-sticky-id="/g) ?? []).length, 2);
  assert.equal((html.match(/data-highlight-id="/g) ?? []).length, 5);
  assert.equal(kinds[0].filter(kind => kind === 'sticky').length, 2); assert.equal(kinds[1].filter(kind => kind === 'ink').length, 2);
  assert.match(html, /aspect-ratio:210 \/ 297|aspect-ratio:\s*[\d.]+ \/ [\d.]+/);
  assert.doesNotMatch(html, /<button|<input|<img|<canvas/);
});

test('NativeNotebookPreview opens idle: states what is and is not verified and offers no cancel yet', () => {
  const html = renderToStaticMarkup(createElement(NativeNotebookPreview as never, { facade: scripted({}), runId: RUN }));
  assert.match(html, /保存したノートを確認/); assert.match(html, /編集や移行は行いません/); assert.match(html, /256MiB/);
  assert.doesNotMatch(html, /確認を取り消す/); assert.doesNotMatch(html, new RegExp(NOTE));
});

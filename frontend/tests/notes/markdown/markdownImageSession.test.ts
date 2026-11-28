import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MarkdownEditSession, type MarkdownImagePort } from '../../../src/features/notes/markdown/MarkdownEditSession.ts';
import type { MarkdownDraftPort } from '../../../src/features/notes/markdown/MarkdownDraftPort.ts';
import type { MarkdownSnapshot } from '../../../src/runtime/edits/contracts.ts';
import { DurableEditRepository } from '../../../src/runtime/edits/repository.ts';
import { markdownImageMarkup } from '../../../src/runtime/markdown/markdownImages.ts';
import { EditMemoryDatabase } from '../../support/editMemoryDatabase.ts';

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1cAAAAASUVORK5CYII=', 'base64'));
async function setup(wrap: (port: MarkdownImagePort) => MarkdownImagePort = port => port) {
  const scope = { accountId: 'markdown-image-test', libraryId: crypto.randomUUID(), epoch: 'one' };
  const repository = new DurableEditRepository(scope, new EditMemoryDatabase());
  const root: MarkdownSnapshot = { kind: 'markdown', id: crypto.randomUUID(), version: crypto.randomUUID(), content: 'base', appendIds: [], imageResources: [] };
  await repository.initialize(root);
  let raw: unknown;
  const drafts: MarkdownDraftPort = { scope, targets: () => raw === undefined ? [] : [root.id],
    read: () => structuredClone(raw), write: (_, value) => { raw = structuredClone(value); }, remove: () => { raw = undefined; } };
  const resources = wrap(repository);
  const create = () => new MarkdownEditSession(repository, root.id, drafts, undefined, undefined, resources);
  const session = create(); assert.equal(await session.refresh(), true);
  return { repository, root, drafts, session, create, raw: () => raw, setRaw: (value: unknown) => { raw = value; } };
}
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(condition(), 'controlled async boundary reached');
};

test('external image append IDs retry original metadata and suffix as one immutable append', async () => {
  let lose = true; const storedIds: string[] = [];
  const { session } = await setup(port => ({ ...port, storeResource: async input => {
    storedIds.push(input.id); const metadata = await port.storeResource(input);
    if (lose) { lose = false; throw new Error('lost-resource-reply'); } return metadata;
  } }));
  const appendId = crypto.randomUUID();
  assert.equal(await session.appendImage({ appendId, bytes: png, mediaType: 'image/png', alt: 'original', suffix: '\noriginal citation\n' }), false);
  assert.equal(session.appendStatus(appendId), 'pending');
  assert.equal(await session.appendImage({ appendId, bytes: async () => { throw new Error('replacement must not run'); }, mediaType: 'bad/type', alt: 'replacement', suffix: 'replacement' }), true);
  await session.flush();
  assert.deepEqual(storedIds, [storedIds[0], storedIds[0]]);
  assert.match(session.getSnapshot().content, /!\[original\]/); assert.match(session.getSnapshot().content, /original citation/);
  assert.doesNotMatch(session.getSnapshot().content, /replacement/); assert.equal(session.appendStatus(appendId), 'accepted');
  const content = session.getSnapshot().content;
  assert.equal(await session.appendImage({ appendId, bytes: png, mediaType: 'image/png', suffix: 'duplicate' }), true);
  assert.equal(session.getSnapshot().content, content);
});

test('image body and manifest save together, survive reload and durable Undo/Redo', async () => {
  const { session, create, repository, root } = await setup();
  assert.equal(await session.appendImage({ bytes: png, mediaType: 'image/png', alt: 'diagram [a]' }), true);
  const state = session.getSnapshot();
  assert.equal(state.imageResources.length, 1); assert.match(state.content, /^base\n\n!\[/);
  assert.deepEqual((await repository.readResource(state.imageResources[0].resourceId))!.bytes, png);
  assert.equal(session.canLeave(), false); await session.flush(); assert.equal(session.canLeave(), true);
  const saved = session.getSnapshot().content;
  const reload = create(); await reload.refresh(); assert.equal(reload.getSnapshot().content, saved);
  assert.equal(await reload.undo(), true); assert.equal(reload.getSnapshot().content, 'base');
  assert.deepEqual(reload.getSnapshot().imageResources, []);
  const again = create(); await again.refresh(); assert.equal(await again.redo(), true);
  assert.equal(again.getSnapshot().content, saved); assert.deepEqual(again.getSnapshot().imageResources, state.imageResources);
  assert.equal((await repository.read(root.id)).checkpoint.batches.length, 3);
});

test('resource durable reply loss retries the same asset and append without changing the original body', async () => {
  const ids: string[] = []; let lose = true;
  const { session } = await setup(port => ({ ...port, storeResource: async input => {
    ids.push(input.id); const result = await port.storeResource(input);
    if (lose) { lose = false; throw new Error('resource-reply-lost'); } return result;
  } }));
  assert.equal(await session.appendImage({ bytes: png, mediaType: 'image/png' }), false);
  assert.equal(session.getSnapshot().content, 'base'); assert.equal(session.canLeave(), false);
  await session.retry(); assert.deepEqual(ids, [ids[0], ids[0]]);
  assert.equal(session.getSnapshot().accepted!.appendIds.length, 1);
  assert.equal(session.getSnapshot().imageResources.length, 1); assert.equal(session.canLeave(), true);
});

test('typing during resource IO is preserved and cancel drains IO without appending', async () => {
  for (const cancel of [false, true]) {
    let release: (() => void) | undefined;
    const { session } = await setup(port => ({ ...port, storeResource: async input => {
      await new Promise<void>(resolve => { release = resolve; }); return port.storeResource(input);
    } }));
    const adding = session.appendImage({ bytes: png, mediaType: 'image/png' }); await until(() => !!release);
    session.editText('later text');
    if (cancel) session.cancelImage();
    assert.equal(session.canLeave(), false); release!(); assert.equal(await adding, !cancel);
    assert.ok(session.getSnapshot().content.startsWith('later text'));
    assert.equal(session.getSnapshot().imageResources.length, cancel ? 0 : 1);
    await session.flush(); assert.equal(session.canLeave(), true);
  }
});

test('malformed image draft remains editable on restart and missing assets never lock an immutable request', async () => {
  const { session, create, repository, root } = await setup();
  session.editText('![broken](papeer://resource/bad)'); await session.flush();
  const reload = create(); assert.equal(await reload.refresh(), true);
  assert.equal(reload.getSnapshot().editingBlocked, false); assert.ok(reload.getSnapshot().imageProblem);
  const ref = { resourceId: crypto.randomUUID(), sha256: 'a'.repeat(64) };
  reload.editText(markdownImageMarkup(ref)); await reload.flush();
  assert.equal(await repository.readIntent(root.id), undefined);
  assert.equal((await repository.read(root.id)).checkpoint.batches.length, 0);
  reload.editText('fixed'); await reload.flush(); assert.equal(reload.canLeave(), true);
  assert.equal(reload.getSnapshot().accepted!.content, 'fixed');
});

test('unconfirmed bytes and nonimage files cannot enter Markdown history', async () => {
  const { session, repository, root } = await setup(port => ({ ...port, readResource: async id => {
    const stored = await port.readResource(id); return stored && { ...stored, bytes: new Uint8Array([0]) };
  } }));
  assert.equal(await session.appendImage({ bytes: png, mediaType: 'image/png' }), false);
  assert.match(session.getSnapshot().error, /unconfirmed/); assert.equal(session.getSnapshot().content, 'base');
  session.cancelImage();
  assert.equal(await session.appendImage({ bytes: png, mediaType: 'text/html' }), false);
  assert.match(session.getSnapshot().error, /media-type/); session.cancelImage();
  assert.equal((await repository.read(root.id)).checkpoint.batches.length, 0);
});

test('corrupt scratch image manifests are preserved and cannot publish body-only history', async () => {
  for (const field of ['current', 'append'] as const) {
    const { session, create, raw, setRaw, repository, root } = await setup();
    assert.equal(await session.appendImage({ bytes: png, mediaType: 'image/png' }), true);
    const corrupted = structuredClone(raw()) as { imageResources: unknown[]; appendSnapshots: { imageResources: unknown[] }[] };
    if (field === 'current') corrupted.imageResources = [];
    else corrupted.appendSnapshots[0].imageResources = [];
    setRaw(corrupted);
    const reload = create(); assert.equal(await reload.refresh(), false);
    assert.equal(reload.getSnapshot().editingBlocked, true); assert.equal(reload.canLeave(), false);
    await reload.flush(); assert.deepEqual(raw(), corrupted);
    assert.equal((await repository.read(root.id)).checkpoint.batches.length, 0);
  }
});

test('journal-only recovery refuses a mismatched image manifest without clearing recovery data', async () => {
  const { repository, root, create } = await setup();
  const id = crypto.randomUUID();
  const record = { id: crypto.randomUUID(), intent: { dispatched: true, undoRequested: false, request: {
    batch: { kind: 'markdown' as const, id, libraryId: repository.scope.libraryId, targetId: root.id, parents: [root.version],
      content: markdownImageMarkup({ resourceId: crypto.randomUUID(), sha256: 'a'.repeat(64) }), imageResources: [] },
    history: { operationId: id, beforeVersion: root.version, afterVersion: id, undoRequested: false },
  } } };
  await repository.replaceIntent(root.id, record, null);
  const reload = create(); assert.equal(await reload.refresh(), false); await reload.retry();
  assert.equal(reload.getSnapshot().editingBlocked, true); assert.equal(reload.canLeave(), false);
  assert.deepEqual(await repository.readIntent(root.id), record);
  assert.equal((await repository.read(root.id)).checkpoint.batches.length, 0);
});

test('image append and later typing recover together after a lost commit reply', async () => {
  const { repository, root, drafts } = await setup();
  let lose = true;
  const sent: string[] = [];
  const writer = { ...repository, commit: async (...args: Parameters<typeof repository.commit>) => {
    sent.push(args[0].id); const result = await repository.commit(...args);
    if (lose) { lose = false; return { status: 'unknown' as const, reason: 'lost' }; } return result;
  } };
  const session = new MarkdownEditSession(writer, root.id, drafts, undefined, undefined, repository);
  await session.refresh(); await session.appendImage({ bytes: png, mediaType: 'image/png' });
  const imageBody = session.getSnapshot().content, references = session.getSnapshot().imageResources;
  await session.flush(); assert.equal(session.canLeave(), false);
  session.editText(imageBody + '\nlater input');
  const reload = new MarkdownEditSession(writer, root.id, drafts, undefined, undefined, repository);
  assert.equal(await reload.refresh(), true); await reload.retry();
  assert.equal(reload.canLeave(), true); assert.equal(sent[0], sent[1]);
  assert.equal(reload.getSnapshot().accepted!.content, imageBody + '\nlater input');
  assert.deepEqual(reload.getSnapshot().accepted!.imageResources, references);
  assert.equal(reload.getSnapshot().accepted!.appendIds.length, 1);
  assert.equal(await reload.undo(), true); assert.equal(reload.getSnapshot().content, imageBody);
  assert.equal(await reload.undo(), true); assert.equal(reload.getSnapshot().content, 'base');
  assert.deepEqual(reload.getSnapshot().imageResources, []);
});

test('valid manifests with different ordering retain durable Undo/Redo and scratch recovery', async () => {
  const { session, repository, root, create, raw, setRaw } = await setup();
  await session.appendImage({ bytes: png, mediaType: 'image/png' });
  await session.appendImage({ bytes: png, mediaType: 'image/png' });
  const scratch = structuredClone(raw()) as { imageResources: unknown[]; appendSnapshots: { imageResources: unknown[] }[] };
  scratch.imageResources.reverse(); scratch.appendSnapshots[1].imageResources.reverse(); setRaw(scratch);
  const recovered = create(); assert.equal(await recovered.refresh(), true); await recovered.flush();
  const before = recovered.getSnapshot().accepted!;
  const reordered = { kind: 'markdown' as const, id: crypto.randomUUID(), targetId: root.id, libraryId: repository.scope.libraryId,
    parents: [before.version], content: before.content, imageResources: [...before.imageResources].reverse() };
  const originalPayload = structuredClone(reordered);
  await repository.receive([reordered]); assert.equal(await recovered.refresh(), true);
  recovered.editText(before.content + '\nchange'); await recovered.flush();
  assert.equal(await recovered.undo(), true);
  assert.deepEqual(recovered.getSnapshot().accepted!.imageResources, reordered.imageResources);
  assert.equal(await recovered.redo(), true); assert.equal(recovered.getSnapshot().content, before.content + '\nchange');
  assert.deepEqual((await repository.read(root.id)).checkpoint.batches.find(batch => batch.id === reordered.id), originalPayload);
});

test('a second editor owner cannot discard another editor’s pending image', async () => {
  let release: (() => void) | undefined;
  const { session } = await setup(port => ({ ...port, storeResource: async input => {
    await new Promise<void>(resolve => { release = resolve; }); return port.storeResource(input);
  } }));
  const owner = Symbol('owner'), other = Symbol('readonly');
  assert.equal(session.acquireEditor(owner), true); assert.equal(session.acquireEditor(other), false);
  const adding = session.appendImage({ bytes: png, mediaType: 'image/png' }, owner); await until(() => !!release);
  assert.equal(session.cancelImage(other), false); assert.equal(session.getSnapshot().imagePending, true);
  assert.equal(session.cancelImage(owner), true); assert.equal(session.canLeave(), false);
  release!(); assert.equal(await adding, false); assert.equal(session.getSnapshot().content, 'base');
  assert.equal(session.canLeave(), true);
});

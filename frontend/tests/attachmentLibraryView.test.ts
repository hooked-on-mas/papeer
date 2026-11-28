import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readAttachmentResource, attachmentText } from '../src/features/reader/attachmentResource.ts';
import { DurableEditRepository } from '../src/runtime/edits/repository.ts';
import { EditMemoryDatabase } from './support/editMemoryDatabase.ts';
import { resourceHash } from '../src/runtime/edits/contentPublication.ts';
import type { LibrarySnapshot } from '../src/runtime/edits/contracts.ts';

test('attachment reader validates exact identity, bytes and metadata without creating a content authority', async () => {
  const scope = { accountId: 'attachment', libraryId: crypto.randomUUID(), epoch: 'one' };
  const repository = new DurableEditRepository(scope, new EditMemoryDatabase());
  const id = crypto.randomUUID(), owner = crypto.randomUUID(), resourceId = crypto.randomUUID();
  const bytes = new TextEncoder().encode('<script>globalThis.executed=true</script>');
  await repository.storeResource({ id: resourceId, bytes, sha256: await resourceHash(bytes), mediaType: 'text/html' });
  const base = { title: 'owner', ownerId: null, folderId: null, position: 0, tags: [], read: false, metadata: {} };
  const root: LibrarySnapshot = { kind: 'library', id: scope.libraryId, version: crypto.randomUUID(), folders: [], links: [], deletions: [],
    items: [{ ...base, id: owner, kind: 'markdown' }, { ...base, id, kind: 'attachment', ownerId: owner, resourceId, title: 'example.html' }] };
  await repository.initialize({ kind: 'markdown', id: owner, version: crypto.randomUUID(), content: '', imageResources: [], appendIds: [] });
  await repository.initialize(root);
  const read = repository.read.bind(repository), readResource = repository.readResource.bind(repository);
  const source = { scope, read: async (targetId: string) => { assert.equal(targetId, scope.libraryId); return read(targetId); }, readResource };
  const result = await readAttachmentResource(source, id);
  assert.equal(result.item.id, id); assert.equal(result.deleted, false);
  assert.equal(attachmentText(result.resource.metadata.mediaType, result.item.title, result.resource.bytes), new TextDecoder().decode(bytes));
  await assert.rejects(readAttachmentResource(source, owner), /attachment-missing/);
  await assert.rejects(readAttachmentResource(source, id, crypto.randomUUID()), /head-unavailable/);
  await assert.rejects(readAttachmentResource({ ...source, readResource: async () => undefined }, id), /resource-missing/);
  await assert.rejects(readAttachmentResource({ ...source, readResource: async () => ({ ...result.resource, bytes: new Uint8Array(bytes.length) }) }, id), /resource-invalid/);
  await assert.rejects(readAttachmentResource({ ...source, readResource: async () => ({ ...result.resource, metadata: { ...result.resource.metadata, id: crypto.randomUUID() } }) }, id), /resource-invalid/);
  assert.equal((await read(scope.libraryId)).checkpoint.batches.length, 0);
});

test('untrusted HTML stays escaped source and the read-only surface releases resource URLs and stale requests', () => {
  const view = readFileSync(new URL('../src/features/reader/AttachmentLibraryView.tsx', import.meta.url), 'utf8');
  assert.match(view, /<pre[^>]*>\{loaded.text\}<\/pre>/);
  assert.doesNotMatch(view, /dangerouslySetInnerHTML|srcDoc|getMarkdown\(/);
  assert.match(view, /URL.revokeObjectURL\(url\)/);
  assert.match(view, /if \(!alive\(\)\) return;/);
  assert.match(view, /sandbox=""/);
  assert.match(view, /download=\{loaded.title\}/);
  assert.equal(attachmentText('application/octet-stream', 'note.md', new TextEncoder().encode('# attached')), '# attached');
  assert.equal(attachmentText('application/octet-stream', 'binary.bin', new Uint8Array([0, 1])), null);
});

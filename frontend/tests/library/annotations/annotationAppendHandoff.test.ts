import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnnotationAppendHandoff } from '../../../src/features/library/annotations/AnnotationAppendHandoff.ts';
import { freezeAnnotationExport, projectCanonicalAnnotations } from '../../../src/features/library/annotations/canonicalAnnotationBrowser.ts';
import { NoteAppendSession } from '../../../src/features/notes/append/NoteAppendSession.ts';
import { DurableEditRepository } from '../../../src/runtime/edits/repository.ts';
import type { LibrarySnapshot } from '../../../src/runtime/edits/contracts.ts';
import { EditMemoryDatabase } from '../../support/editMemoryDatabase.ts';
import type { NoteAppendDraftPort } from '../../../src/features/notes/append/NoteAppendDraftPort.ts';

async function setup() {
  const id = () => crypto.randomUUID(), scope = { accountId: 'handoff', libraryId: id(), epoch: 'one' };
  const repository = new DurableEditRepository(scope, new EditMemoryDatabase());
  const root: LibrarySnapshot = { kind: 'library', id: scope.libraryId, version: id(), items: [], folders: [], links: [], deletions: [] };
  await repository.initialize(root);
  let release!: () => void, active = true, failure = false;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const port = { scope, read: async (target: string) => { await waiting; if (failure) throw new Error('read failed'); return repository.read(target); } };
  let raw: unknown;
  const drafts: NoteAppendDraftPort = { scope, read: () => raw, write: value => { raw = structuredClone(value); }, remove: () => { raw = undefined; } };
  const session = new NoteAppendSession({ repository: port, drafts, getMarkdown: () => { throw new Error('not used'); }, isActive: () => active });
  const revision = id(), result = freezeAnnotationExport(projectCanonicalAnnotations([{ libraryId: scope.libraryId, title: 'source', document: {
    kind: 'document', id: id(), version: id(), deletedPages: [], pages: [{ id: id(), backgroundRevision: revision, annotationVersion: revision,
      lifecycleVersion: revision, widthPt: 600, heightPt: 800, background: { kind: 'paper', spec: { template: 'blank', color: 'white' } },
      annotations: [{ kind: 'sticky', id: id(), text: 'note', anchor: { x: 10, y: 20 }, color: null, metadata: { label: 'tag', createdAt: null } }],
    }],
  } }]));
  return { session, handoff: new AnnotationAppendHandoff(session), result, release, active: (value: boolean) => { active = value; }, fail: () => { failure = true; } };
}

test('explicit same-request cancel settles delayed handoff without leaving retry data', async () => {
  const f = await setup(), work = f.handoff.begin(f.result, () => true);
  assert.ok(f.session.getSnapshot().request); assert.equal(f.handoff.cancel(), true);
  assert.equal(f.session.getSnapshot().request, null);
  f.release(); assert.equal(await work, true);
});

test('actual failed read retains its own request for retry; invalid input is refused', async () => {
  const f = await setup(), work = f.handoff.begin(f.result, () => true);
  f.fail(); f.release(); assert.equal(await work, true); assert.equal(f.session.getSnapshot().phase, 'failed');
  assert.ok(f.session.getSnapshot().request);
  const other = await setup();
  assert.equal(await other.handoff.begin({ ...other.result, rows: [] }, () => true), false);
});

test('unrelated replacement and scope loss cannot acknowledge an old flight', async () => {
  for (const mode of ['replacement', 'scope'] as const) {
    const f = await setup(); let alive = true;
    const work = f.handoff.begin(f.result, () => alive), oldId = f.session.getSnapshot().request!.id;
    assert.equal(f.session.cancel(), true); assert.equal(f.session.dismiss(), true);
    if (mode === 'replacement') {
      void f.session.begin({ kind: 'annotations', result: f.result });
      assert.notEqual(f.session.getSnapshot().request?.id, oldId);
    } else { alive = false; f.active(false); }
    f.release(); assert.equal(await work, false, mode);
  }
});

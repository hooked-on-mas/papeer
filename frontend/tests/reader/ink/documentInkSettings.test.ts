import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DocumentInkSettings } from '../../../src/features/reader/ink/DocumentInkSettings.ts';
import { assertDocumentLibraryBinding } from '../../../src/features/reader/DocumentLibraryBinding.ts';
import { DocumentEditSessions } from '../../../src/features/reader/DocumentEditSessions.ts';
import { DurableEditRepository } from '../../../src/runtime/edits/repository.ts';
import { EditReplication, type EditTransferPort } from '../../../src/runtime/edits/replication.ts';
import { EditMemoryDatabase } from '../../support/editMemoryDatabase.ts';
import type { InkObject } from '../../../src/runtime/edits/contracts.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
const scope = { accountId: 'clipboard-fixture', libraryId: fixture.libraryId, epoch: 'canonical-tools' };

test('the scope clipboard retains canonical attributes independently of its source and tool changes', () => {
  const settings = new DocumentInkSettings(scope);
  const source: InkObject = structuredClone(fixture.batches[0].changes[0].annotation);
  const original = structuredClone(source);
  settings.put([source], 810);
  source.style.opacity = .11; source.transform.scaleX = 3;
  settings.setTool('text'); settings.change({ width: .006, color: '#123456' });
  assert.deepEqual(settings.getSnapshot().clipboard, { annotations: [original], sourceWidthPt: 810 });
});

test('another account, library or epoch cannot supply the document clipboard', () => {
  const repository = new DurableEditRepository(scope, new EditMemoryDatabase());
  const sessions = new DocumentEditSessions(repository);
  const unused = () => { throw new Error('no transport call is authorized by this boundary test'); };
  const transfer: EditTransferPort = { pull: unused, upload: unused, imported: unused, uploadResource: unused, downloadResource: unused };
  const replication = new EditReplication(repository, transfer, 'clipboard-peer');
  const readerState = { scope, read: () => null, write: () => {} };
  const binding = { repository, sessions, replication, documentId: fixture.document.id, inkSettings: new DocumentInkSettings(scope), readerState };
  assert.doesNotThrow(() => assertDocumentLibraryBinding(binding));
  for (const other of [{ ...scope, accountId: 'other' }, { ...scope, libraryId: crypto.randomUUID() }, { ...scope, epoch: 'other' }]) {
    assert.throws(() => assertDocumentLibraryBinding({ ...binding, inkSettings: new DocumentInkSettings(other) }), /document-binding-scope/);
    assert.throws(() => assertDocumentLibraryBinding({ ...binding, readerState: { ...readerState, scope: other } }), /document-binding-scope/);
  }
  const mutable = { ...scope }, settings = new DocumentInkSettings(mutable);
  mutable.accountId = 'changed-after-creation';
  assert.deepEqual(settings.scope, scope);
});

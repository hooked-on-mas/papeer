import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendAllowsFocusChange } from '../../src/features/notes/append/appendAllowsFocusChange.ts';
import type { NoteAppendState } from '../../src/features/notes/append/NoteAppendSession.ts';

test('focus permits settled canceled append but preserves visible or recoverable append actions', () => {
  const base: NoteAppendState = { request: null, candidates: [], destinationId: null, phase: 'idle', busy: false, error: '', creation: null };
  const request = { id: 'request', input: { kind: 'quote', text: 'text', target: { libraryId: 'library', documentId: 'document', pageId: 'page', surface: 'original' } } } as unknown as NonNullable<NoteAppendState['request']>;
  const check = (state: NoteAppendState, canLeave = true) => appendAllowsFocusChange({ getSnapshot: () => state, canLeave: () => canLeave });
  assert.equal(check(base), true);
  assert.equal(check({ ...base, request, phase: 'canceled' }), true);
  assert.equal(check({ ...base, request, phase: 'canceled' }, false), false);
  assert.equal(check({ ...base, request, phase: 'accepted' }), false);
  assert.equal(check({ ...base, request, phase: 'choosing' }), false);
  assert.equal(check({ ...base, error: 'recovery' }), false);
  assert.equal(check({ ...base, request, phase: 'canceled', busy: true }), false);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkspaceSession, workspacePreference, type WorkspacePreference } from '../../src/features/workspace/WorkspaceSession.ts';
import { BrowserWorkspacePreferences } from '../../src/adapters/browser/workspacePreferences.ts';
import { BrowserLibraryQueryPreferences } from '../../src/adapters/browser/libraryQueryPreferences.ts';

const scope = { accountId: 'workspace-test', libraryId: '00000000-0000-4000-8000-000000000001', epoch: 'one' };
const dark: WorkspacePreference = { version: 1, theme: 'dark', uiScale: 1.25, catalogOpen: false, editorWidth: 60, catalogHeight: 55, sidebarWidth: 320 };

test('unreadable display settings remain intact until an explicit preference change', () => {
  const raw = { version: 9, theme: 'future', opaque: 'preserve' };
  const writes: WorkspacePreference[] = [];
  const session = new WorkspaceSession({ scope, read: () => raw, write: value => writes.push(value) }, () => true);
  assert.ok(session.getSnapshot().error);
  assert.deepEqual(writes, []);
  assert.equal(session.getSnapshot().value.catalogOpen, true);
  assert.equal(session.getSnapshot().value.sidebarWidth, 280);
  assert.equal(session.set({ theme: 'dark' }), true);
  assert.deepEqual(raw, { version: 9, theme: 'future', opaque: 'preserve' });
  assert.deepEqual(writes, [{ version: 1, theme: 'dark', uiScale: 1, catalogOpen: true, editorWidth: 40, catalogHeight: 45, sidebarWidth: 280 }]);
  for (const invalid of [{ ...dark, theme: ['dark'] }, { ...dark, uiScale: 10 }, { ...dark, extra: true }, { ...dark, editorWidth: 99 }, { ...dark, catalogHeight: -5 },
    { ...dark, sidebarWidth: 199 }, { ...dark, sidebarWidth: 561 }, { ...dark, sidebarWidth: 280.5 }, { ...dark, sidebarWidth: '280' }])
    assert.throws(() => workspacePreference(invalid), /workspace-preference-invalid/);
  const legacy = { version: 1, theme: 'light', uiScale: 1, catalogOpen: true };
  assert.deepEqual(workspacePreference(legacy), { version: 1, theme: 'light', uiScale: 1, catalogOpen: true, editorWidth: 40, catalogHeight: 45, sidebarWidth: 280 });
  assert.equal(workspacePreference({ ...legacy, sidebarWidth: 345 }).sidebarWidth, 345);
});

test('failed local display preference stays retryable and an inactive or rebound scope cannot write', () => {
  let active = true, failure = true;
  const mutableScope = { ...scope }, writes: WorkspacePreference[] = [];
  const session = new WorkspaceSession({ scope: mutableScope, read: () => dark, write: value => {
    if (failure) throw new Error('storage full'); writes.push(value); value.theme = 'light';
  } }, () => active);
  assert.equal(session.set({ uiScale: 1.5 }), false);
  assert.equal(session.getSnapshot().pending, true);
  active = false; failure = false;
  assert.equal(session.retry(), false); assert.deepEqual(writes, []);
  active = true; mutableScope.epoch = 'other';
  assert.equal(session.retry(), false); assert.deepEqual(writes, []);
  mutableScope.epoch = 'one'; assert.equal(session.retry(), true);
  assert.equal(session.getSnapshot().value.theme, 'dark', 'host cannot mutate the retained preference through a borrowed value');
  assert.equal(session.getSnapshot().value.uiScale, 1.5);
  assert.equal(session.getSnapshot().pending, false);
});

test('browser and desktop display caches separate account, library and epoch keys', () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const a = new BrowserWorkspacePreferences(scope, storage); a.write(dark);
  assert.deepEqual(new BrowserWorkspacePreferences(scope, storage).read(), dark);
  for (const other of [{ ...scope, accountId: 'B' }, { ...scope, libraryId: '00000000-0000-4000-8000-000000000002' }, { ...scope, epoch: 'two' }]) {
    const isolated = new BrowserWorkspacePreferences(other, storage); assert.equal(isolated.read(), null);
    isolated.write({ ...dark, theme: 'light' }); assert.deepEqual(a.read(), dark);
  }
  assert.equal(data.size, 4);
});

test('search conditions use a separate scoped cache and cannot replace appearance preferences', () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const appearance = new BrowserWorkspacePreferences(scope, storage), query = new BrowserLibraryQueryPreferences(scope, storage);
  appearance.write(dark);
  const condition = { text: 'private research', scope: 'content' as const, tag: 'review', read: 'unread' as const, sort: 'title' as const, descending: true };
  query.write(condition);
  assert.deepEqual(appearance.read(), dark); assert.deepEqual(new BrowserLibraryQueryPreferences(scope, storage).read(), condition);
  for (const other of [{ ...scope, accountId: 'other' }, { ...scope, epoch: 'two' }]) assert.equal(new BrowserLibraryQueryPreferences(other, storage).read(), null);
  assert.equal(data.size, 2);
});

test('a persisted JSON null query is corruption, distinct from an absent preference key', () => {
  let raw: string | null = null;
  const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } };
  const query = new BrowserLibraryQueryPreferences(scope, storage);
  assert.equal(query.read(), null);
  raw = 'null';
  assert.throws(() => query.read(), /library-query-preference-invalid/);
  assert.equal(raw, 'null', 'a failed read never rewrites the malformed cache');
});

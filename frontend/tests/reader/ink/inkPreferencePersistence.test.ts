import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DocumentInkSettings } from '../../../src/features/reader/ink/DocumentInkSettings.ts';
import { inkPreferenceKey, validateInkPreferences, type InkPreferenceStorage } from '../../../src/features/reader/ink/inkPreferencePersistence.ts';
const scope = { accountId: 'account', libraryId: 'library', epoch: 'epoch' };
const values = new Map<string, string>();
const storage: InkPreferenceStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };

test('preferences survive new settings owner and are isolated by full scope without serializing editor state', () => {
  values.clear();
  const owner = new DocumentInkSettings(scope, storage);
  owner.setTool('text'); owner.setListOpen(true); owner.setAnnotationMode('sticky-place');
  owner.change({ color: '#123456', width: .006, highColor: '#abcdef', highWidth: .04,
    partial: true, eraserRadius: 20, highlightOnly: true, fingerDraw: true, straight: false, presets: [{ color: '#445566', width: .015 }] });
  const restored = new DocumentInkSettings(scope, storage).getSnapshot();
  for (const key of ['color', 'width', 'highColor', 'highWidth', 'partial', 'eraserRadius', 'highlightOnly', 'fingerDraw', 'straight', 'presets'] as const)
    assert.deepEqual(restored[key], owner.getSnapshot()[key]);
  assert.equal(restored.tool, 'pen'); assert.equal(restored.mode, 'ink'); assert.equal(restored.listOpen, false);
  assert.deepEqual(restored.clipboard.annotations, []);
  const saved = JSON.parse(values.get(inkPreferenceKey(scope))!);
  assert.deepEqual(Object.keys(saved).sort(), ['preferences', 'version']);
  assert.ok(!JSON.stringify(saved).includes('clipboard'));
  for (const other of [{ ...scope, accountId: 'other' }, { ...scope, libraryId: 'other' }, { ...scope, epoch: 'other' }])
    assert.equal(new DocumentInkSettings(other, storage).getSnapshot().color, '#dc2626');
});

test('corrupt and denied preference reads keep defaults and a visible error', () => {
  for (const raw of ['{', '{}', '{"version":2,"preferences":{}}', '{"version":1,"preferences":{"clipboard":[]}}']) {
    const owner = new DocumentInkSettings(scope, { getItem: () => raw, setItem: () => { throw new Error('must not rewrite corrupt original on read'); } });
    assert.equal(owner.getSnapshot().color, '#dc2626'); assert.ok(owner.getSnapshot().persistenceError);
  }
  const denied = new DocumentInkSettings(scope, { getItem: () => { throw new Error('denied'); }, setItem() {} });
  assert.ok(denied.getSnapshot().persistenceError);
});

test('write failure retains changed preferences and retry clears the error only after actual write', () => {
  let fail = true, written = '';
  const owner = new DocumentInkSettings(scope, { getItem: () => null, setItem: (_key, value) => {
    if (fail) throw new Error('quota'); written = value;
  } });
  owner.change({ color: '#123456' });
  assert.equal(owner.getSnapshot().color, '#123456'); assert.ok(owner.getSnapshot().persistenceError); assert.equal(written, '');
  fail = false; owner.retryPersistence();
  assert.equal(owner.getSnapshot().persistenceError, null); assert.equal(JSON.parse(written).preferences.color, '#123456');
});

test('invalid numeric, unbounded and editor-state preferences are rejected', () => {
  const valid = JSON.parse(values.get(inkPreferenceKey(scope))!).preferences;
  for (const invalid of [{ width: NaN }, { highWidth: Infinity }, { color: 'red' }, { width: -1 }, { eraserRadius: 0 },
    { presets: [{ color: '#123456', width: 0 }] }, { fingerDraw: null }, { clipboard: [] }]) assert.equal(validateInkPreferences({ ...valid, ...invalid }), null);
});

test('earlier preference v1 records restore with finger drawing disabled and remain unchanged on read', () => {
  const previous = JSON.parse(values.get(inkPreferenceKey(scope))!);
  delete previous.preferences.fingerDraw;
  const raw = JSON.stringify(previous);
  const owner = new DocumentInkSettings(scope, { getItem: () => raw, setItem: () => { throw new Error('read must not rewrite'); } });
  assert.equal(owner.getSnapshot().fingerDraw, false);
  assert.equal(owner.getSnapshot().color, previous.preferences.color);
  assert.equal(owner.getSnapshot().persistenceError, null);
});

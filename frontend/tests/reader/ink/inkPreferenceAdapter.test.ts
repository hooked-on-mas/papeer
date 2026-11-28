import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBrowserInkPreferences } from '../../../src/adapters/browser/inkPreferences.ts';
import { inkPreferenceKey } from '../../../src/features/reader/ink/inkPreferencePersistence.ts';
import { DocumentInkSettings } from '../../../src/features/reader/ink/DocumentInkSettings.ts';
const scope = { accountId: 'account', libraryId: 'library', epoch: 'epoch' };

test('browser preference adapter admits only its fixed full namespace and retains storage read/write failures', () => {
  const values = new Map<string, string>();
  const mutable = { ...scope };
  const port = createBrowserInkPreferences(mutable, { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } });
  mutable.accountId = 'changed';
  const settings = new DocumentInkSettings(scope, port); settings.change({ color: '#123456' });
  assert.equal(new DocumentInkSettings(scope, port).getSnapshot().color, '#123456');
  assert.throws(() => port.getItem(inkPreferenceKey(mutable)), /ink-preference-scope/);
  assert.throws(() => port.setItem(inkPreferenceKey(mutable), '{}'), /ink-preference-scope/);
  const denied = createBrowserInkPreferences(scope, { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } });
  const failed = new DocumentInkSettings(scope, denied); assert.ok(failed.getSnapshot().persistenceError);
  failed.change({ width: .006 }); assert.equal(failed.getSnapshot().width, .006); assert.ok(failed.getSnapshot().persistenceError);
});

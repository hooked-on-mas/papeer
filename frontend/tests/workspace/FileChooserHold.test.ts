import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FileChooserHold } from '../../src/features/workspace/FileChooserHold.ts';

test('chooser flight remains held until the matching completion and ignores stale completion', () => {
  const hold = new FileChooserHold(), first = hold.begin(); assert.ok(first);
  assert.equal(hold.begin(), null); assert.equal(hold.current(), first);
  hold.end(first); const second = hold.begin(); assert.ok(second);
  hold.end(first); assert.equal(hold.current(), second);
  hold.end(second); assert.equal(hold.current(), null);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { editContentBytes, editContentHash } from '../src/runtime/edits/editContentHash.ts';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/shared-edits.json', import.meta.url), 'utf8'));
test('Python/TypeScript content digests agree for binary64 boundaries, Unicode keys and scalar/type boundaries', async () => {
  for (const { value, sha256 } of fixture.contentHashes) assert.equal(await editContentHash(value), sha256);
  assert.equal(await editContentHash({ '😀': 1.0, '\ue000': 2, a: -0 }), await editContentHash({ a: 0.0, '\ue000': 2.0, '😀': 1 }));
  const values = [null, false, true, 0, 1, '', '0', '1', [], {}, ['a', 'bc'], ['ab', 'c'], { x: [] }, { x: {} }];
  const hashes = await Promise.all(values.map(editContentHash));
  assert.equal(new Set(hashes).size, values.length);
  assert.equal(new DataView(editContentBytes(1).buffer).getFloat64(24), 1, '23-byte version prefix, number tag, then big endian binary64');
});
test('content hashing rejects non-JSON values rather than hashing lossy JSON coercions', () => {
  const cycle: unknown[] = []; cycle.push(cycle);
  for (const value of [NaN, Infinity, undefined, 1n, new Date(), () => 1, { key: undefined }, '\ud800', { '\udfff': 'bad' }, cycle, Array(2)]) {
    assert.throws(() => editContentBytes(value), /non-json-content/);
  }
});

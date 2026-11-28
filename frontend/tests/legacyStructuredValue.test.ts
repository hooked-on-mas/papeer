import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeLegacyValue, decodeLegacyValue } from '../src/adapters/browser/legacyStructuredValue.ts';

test('raw structured values retain cycles, sparse arrays, UTF-16, numeric edge cases and dangerous property names', async () => {
  const array = new Array(4); array[2] = undefined;
  const object = Object.create(null); Object.defineProperty(object, '__proto__', { value: { draft: '\ud800' }, enumerable: true });
  const input = { object, array, alias: array, numbers: [-0, NaN, Infinity, -Infinity, 0, 1e-300], bigint: 2n ** 100n,
    date: new Date(NaN), validDate: new Date('2026-10-25T00:00:00Z'), pattern: /\p{Letter}+/giu, cycle: null as unknown };
  input.cycle = input;
  const encoded = await encodeLegacyValue(input), value = await decodeLegacyValue(encoded.bytes, async hash => encoded.objects.get(hash)!) as typeof input;
  assert.deepEqual(value, input); assert.equal(value.cycle, value); assert.equal(value.array, value.alias);
  assert.equal(0 in value.array, false); assert.equal(2 in value.array, true); assert.equal(Object.getPrototypeOf(value.object), null);
  assert.equal(({} as { draft?: string }).draft, undefined); assert.equal(Object.is(value.numbers[0], -0), true);
});

test('raw structured values retain aliased buffers/views, map/set identities and exact Blob/File bodies', async () => {
  const buffer = Uint8Array.from([0, 255, 128, 1, 2, 3, 4, 5]).buffer;
  const map = new Map<unknown, unknown>(), set = new Set<unknown>(); map.set(map, set); set.add(map);
  const input = { buffer, view: new Uint16Array(buffer, 2, 2), data: new DataView(buffer, 1, 3), map, set,
    blob: new Blob([buffer], { type: 'application/pdf' }), file: new File(['未送信\n'], 'note😀.json', { type: 'application/json', lastModified: 42 }) };
  const encoded = await encodeLegacyValue(input), value = await decodeLegacyValue(encoded.bytes, async hash => encoded.objects.get(hash)!) as typeof input;
  assert.equal(encoded.objects.size, 2); assert.equal(value.view.buffer, value.buffer); assert.equal(value.data.buffer, value.buffer);
  assert.equal(value.view.byteOffset, 2); assert.equal(value.data.byteLength, 3); assert.equal(value.map.get(value.map), value.set); assert.equal(value.set.has(value.map), true);
  assert.deepEqual(new Uint8Array(await value.blob.arrayBuffer()), new Uint8Array(buffer));
  assert.equal(value.blob.type, input.blob.type); assert.equal(value.file.name, input.file.name); assert.equal(value.file.lastModified, 42);
  assert.equal(await value.file.text(), await input.file.text());
});

test('raw structured-value reader rejects corrupt bodies, dangling/extra graph nodes and prototype constructor injection', async () => {
  const input = await encodeLegacyValue(new Uint8Array([1, 2, 3]));
  await assert.rejects(decodeLegacyValue(input.bytes, async () => new Uint8Array([3, 2, 1])), /backup-object-hash/);
  const graph = JSON.parse(new TextDecoder().decode(input.bytes));
  for (const mode of ['reference', 'extra', 'constructor', 'field']) {
    const bad = structuredClone(graph);
    if (mode === 'reference') bad.root = ['ref', 99];
    if (mode === 'extra') bad.nodes.push({ kind: 'date', time: ['number', 0] });
    if (mode === 'constructor') bad.nodes[0].name = '__proto__';
    if (mode === 'field') bad.nodes[0].unexpected = true;
    await assert.rejects(decodeLegacyValue(new TextEncoder().encode(JSON.stringify(bad)), async hash => input.objects.get(hash)!), /backup-value-/);
  }
  class Unknown { draft = 'must not disappear'; }
  await assert.rejects(encodeLegacyValue({ unknown: new Unknown() }), /backup-value-unsupported/);
  await assert.rejects(encodeLegacyValue(Symbol('input')), /backup-value-unsupported/);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readProviderDescriptorBytes } from '../../../src/runtime/edits/provider/providerDescriptorBytes.ts';

const vectors = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/provider-descriptor-bytes.json', import.meta.url), 'utf8')) as {
  valid: unknown; cases: { name: string; bytesHex: string; expectedSha256: string; scope: { accountId: string; libraryId: string; epoch: string }; ok: boolean; expectedDescriptor?: unknown }[]
};
for (const vector of vectors.cases) test(`provider descriptor bytes: ${vector.name}`, async () => {
  const bytes = Uint8Array.from(Buffer.from(vector.bytesHex, 'hex'));
  if (vector.ok) {
    const actual = await readProviderDescriptorBytes(bytes, vector.expectedSha256, vector.scope);
    assert.deepEqual(actual.descriptor, vector.expectedDescriptor ?? vectors.valid); assert.equal(actual.sha256, vector.expectedSha256);
  } else await assert.rejects(readProviderDescriptorBytes(bytes, vector.expectedSha256, vector.scope));
});

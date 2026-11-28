import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateResourceMetadata, type ResourceMetadata } from '../../src/runtime/edits/contracts.ts';

export type PhysicalCompositionResource = { envelopeId: string; envelope: unknown; bytes: Uint8Array | undefined };
export type FixtureResourceFile = { id: string; body: string; bytes: Uint8Array; properties?: Record<string, string>; parents?: string[]; mimeType?: string; size?: string };

/** Binary attachments may contain resource-shaped JSON. Only the canonical wire marker is an envelope. */
export function collectCompositionResources(files: ReadonlyMap<string, FixtureResourceFile>, namespace: string, parentId: string): PhysicalCompositionResource[] {
  const physical: PhysicalCompositionResource[] = [];
  for (const file of files.values()) {
    if (file.properties?.papeer !== 'edits-v1') continue;
    assert.equal(file.properties.scope, namespace, 'actual canonical resource scope');
    assert.deepEqual(file.parents, [parentId], 'actual canonical resource parent');
    const value = JSON.parse(file.body) as { kind?: unknown; blobId?: unknown; metadata?: unknown } | null;
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'canonical envelope object required');
    if (file.properties.editKind !== 'resource') {
      assert.notEqual(value?.kind, 'resource', 'resource envelope marker required');
      continue;
    }
    assert.equal(value?.kind, 'resource', 'marked resource envelope body required');
    validateResourceMetadata(value.metadata);
    assert.ok(typeof value.blobId === 'string' && value.blobId, 'physical resource blob ID required');
    const blob = files.get(value.blobId); assert.ok(blob, 'physical resource blob missing');
    assert.equal(blob.properties?.papeer, 'edits-resource-v1', 'physical resource blob marker');
    assert.equal(blob.properties?.scope, namespace, 'physical resource blob scope');
    assert.equal(blob.properties?.sha256, value.metadata.sha256, 'physical resource blob declared SHA256');
    assert.deepEqual(blob.parents, [parentId], 'physical resource blob parent');
    assert.equal(blob.mimeType, 'application/octet-stream', 'physical resource blob media type');
    assert.equal(blob.size, String(value.metadata.byteLength), 'physical resource blob declared length');
    physical.push({ envelopeId: file.id, envelope: value, bytes: blob.bytes });
  }
  return physical;
}

type StoredResource = { metadata: ResourceMetadata; bytes: Uint8Array };
type ResourceObservation = { envelope: string; blob: string | null; logicalId: string | null; byteLength: number | null; sha256: string | null };

/** Fixture assertion only: every physical representation is verified before logical collapse. */
export async function verifyCompositionResourceClosure(physical: PhysicalCompositionResource[], expectedIds: string[],
  readResource: (id: string) => Promise<StoredResource | undefined>,
  observe: (evidence: { physical: number; checked: number; dropped: number; entries: ResourceObservation[] }) => void): Promise<ResourceMetadata[]> {
  const logical = new Map<string, StoredResource>(), envelopes = new Set<string>(), blobs = new Map<string, string>();
  const entries: ResourceObservation[] = []; let checked = 0, dropped = 0;
  try {
    for (const resource of physical) {
      const raw = resource.envelope as { kind?: unknown; metadata?: unknown; blobId?: unknown } | null;
      const metadata = raw?.metadata as Partial<ResourceMetadata> | undefined;
      const bytes = resource.bytes;
      const blobId = typeof raw?.blobId === 'string' && raw.blobId ? raw.blobId : null;
      if (blobId && !blobs.has(blobId)) blobs.set(blobId, 'b' + (blobs.size + 1));
      const digest = bytes instanceof Uint8Array ? createHash('sha256').update(bytes).digest('hex') : null;
      const observation = { envelope: 'r' + (envelopes.size + 1), blob: blobId ? blobs.get(blobId)! : null,
        logicalId: typeof metadata?.id === 'string' ? metadata.id : null,
        byteLength: bytes instanceof Uint8Array ? bytes.byteLength : null, sha256: digest };
      if (entries.length < 128) entries.push(observation); else dropped++;
      assert.ok(resource.envelopeId && !envelopes.has(resource.envelopeId), 'unique physical resource envelope required');
      envelopes.add(resource.envelopeId);
      assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw));
      assert.deepEqual(Object.keys(raw).sort(), ['blobId', 'kind', 'metadata']);
      assert.equal(raw.kind, 'resource'); assert.ok(blobId, 'physical resource blob ID required');
      validateResourceMetadata(metadata);
      assert.ok(bytes instanceof Uint8Array, 'physical resource blob missing');
      assert.equal(bytes.byteLength, metadata.byteLength, 'physical resource byte length');
      assert.equal(digest, metadata.sha256, 'physical resource SHA256');
      let actual = logical.get(metadata.id);
      if (!actual) {
        actual = await readResource(metadata.id);
        assert.ok(actual, 'actual admitted resource required');
        validateResourceMetadata(actual.metadata);
        assert.ok(actual.bytes instanceof Uint8Array);
        assert.equal(actual.bytes.byteLength, actual.metadata.byteLength);
        assert.equal(createHash('sha256').update(actual.bytes).digest('hex'), actual.metadata.sha256);
        logical.set(metadata.id, actual);
      }
      assert.deepEqual(actual.metadata, metadata, 'physical metadata equals actual admitted metadata');
      assert.deepEqual(Array.from(actual.bytes), Array.from(bytes), 'physical bytes equal actual admitted bytes');
      checked++;
    }
    assert.deepEqual([...logical.keys()].sort(), [...new Set(expectedIds)].sort(), 'exact logical resource closure');
    return [...logical.values()].map(value => value.metadata);
  } finally {
    observe({ physical: physical.length, checked, dropped, entries });
  }
}

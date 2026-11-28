import { EDIT_LIMITS, validateCanonicalProviderDescriptor, type CanonicalProviderDescriptor } from '../contracts.ts';
import { canonicalJson, EditRejected } from '../editModel.ts';
import { resourceHash } from '../contentPublication.ts';
import type { EditScope } from '../ports.ts';

/** Validated bytes are data, never an owner or provider capability. */
export async function readProviderDescriptorBytes(bytes: Uint8Array, expectedSha256: string, expectedScope: EditScope): Promise<{ descriptor: CanonicalProviderDescriptor; sha256: string }> {
  if (!bytes.length || bytes.length > EDIT_LIMITS.providerDescriptorBytes || !/^[0-9a-f]{64}$/.test(expectedSha256)) throw new EditRejected('provider-descriptor-size-or-hash');
  bytes = Uint8Array.from(bytes);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new EditRejected('provider-descriptor-bom');
  let text: string, value: unknown;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); value = JSON.parse(text); }
  catch { throw new EditRejected('provider-descriptor-json'); }
  validateCanonicalProviderDescriptor(value);
  // Duplicate members and alternate encodings are rejected because parsing then serializing changes the bytes.
  if (canonicalJson(value) !== text) throw new EditRejected('provider-descriptor-noncanonical');
  if (canonicalJson(value.scope) !== canonicalJson(expectedScope)) throw new EditRejected('provider-descriptor-scope');
  const sha256 = await resourceHash(bytes);
  if (sha256 !== expectedSha256) throw new EditRejected('provider-descriptor-hash');
  return { descriptor: value, sha256 };
}

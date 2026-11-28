import { canonicalJson } from '../../../../runtime/edits/editModel.ts';
import { resourceHash } from '../../../../runtime/edits/contentPublication.ts';

/** Preserve IDB value types: a byte array is never the same as a numeric-key object. */
function tagged(value: unknown): unknown {
  if (value instanceof Uint8Array) return ['bytes', [...value]];
  if (Array.isArray(value)) return ['array', value.map(tagged)];
  if (value !== null && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('offline-activation-unsupported');
    return ['object', Object.keys(value).sort().map(name => [name, tagged((value as Record<string, unknown>)[name])])];
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return ['scalar', value];
  if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER && !Object.is(value, -0)) return ['number', value];
  throw new Error('offline-activation-unsupported');
}
export const offlineActivationDigest = (value: unknown): Promise<string> => resourceHash(new TextEncoder().encode(canonicalJson(tagged(value))));

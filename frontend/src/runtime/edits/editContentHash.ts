import { EditRejected } from './editModel.ts';
import { resourceHash } from './contentPublication.ts';

/** Versioned JSON-value encoding for cross-runtime content identity. Numeric values are
 * binary64 (big endian, signed zero normalized), strings are scalar UTF-8, and object
 * keys sort by UTF-8 bytes. Tags and uint64 lengths keep all value boundaries distinct.
 * Display/storage JSON serializers are deliberately not used as hash input.
 */
export function editContentBytes(value: unknown): Uint8Array {
  let bytes = new Uint8Array(4096), size = 0, view = new DataView(bytes.buffer);
  const reserve = (count: number) => {
    if (size + count <= bytes.length) return;
    const next = new Uint8Array(Math.max(bytes.length * 2, size + count)); next.set(bytes); bytes = next; view = new DataView(bytes.buffer);
  };
  const append = (value: Uint8Array) => { reserve(value.length); bytes.set(value, size); size += value.length; };
  const tag = (value: number) => { reserve(1); bytes[size++] = value; };
  const length = (value: number) => { reserve(8); view.setBigUint64(size, BigInt(value)); size += 8; };
  const encoder = new TextEncoder(), active = new WeakSet<object>();
  const text = (value: string) => {
    for (const char of value) { const cp = char.codePointAt(0)!; if (cp >= 0xd800 && cp <= 0xdfff) throw new EditRejected('non-json-content'); }
    return encoder.encode(value);
  };
  const string = (encoded: Uint8Array) => { tag(4); length(encoded.length); append(encoded); };
  const visit = (value: unknown): void => {
    if (value === null) { tag(0); return; }
    if (typeof value === 'boolean') { tag(value ? 2 : 1); return; }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new EditRejected('non-json-content');
      tag(3); reserve(8); view.setFloat64(size, value === 0 ? 0 : value); size += 8; return;
    }
    if (typeof value === 'string') { string(text(value)); return; }
    if (!value || typeof value !== 'object' || active.has(value)) throw new EditRejected('non-json-content');
    active.add(value);
    if (Array.isArray(value)) { tag(5); length(value.length); for (const item of value) visit(item); }
    else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new EditRejected('non-json-content');
      const entries = Object.keys(value).map(key => ({ key, bytes: text(key) })).sort((a, b) => {
        for (let i = 0; i < Math.min(a.bytes.length, b.bytes.length); i++) if (a.bytes[i] !== b.bytes[i]) return a.bytes[i] - b.bytes[i];
        return a.bytes.length - b.bytes.length;
      });
      tag(6); length(entries.length);
      for (const entry of entries) { string(entry.bytes); visit((value as Record<string, unknown>)[entry.key]); }
    }
    active.delete(value);
  };
  append(encoder.encode('papeer-edit-content-v1\0')); visit(value); return bytes.slice(0, size);
}
export const editContentHash = (value: unknown) => resourceHash(editContentBytes(value));

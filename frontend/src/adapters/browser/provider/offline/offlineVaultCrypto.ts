/** Host-private cryptography. This module never issues a scope or admission. */
import { canonicalJson } from '../../../../runtime/edits/editModel.ts';

export type OfflineVaultHeader = { version: 1; context: string; iterations: 600000; salt: number[]; iv: number[]; prefix: number[]; wrapped: number[] };
export type OfflineVaultGrant = { version: 1; context: string; id: string; counter: string; ciphertext: number[] };
export type OfflineVaultKeys = { encryption: CryptoKey; counterMac: CryptoKey };
export type OfflineVaultCounter = { version: 1; context: string; next: string; mac: number[] };
const iterations = 600000 as const, enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: true });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bytes = (value: unknown, length: number): value is number[] => Array.isArray(value) && value.length === length
  && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255);
const fields = (value: object, names: string[]) => Object.keys(value).sort().join('|') === [...names].sort().join('|');
const random = (size: number) => crypto.getRandomValues(new Uint8Array(size));
const contextData = (header: Pick<OfflineVaultHeader, 'version' | 'context' | 'iterations' | 'salt' | 'iv' | 'prefix'>) => enc.encode(canonicalJson(header));
const fail = (): never => { throw new Error('offline-unlock-failed'); };

function password(secret: string): Uint8Array<ArrayBuffer> {
  if (typeof secret !== 'string') return fail();
  let count = 0;
  for (const char of secret) {
    const code = char.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) return fail();
    count++;
  }
  const encoded = enc.encode(secret);
  if (count < 12 || count > 1024 || encoded.length > 4096) return fail();
  return encoded;
}
async function wrapping(secret: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const raw = password(secret);
  try {
    const base = await crypto.subtle.importKey('raw', raw, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } finally { raw.fill(0); }
}
function validHeader(value: unknown, context: string): value is OfflineVaultHeader {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const h = value as OfflineVaultHeader;
  return fields(h, ['version', 'context', 'iterations', 'salt', 'iv', 'prefix', 'wrapped'])
    && h.version === 1 && h.context === context && uuid.test(context) && h.iterations === iterations
    && bytes(h.salt, 32) && bytes(h.iv, 12) && bytes(h.prefix, 4) && bytes(h.wrapped, 48);
}
async function masterKeys(raw: Uint8Array<ArrayBuffer>): Promise<OfflineVaultKeys> {
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  const salt = enc.encode('papeer-offline-vault-v1');
  const encryption = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('grant-encryption') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const counterMac = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('counter-authentication') },
    base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
  return { encryption, counterMac };
}
export async function createVaultHeader(context: string, secret: string): Promise<{ header: OfflineVaultHeader; master: OfflineVaultKeys }> {
  if (!uuid.test(context)) return fail();
  const parameters = { version: 1 as const, context, iterations, salt: [...random(32)], iv: [...random(12)], prefix: [...random(4)] };
  const wrappingKey = await wrapping(secret, Uint8Array.from(parameters.salt)), raw = random(32);
  try {
    const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: Uint8Array.from(parameters.iv),
      additionalData: contextData(parameters), tagLength: 128 }, wrappingKey, raw);
    const master = await masterKeys(raw);
    return { header: { ...parameters, wrapped: [...new Uint8Array(wrapped)] }, master };
  } finally { raw.fill(0); }
}
export async function unlockVaultHeader(value: unknown, context: string, secret: string): Promise<{ header: OfflineVaultHeader; master: OfflineVaultKeys }> {
  try {
    if (!validHeader(value, context)) return fail();
    const { wrapped, ...parameters } = value, wrappingKey = await wrapping(secret, Uint8Array.from(parameters.salt));
    const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.from(parameters.iv),
      additionalData: contextData(parameters), tagLength: 128 }, wrappingKey, Uint8Array.from(wrapped)));
    try { if (raw.length !== 32) return fail(); return { header: structuredClone(value),
      master: await masterKeys(raw) }; }
    finally { raw.fill(0); }
  } catch { return fail(); }
}
function nonce(header: OfflineVaultHeader, counter: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:0|[1-9][0-9]{0,19})$/.test(counter)) return fail();
  const value = BigInt(counter); if (value < 1n || value > 0xffffffffffffffffn) return fail();
  const result = new Uint8Array(12); result.set(header.prefix);
  new DataView(result.buffer).setBigUint64(4, value); return result;
}
const grantData = (context: string, id: string, counter: string) => enc.encode(canonicalJson({ version: 1, context, id, counter }));
/** Counter must be uniquely reserved and durably committed before this call. */
export async function sealVaultGrant(header: OfflineVaultHeader, master: OfflineVaultKeys, id: string, counter: string, value: unknown): Promise<OfflineVaultGrant> {
  if (!validHeader(header, header.context) || !uuid.test(id)) return fail();
  const plain = enc.encode(canonicalJson(value)); if (plain.length > 65536) return fail();
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce(header, counter),
    additionalData: grantData(header.context, id, counter), tagLength: 128 }, master.encryption, plain);
  return { version: 1, context: header.context, id, counter, ciphertext: [...new Uint8Array(ciphertext)] };
}
export async function openVaultGrant(header: OfflineVaultHeader, master: OfflineVaultKeys, value: unknown): Promise<unknown> {
  try {
    if (!validHeader(header, header.context) || !value || typeof value !== 'object' || Array.isArray(value)) return fail();
    const grant = value as OfflineVaultGrant;
    if (!fields(grant, ['version', 'context', 'id', 'counter', 'ciphertext']) || grant.version !== 1
      || grant.context !== header.context || !uuid.test(grant.id) || !Array.isArray(grant.ciphertext)
      || grant.ciphertext.length < 16 || grant.ciphertext.length > 65552 || !bytes(grant.ciphertext, grant.ciphertext.length)) return fail();
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce(header, grant.counter),
      additionalData: grantData(grant.context, grant.id, grant.counter), tagLength: 128 }, master.encryption, Uint8Array.from(grant.ciphertext));
    return JSON.parse(dec.decode(plain));
  } catch { return fail(); }
}
function counterData(header: OfflineVaultHeader, next: string): Uint8Array<ArrayBuffer> {
  return enc.encode(canonicalJson({ purpose: 'offline-counter-v1', header, next }));
}
export async function signVaultCounter(header: OfflineVaultHeader, master: OfflineVaultKeys, next: string): Promise<OfflineVaultCounter> {
  if (!validHeader(header, header.context)) return fail();
  nonce(header, next);
  const mac = await crypto.subtle.sign('HMAC', master.counterMac, counterData(header, next));
  return { version: 1, context: header.context, next, mac: [...new Uint8Array(mac)] };
}
export async function verifyVaultCounter(header: OfflineVaultHeader, master: OfflineVaultKeys, value: unknown): Promise<bigint> {
  try {
    if (!validHeader(header, header.context) || !value || typeof value !== 'object' || Array.isArray(value)) return fail();
    const counter = value as OfflineVaultCounter;
    if (!fields(counter, ['version', 'context', 'next', 'mac']) || counter.version !== 1 || counter.context !== header.context
      || typeof counter.next !== 'string' || !bytes(counter.mac, 32)) return fail();
    nonce(header, counter.next);
    if (!await crypto.subtle.verify('HMAC', master.counterMac, Uint8Array.from(counter.mac), counterData(header, counter.next))) return fail();
    return BigInt(counter.next);
  } catch { return fail(); }
}

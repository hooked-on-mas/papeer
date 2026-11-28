/** Host-local durable evidence; this record is not an authenticated principal. */
export type CanonicalLocalOwnerGrant = { version: 1; kind: 'local-created'; contextId: string; namespaceId: string; revision: string };
const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function assertLocalOwnerGrant(value: unknown): asserts value is CanonicalLocalOwnerGrant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('recovery-required');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(',') !== 'contextId,kind,namespaceId,revision,version' || v.version !== 1 || v.kind !== 'local-created' ||
      ![v.contextId, v.namespaceId, v.revision].every(x => typeof x === 'string' && x.length === 36 && id.test(x))) throw new Error('recovery-required');
}
export function makeLocalOwnerGrant(makeId: () => string): CanonicalLocalOwnerGrant {
  const grant: CanonicalLocalOwnerGrant = { version: 1, kind: 'local-created', contextId: makeId(), namespaceId: makeId(), revision: makeId() };
  assertLocalOwnerGrant(grant); return grant;
}

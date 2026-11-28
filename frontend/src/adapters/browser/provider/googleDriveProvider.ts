import { DriveSession, DriveHttpError, type ProviderDriveTransport } from '../../../web/drive.ts';
import { loadGoogleSdk } from '../../../web/googleSdk.ts';
import type { ProviderVerifier } from '../ownership/providerGrantIssuer.ts';
import type { DriveEditStorage } from '../../drive/editTransfer.ts';
import { googleDrivePrincipalDigest } from '../../../runtime/edits/provider/providerPrincipal.ts';
import { canonicalJson } from '../../../runtime/edits/editModel.ts';
import { resourceHash } from '../../../runtime/edits/contentPublication.ts';
import { readProviderDescriptorBytes } from '../../../runtime/edits/provider/providerDescriptorBytes.ts';
import { EDIT_LIMITS, validateCanonicalProviderDescriptor } from '../../../runtime/edits/contracts.ts';
import { pyStrip } from '../../../lib/pyWhitespace.ts';

type Principal = Awaited<ReturnType<ProviderVerifier['current']>>;
type Metadata = { id: string; name?: string; mimeType: string; version: string; size?: string; sha256Checksum?: string;
 ownedByMe: boolean; trashed: boolean; capabilities: { canEdit?: boolean; canDownload?: boolean }; properties?: Record<string, string>; parents?: string[]; driveId?: string };
type Descriptor = Awaited<ReturnType<ProviderVerifier['descriptor']>> & { folderId: string; title: string };
type ReadDescriptor = { metadata: Metadata; descriptor: Descriptor; bytes: Uint8Array };
const fields = 'id,name,mimeType,version,size,sha256Checksum,ownedByMe,trashed,capabilities(canEdit,canDownload),properties,parents,driveId';
const id = (value: string) => { if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new Error('invalid-drive-id');return value; };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
let configuredSession: DriveSession | undefined;

export interface GoogleDriveProviderHost {
 preload(): Promise<void>;
 connect(options: { selectAccount?: boolean }, signal: AbortSignal): Promise<Principal>;
 readonly verifier: ProviderVerifier;
 list(signal: AbortSignal): Promise<readonly { id: string; title: string }[]>;
 boundStorage(groupSignal?: () => AbortSignal): DriveEditStorage;
 disconnectAndWait(): Promise<void>;
 allocateFileIds(count: number, signal: AbortSignal): Promise<string[]>;
 createFolder(providerFileId: string, logicalId: string, title: string, parentId: string | undefined, signal: AbortSignal): Promise<{ id: string; version: string }>;
 writeImmutableJson(providerFileId: string, namespace: string, folderId: string, logicalId: string, kind: 'dataset-manifest' | 'repository-checkpoint', value: unknown, signal: AbortSignal): Promise<{ id: string; version: string; sha256: string }>;
 writeDescriptor(providerFileId: string, logicalId: string, folderId: string, title: string, bytes: Uint8Array, namespace: string, signal: AbortSignal): Promise<{ id: string; version: string; sha256: string }>;
}

/** Fixed configured Google adapter. No session, token, HTTP client, verifier or permission callback can be supplied by a renderer. */
export function createGoogleDriveProviderHost(): GoogleDriveProviderHost {
 const session = configuredSession ??= new DriveSession();
 let transport: ProviderDriveTransport | undefined, principal: Principal | undefined, connecting = false;
 const selected = new Map<string, ReadDescriptor>();
 const lock = () => { selected.clear();transport = undefined;principal = undefined;session.signOut(); };
 const receiver = () => { if (!transport || !principal) throw new Error('drive-provider-not-connected');transport.assertCurrent();return transport; };
 const assert = (expected: Principal) => {
  const current = receiver();if (expected.digest !== principal!.digest || expected.generation !== principal!.generation || current.generation !== expected.generation) throw new Error('drive-provider-auth-changed');
 };
 const call = async <T>(action: (current: ProviderDriveTransport) => Promise<T>, expected: Principal = principal!, authentication = false): Promise<T> => {
  assert(expected);const current = receiver();
  try { const value = await action(current);assert(expected);return value; }
  catch (error) { if (error instanceof DriveHttpError && (error.status === 401 || (authentication && error.status === 403))) lock();throw error; }
 };
 const currentPrincipal = async (signal: AbortSignal, expected: Principal = principal!): Promise<Principal> => {
  assert(expected);
  const value = await call(current => current.about(signal), expected, true) as { user?: { permissionId?: unknown } };
  if (typeof value?.user?.permissionId !== 'string') { lock();throw new Error('drive-principal-missing'); }
  let digest: string;try { digest = await googleDrivePrincipalDigest(value.user.permissionId); } catch (error) { lock();throw error; }
  signal.throwIfAborted();assert(expected);
  if (digest !== expected.digest) { lock();throw new Error('drive-principal-changed'); }return { ...expected };
 };
 const metadata = async (fileId: string, signal: AbortSignal, downloadable = true, expected: Principal = principal!): Promise<Metadata> => {
  const value = await call(current => current.metadata(id(fileId), fields, signal), expected) as Metadata;
  if (!value || value.id !== fileId || typeof value.version !== 'string' || !/^[1-9][0-9]{0,39}$/.test(value.version)
   || value.trashed !== false || value.ownedByMe !== true || value.driveId !== undefined || value.capabilities?.canEdit !== true
   || (downloadable && value.capabilities?.canDownload !== true)) { throw new Error('drive-owner-write-required'); }
  return structuredClone(value);
 };
 const readDescriptor = async (fileId: string, signal: AbortSignal, expected: Principal = principal!): Promise<ReadDescriptor> => {
  assert(expected);await currentPrincipal(signal, expected);const before = await metadata(fileId, signal, true, expected);
  if (before.mimeType !== 'application/json' || before.properties?.papeer !== 'canonical-provider-v1' || before.properties?.providerKind !== 'descriptor'
   || typeof before.name !== 'string' || !pyStrip(before.name) || before.name !== pyStrip(before.name) || Array.from(before.name).length > EDIT_LIMITS.title
   || typeof before.size !== 'string' || !/^[0-9]+$/.test(before.size) || Number(before.size) < 1 || Number(before.size) > EDIT_LIMITS.providerDescriptorBytes) throw new Error('drive-descriptor-metadata');
  if (!Array.isArray(before.parents) || before.parents.length !== 1) throw new Error('drive-descriptor-folder');
  const folderId = id(before.parents[0]), folder = await metadata(folderId, signal, false, expected);
  if (folder.mimeType !== 'application/vnd.google-apps.folder') throw new Error('drive-descriptor-folder');
  const bytes = await call(current => current.bytes(fileId, EDIT_LIMITS.providerDescriptorBytes, signal), expected);
  const [after, folderAfter] = await Promise.all([metadata(fileId, signal, true, expected), metadata(folderId, signal, false, expected)]);
  if (!same(before, after) || !same(folder, folderAfter) || bytes.length !== Number(before.size)) throw new Error('drive-descriptor-version-changed');
  const digest = await resourceHash(bytes);if (before.sha256Checksum !== undefined && before.sha256Checksum !== digest) throw new Error('drive-descriptor-checksum');
  let raw: unknown;try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Error('drive-descriptor-json'); }
  validateCanonicalProviderDescriptor(raw);const validated = await readProviderDescriptorBytes(bytes, digest, raw.scope);
  signal.throwIfAborted();assert(expected);
  return { metadata: before, bytes: Uint8Array.from(bytes), descriptor: { id: fileId, version: before.version, sha256: validated.sha256,
   scope: { ...validated.descriptor.scope }, owner: true, writable: true, folderId, title: before.name } };
 };
 const verifier: ProviderVerifier = Object.freeze({
  current: currentPrincipal, assertCurrent: assert, subscribeInvalidation: (listener: () => void) => session.subscribeInvalidation(listener),
  descriptor: async (_expected: Principal, selection: string, signal: AbortSignal) => { assert(_expected);const value = await readDescriptor(id(selection), signal, _expected);assert(_expected);selected.set(selection, value);return structuredClone(value.descriptor); },
  descriptorBytes: async (_expected: Principal, fileId: string, signal: AbortSignal) => {
   assert(_expected);const previous = selected.get(fileId);if (!previous) throw new Error('drive-descriptor-not-selected');
   const fresh = await readDescriptor(fileId, signal, _expected);if (!same(previous.descriptor, fresh.descriptor)) throw new Error('drive-descriptor-version-changed');assert(_expected);return Uint8Array.from(fresh.bytes);
  },
  captureDescriptor: async (_expected: Principal, selection: string, signal: AbortSignal) => {
   assert(_expected);const value = await readDescriptor(id(selection), signal, _expected);assert(_expected);selected.set(selection, value);
   return { descriptor: structuredClone(value.descriptor), bytes: Uint8Array.from(value.bytes) };
  },
 });
 const checkFolder = async (folderId: string, signal: AbortSignal, expected: Principal) => { const folder = await metadata(id(folderId), signal, false, expected);if (folder.mimeType !== 'application/vnd.google-apps.folder') throw new Error('drive-folder-required'); };
 const immutableMatch = (item: Metadata, displayName: string, folderId: string, expectedProps: Record<string, string>, byteLength: number, digest: string) =>
  item.mimeType === 'application/json' && item.name === displayName && !!item.parents?.includes(folderId) && same(item.properties, expectedProps)
  && (item.size === undefined || Number(item.size) === byteLength) && (item.sha256Checksum === undefined || item.sha256Checksum === digest);
 const write = async (providerFileId: string, namespace: string, folderId: string, logicalId: string, properties: Record<string, string>, bytes: Uint8Array, signal: AbortSignal, displayName = logicalId + '.json', expected: Principal = principal!) => {
  assert(expected);
  id(providerFileId);
  if (!/^[0-9a-f]{64}$/.test(namespace) || !uuid.test(logicalId)) throw new Error('drive-immutable-identity');
  await currentPrincipal(signal, expected);await checkFolder(folderId, signal, expected);const stable = Uint8Array.from(bytes), digest = await resourceHash(stable);
  const expectedProps = { ...properties, scope: namespace, objectId: logicalId };
  // Caller durably retains the Google-generated ID BEFORE first POST. Every retry uses it; 409 never overwrites.
  try { const result = await call(current => current.createJson({ id: providerFileId, name: displayName, parents: [id(folderId)], mimeType: 'application/json', properties: expectedProps }, stable, signal), expected) as { id?: string };
   if (result?.id !== providerFileId) throw new Error('drive-upload-id');
  } catch (error) { if (!(error instanceof DriveHttpError && error.status === 409)) throw error; }
  const fileId = providerFileId;
  const before = await metadata(fileId, signal, true, expected);
  if (!immutableMatch(before, displayName, folderId, expectedProps, stable.length, digest)) throw new Error('drive-immutable-metadata');
  const downloaded = await call(current => current.bytes(fileId, Math.max(1, stable.length), signal), expected), after = await metadata(fileId, signal, true, expected);
  // Google Drive may increment `version` and populate `sha256Checksum` right after upload; verify immutable identity, parents, checksum and downloaded bytes.
  if (!immutableMatch(after, displayName, folderId, expectedProps, stable.length, digest)
    || !same(before.parents, after.parents) || downloaded.length !== stable.length || await resourceHash(downloaded) !== digest) throw new Error('drive-immutable-changed');
  assert(expected);return { id: fileId, version: after.version, sha256: digest };
 };
 return Object.freeze({ preload: loadGoogleSdk, verifier,
  connect(options: { selectAccount?: boolean }, signal: AbortSignal) {
   if (connecting || signal.aborted) return Promise.reject(new Error('drive-connect-unavailable'));connecting = true;
   // Deliberately synchronous before any awaited DB/lock/network work, preserving the actual click activation.
   const login = session.signIn(options);const cancel = () => session.cancelSignIn();signal.addEventListener('abort', cancel, { once: true });
   return (async () => { try {
    await login;if (signal.aborted) throw new Error('drive-connect-cancelled');const captured = session.captureProviderTransport();
    const about = await captured.about(signal) as { user?: { permissionId?: unknown } };captured.assertCurrent();
    if (typeof about?.user?.permissionId !== 'string') throw new Error('drive-principal-missing');
    const digest = await googleDrivePrincipalDigest(about.user.permissionId);signal.throwIfAborted();captured.assertCurrent();transport = captured;principal = Object.freeze({ digest, generation: captured.generation });selected.clear();return { ...principal };
   } finally { signal.removeEventListener('abort', cancel);connecting = false; } })();
  },
  list: async (signal: AbortSignal) => { const expected = principal!;assert(expected);await currentPrincipal(signal, expected);const values = await call(current => current.list("trashed = false and 'me' in owners and properties has { key='papeer' and value='canonical-provider-v1' }", 'id,name', signal), expected);
   return values.map(value => { const row = value as { id?: string; name?: string };if (typeof row.id !== 'string' || typeof row.name !== 'string' || row.name.length > 2000) throw new Error('drive-list-entry');return { id: id(row.id), title: row.name }; }); },
  boundStorage(groupSignal?: () => AbortSignal): DriveEditStorage {
   const captured = receiver(), expected = principal!;
   const scoped = () => { assert(expected);const signal = groupSignal?.();return signal ? captured.scopedStorage(signal) : captured.storage; };
   const guard = async <T>(action: (storage: DriveEditStorage) => Promise<T>) => {
    // Snapshot exactly once, before any await. Every chained request/body of
    // this storage operation retains the same group, even if the getter changes.
    const storage = scoped();await storage.assertCurrent();
    const result = await call(async current => { if (current !== captured) throw new Error('drive-auth-changed');return action(storage); }, expected);
    await storage.assertCurrent();return result;
   };
   return { bindAccount: async () => { throw new Error('provider-scope-rebinding-forbidden'); }, assertCurrent: () => scoped().assertCurrent(),
    sharedEditFiles: namespace => guard(storage => storage.sharedEditFiles(namespace)), annotation: fileId => guard(storage => storage.annotation(fileId)),
    saveSharedEdit: (namespace, folderId, objectId, value) => guard(storage => storage.saveSharedEdit(namespace, folderId, objectId, value)),
    sharedResource: (namespace, descriptor, blobId) => guard(storage => storage.sharedResource(namespace, descriptor, blobId)),
    saveSharedResource: (namespace, folderId, resource) => guard(storage => storage.saveSharedResource(namespace, folderId, resource)) };
  },
  async disconnectAndWait() { selected.clear();transport = undefined;principal = undefined;await session.signOutAndWait(); },
  allocateFileIds: (count: number, signal: AbortSignal) => call(current => current.allocateFileIds(count, signal)),
  createFolder: async (providerFileId: string, logicalId: string, title: string, parent: string | undefined, signal: AbortSignal) => {
   const expected = principal!;assert(expected);id(providerFileId);if (!uuid.test(logicalId) || !pyStrip(title) || title !== pyStrip(title) || Array.from(title).length > EDIT_LIMITS.title) throw new Error('drive-folder-title');
   await currentPrincipal(signal, expected);if (parent !== undefined) await checkFolder(parent, signal, expected);
   try { const created = await call(current => current.createMetadata({ id: providerFileId, name: title, mimeType: 'application/vnd.google-apps.folder',
    ...(parent !== undefined ? { parents: [id(parent)] } : {}), properties: { papeer: 'canonical-provider-folder-v1', objectId: logicalId } }, signal), expected) as { id?: string };
    if (created?.id !== providerFileId) throw new Error('drive-folder-id');
   } catch (error) { if (!(error instanceof DriveHttpError && error.status === 409)) throw error; }
   const actual = await metadata(providerFileId, signal, false, expected);
   if (actual.mimeType !== 'application/vnd.google-apps.folder' || actual.name !== title || !same(actual.properties, { papeer: 'canonical-provider-folder-v1', objectId: logicalId })
    || (parent !== undefined && !actual.parents?.includes(parent))) throw new Error('drive-folder-metadata');return { id: actual.id, version: actual.version };
  },
  writeImmutableJson: (providerFileId: string, namespace: string, folderId: string, logicalId: string, kind: 'dataset-manifest' | 'repository-checkpoint', value: unknown, signal: AbortSignal) => {
   if (kind !== 'dataset-manifest' && kind !== 'repository-checkpoint') throw new Error('drive-immutable-kind');
   const bytes = new TextEncoder().encode(canonicalJson(value));if (bytes.length > 16 * 1024 * 1024) throw new Error('drive-immutable-size');
   return write(providerFileId, namespace, folderId, logicalId, { papeer: 'edits-v1', editKind: kind }, bytes, signal);
  },
  writeDescriptor: async (providerFileId: string, logicalId: string, folderId: string, title: string, bytes: Uint8Array, namespace: string, signal: AbortSignal) => {
   const expected = principal!;assert(expected);if (!pyStrip(title) || title !== pyStrip(title) || Array.from(title).length > EDIT_LIMITS.title) throw new Error('drive-descriptor-title');
   const stable = Uint8Array.from(bytes);if (!stable.length || stable.length > EDIT_LIMITS.providerDescriptorBytes) throw new Error('drive-descriptor-size');
   let value: unknown;try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stable)); } catch { throw new Error('drive-descriptor-json'); }
   validateCanonicalProviderDescriptor(value);await readProviderDescriptorBytes(stable, await resourceHash(stable), value.scope);
   return write(providerFileId, namespace, folderId, logicalId, { papeer: 'canonical-provider-v1', providerKind: 'descriptor' }, stable, signal, title, expected);
  },
 });
}

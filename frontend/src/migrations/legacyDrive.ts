import type { LegacyBackupEntry, LegacyBackupManifest, LegacyBackupPlan } from '../runtime/edits/contracts.ts';
import { canonicalJson, EditRejected } from '../runtime/edits/editModel.ts';
import { editContentHash } from '../runtime/edits/editContentHash.ts';
import { resourceHash } from '../runtime/edits/contentPublication.ts';
import { assertLegacyBackupPlan, compareBackupKeys, legacyInventoryHash, type LegacyBackupObjectStore, type LegacyBackupPort } from './legacyBackup.ts';
import { StoredLegacyBackup, type LegacyBackupSink } from './storedLegacyBackup.ts';

export type LegacyDriveIdentity = { accountId: string; libraryId: string };
/** Authenticated raw I/O only. Neither host parses, adopts, acknowledges, or rewrites old operations here. */
export interface LegacyDriveReadPort {
  account(): Promise<string>;
  metadata(id: string): Promise<unknown>;
  children(folderId: string): Promise<unknown[]>;
  libraryFiles(libraryId: string, kind: 'ink-v1' | 'notes-v1' | 'note-blob-v1'): Promise<unknown[]>;
  read(id: string): Promise<Uint8Array>;
}
type Metadata = { id: string; name: string; mimeType: string; version: string; size: string | null; sha256Checksum: string | null;
  parents: string[]; properties: Record<string, string>; trashed: false };
type Reference = { id: string; sha256: string; size: number };
type Observation = { files: Metadata[]; bytes: Uint8Array; references: Reference[]; digest: string };
const folderMime = 'application/vnd.google-apps.folder';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const decimal = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 30 && !/[^0-9]/.test(value) && (value === '0' || value[0] !== '0');
const sha256 = (value: unknown): value is string => typeof value === 'string' && value.length === 64 && /^[a-f0-9]+$/.test(value);
function metadata(value: unknown): Metadata {
  if (!record(value) || !text(value.id) || !text(value.name) || !text(value.mimeType) || !decimal(value.version)
    || value.trashed !== false || (value.size !== undefined && !decimal(value.size))
    || (value.sha256Checksum !== undefined && !sha256(value.sha256Checksum))
    || (value.parents !== undefined && (!Array.isArray(value.parents) || !value.parents.every(text)))
    || (value.properties !== undefined && (!record(value.properties) || !Object.values(value.properties).every(v => typeof v === 'string')))) throw new EditRejected('backup-drive-metadata');
  const result: Metadata = { id: value.id, name: value.name, mimeType: value.mimeType, version: value.version,
    size: value.size as string ?? null, sha256Checksum: value.sha256Checksum as string ?? null,
    parents: [...(value.parents as string[] ?? [])].sort(), properties: structuredClone(value.properties as Record<string, string> ?? {}), trashed: false };
  if (result.mimeType !== folderMime && (result.size === null || !Number.isSafeInteger(Number(result.size)))) throw new EditRejected('backup-drive-unsupported-file');
  return result;
}
function references(bytes: Uint8Array): { folderId?: string; files: Reference[] } {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!record(value) || value.version !== 1 || !record(value.files) || (value.folder_id !== undefined && !text(value.folder_id))) throw new EditRejected('backup-drive-manifest');
  const files: Reference[] = [];
  for (const [path, file] of Object.entries(value.files)) {
    if (!path || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')
      || !record(file) || !text(file.id) || !sha256(file.sha256) || !Number.isSafeInteger(file.size) || (file.size as number) < 0) throw new EditRejected('backup-drive-manifest');
    files.push({ id: file.id, sha256: file.sha256, size: file.size as number });
  }
  return { files, ...(value.folder_id ? { folderId: value.folder_id as string } : {}) };
}

export async function legacyDriveBackupSource(identity: LegacyDriveIdentity) {
  const stable = structuredClone(identity);
  if (!text(stable.accountId) || !text(stable.libraryId)) throw new EditRejected('backup-source-identity');
  return { kind: 'drive' as const, id: await editContentHash(stable) };
}
export async function createLegacyDriveBackup(identity: LegacyDriveIdentity, io: LegacyDriveReadPort, store: LegacyBackupObjectStore): Promise<LegacyBackupPort> {
  const stable = structuredClone(identity);
  return new LegacyDriveBackup((await legacyDriveBackupSource(stable)).id, stable, io, store);
}
class LegacyDriveBackup extends StoredLegacyBackup {
  private readonly identity: LegacyDriveIdentity;
  private readonly io: LegacyDriveReadPort;
  constructor(sourceId: string, identity: LegacyDriveIdentity, io: LegacyDriveReadPort, store: LegacyBackupObjectStore) {
    super({ kind: 'drive', id: sourceId }, store); this.identity = identity; this.io = io;
  }
  private async account() {
    if (await this.io.account() !== this.identity.accountId) throw new EditRejected('backup-drive-account');
  }
  private async read(file: Metadata): Promise<Uint8Array> {
    const bytes = Uint8Array.from(await this.io.read(file.id));
    if (file.size === null || bytes.byteLength !== Number(file.size)
      || (file.sha256Checksum !== null && await resourceHash(bytes) !== file.sha256Checksum)) throw new EditRejected('backup-object-hash');
    if (canonicalJson(metadata(await this.io.metadata(file.id))) !== canonicalJson(file)) throw new EditRejected('backup-source-changed');
    return bytes;
  }
  private async observe(): Promise<Observation> {
    await this.account();
    const manifest = metadata(await this.io.metadata(this.identity.libraryId));
    if (manifest.id !== this.identity.libraryId || manifest.properties.papeer !== 'library-v1' || manifest.mimeType === folderMime) throw new EditRejected('backup-drive-library');
    const bytes = await this.read(manifest), reference = references(bytes), files = new Map<string, Metadata>([[manifest.id, manifest]]);
    const add = (file: Metadata) => {
      const old = files.get(file.id);
      if (old && canonicalJson(old) !== canonicalJson(file)) throw new EditRejected('backup-source-changed');
      files.set(file.id, file);
    };
    const folderId = reference.folderId ?? (manifest.parents.length === 1 ? manifest.parents[0] : undefined);
    if (!folderId || !manifest.parents.includes(folderId)) throw new EditRejected('backup-drive-folder');
    const visited = new Set<string>(), pending = [folderId];
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) throw new EditRejected('backup-drive-folder-cycle'); visited.add(id);
      const folder = metadata(await this.io.metadata(id));
      if (folder.id !== id || folder.mimeType !== folderMime) throw new EditRejected('backup-drive-folder'); add(folder);
      const seen = new Set<string>();
      for (const input of await this.io.children(id)) {
        const child = metadata(input);
        if (!child.parents.includes(id) || seen.has(child.id)) throw new EditRejected('backup-source-changed');
        seen.add(child.id); add(child); if (child.mimeType === folderMime) pending.push(child.id);
      }
    }
    const noteOperations = new Set<string>();
    for (const kind of ['ink-v1', 'notes-v1', 'note-blob-v1'] as const) {
      const seen = new Set<string>();
      for (const input of await this.io.libraryFiles(this.identity.libraryId, kind)) {
        const file = metadata(input);
        if (seen.has(file.id) || file.properties.papeer !== kind || file.properties.library !== this.identity.libraryId || file.mimeType === folderMime) throw new EditRejected('backup-drive-operation-scope');
        seen.add(file.id); add(file); if (kind === 'notes-v1') noteOperations.add(file.id);
      }
    }
    const noteHashes: { id: string; sha256: string }[] = [];
    for (const id of [...noteOperations].sort()) {
      const bytes = await this.read(files.get(id)!); noteHashes.push({ id, sha256: await resourceHash(bytes) });
      let operation: unknown;
      try { operation = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { continue; } // Raw damaged operations are retained, as are all tagged note blobs. Conversion reports their damage later.
      if (!record(operation) || operation.blob === undefined) continue;
      const blob = operation.blob;
      if (!record(blob) || !text(blob.id) || !sha256(blob.sha256) || !Number.isSafeInteger(blob.size) || (blob.size as number) < 0) throw new EditRejected('backup-drive-note-reference');
      reference.files.push({ id: blob.id, sha256: blob.sha256, size: blob.size as number });
    }
    for (const ref of reference.files) {
      if (!files.has(ref.id)) {
        const file = metadata(await this.io.metadata(ref.id)); if (file.id !== ref.id) throw new EditRejected('backup-drive-metadata'); add(file);
      }
      const file = files.get(ref.id)!;
      if (file.size !== String(ref.size) || (file.sha256Checksum !== null && file.sha256Checksum !== ref.sha256)) throw new EditRejected('backup-object-hash');
    }
    await this.account();
    const ordered = [...files.values()].sort((a, b) => compareBackupKeys([a.id], [b.id]));
    return { files: ordered, bytes, references: reference.files,
      digest: await editContentHash({ identity: this.identity, files: ordered, manifestSha256: await resourceHash(bytes), noteOperations: noteHashes }) };
  }
  protected async checkCurrent(plan: LegacyBackupPlan): Promise<void> {
    if ((await this.observe()).digest !== plan.observationSha256) throw new EditRejected('backup-source-changed');
  }
  protected async snapshot(id: string, sink?: LegacyBackupSink): Promise<LegacyBackupPlan> {
    const observed = await this.observe(), entries: LegacyBackupEntry[] = [], hashes = new Map<string, string>();
    const add = async (key: string[], bytes: Uint8Array) => {
      const hash = await resourceHash(bytes), entry = { key, sha256: hash, byteLength: bytes.byteLength };
      entries.push(entry); await sink?.(entry, bytes); return hash;
    };
    for (const file of observed.files) {
      await add(['metadata', file.id], new TextEncoder().encode(canonicalJson(file)));
      if (file.mimeType !== folderMime) hashes.set(file.id, await add(['bodies', file.id], file.id === this.identity.libraryId ? observed.bytes : await this.read(file)));
    }
    for (const ref of observed.references) if (hashes.get(ref.id) !== ref.sha256) throw new EditRejected('backup-object-hash');
    await add(['manifest.json'], observed.bytes);
    entries.sort((a, b) => compareBackupKeys(a.key, b.key));
    const manifest: LegacyBackupManifest = { version: 1, id, source: structuredClone(this.source), entries, containers: [['bodies'], ['metadata']], inventorySha256: '' };
    manifest.inventorySha256 = await legacyInventoryHash(manifest);
    const plan = { manifest, observationSha256: observed.digest }; await assertLegacyBackupPlan(plan); await this.checkCurrent(plan);
    return plan;
  }
}

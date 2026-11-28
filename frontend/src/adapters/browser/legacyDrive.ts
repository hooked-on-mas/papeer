import type { LegacyDriveReadPort } from '../../migrations/legacyDrive.ts';

type DriveGet = (resource: 'files' | 'about', path: string, format: 'json' | 'bytes') => Promise<unknown>;
const fields = 'id,name,mimeType,version,size,sha256Checksum,parents,properties,trashed';
function id(value: string): string {
  if (!value || value.length > 200 || /[^A-Za-z0-9_-]/.test(value)) throw new Error('invalid-drive-id'); return value;
}
export function createBrowserLegacyDriveRead(get: DriveGet): LegacyDriveReadPort {
  const list = async (q: string): Promise<unknown[]> => {
    const files: unknown[] = [], seen = new Set<string>(); let token: string | undefined;
    do {
      const params = new URLSearchParams({ q: q + ' and trashed = false', fields: 'nextPageToken,incompleteSearch,files(' + fields + ')',
        pageSize: '1000', corpora: 'user', spaces: 'drive', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
      if (token) params.set('pageToken', token);
      const page = await get('files', '?' + params, 'json') as { files?: unknown[]; incompleteSearch?: boolean; nextPageToken?: string };
      if (!page || page.incompleteSearch === true || !Array.isArray(page.files)) throw new Error('backup-drive-incomplete-list');
      files.push(...page.files); token = page.nextPageToken;
      if (token !== undefined && (typeof token !== 'string' || !token || seen.has(token))) throw new Error('backup-drive-pagination');
      if (token) seen.add(token);
    } while (token !== undefined);
    return files;
  };
  return {
    account: async () => {
      const value = await get('about', '?fields=user(permissionId)', 'json') as { user?: { permissionId?: string } };
      const identity = value?.user?.permissionId;
      if (typeof identity !== 'string' || !identity || identity.length > 200) throw new Error('backup-drive-account'); return identity;
    },
    metadata: fileId => get('files', '/' + id(fileId) + '?' + new URLSearchParams({ fields, supportsAllDrives: 'true' }), 'json'),
    children: folderId => list("'" + id(folderId) + "' in parents"),
    libraryFiles: (libraryId, kind) => {
      if (kind !== 'ink-v1' && kind !== 'notes-v1' && kind !== 'note-blob-v1') throw new Error('backup-drive-operation-kind');
      return list("properties has { key='papeer' and value='" + kind + "' } and properties has { key='library' and value='" + id(libraryId) + "' }");
    },
    read: async fileId => {
      const bytes = await get('files', '/' + id(fileId) + '?alt=media&supportsAllDrives=true', 'bytes');
      if (!(bytes instanceof Uint8Array)) throw new Error('backup-drive-body'); return bytes;
    },
  };
}

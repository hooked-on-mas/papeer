/** Shared source coverage for readonly startup admission and the legacy backup inventory. */
export function isLegacyLocalStorageKey(key: string): boolean {
  return (key === 'paper-desk-storage' || key.startsWith('papeer-') || key.startsWith('papeer:') || key.startsWith('paperdesk-'))
    && !['papeer-google-session:v1', 'paperdesk-google-session:v1'].includes(key);
}

export function readLegacyLocalStorageEntries(storage: Pick<Storage, 'length' | 'key' | 'getItem'>): [string, string][] {
  const length = storage.length, keys: string[] = [];
  if (!Number.isSafeInteger(length) || length < 0) throw new Error('backup-source-unreadable');
  for (let index = 0; index < length; index++) {
    const key = storage.key(index);
    if (typeof key !== 'string') throw new Error('backup-source-changed');
    if (isLegacyLocalStorageKey(key)) keys.push(key);
  }
  if (storage.length !== length || new Set(keys).size !== keys.length) throw new Error('backup-source-changed');
  return keys.sort().map(key => {
    const value = storage.getItem(key);
    if (typeof value !== 'string') throw new Error('backup-source-changed');
    return [key, value];
  });
}

export const isLegacyIndexedDbName = (name: string): boolean => name.startsWith('papeer-documents:');

/** No open/create/upgrade. Enumeration failure cannot establish an empty source set. */
export async function discoverLegacyIndexedDbNames(factory: IDBFactory = indexedDB): Promise<string[]> {
  if (typeof factory.databases !== 'function') throw new Error('backup-database-discovery-unavailable');
  const databases = await factory.databases();
  if (!Array.isArray(databases) || databases.some(db => !db || typeof db.name !== 'string' || !db.name)) throw new Error('backup-database-discovery-invalid');
  const names = databases.map(db => db.name!).filter(isLegacyIndexedDbName).sort();
  if (new Set(names).size !== names.length) throw new Error('backup-source-changed');
  return names;
}

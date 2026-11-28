import type { EditScope } from '../../runtime/edits/ports.ts';
import { inkPreferenceKey, type InkPreferenceStorage } from '../../features/reader/ink/inkPreferencePersistence.ts';

/** Device-local host I/O, scoped to the same complete identity as the reader. */
export function createBrowserInkPreferences(scope: EditScope, storage?: InkPreferenceStorage): InkPreferenceStorage {
  const expected = inkPreferenceKey({ ...scope });
  const check = (key: string) => { if (key !== expected) throw new Error('ink-preference-scope'); };
  // Acquiring localStorage can itself fail. Defer it into the model's guarded
  // read/write call so the ordinary settings error and retry UI can report it.
  return {
    getItem(key) { check(key); return (storage ?? globalThis.localStorage).getItem(key); },
    setItem(key, value) { check(key); (storage ?? globalThis.localStorage).setItem(key, value); },
  };
}

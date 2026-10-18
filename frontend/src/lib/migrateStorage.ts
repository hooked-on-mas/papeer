// Run before stores hydrate. Keep old values if storage is unavailable or full.
export function migrateStorage(storage: Storage): void {
  for (const oldKey of Object.keys(storage)) {
    const newKey = oldKey === "paper-desk-storage" ? "papeer-storage"
      : oldKey.startsWith("paperdesk-") ? oldKey.replace(/^paperdesk-/, "papeer-") : null;
    if (!newKey) continue;
    const value = storage.getItem(oldKey);
    if (value === null) continue;
    if (storage.getItem(newKey) === null) storage.setItem(newKey, value);
    storage.removeItem(oldKey);
  }
}

try {
  migrateStorage(localStorage);
} catch {
  // Storage can be disabled by the browser; leave the original data intact.
}

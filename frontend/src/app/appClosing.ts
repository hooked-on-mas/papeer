/**
 * Whether the app is closing (AppShell's close handling). A sync or restore that replaced the library
 * reloads the page; during the close sequence that reload would throw the sequence away (the window
 * would stay open, or outlive its sidecar), so it is held back until the closing is called off.
 */
let closing = false;
let heldReload: (() => void) | null = null;
const listeners = new Set<(closing: boolean) => void>();

export function isAppClosing(): boolean {
  return closing;
}

export function setAppClosing(value: boolean): void {
  const changed = closing !== value;
  closing = value;
  if (changed) listeners.forEach((listener) => listener(value));
  if (!value && heldReload) {
    const reload = heldReload;
    heldReload = null;
    reload();
  }
}

/** Run `reload` now, or, while the app is closing, only if the closing is called off. */
export function reloadUnlessClosing(reload: () => void): void {
  if (closing) heldReload = reload;
  else reload();
}

/** Hear the app start closing (true) and the closing called off (false); returns the unsubscribe. */
export function onAppClosingChange(listener: (closing: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Whether the app is closing (AppShell's close handling). A sync or restore that replaced the library
 * reloads the page; during the close sequence that reload would throw the sequence away (the window
 * would stay open, or outlive its sidecar), so it is held back until the closing is called off.
 */
let closing = false;
let heldReload: (() => void) | null = null;

export function isAppClosing(): boolean {
  return closing;
}

export function setAppClosing(value: boolean): void {
  closing = value;
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

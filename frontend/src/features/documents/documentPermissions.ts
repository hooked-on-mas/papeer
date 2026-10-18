const PREFIX = "papeer-html-script:";
/** Permission is local to this computer and this exact source; changing the HTML revokes it. */
export function scriptPermission(id: string, hash: string): boolean {
  try { return localStorage.getItem(PREFIX + id) === hash; } catch { return false; }
}
export function setScriptPermission(id: string, hash: string, allowed: boolean): void {
  if (allowed) localStorage.setItem(PREFIX + id, hash);
  else localStorage.removeItem(PREFIX + id);
}

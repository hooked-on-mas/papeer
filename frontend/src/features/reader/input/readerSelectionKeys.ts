export type ReaderSelectionKeyResult = 'pass' | 'handled' | 'blocked';
export type ReaderSelectionKeyPort = { handleKey(event: KeyboardEvent): ReaderSelectionKeyResult };
/** A focused handle survives endpoint equality so its next key remains owned by
 * selection. Nonfocused handles may disappear when there is no selected text. */
export function pdfSelectionHandleVisible(endpoint: 'anchor' | 'focus', collapsed: boolean, focusedEndpoint: 'anchor' | 'focus' | null): boolean {
  return !collapsed || endpoint === focusedEndpoint;
}
/** Called once from useReaderInput's existing bubble listener after its IME and
 * ownsKey checks. A handled/blocked result closes the Reader fallback route. */
export function routeReaderSelectionKey(event: KeyboardEvent, port: ReaderSelectionKeyPort | undefined): boolean {
  if (event.defaultPrevented) return true;
  const result = port?.handleKey(event) ?? 'pass';
  if (result === 'pass') return false;
  event.preventDefault(); return true;
}
export const pdfSelectionMotionKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
/** Pure ownership decision; the sole window bubble listener performs default prevention. */
export function pdfSelectionKeyIntent({ key, started, target, contact, current, ctrlKey, metaKey, altKey, shiftKey }: {
  key: string; started: boolean; target: 'body' | 'handle' | 'other'; contact: boolean; current: boolean;
  ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean;
}): ReaderSelectionKeyResult | 'start' | 'move' | 'clear' {
  if (target === 'other') return 'pass';
  // Let the platform generate the ordinary copy event, including for an empty selection.
  if (key.toLowerCase() === 'c' && (ctrlKey || metaKey) && !altKey) return 'pass';
  const relevant = started ? pdfSelectionMotionKeys.has(key) || key === 'Escape' : target === 'body' && key === 'Enter';
  if (!relevant) return 'pass';
  if (contact || !current || ctrlKey || metaKey || altKey || shiftKey && (!started || key === 'Escape')) return 'blocked';
  if (!started) return 'start';
  if (key === 'Escape') return 'clear';
  // Vertical/page movement has no admitted text traversal policy. Never fall back to Reader paging.
  if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'PageUp' || key === 'PageDown') return 'blocked';
  return 'move';
}

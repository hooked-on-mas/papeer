/**
 * The result that Enter, Shift+Enter and F3 move to in the paper search, wrapping around at either
 * end. `current` is -1 before any result has been shown, when Enter shows the first and Shift+Enter the last.
 */
export function stepSearchResult(current: number, total: number, delta: 1 | -1): number {
  if (total <= 0) return -1;
  if (current < 0 || current >= total) return delta > 0 ? 0 : total - 1;
  return (current + delta + total) % total;
}

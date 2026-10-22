// Layout depends on available space, regardless of device or input hardware.
export const COMPACT_LAYOUT_QUERY = "(max-width: 600px), (max-height: 500px)";
export const SIDEBAR_OVERLAY_QUERY = "(max-width: 1200px)";

/** Separate entry/exit thresholds keep small resizes from alternating layouts. */
export function automaticReaderSplit(width: number, height: number, previous: boolean) {
  if (width <= 0 || height <= 0) return previous;
  return previous ? width >= 932 && width / height >= 1.08
    : width >= 964 && width / height >= 1.15;
}

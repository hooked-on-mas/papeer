import { useCallback, useLayoutEffect, useState } from "react";
import { useUiScale } from "@/app/uiScale";

/**
 * The content width of a toolbar row at 100% UI size, less `padding` px: measured before the first
 * paint, and again whenever the row changes width. The row is given back as a ref callback.
 */
export function useRowWidth(padding = 24): [(row: HTMLElement | null) => void, number] {
  const [row, setRow] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  const uiScale = useUiScale((s) => s.scale);
  useLayoutEffect(() => {
    if (!row) return;
    const measure = () => setWidth(row.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [row]);
  const ref = useCallback((node: HTMLElement | null) => setRow(node), []);
  // The widths in readerBars.ts are at 100%; the UI size (lib/uiScale.ts) scales everything drawn in the row.
  return [ref, Math.max(0, width / uiScale - padding)];
}

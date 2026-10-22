import { useLayoutEffect, useRef, useState } from "react";
import { automaticReaderSplit } from "./readerLayout";
import { prepareWebNavigation } from "./textDrafts";

/** Measure the reader after surrounding panels have taken their space. */
export function useReaderLayout() {
  const ref = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(false);
  const [width, setWidth] = useState(0);
  const measured = useRef({ split: false, width: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      // Keyboard resizing must not replace an editor while its text is focused.
      if (document.activeElement?.matches('input, textarea, select, [contenteditable="true"]')) return;
      const { width, height } = element.getBoundingClientRect();
      const next = { width: Math.round(width), split: automaticReaderSplit(width, height, measured.current.split) };
      // Pointer/focus events only retry an actual deferred layout change. Unrelated
      // clicks must not flush or alter an editor's unsaved-stroke recovery state.
      if (next.width === measured.current.width && next.split === measured.current.split) return;
      if (!prepareWebNavigation()) return;
      measured.current = next;
      setWidth(next.width); setSplit(next.split);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    // Reconsider a deferred change after a stroke finishes or the keyboard closes.
    document.addEventListener("pointerup", schedule);
    document.addEventListener("pointercancel", schedule);
    document.addEventListener("focusout", schedule);
    measure();
    return () => {
      observer.disconnect(); cancelAnimationFrame(frame);
      document.removeEventListener("pointerup", schedule);
      document.removeEventListener("pointercancel", schedule);
      document.removeEventListener("focusout", schedule);
    };
  }, []);
  return { ref, split, width };
}

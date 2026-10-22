import { useLayoutEffect, useRef, useState } from "react";
import { automaticReaderSplit } from "./readerLayout";
import { prepareWebNavigation } from "./textDrafts";

/** Measure the reader after surrounding panels have taken their space. */
export function useReaderLayout() {
  const ref = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(false);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    const measure = () => {
      // Keyboard resizing must not replace an editor while its text is focused.
      if (document.activeElement?.matches('input, textarea, select, [contenteditable="true"]')) return;
      const { width, height } = element.getBoundingClientRect();
      if (!prepareWebNavigation()) return;
      setWidth(Math.round(width));
      setSplit(previous => automaticReaderSplit(width, height, previous));
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

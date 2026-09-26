type ScrollPane = Pick<HTMLElement,
  "scrollTop" | "scrollLeft" | "scrollHeight" | "scrollWidth" | "clientHeight" | "clientWidth">;

/** Ignore synchronization echoes even when the browser delivers them in a later frame. */
export function createScrollSync() {
  const expected = new WeakMap<ScrollPane, { top: number; left: number }>();
  return (source: ScrollPane, target: ScrollPane | null) => {
    const position = expected.get(source);
    if (position && source.scrollTop === position.top && source.scrollLeft === position.left) return;
    expected.delete(source);
    if (!target) return;

    const ratioY = source.scrollTop / Math.max(1, source.scrollHeight - source.clientHeight);
    const ratioX = source.scrollLeft / Math.max(1, source.scrollWidth - source.clientWidth);
    const top = ratioY * Math.max(0, target.scrollHeight - target.clientHeight);
    const left = ratioX * Math.max(0, target.scrollWidth - target.clientWidth);
    // Avoid redundant writes, which can interrupt a native wheel animation.
    if (target.scrollTop !== top) target.scrollTop = top;
    if (target.scrollLeft !== left) target.scrollLeft = left;
    // Read back the actual position: browsers may clamp or round the assignment.
    expected.set(target, { top: target.scrollTop, left: target.scrollLeft });
  };
}

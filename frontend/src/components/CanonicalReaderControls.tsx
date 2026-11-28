import type { ReactNode } from 'react';

/** Keep controls reachable without letting wrapped rows consume the reading surface. */
export function CanonicalReaderControls({ children }: { children: ReactNode }) {
  return <div className="max-h-[45%] min-h-0 shrink-0 overflow-y-auto bg-background" tabIndex={0} role="region" aria-label="文書操作"
    onKeyDown={event => {
      if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
      const region = event.currentTarget;
      const amount = event.key === 'PageDown' ? region.clientHeight : event.key === 'PageUp' ? -region.clientHeight
        : event.key === 'End' ? region.scrollHeight : event.key === 'Home' ? -region.scrollHeight
        : event.key === 'ArrowDown' ? 40 : event.key === 'ArrowUp' ? -40 : 0;
      const horizontal = event.key === 'ArrowRight' ? 40 : event.key === 'ArrowLeft' ? -40 : 0;
      if (amount || horizontal) { event.preventDefault(); event.stopPropagation(); region.scrollBy({ top: amount, left: horizontal }); }
    }}>
    {children}
  </div>;
}

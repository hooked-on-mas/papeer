import type { ReactNode, RefObject } from 'react';
import { CanonicalReaderControls } from '../../components/CanonicalReaderControls';

/** One host-independent viewport and input scope for canonical content. */
export function CanonicalReaderFrame({ title, rootRef, toolbar, children }: {
  title: string; rootRef: RefObject<HTMLDivElement | null>; toolbar: ReactNode; children: ReactNode;
}) {
  return <div ref={rootRef} data-reader-root data-layout="single" className="canonical-reader-frame flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden bg-reader-bg">
    <h1 className="shrink-0 truncate border-b bg-background px-3 py-1.5 text-sm font-medium text-foreground">{title}</h1>
    <CanonicalReaderControls>{toolbar}</CanonicalReaderControls>
    <div id="original" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
  </div>;
}

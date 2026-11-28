import type { ReactNode, Ref } from "react";
import { ReaderSplit } from "../features/reader/layout/ReaderSplit";
export type ReaderControls = { title: string; leading: ReactNode; language: ReactNode; menu: ReactNode };
/** Shared layout; loading, navigation and editing belong to its caller. */
export function DocumentReader({ rootRef, split, fraction, onResize, header, toolbar, message, original, translated }: {
  rootRef?: Ref<HTMLDivElement>; split: boolean; fraction: number; onResize: (fraction: number) => void;
  header?: ReactNode; toolbar?: ReactNode; message?: ReactNode; original: ReactNode; translated?: ReactNode;
}) {
  return <div ref={rootRef} className="web-document-reader" data-reader-root data-layout={split ? "split" : "single"}>
    {header}{toolbar}{message}
    <ReaderSplit fraction={fraction} onResize={onResize} original={original} translated={translated} />
  </div>;
}

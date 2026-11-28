import { createContext, useCallback, useContext, useState, type ReactNode, type SetStateAction } from "react";

import { WritingToolbarProvider, type WritingSide } from "../features/reader/WritingToolbar";
import type { DrawingKind } from '../features/ink/inkDraft';
import type { PageHistory } from './pdfWritingHistory';

export type PdfTool = "read" | DrawingKind | "eraser" | "text";

function useSettings() {
  const [tool, setTool] = useState<PdfTool>("pen");
  const [color, setColor] = useState("#d93c36");
  const [width, setWidth] = useState(.003);
  const [finger, setFinger] = useState(false);
  return { tool, setTool, color, setColor, width, setWidth, finger, setFinger };
}

const WritingContext = createContext<ReturnType<typeof useSettings> | null>(null);
const EMPTY_HISTORY: PageHistory = { undo: [], redo: [] };
const HistoryContext = createContext<{
  pages: Record<string, PageHistory>;
  change: (key: string, update: SetStateAction<PageHistory>) => void;
} | null>(null);

/** Preferences and page journals belong to the document; PDF surfaces can freely remount. */
export function PdfWritingTools({ children, initialActive }: { children: ReactNode; initialActive: WritingSide }) {
  const settings = useSettings();
  const [pages, setPages] = useState<Record<string, PageHistory>>({});
  const change = useCallback((key: string, update: SetStateAction<PageHistory>) => {
    setPages(previous => {
      const page = previous[key] ?? EMPTY_HISTORY;
      return { ...previous, [key]: typeof update === "function" ? update(page) : update };
    });
  }, []);
  return <WritingToolbarProvider initialSide={initialActive}>
    <WritingContext.Provider value={settings}>
      <HistoryContext.Provider value={{ pages, change }}>{children}</HistoryContext.Provider>
    </WritingContext.Provider>
  </WritingToolbarProvider>;
}

/** Layout changes remount PDF surfaces; history follows the canonical library/hash/side/page key. */
export function usePdfWritingHistory(key: string) {
  const shared = useContext(HistoryContext);
  const [local, setLocal] = useState(EMPTY_HISTORY);
  const changeShared = shared?.change;
  const change = useCallback((update: SetStateAction<PageHistory>) => {
    if (changeShared) changeShared(key, update);
    else setLocal(update);
  }, [key, changeShared]);
  const page = shared ? shared.pages[key] ?? EMPTY_HISTORY : local;
  return { history: page.undo, redo: page.redo, changeHistory: change };
}

export function usePdfWritingSettings() {
  const local = useSettings();
  return useContext(WritingContext) ?? local;
}

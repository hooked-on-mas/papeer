import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Redo2, Undo2 } from "lucide-react";
import { inkToolbarSide } from "./layout/readerBars";

export const INK_TOOLBAR_SLOT = "data-ink-toolbar-slot";
export const WRITING_SIDES = [["original", "原文"], ["translated", "訳文"]] as const;
export type WritingSide = typeof WRITING_SIDES[number][0];

function useToolbarState(initialSide: WritingSide) {
  const [selected, setSelected] = useState(initialSide);
  const [owners, setOwners] = useState<Partial<Record<WritingSide, Set<symbol>>>>({});
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const restoreTargetFocus = useRef(false);
  const setActive = (side: WritingSide) => {
    if (side === selected) return;
    const focused = document.activeElement;
    restoreTargetFocus.current = !!slot && focused instanceof Element && slot.contains(focused) && !!focused.closest("[data-writing-target]");
    setSelected(side);
  };
  const register = useCallback((side: WritingSide) => {
    const owner = Symbol(side);
    setOwners(previous => ({ ...previous, [side]: new Set(previous[side]).add(owner) }));
    return () => setOwners(previous => {
      const remaining = new Set(previous[side]); remaining.delete(owner);
      return { ...previous, [side]: remaining };
    });
  }, []);
  useLayoutEffect(() => {
    if (!slot) return;
    const measure = () => setWidth(slot.clientWidth);
    const observer = new ResizeObserver(measure);
    observer.observe(slot); measure();
    return () => observer.disconnect();
  }, [slot]);
  const hosts = { original: !!owners.original?.size, translated: !!owners.translated?.size };
  const active = inkToolbarSide(selected, hosts);
  useLayoutEffect(() => {
    if (!restoreTargetFocus.current) return;
    restoreTargetFocus.current = false;
    slot?.querySelector<HTMLElement>('[data-writing-target] select, [data-writing-target] [aria-pressed="true"]')?.focus({ preventScroll: true });
  }, [active, selected, slot]);
  return { active, hosts, setActive, register, slot, setSlot, width };
}

const ToolbarContext = createContext<ReturnType<typeof useToolbarState> | null>(null);

/** Only placement and pane ownership are shared. Each host supplies commands and persistence. */
export function WritingToolbarProvider({ initialSide = "original", children }: { initialSide?: WritingSide; children: ReactNode }) {
  return <ToolbarContext.Provider value={useToolbarState(initialSide)}>{children}</ToolbarContext.Provider>;
}
export function useWritingToolbar() { return useContext(ToolbarContext); }

export function useWritingPane(side: WritingSide, available: boolean) {
  const toolbar = useWritingToolbar();
  const register = toolbar?.register;
  useLayoutEffect(() => available ? register?.(side) : undefined, [register, side, available]);
  return {
    servesToolbar: available && (!toolbar || toolbar.active === side),
    activate: () => { if (available) toolbar?.setActive(side); },
    slot: toolbar?.slot,
  };
}

export function WritingToolbarSlot({ className, id }: { className?: string; id?: string }) {
  const toolbar = useWritingToolbar();
  return <div id={id} ref={toolbar?.setSlot} data-ink-toolbar-slot="" className={className} />;
}

/** undefined: standalone pane; null: wait for its shared slot; element: render above both PDFs. */
export function WritingToolbarPortal({ slot, children }: { slot?: HTMLElement | null; children: ReactNode }) {
  return slot === undefined ? children : slot ? createPortal(children, slot) : null;
}

export function WritingTarget({ side, presentation = "buttons", className, buttonClassName, activeClassName, beforeChange }: {
  side: WritingSide; presentation?: "buttons" | "select"; className?: string;
  buttonClassName?: string; activeClassName?: string; beforeChange?: () => boolean;
}) {
  const toolbar = useWritingToolbar();
  const hosts = toolbar?.hosts ?? { original: side === "original", translated: side === "translated" };
  const choose = (value: WritingSide) => { if (!beforeChange || beforeChange()) toolbar?.setActive(value); };
  if (presentation === "select") {
    if (!hosts.original || !hosts.translated) return null;
    return <label data-writing-target="" className={className}>
      <span className="sr-only">書き込みの操作対象</span>
      <select aria-label="書き込みの操作対象" value={side} onChange={e => choose(e.target.value as WritingSide)}>
        {WRITING_SIDES.filter(([id]) => hosts[id]).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select>
    </label>;
  }
  return <div data-writing-target="" role="group" aria-label="書き込むPDF" className={className}>
    {WRITING_SIDES.map(([value, label]) => <button key={value} type="button" aria-pressed={side === value} disabled={!hosts[value]}
      title={`${label}のPDFに書き込む（PDFをクリックしても切り替わります）`}
      className={`${buttonClassName ?? ""} ${side === value ? activeClassName ?? "" : ""}`}
      onClick={() => choose(value)}>{label}</button>)}
  </div>;
}

export function WritingHistoryButtons({ canUndo, canRedo, onUndo, onRedo, className, undoLabel = "元に戻す", redoLabel = "やり直す", undoTitle = undoLabel, redoTitle = redoLabel }: {
  canUndo: boolean; canRedo: boolean; onUndo?: () => void; onRedo?: () => void;
  className?: string; undoLabel?: string; redoLabel?: string; undoTitle?: string; redoTitle?: string;
}) {
  return <>
    <button type="button" title={undoTitle} aria-label={undoLabel} disabled={!canUndo} className={className} onClick={onUndo}><Undo2 aria-hidden="true" /><span className="sr-only">{undoLabel}</span></button>
    <button type="button" title={redoTitle} aria-label={redoLabel} disabled={!canRedo} className={className} onClick={onRedo}><Redo2 aria-hidden="true" /><span className="sr-only">{redoLabel}</span></button>
  </>;
}

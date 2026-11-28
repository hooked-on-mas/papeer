import type { KeyTarget } from "./pageTurn.ts";

/** A reader-owned key can target document.body; tell pane observers before its explicit scroll. */
export const READER_SCROLL_INTENT = "reader-scroll-intent";

/** Commands speak in logical document pages, never a translated PDF's physical page index. */
export type ReaderCommand =
  | { type: "step"; amount: -1 | 1; toEnd?: boolean }
  | { type: "jump"; page: number; toEnd?: boolean }
  | { type: "edge"; edge: "first" | "last" }
  | { type: "history"; direction: "back" | "forward" }
  | { type: "zoom"; value: number; anchor?: { x: number; y: number } }
  | { type: "zoom-step"; steps: -1 | 1 }
  | { type: "zoom-reset" }
  | { type: "focus-page-input" };

export type ReaderCommandResult = { status: "applied" | "unchanged" | "blocked" };
export interface ReaderCommandPort {
  /** Event handlers read current state, including changes not rendered by React yet. Fit-page zoom is 0. */
  getSnapshot(): { active: boolean; blocked: boolean; zoom: number; actualZoom?: number; minimumZoom?: number };
  /** The host prepares durable drafts before committing navigation. Rejected gestures are not replayed. */
  dispatch(command: ReaderCommand): ReaderCommandResult;
}

/** Reader shortcuts formerly registered by the desktop shell, shared with browser readers. */
export function readerShortcutCommand(event: {
  key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean;
}, target: KeyTarget): ReaderCommand | null {
  if (target === "editable" || event.altKey) return null;
  if (event.ctrlKey || event.metaKey) {
    const key = event.key.toLowerCase(), code = event.code;
    // Include physical keys used by Japanese keyboards and the numeric keypad.
    if (["+", "=", ";"].includes(key) || code === "Equal" || code === "NumpadAdd" || code === "Semicolon")
      return { type: "zoom-step", steps: 1 };
    if (!event.shiftKey && (key === "-" || code === "Minus" || code === "NumpadSubtract")) return { type: "zoom-step", steps: -1 };
    if (!event.shiftKey && (key === "0" || code === "Digit0" || code === "Numpad0")) return { type: "zoom-reset" };
    if (!event.shiftKey && key === "g") return { type: "focus-page-input" };
    return null;
  }
  if (event.shiftKey) return null;
  if (event.key === "ArrowLeft") return { type: "step", amount: -1 };
  if (event.key === "ArrowRight") return { type: "step", amount: 1 };
  return null;
}

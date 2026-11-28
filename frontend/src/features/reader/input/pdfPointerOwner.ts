import { create } from "zustand";

/** One redraw/pinch owner authority shared by the staged and legacy input hooks. */
export const usePdfTouchOwner = create<{ owners: ReadonlyMap<HTMLElement, HTMLDivElement> }>(() => ({ owners: new Map() }));
export const scopeOf = (pane: HTMLElement) => pane.closest<HTMLElement>("[data-reader-root]") ?? pane;
export const getPdfPointerOwner = (element: HTMLElement | null) => element ? usePdfTouchOwner.getState().owners.get(scopeOf(element)) ?? null : null;
export function claim(pane: HTMLDivElement, active: boolean) {
  usePdfTouchOwner.setState(state => {
    const owners = new Map(state.owners), scope = scopeOf(pane);
    if (active) owners.set(scope, pane);
    else for (const [key, owner] of owners) if (owner === pane) owners.delete(key);
    return { owners };
  });
}

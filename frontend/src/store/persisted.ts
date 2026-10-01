/**
 * The settings the store keeps in localStorage ("papeer-storage"): bringing data saved by an older
 * version up to date, and merging what was saved into the store's state. Kept apart from the store so
 * that it can be tested.
 */
import { mergeSavedSettings, type PageFilter } from "../features/reader/pageAppearance.ts";
import type { SidePanel } from "../features/reader/sidePanel.ts";
import { initialInkBarOpen, inkBarStartOf, type InkBarStart } from "../features/reader/readerBars.ts";

/** The version of the saved data; migratePersisted brings older versions up to it. */
export const PERSIST_VERSION = 3;

export function migratePersisted(persisted: any, version: number): any {
  // v1 stored 0 for "fit width" and absolute scales otherwise; from v2 on, 0 is ZOOM_FIT_PAGE.
  if (version < 2 && persisted) {
    persisted.zoom = persisted.zoom && persisted.zoom >= 1 ? persisted.zoom : 1;
  }
  // v2 had the side panel in focus mode only (focusPanel). It now opens in the normal view too,
  // so it starts closed rather than appearing there unasked; its width is kept.
  if (version < 3 && persisted) {
    if (typeof persisted.focusPanelWidth === "number") persisted.sidePanelWidth = persisted.focusPanelWidth;
    delete persisted.focusPanel;
    delete persisted.focusPanelWidth;
  }
  return persisted;
}

/**
 * Takes what was saved over the defaults; unknown page filters and writing toolbar starts are dropped.
 * The side panel always starts closed, keeping only its saved width. The writing toolbar opens as its
 * start setting says (readerBars.ts), from how it was saved only with 「前回の状態を引き継ぐ」.
 */
export function mergePersisted<T extends {
  pageFilter: PageFilter; sidePanel: SidePanel | null; inkBarStart: InkBarStart; inkBarOpen: boolean;
}>(saved: unknown, current: T): T {
  const merged = mergeSavedSettings(saved, current);
  const inkBarStart = inkBarStartOf(merged.inkBarStart);
  return {
    ...merged,
    sidePanel: null,
    inkBarStart,
    inkBarOpen: initialInkBarOpen(inkBarStart, merged.inkBarOpen),
  };
}

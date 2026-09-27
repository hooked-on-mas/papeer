/**
 * The settings the store keeps in localStorage ("papeer-storage"): bringing data saved by an older
 * version up to date, and merging what was saved into the store's state. Kept apart from the store so
 * that it can be tested.
 */
import { mergeSavedSettings, type PageFilter } from "../features/reader/pageAppearance.ts";
import { isSidePanel, type SidePanel } from "../features/reader/sidePanel.ts";

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

/** Takes what was saved over the defaults; a page filter or side panel this version doesn't know is dropped. */
export function mergePersisted<T extends { pageFilter: PageFilter; sidePanel: SidePanel | null }>(saved: unknown, current: T): T {
  const merged = mergeSavedSettings(saved, current);
  return { ...merged, sidePanel: isSidePanel(merged.sidePanel) ? merged.sidePanel : null };
}

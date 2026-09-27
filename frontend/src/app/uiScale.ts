import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_UI_SCALE, rootFontSize, uiScaleOf } from "@/lib/uiScale";

/**
 * The UI size chosen in 設定「表示」, kept in this browser's storage like the other display settings.
 * A store of its own (not the main one in store/index.ts) so that the root font size can be set
 * before the first render: main.tsx imports this module first.
 */
export const useUiScale = create<{ scale: number; setScale: (scale: number) => void }>()(
  persist(
    (set) => ({
      scale: DEFAULT_UI_SCALE,
      setScale: (scale) => set({ scale: uiScaleOf(scale) }),
    }),
    {
      name: "papeer-ui-scale",
      version: 1,
      partialize: (state) => ({ scale: state.scale }),
      // A value that is not one of the choices (edited by hand, or from a later version) reads as 100%.
      merge: (saved, current) => ({ ...current, scale: uiScaleOf((saved as { scale?: unknown } | undefined)?.scale) }),
    },
  ),
);

function applyUiScale(scale: number): void {
  document.documentElement.style.fontSize = rootFontSize(scale);
}

applyUiScale(useUiScale.getState().scale);
useUiScale.subscribe((state, previous) => {
  if (state.scale !== previous.scale) applyUiScale(state.scale);
});

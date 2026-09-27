/**
 * The size of the whole UI (設定「表示」の「文字の大きさ」), apart from the PDF zoom. It sets the
 * root font size, so everything sized in rem follows: text, Tailwind's spacing, bar heights. Sizes
 * are therefore written in rem, never px (tests/fontSizes.test.mjs checks the font sizes).
 * Kept free of React and the stores so that tests/uiScale.test.ts can check the rules.
 */

export const UI_SCALES = [
  { value: 0.9, label: "90%" },
  { value: 1, label: "100%" },
  { value: 1.1, label: "110%" },
  { value: 1.25, label: "125%" },
  { value: 1.5, label: "150%" },
] as const;

export const DEFAULT_UI_SCALE = 1;

/** A saved scale if it is one of the choices, else 100% (a hand-edited or future value). */
export function uiScaleOf(value: unknown): number {
  return UI_SCALES.some((scale) => scale.value === value) ? (value as number) : DEFAULT_UI_SCALE;
}

/**
 * The root font size for a scale, relative to the webview's default (16px unless the user changed
 * it), so 100% leaves the page as the browser would size it.
 */
export function rootFontSize(scale: number): string {
  return `${Math.round(uiScaleOf(scale) * 100)}%`;
}

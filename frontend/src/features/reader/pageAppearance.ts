/**
 * How PDF pages look under the dark theme (設定「表示」). A white page glares next to the dark
 * panes, so it can be shown inverted or as dimmed sepia paper instead. Only what the reader shows is
 * changed, with a CSS filter on the page's canvas: figure and formula copies (InkCapture) and saved PDFs
 * are drawn by the sidecar from the PDF itself, and keep its colours. The light theme always shows the
 * page as it is.
 */

export type PageFilter = "normal" | "invert" | "sepia";

export const PAGE_FILTERS: readonly { id: PageFilter; label: string }[] = [
  { id: "normal", label: "通常" },
  { id: "invert", label: "反転" },
  { id: "sepia", label: "セピア" },
];

/** A saved setting, falling back to 通常 for anything this version does not know. */
export function pageFilterOf(value: unknown): PageFilter {
  return PAGE_FILTERS.some((item) => item.id === value) ? value as PageFilter : "normal";
}

/**
 * The reader's saved settings (the store's `papeer-storage`) laid over the defaults. A page filter
 * saved by a newer version, or edited by hand, falls back to 通常; everything else is taken as saved
 * (the store's `migrate` has already brought older data up to date).
 */
export function mergeSavedSettings<T extends { pageFilter: PageFilter }>(saved: unknown, current: T): T {
  const merged = { ...current, ...(saved && typeof saved === "object" ? saved : {}) } as T;
  return { ...merged, pageFilter: pageFilterOf(merged.pageFilter) };
}

/**
 * How far 反転 goes: white paper becomes dark grey (31) and black text light grey (224) rather than
 * pure black and white, which glare at each other on a dark screen.
 */
export const INVERT_AMOUNT = 0.88;

/** Turning the hue back halfway round keeps red red and blue blue once the brightness is inverted. */
const INVERT_FILTER = `invert(${INVERT_AMOUNT}) hue-rotate(180deg)`;
/** Darker, warm paper; the figures' colours fade a little. */
const SEPIA_FILTER = "brightness(0.7) sepia(0.8)";

export interface PageAppearance {
  /** CSS filter for the page's canvas, or undefined to draw it as it is. */
  filter?: string;
  /** The page's colour before its canvas is drawn: white paper under the filter. */
  background: string;
  /** How to show an ink colour over the page, or undefined to show it as picked. */
  inkColor?: (color: string) => string;
}

const NORMAL: PageAppearance = { background: "#ffffff" };
const APPEARANCES: Record<Exclude<PageFilter, "normal">, PageAppearance> = {
  // Ink is drawn above the canvas, so it is not filtered; a black pen would vanish into the dark page.
  invert: { filter: INVERT_FILTER, background: "#1f1f1f", inkColor: invertInkColor },
  // Ink stays as picked: every pen colour still reads on the dimmed paper.
  sepia: { filter: SEPIA_FILTER, background: "#e5cfaa" },
};

export function pageAppearance(filter: PageFilter, dark: boolean): PageAppearance {
  return dark && filter !== "normal" ? APPEARANCES[filter] : NORMAL;
}

/**
 * An ink colour as it shows over an inverted page: its lightness inverted as far as the page's
 * (black becomes light grey, white dark grey) while its hue and saturation stay, so a red pen stays
 * red and a black one reads like the page's text. Anything but #rgb or #rrggbb is left as it is.
 */
export function invertInkColor(color: string): string {
  const rgb = parseHex(color);
  if (!rgb) return color;
  const [h, s, l] = rgbToHsl(rgb);
  return toHex(hslToRgb([h, s, INVERT_AMOUNT * (1 - l) + (1 - INVERT_AMOUNT) * l]));
}

type Rgb = [number, number, number];

function parseHex(color: string): Rgb | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  const hex = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
}

function toHex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function rgbToHsl([r, g, b]: Rgb): Rgb {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb([h, s, l]: Rgb): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b]: Rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}

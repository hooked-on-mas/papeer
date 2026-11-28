import type { EditScope } from '../../../runtime/edits/ports';
import type { InkPreferenceValues } from '../inkEditor';

export interface InkPreferenceStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const inkPreferenceKey = (scope: EditScope) => `papeer.document-ink-preferences.v1:${JSON.stringify([scope.accountId, scope.libraryId, scope.epoch])}`;
const color = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const width = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1;

/** Accept only the finite preferences schema; editor/clipboard objects never cross this boundary. */
export function validateInkPreferences(input: unknown): InkPreferenceValues | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const original = input as Record<string, unknown>;
  // Earlier v1 records had no finger-ink choice. Preserve all preferences and
  // keep their existing no-finger-drawing behavior without rewriting on read.
  const value = 'fingerDraw' in original ? original : { ...original, fingerDraw: false };
  const keys = ['color', 'width', 'highColor', 'highWidth', 'straight', 'partial', 'eraserRadius', 'highlightOnly', 'fingerDraw', 'presets'];
  if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) return null;
  if (!color(value.color) || !color(value.highColor) || !width(value.width) || !width(value.highWidth)
    || typeof value.straight !== 'boolean' || typeof value.partial !== 'boolean' || typeof value.highlightOnly !== 'boolean' || typeof value.fingerDraw !== 'boolean'
    || ![5, 10, 20].includes(value.eraserRadius as number) || !Array.isArray(value.presets) || value.presets.length > 100
    || value.presets.some(preset => !preset || typeof preset !== 'object' || Array.isArray(preset)
      || Object.keys(preset).length !== 2 || !color(preset.color) || !width(preset.width))) return null;
  return structuredClone(value) as InkPreferenceValues;
}

export function pickInkPreferences(value: InkPreferenceValues): InkPreferenceValues {
  return { color: value.color, width: value.width, highColor: value.highColor, highWidth: value.highWidth,
    straight: value.straight, partial: value.partial, eraserRadius: value.eraserRadius,
    highlightOnly: value.highlightOnly, fingerDraw: value.fingerDraw, presets: structuredClone(value.presets) };
}

import type { EditScope } from '../../runtime/edits/ports.ts';
import { UI_SCALES } from '../../lib/uiScale.ts';

export type WorkspacePreference = { version: 1; theme: 'system' | 'light' | 'dark'; uiScale: number; catalogOpen: boolean; editorWidth: number; catalogHeight: number; sidebarWidth: number };
export const EDITOR_WIDTHS = [30, 40, 50, 60, 70] as const;
export const CATALOG_HEIGHTS = [25, 35, 45, 55, 65] as const;
export const SIDEBAR_WIDTHS = [240, 280, 320, 380] as const;
export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 560;
export interface WorkspacePreferencePort {
  readonly scope: EditScope;
  read(): unknown;
  write(value: WorkspacePreference): void;
}
const defaults: WorkspacePreference = { version: 1, theme: 'system', uiScale: 1, catalogOpen: true, editorWidth: 40, catalogHeight: 45, sidebarWidth: 280 };
const validSidebarWidth = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= MIN_SIDEBAR_WIDTH && value <= MAX_SIDEBAR_WIDTH;
export function workspacePreference(raw: unknown): WorkspacePreference {
  if (raw === null || raw === undefined) return { ...defaults };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('workspace-preference-invalid');
  const value = raw as Record<string, unknown>;
  const allowed = ['version', 'theme', 'uiScale', 'catalogOpen', 'editorWidth', 'catalogHeight', 'sidebarWidth'];
  if (Object.keys(value).some(key => !allowed.includes(key)) || value.version !== 1 || typeof value.theme !== 'string' || !['system', 'light', 'dark'].includes(value.theme)
    || !UI_SCALES.some(choice => choice.value === value.uiScale) || typeof value.catalogOpen !== 'boolean'
    || value.editorWidth !== undefined && !EDITOR_WIDTHS.some(choice => choice === value.editorWidth)
    || value.catalogHeight !== undefined && !CATALOG_HEIGHTS.some(choice => choice === value.catalogHeight)
    || value.sidebarWidth !== undefined && !validSidebarWidth(value.sidebarWidth)) throw new Error('workspace-preference-invalid');
  return { version: 1, theme: value.theme as WorkspacePreference['theme'], uiScale: value.uiScale as number, catalogOpen: value.catalogOpen,
    editorWidth: value.editorWidth as number ?? defaults.editorWidth, catalogHeight: value.catalogHeight as number ?? defaults.catalogHeight,
    sidebarWidth: value.sidebarWidth as number ?? defaults.sidebarWidth };
}

/** Disposable local display preferences. No content writer, journal, credentials or host storage. */
export class WorkspaceSession {
  readonly scope: Readonly<EditScope>;
  private readonly listeners = new Set<() => void>();
  private readonly persistence: WorkspacePreferencePort;
  private readonly active: () => boolean;
  private state: { value: Readonly<WorkspacePreference>; error: string; pending: boolean };
  constructor(persistence: WorkspacePreferencePort, active: () => boolean) {
    this.persistence = persistence; this.active = active;
    this.scope = Object.freeze({ ...persistence.scope });
    let value = { ...defaults }, error = '';
    try { value = workspacePreference(persistence.read()); } catch (cause) { error = String(cause); }
    this.state = Object.freeze({ value: Object.freeze(value), error, pending: false });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(value: WorkspacePreference, error: string, pending: boolean) {
    this.state = Object.freeze({ value: Object.freeze({ ...value }), error, pending });
    this.listeners.forEach(listener => listener());
  }
  private available() {
    return this.active() && this.scope.accountId === this.persistence.scope.accountId
      && this.scope.libraryId === this.persistence.scope.libraryId && this.scope.epoch === this.persistence.scope.epoch;
  }
  set = (patch: Partial<Omit<WorkspacePreference, 'version'>>): boolean => {
    if (!this.available()) return false;
    const value = workspacePreference({ ...this.state.value, ...patch });
    // Keep a failed preference in memory for an explicit retry, without blocking content editing.
    try { this.persistence.write({ ...value }); this.update(value, '', false); return true; }
    catch (cause) { this.update(value, String(cause), true); return false; }
  };
  retry = (): boolean => {
    if (!this.available()) return false;
    if (this.state.pending) return this.set({});
    try { this.update(workspacePreference(this.persistence.read()), '', false); return true; }
    catch (cause) { this.update({ ...this.state.value }, String(cause), false); return false; }
  };
}

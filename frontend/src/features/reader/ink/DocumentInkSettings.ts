import { SHAPE_KINDS, type InkTool } from '../../ink/inkGeometry.ts';
import type { InkPreferenceValues } from '../inkEditor';
import type { InkObject } from '../../../runtime/edits/contracts';
import type { EditScope } from '../../../runtime/edits/ports';
import type { CanonicalAnnotationMode } from '../annotations/CanonicalAnnotationEditor';
import { inkPreferenceKey, pickInkPreferences, validateInkPreferences, type InkPreferenceStorage } from './inkPreferencePersistence.ts';

type State = InkPreferenceValues & {
  tool: InkTool; mode: CanonicalAnnotationMode; lastPen: InkTool; lastShape: InkTool; lastRange: InkTool; version: number; listOpen: boolean;
  clipboard: { annotations: InkObject[]; sourceWidthPt: number };
  persistenceError: string | null;
};

/** One scope's tools and canonical clipboard outlive individual document views. */
export class DocumentInkSettings {
  readonly scope: EditScope;
  private storage: InkPreferenceStorage | null = null;
  constructor(scope: EditScope, storage: InkPreferenceStorage | null = null) {
    this.scope = Object.freeze({ ...scope });
    try {
      this.storage = storage;
      const raw = this.storage?.getItem(inkPreferenceKey(this.scope));
      if (raw != null) {
        const parsed = JSON.parse(raw) as { version?: unknown; preferences?: unknown };
        const preferences = parsed?.version === 1 && Object.keys(parsed).length === 2 ? validateInkPreferences(parsed.preferences) : null;
        if (!preferences) throw new Error('invalid-ink-preferences');
        this.state = { ...this.state, ...preferences };
      }
    } catch { this.state = { ...this.state, persistenceError: '書き込み設定を読み込めませんでした。初期設定で表示しています。' }; }
  }
  private state: State = { tool: 'pen', mode: 'ink', lastPen: 'pen', lastShape: 'rectangle', lastRange: 'region', version: 0, listOpen: false,
    color: '#dc2626', width: .003, highColor: '#facc15', highWidth: .025, straight: true, partial: false,
    eraserRadius: 10, highlightOnly: false, fingerDraw: false, presets: [], clipboard: { annotations: [], sourceWidthPt: 1 }, persistenceError: null };
  private listeners = new Set<() => void>();
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(fields: Partial<State>) { this.state = { ...this.state, ...fields }; this.listeners.forEach(listener => listener()); }
  setTool = (tool: InkTool) => this.update({ tool, mode: 'ink', version: this.state.version + 1,
    lastPen: ['pen', 'highlighter', ...SHAPE_KINDS].includes(tool) ? tool : this.state.lastPen,
    lastShape: SHAPE_KINDS.includes(tool) ? tool : this.state.lastShape,
    lastRange: ['region', 'lasso'].includes(tool) ? tool : this.state.lastRange });
  getVersion = () => this.state.version;
  setAnnotationMode = (mode: CanonicalAnnotationMode) => this.update({ mode, tool: 'select', version: this.state.version + 1 });
  setListOpen = (listOpen: boolean) => this.update({ listOpen });
  retryPersistence = () => {
    try {
      this.storage?.setItem(inkPreferenceKey(this.scope), JSON.stringify({ version: 1, preferences: pickInkPreferences(this.state) }));
      this.update({ persistenceError: null });
    } catch { this.update({ persistenceError: '書き込み設定をこの端末に保存できませんでした。現在の設定はこの画面に保持しています。' }); }
  };
  change = (values: Partial<InkPreferenceValues>) => {
    const preferences = validateInkPreferences({ ...pickInkPreferences(this.state), ...values });
    if (!preferences) { this.update({ persistenceError: '書き込み設定が不正なため変更できませんでした。' }); return; }
    this.update(preferences); this.retryPersistence();
  };
  put = (annotations: InkObject[], sourceWidthPt: number) => this.update({ clipboard: { annotations: structuredClone(annotations), sourceWidthPt } });
}

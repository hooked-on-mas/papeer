import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import type { LibraryScopeBinding } from '../reader/DocumentLibraryBinding';
import { EDITOR_WIDTHS, SIDEBAR_WIDTHS, WorkspaceSession, type WorkspacePreference } from './WorkspaceSession';
import { UI_SCALES, rootFontSize } from '../../lib/uiScale';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { NativeSelect } from '../../components/ui/native-select';
import { useWorkspaceFocusGuard } from './WorkspaceCommandContext';

const Context = createContext<WorkspaceSession | null>(null);
export const useWorkspacePreferences = () => useContext(Context);

export function WorkspacePreferencesProvider({ binding, children }: { binding: LibraryScopeBinding; children: ReactNode }) {
  const session = useMemo(() => binding.workspacePreferences ? new WorkspaceSession(binding.workspacePreferences, () => {
    const state = binding.sessions.getSnapshot(); return state.ready && state.active;
  }) : null, [binding.workspacePreferences, binding.sessions]);
  return <Context.Provider value={session}>{session && <WorkspaceAppearance session={session} />}{children}</Context.Provider>;
}
function WorkspaceAppearance({ session }: { session: WorkspaceSession }) {
  const { value } = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  useLayoutEffect(() => {
    const root = document.documentElement, theme = root.dataset.theme, size = root.style.fontSize;
    const width = root.style.getPropertyValue('--workspace-editor-width');
    const height = root.style.getPropertyValue('--workspace-catalog-height');
    const sidebar = root.style.getPropertyValue('--workspace-sidebar-width');
    root.dataset.theme = value.theme; root.style.fontSize = rootFontSize(value.uiScale);
    root.style.setProperty('--workspace-editor-width', `${value.editorWidth}%`);
    root.style.setProperty('--workspace-catalog-height', `${value.catalogHeight}vh`);
    root.style.setProperty('--workspace-sidebar-width', `${value.sidebarWidth}px`);
    return () => { if (theme === undefined) delete root.dataset.theme; else root.dataset.theme = theme; root.style.fontSize = size;
      if (width) root.style.setProperty('--workspace-editor-width', width); else root.style.removeProperty('--workspace-editor-width');
      if (height) root.style.setProperty('--workspace-catalog-height', height); else root.style.removeProperty('--workspace-catalog-height');
      if (sidebar) root.style.setProperty('--workspace-sidebar-width', sidebar); else root.style.removeProperty('--workspace-sidebar-width'); };
  }, [value.theme, value.uiScale, value.editorWidth, value.catalogHeight, value.sidebarWidth]);
  return null;
}
export function WorkspaceSettings() {
  const session = useWorkspacePreferences();
  return session ? <WorkspaceSettingsView session={session} /> : <NoWorkspaceSettings />;
}
function NoWorkspaceSettings() { useWorkspaceFocusGuard('settings', () => true); return null; }
function WorkspaceSettingsView({ session }: { session: WorkspaceSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [open, setOpen] = useState(false);
  const openRef = useRef(false); openRef.current = open;
  const changeOpen = (value: boolean) => { openRef.current = value; setOpen(value); };
  useWorkspaceFocusGuard('settings', () => !openRef.current);
  const currentSidebar = state.value.sidebarWidth;
  const sidebarOptions = SIDEBAR_WIDTHS.some(width => width === currentSidebar)
    ? [...SIDEBAR_WIDTHS]
    : [...SIDEBAR_WIDTHS, currentSidebar].sort((a, b) => a - b);
  return <div className="flex shrink-0 items-center gap-1.5">
    <Button type="button" variant="ghost" size="sm" aria-label="表示設定" title="表示設定" onClick={() => changeOpen(true)}>
      <SlidersHorizontal className="size-4" />
      <span className="hidden sm:inline">表示設定</span>
    </Button>
    {state.error && <span role="status" className="text-xs text-destructive">表示設定を保存・読込できません。<Button type="button" variant="link" size="xs" onClick={() => session.retry()}>表示設定を再試行</Button></span>}
    <Dialog open={open} onOpenChange={changeOpen}><DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>このライブラリの表示設定</DialogTitle>
        <DialogDescription>表示設定は、この端末のライブラリごとに保存します。</DialogDescription>
      </DialogHeader>
      <div className="grid gap-3 py-1 text-sm">
        <label className="grid grid-cols-[8.5rem_1fr] items-center gap-3">
          <span className="text-muted-foreground">配色</span>
          <NativeSelect aria-label="配色" value={state.value.theme} onChange={event => session.set({ theme: event.target.value as WorkspacePreference['theme'] })}>
            <option value="system">端末に合わせる</option><option value="light">ライト</option><option value="dark">ダーク</option>
          </NativeSelect>
        </label>
        <label className="grid grid-cols-[8.5rem_1fr] items-center gap-3">
          <span className="text-muted-foreground">文字の大きさ</span>
          <NativeSelect aria-label="文字の大きさ" value={state.value.uiScale} onChange={event => session.set({ uiScale: Number(event.target.value) })}>
            {UI_SCALES.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
          </NativeSelect>
        </label>
        <label className="grid grid-cols-[8.5rem_1fr] items-center gap-3">
          <span className="text-muted-foreground">サイドバーの幅</span>
          <NativeSelect aria-label="サイドバーの幅" value={state.value.sidebarWidth} onChange={event => session.set({ sidebarWidth: Number(event.target.value) })}>
            {sidebarOptions.map(width => <option key={width} value={width}>{width}px</option>)}
          </NativeSelect>
        </label>
        <label className="grid grid-cols-[8.5rem_1fr] items-center gap-3">
          <span className="text-muted-foreground">右側の編集幅</span>
          <NativeSelect aria-label="右側の編集幅" value={state.value.editorWidth} onChange={event => session.set({ editorWidth: Number(event.target.value) })}>
            {EDITOR_WIDTHS.map(width => <option key={width} value={width}>{width}%</option>)}
          </NativeSelect>
        </label>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => changeOpen(false)}>表示設定を閉じる</Button>
      </DialogFooter>
    </DialogContent></Dialog>
  </div>;
}

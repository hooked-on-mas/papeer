import { NotebookDialogs, newNotebook } from "@/features/notebooks/NotebookDialogs";
import { ItemLinkDialog } from "@/features/library/ItemLinkDialog";
import { useSettingsNavigation } from "../features/settings/settingsNavigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { FilePlus2, NotebookPen, Settings2 } from "lucide-react";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { WorkspaceRoot, WorkspaceSidebar, WorkspaceLibraryPanel, WorkspaceRail, WorkspaceTabList } from "@/components/WorkspaceChrome";
import { Tabs, TabsContent, TabsTrigger } from "@/components/ui/tabs";
import { api, unwrap } from "@/api/client";
import { showToast } from "@/components/toast";
import { usePaper } from "@/api/hooks";
import { itemCapabilities, tabAvailable } from "@/lib/itemKinds";
import { AppDialogs, askConfirm } from "@/components/AppDialogs";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { lazyComponent } from "@/components/LazyPanel";
import { whenIdle } from "@/lib/lazyLoader";
import { isRunning, useStore } from "../store";
import { anyJobRunning } from "@/features/jobs/jobSelectors";
import { Header, TranslationDialogHost } from "./Header";
import { StatusBar } from "./StatusBar";
import { StartupReader } from "./StartupReader";
import { ConnectionBanner } from "@/features/jobs/ConnectionBanner";
import { LibrarySidebar } from "../features/library/LibrarySidebar";
import { ReaderTab, useSidePanelOpen } from "./ReaderArea";
import { ChatPane, NotesPane, SummaryPane, ReferencesPane } from "./lazyPanes";
import { StickyNotesTab } from "../features/reader/StickyNotesTab";
import { StickyNoteDialog } from "../features/reader/StickyNoteDialog";
import { PaperDetailsPanel } from "../features/notes/PaperDetailsPanel";
import { OrganizeDialogHost } from "../features/library/OrganizeDialog";
import { DriveSyncHost } from "../features/settings/DriveSection";
import { CloudDriveHost } from "../features/settings/CloudDriveSection";
import { SettingsVersionNotice } from "../features/settings/VersionNoticeHost";
import { syncDrive } from "../features/settings/driveSync";
import { fetchDriveStatus, fetchSyncCheck } from "../features/settings/driveApi";
import { useJobEvents } from "../features/jobs/jobEvents";
import { changeZoom, focusPageInput, movePage, resetZoom } from "../features/reader/navigation";
import { createFolder, importPdfs, renameFolder, renamePaperFile } from "./actions";
import { normalizeCollection } from "@/lib/collectionPath";
import { useDropTarget, useFileDrop } from "./fileDrop";
import { flushUiState, initUiStateSync } from "./uiStateSync";
import { initPaperOpenedTracking } from "./paperOpened";
import { describeFailure, discardHeldDrafts, flushPendingSaves, heldDraftDescriptions } from "@/lib/pendingSaves";
import { isAppClosing, setAppClosing } from "./appClosing";
import { emitAppEvent, onAppEvent } from "@/lib/appEvents";
import { isJobKind, SNAPSHOT_JOBS } from "@/features/jobs/jobKinds";
import { registerAllJobHandlers } from "./jobHandlers";
import { ReferenceReturnBar } from "@/features/references/researchNavigation";
import { withShortcutLabels } from "@/lib/platform";

const TABS = ["reader", "summary", "chat", "notes", "sticky-notes", "references"];

// Split from the initial bundle like the panes in ./lazyPanes; loaded when first opened, or once the app is idle.
const SettingsDialog = lazyComponent(() => import("../features/settings/SettingsDialog").then((m) => m.SettingsDialog), {
  loading: () => null,
  failed: ({ open, onOpenChange }, retry) => (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>接続・設定を開けませんでした</DialogTitle>
          <DialogDescription>繰り返す場合はアプリを再起動してください。</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>閉じる</Button>
          <Button onClick={retry}>再試行</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
});

async function waitForJobs(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const jobs = await unwrap(api.GET("/api/jobs"));
      if (!jobs.some((j) => j.running)) return;
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

registerAllJobHandlers();

/**
 * The confirmation before closing goes ahead of any question already on screen (lib/dialogQueue.ts),
 * and pressing close again while it is up does not ask a second time (that press is ignored).
 */
const CLOSE_QUESTION = { key: "app-close", urgent: true } as const;

function useCloseHandling(): void {
  useEffect(() => {
    // @ts-ignore injected by Tauri
    if (window.__TAURI_INTERNALS__ === undefined) return;
    const unlisteners: Array<() => void> = [];

    // Saving and asking before anything is stopped may take a while: a second press waits for the first.
    let preparing = false;
    const handleClose = async () => {
      if (isAppClosing() || preparing) return;
      preparing = true;
      try {
        await closeApp();
      } finally {
        preparing = false;
      }
    };

    const closeApp = async () => {
      // Saved, and asked about, before any job is stopped: calling the closing off here leaves them running.
      const saveFailure = await flushPendingSaves();
      if (saveFailure) {
        showToast({ title: "終了を中止しました", description: describeFailure(saveFailure), tone: "error", timeout: 0 });
        return;
      }
      // Values that cannot be saved as they are (論文情報): the library keeps what was saved before.
      const held = heldDraftDescriptions();
      if (held.length && !await askConfirm("保存できない入力があります",
        `次の入力は保存できないため、保存済みの内容のままです。\n\n${held.join("\n\n")}\n\n直す場合は「キャンセル」を押し、「論文情報・整理」で直すか元に戻してください。`,
        "入力を破棄して終了", true, CLOSE_QUESTION)) return;
      const running = useStore.getState().activeJobs.filter(isRunning);
      const snapshot = running.some(job => isJobKind(job.kind, SNAPSHOT_JOBS));
      if (snapshot) {
        const ok = await askConfirm("同期・バックアップ中",
          "同期・バックアップ・復元を中止して終了しますか？\n作りかけのデータは破棄します。ライブラリのフォルダーの入れ替えが始まっている場合は、完了してから終了します。",
          "中止して終了", true, CLOSE_QUESTION);
        if (!ok) return;
      } else if (running.length) {
        const ok = await askConfirm("処理中",
          `実行中の処理が${running.length}件あります。中止して終了しますか？\n翻訳済みのページは保存されており、次回再開できます。`,
          "中止して終了", true, CLOSE_QUESTION);
        if (!ok) return;
      }
      // Only once every question is answered: calling the closing off keeps what was typed.
      if (held.length) discardHeldDrafts();
      setAppClosing(true);
      if (running.length) {
        useStore.getState().setStatus("処理を中止しています…終了まで少しお待ちください。");
        await unwrap(api.POST("/api/jobs/cancel-all")).catch(() => undefined);
        // Let CLI subprocesses stop before the sidecar exits (/shutdown also waits, for a while longer).
        await waitForJobs(15_000);
      }
      // Again: what was typed meanwhile, and what the stopped jobs left.
      const failure = await flushPendingSaves();
      if (failure) {
        setAppClosing(false);
        useStore.getState().setStatus(""); // 「処理を中止しています…」 no longer holds.
        showToast({ title: "終了を中止しました", description: describeFailure(failure), tone: "error", timeout: 0 });
        return;
      }
      await flushUiState();
      // Syncing right after the user stopped a sync (or a backup) would only start it over; the next launch syncs.
      if (!snapshot) {
        try {
          const drive = await fetchDriveStatus();
          // Like the automatic sync: not while a review waits for the user, nor over a missing data folder.
          // Unchanged since the last sync (drive_sync.check): closing need not hash and copy the library.
          const check = drive.connected && drive.auto_sync && !drive.review && !drive.library_missing
            && await fetchSyncCheck();
          if (check && check.action !== "none" && await syncDrive()) {
            setAppClosing(false);
            return;
          }
        } catch {
          if (!await askConfirm("同期フォルダーを更新できませんでした", "変更はこのPCに保存されています。同期せずに終了しますか？", "同期せず終了")) {
            setAppClosing(false);
            return;
          }
        }
      }
      useStore.getState().setStatus("終了しています…");
      try {
        // Answers once the sidecar's jobs have stopped; the sidecar then exits by itself and Tauri
        // waits for that before the app ends (killing it is the last resort, src-tauri/src/sidecar.rs).
        await unwrap(api.POST("/shutdown"));
      } catch {
        // The sidecar may already be gone.
      }
      // Tauri may still wait a moment for the sidecar to end; a window left on screen would look frozen.
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().hide().catch(() => undefined);
      const { exit } = await import("@tauri-apps/plugin-process");
      await exit(0);
    };

    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      getCurrentWindow().onCloseRequested(async (event) => {
        event.preventDefault();
        await handleClose();
      }).then((unlisten) => unlisteners.push(unlisten));
    });
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen("tray-quit-requested", handleClose).then((unlisten) => unlisteners.push(unlisten));
    });
    return () => unlisteners.forEach((unlisten) => unlisten());
  }, []);
}

/**
 * The webview's own zoom stays enabled only so touchpad pinch reaches the page as Ctrl+wheel
 * (the reader turns it into PDF zoom); everywhere else it must not scale the whole app.
 * The app's own size is 設定「表示」の文字の大きさ (app/uiScale.ts), which scales the UI but not the PDF;
 * it has no shortcut, since Ctrl + / Ctrl − / Ctrl 0 are the PDF zoom.
 */
function useBlockWebviewZoom(): void {
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && ["+", "-", "=", "0", ";"].includes(e.key)) e.preventDefault();
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
}

function Lightbox() {
  const [image, setImage] = useState<{ src: string; alt?: string } | null>(null);
  useEffect(() => {
    return onAppEvent("open-lightbox", setImage);
  }, []);
  useHotkeys("esc", () => setImage(null), { enabled: !!image });
  if (!image) return null;
  return (
    <div data-lightbox className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-8 cursor-zoom-out" onClick={() => setImage(null)}>
      {/* Light paper behind images with transparency, which are usually drawn for white pages;
          slightly dimmed under the dark theme. */}
      <img src={image.src} alt={image.alt} className="max-w-full max-h-full bg-white dark:bg-neutral-200 rounded shadow-2xl" />
    </div>
  );
}

function DropOverlay() {
  const { active, target } = useDropTarget();
  const currentCollection = useStore((s) => s.currentCollection);
  if (!active) return null;
  const destination = target ?? currentCollection;
  return (
    <div className="pointer-events-none fixed inset-2 z-40 rounded-xl border-2 border-dashed border-primary/60 bg-primary/5 flex items-end justify-center pb-10">
      <div className="rounded-lg bg-card border shadow px-4 py-2 text-[0.8125rem]">
        ここにドロップして追加（追加先：{destination || "未分類"}）
      </div>
    </div>
  );
}

export function AppShell() {
  const activeTab = useStore((s) => s.activeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  // Changing defaultSize during a drag re-registers the panel and interrupts resizing.
  // The group retains layouts when panels are hidden; only read saved defaults at mount.
  const [sidebarWidth] = useState(() => useStore.getState().sidebarWidth);
  const focusMode = useStore((s) => s.focusMode);
  const sidePanelOpen = useSidePanelOpen();
  const activePaperId = useStore((s) => s.activePaperId);
  const uiStateLoaded = useStore((s) => s.uiStateLoaded);
  const anyRunning = useStore((s) => anyJobRunning(s.activeJobs));
  // Passages attached from the reader, waiting to be sent.
  const attachmentCount = useStore((s) => s.chatAttachments.filter((item) => item.paperId === s.activePaperId).length);
  const isSettingsOpen = useSettingsNavigation(s => s.open);
  const setIsSettingsOpen = useSettingsNavigation(s => s.setOpen);
  // Mounted from the first opening on, so that it can play its closing animation.
  const [settingsMounted, setSettingsMounted] = useState(isSettingsOpen);
  if (isSettingsOpen && !settingsMounted) setSettingsMounted(true);
  const { data: activePaper, error: activePaperError } = usePaper(activePaperId);
  const lastCollectionPaper = useRef<string | null>(null);
  // What the open item can do (see lib/itemKinds.ts): the tabs of what it cannot are not offered. A tab
  // it has none of, left open from the previous paper, gives way to the reader.
  const caps = itemCapabilities(activePaper);
  const shownTab = tabAvailable(caps, activeTab) ? activeTab : "reader";
  useLayoutEffect(() => {
    if (shownTab !== activeTab) useStore.getState().setActiveTab(shownTab);
  }, [shownTab, activeTab]);

  useEffect(() => initUiStateSync(), []);
  useEffect(() => initPaperOpenedTracking(), []);

  useEffect(() => whenIdle(() => {
    for (const component of [SummaryPane, ChatPane, NotesPane, SettingsDialog]) component.preload();
  }), []);

  useJobEvents();
  useFileDrop();
  useCloseHandling();
  useBlockWebviewZoom();

  // macOS: 「Papeer → 設定…」 in the menu bar (src-tauri/src/lib.rs).
  useEffect(() => {
    // @ts-ignore injected by Tauri
    if (window.__TAURI_INTERNALS__ === undefined) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen("open-settings-requested", () => setIsSettingsOpen(true)))
      .then((u) => { if (disposed) u(); else unlisten = u; });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [setIsSettingsOpen]);

  // Opening a paper makes its folder the 追加先, as selecting it in the old tree did.
  useEffect(() => {
    if (!activePaper || lastCollectionPaper.current === activePaper.id) return;
    lastCollectionPaper.current = activePaper.id;
    const store = useStore.getState();
    if (store.selectedFolder === null) store.setCurrentCollection(normalizeCollection(activePaper.collection_name || ""));
  }, [activePaper]);

  // A paper removed outside this window (or a stale last_paper) cannot be reopened.
  useEffect(() => {
    if (activePaperId && activePaperError) {
      useStore.getState().setActivePaperId(null);
      useStore.getState().setStatus("前回のPDFを開けませんでした。ライブラリから選択してください。");
    }
  }, [activePaperId, activePaperError]);

  const showSidebar = () => {
    const store = useStore.getState();
    if (store.focusMode) store.setFocusMode(false);
    if (store.sidebarCollapsed) store.setSidebarCollapsed(false);
  };

  const focusSearch = () => {
    showSidebar();
    setTimeout(() => {
      const input = document.getElementById("library-search") as HTMLInputElement | null;
      input?.focus();
      input?.select();
    }, 50);
  };

  const hotkeyOptions = { preventDefault: true, enableOnFormTags: false } as const;
  // F11 on Windows and Linux; ⌃⌘F on macOS, where F11 shows the desktop (lib/platform.ts).
  useHotkeys("f11, ctrl+meta+f", () => useStore.getState().setFocusMode(!useStore.getState().focusMode), { preventDefault: true });
  useHotkeys("esc", () => {
    // Esc in a dialog or enlarged image closes it without leaving focus mode.
    if (!document.querySelector("[data-lightbox], [role='dialog']")) useStore.getState().setFocusMode(false);
  }, { enabled: focusMode });
  useHotkeys("ctrl+o, meta+o", () => importPdfs(), { preventDefault: true, enableOnFormTags: true });
  useHotkeys("ctrl+f, meta+f", () => {
    if (useStore.getState().activeTab === "reader" && useStore.getState().activePaperId)
      emitAppEvent("open-reader-search");
    else if (useStore.getState().activeTab === "sticky-notes") document.getElementById("sticky-note-search")?.focus();
    else focusSearch();
  }, { preventDefault: true, enableOnFormTags: true });
  useHotkeys("ctrl+shift+f, meta+shift+f", focusSearch, { preventDefault: true, enableOnFormTags: true });
  useHotkeys("ctrl+l, meta+l", () => {
    // Move the keys to the library tree: the row they were on, or else the open paper (revealed in its
    // folder). The search's results replace the tree, so the search is cleared.
    const store = useStore.getState();
    const hidden = store.focusMode || store.sidebarCollapsed;
    showSidebar();
    store.setLibrarySearch("");
    // A sidebar being shown again needs a moment to mount and listen.
    setTimeout(() => emitAppEvent("focus-library"), hidden ? 300 : 0);
  }, { preventDefault: true, enableOnFormTags: true });
  useHotkeys("ctrl+g, meta+g", focusPageInput, { preventDefault: true, enableOnFormTags: true });
  useHotkeys("ctrl+b, meta+b", () => {
    const store = useStore.getState();
    store.setSidebarCollapsed(!store.sidebarCollapsed);
  }, hotkeyOptions);
  useHotkeys("ctrl+t, meta+t", () => emitAppEvent("open-translate-dialog"), hotkeyOptions);
  // ⌘, is the Mac's key for an app's settings (its menu bar has 「設定…」 as well, src-tauri/src/lib.rs).
  useHotkeys("ctrl+comma, meta+comma", () => setIsSettingsOpen(true), { preventDefault: true, enableOnFormTags: true });
  useHotkeys("f2", () => {
    const store = useStore.getState();
    if (store.selectedFolder) renameFolder(store.selectedFolder);
    else if (store.activePaperId && caps.rename) {
      // A notebook is renamed in its title when the header shows it; the dialog is for the rest.
      if (caps.notebook && !store.focusMode) emitAppEvent("edit-item-title");
      else renamePaperFile(store.activePaperId);
    }
  }, hotkeyOptions);
  useHotkeys("ctrl+shift+n, meta+shift+n", () => {
    const store = useStore.getState();
    createFolder(store.selectedFolder ?? store.currentCollection);
  }, hotkeyOptions);
  // Ctrl+Alt+N makes a notebook in the 追加先; Ctrl+Shift+N is the folder's. Not over another dialog.
  useHotkeys("ctrl+alt+n, meta+alt+n", () => {
    if (!document.querySelector("[role='dialog']")) newNotebook();
  }, hotkeyOptions);
  // Not in the library tree, whose ←→ open and close folders, and move a paper dragged with the keyboard.
  const pageKeyOptions = { ...hotkeyOptions, ignoreEventWhen: (e: KeyboardEvent) => e.target instanceof Element && !!e.target.closest("[role=tree]") };
  useHotkeys("left", () => { if (useStore.getState().activeTab === "reader") movePage(-1); }, pageKeyOptions);
  useHotkeys("right", () => { if (useStore.getState().activeTab === "reader") movePage(1); }, pageKeyOptions);
  // Key names follow KeyboardEvent.code; Ctrl+; / Ctrl+Shift+; is "+" on Japanese keyboards.
  useHotkeys("ctrl+equal, meta+equal, ctrl+add, meta+add, ctrl+semicolon, meta+semicolon, ctrl+shift+semicolon, meta+shift+semicolon, ctrl+shift+equal, meta+shift+equal",
    () => changeZoom(1), hotkeyOptions);
  useHotkeys("ctrl+minus, meta+minus, ctrl+subtract, meta+subtract", () => changeZoom(-1), hotkeyOptions);
  useHotkeys("ctrl+0, meta+0", () => resetZoom(), hotkeyOptions);
  useHotkeys("ctrl+1, ctrl+2, ctrl+3, ctrl+4, ctrl+5, ctrl+6, meta+1, meta+2, meta+3, meta+4, meta+5, meta+6", (_e, handler) => {
    // The digit alone: handler.keys holds no modifier.
    const tab = TABS[Number(handler.keys?.join("")) - 1];
    if (!tab || !tabAvailable(caps, tab)) return;
    const store = useStore.getState();
    // In focus mode Ctrl+1, or the open panel's own key, closes the side panel.
    if (store.focusMode && (tab === "reader" || store.sidePanel === tab)) store.setSidePanel(null);
    else setActiveTab(tab);
  }, hotkeyOptions);

  return (
    <WorkspaceRoot>
      <ConnectionBanner />
      <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0">
        {!focusMode && !sidebarCollapsed && (
          <>
            <WorkspaceLibraryPanel width={sidebarWidth} onWidthChange={width => useStore.getState().setSidebarWidth(width)}>
              <WorkspaceSidebar onCollapse={() => useStore.getState().setSidebarCollapsed(true)}
                collapseTitle={withShortcutLabels("左パネルを閉じる（Ctrl+B）")} footer={<button
                  className="h-10 border-t flex items-center gap-2 px-4 shrink-0 text-[0.8125rem] hover:bg-muted/50 transition-colors text-left"
                  onClick={() => setIsSettingsOpen(true)}>
                  <Settings2 className="w-4 h-4 text-muted-foreground" /> 接続・設定
                </button>}>
                <LibrarySidebar />
              </WorkspaceSidebar>
            </WorkspaceLibraryPanel>
            <ResizableHandle className="w-1 bg-border hover:bg-primary/60 transition-colors cursor-col-resize" />
          </>
        )}

        {!focusMode && sidebarCollapsed && (
          <WorkspaceRail title={withShortcutLabels("ライブラリを表示（Ctrl+B）")} onExpand={() => useStore.getState().setSidebarCollapsed(false)}>
            <button className="w-8 h-8 flex items-center justify-center hover:bg-muted rounded" title={withShortcutLabels("PDFを追加（Ctrl+O）")} onClick={importPdfs}>
              <FilePlus2 className="w-4 h-4 text-muted-foreground" />
            </button>
            <button aria-label="ノートを作る" title={withShortcutLabels("ノートを作る（Ctrl+Alt+N）")} className="w-8 h-8 flex items-center justify-center hover:bg-muted rounded" onClick={() => newNotebook()}><NotebookPen className="size-4 text-muted-foreground" /></button>
            <button className="mt-auto w-8 h-8 flex items-center justify-center hover:bg-muted rounded" title="接続・設定"
              onClick={() => setIsSettingsOpen(true)}>
              <Settings2 className="w-4 h-4 text-muted-foreground" />
            </button>
          </WorkspaceRail>
        )}

        {/* Room for the reader and the side panel within it (320px each) when the panel is open. */}
        <ResizablePanel id="main" minSize={focusMode ? "320px" : sidePanelOpen ? "644px" : "480px"} className="flex flex-col min-w-0 bg-background">
          {!focusMode && <Header />}
          <ReferenceReturnBar />

          <Tabs value={shownTab} onValueChange={(value) => setActiveTab(String(value))} className="flex-1 flex flex-col min-h-0 gap-0">
            <WorkspaceTabList hidden={focusMode}>
                <TabsTrigger value="reader" title={withShortcutLabels("Ctrl+1")}>{caps.notebook ? "ノート" : "本文"}</TabsTrigger>
                {tabAvailable(caps, "summary") && <TabsTrigger value="summary" title={withShortcutLabels("Ctrl+2")}>サマリー</TabsTrigger>}
                {tabAvailable(caps, "chat") && <TabsTrigger value="chat" title={withShortcutLabels("Ctrl+3")}>
                  チャット
                  {attachmentCount > 0 && (
                    <span className="min-w-4 rounded-full bg-primary px-1 text-[0.75rem] leading-4 text-primary-foreground" title={`添付 ${attachmentCount} 件`}>
                      {attachmentCount}
                    </span>
                  )}
                </TabsTrigger>}
                {tabAvailable(caps, "notes") && <TabsTrigger value="notes" title={withShortcutLabels("Ctrl+4")}>メモ</TabsTrigger>}
                {tabAvailable(caps, "sticky-notes") && <TabsTrigger value="sticky-notes" title={withShortcutLabels("Ctrl+5")}>付箋</TabsTrigger>}
                {tabAvailable(caps, "references") && <TabsTrigger value="references" title={withShortcutLabels("Ctrl+6")}>論文マップ</TabsTrigger>}
            </WorkspaceTabList>

            <div className="relative flex-1 flex flex-col min-h-0">
              {!activePaperId && !uiStateLoaded ? <StartupReader /> : (
                <>
                  {/* Kept at the same tree position so that focus mode reuses the loaded PDFs. */}
                  <ReaderTab />
                  {/* The others unmount with their tab in the same update, never lingering beside the same
                      pane opened in the side panel (see features/reader/sidePanel.ts). */}
                  <TabsContent value="summary" className="flex-1 p-0 m-0 overflow-hidden outline-none flex data-hidden:hidden min-h-0">
                    {shownTab === "summary" && <SummaryPane />}
                  </TabsContent>
                  <TabsContent value="chat" className="flex-1 p-0 m-0 overflow-hidden outline-none flex data-hidden:hidden min-h-0">
                    {shownTab === "chat" && <ChatPane />}
                  </TabsContent>
                  <TabsContent value="notes" className="flex-1 p-0 m-0 overflow-hidden outline-none flex data-hidden:hidden min-h-0">
                    {shownTab === "notes" && <NotesPane />}
                  </TabsContent>
                  <TabsContent value="sticky-notes" className="flex-1 p-0 m-0 overflow-hidden outline-none flex data-hidden:hidden min-h-0">
                    {shownTab === "sticky-notes" && <StickyNotesTab />}
                  </TabsContent>
                  <TabsContent value="references" className="flex-1 p-0 m-0 overflow-hidden outline-none flex data-hidden:hidden min-h-0">
                    {shownTab === "references" && <ReferencesPane />}
                  </TabsContent>
                </>
              )}
            </div>
          </Tabs>
        </ResizablePanel>
      </ResizablePanelGroup>

      {(!focusMode || anyRunning) && <StatusBar />}
      {settingsMounted && <SettingsDialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen} />}
      <DriveSyncHost />
      <CloudDriveHost />
      <SettingsVersionNotice />
      <StickyNoteDialog />
      <PaperDetailsPanel />
      <OrganizeDialogHost />
      <NotebookDialogs />
      <ItemLinkDialog />
      <AppDialogs />
      <Lightbox />
      <TranslationDialogHost />
      <DropOverlay />
    </WorkspaceRoot>
  );
}

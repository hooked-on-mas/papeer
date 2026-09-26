import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useHotkeys } from "react-hotkeys-hook";
import { FileText, FilePlus2, Settings2 } from "lucide-react";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiRequest } from "@/api/client";
import { usePaper } from "@/api/hooks";
import { AppDialogs, askConfirm } from "@/components/AppDialogs";
import { isRunning, useStore } from "../store";
import { Header } from "./Header";
import { StatusBar } from "./StatusBar";
import { LibrarySidebar } from "../features/library/LibrarySidebar";
import { Reader } from "../features/reader/Reader";
import { SummaryPane } from "../features/summary/SummaryPane";
import { ChatPane } from "../features/chat/ChatPane";
import { NotesPane, pendingNoteSaves } from "../features/notes/NotesPane";
import { SettingsDialog } from "../features/settings/SettingsDialog";
import { useJobEvents } from "../features/jobs/jobEvents";
import { bindReaderQueryClient, changeZoom, focusPageInput, movePage } from "../features/reader/navigation";
import { bindQueryClient, createFolder, importPdfs, normalizeCollection, renameFolder, renamePaperFile } from "./actions";
import { useDropTarget, useFileDrop } from "./fileDrop";
import { flushUiState, initUiStateSync } from "./uiStateSync";

const TABS = ["reader", "summary", "chat", "notes"];

async function waitForJobs(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const jobs = await apiRequest<{ running: boolean }[]>("GET", "/api/jobs");
      if (!jobs.some((j) => j.running)) return;
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

function useCloseHandling(): void {
  useEffect(() => {
    // @ts-ignore injected by Tauri
    if (window.__TAURI_INTERNALS__ === undefined) return;
    const unlisteners: Array<() => void> = [];
    let closing = false;

    const handleClose = async () => {
      if (closing) return;
      const running = useStore.getState().activeJobs.filter(isRunning);
      if (running.length) {
        const ok = await askConfirm("処理中",
          `実行中の処理が${running.length}件あります。中止して終了しますか？\n翻訳済みのページは保存されており、次回再開できます。`,
          "中止して終了", true);
        if (!ok) return;
      }
      closing = true;
      if (running.length) {
        useStore.getState().setStatus("処理を中止しています…終了まで少しお待ちください。");
        await apiRequest("POST", "/api/jobs/cancel-all").catch(() => undefined);
        // Let CLI subprocesses stop before the sidecar exits.
        await waitForJobs(15_000);
      }
      await Promise.all([...pendingNoteSaves].map((save) => save().catch(() => undefined)));
      await flushUiState();
      try {
        await apiRequest("POST", "/shutdown");
      } catch {
        // The sidecar may already be gone.
      }
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
    const open = (e: Event) => setImage((e as CustomEvent).detail);
    window.addEventListener("open-lightbox", open);
    return () => window.removeEventListener("open-lightbox", open);
  }, []);
  useHotkeys("esc", () => setImage(null), { enabled: !!image });
  if (!image) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-8 cursor-zoom-out" onClick={() => setImage(null)}>
      <img src={image.src} alt={image.alt} className="max-w-full max-h-full bg-white rounded shadow-2xl" />
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
      <div className="rounded-lg bg-card border shadow px-4 py-2 text-[13px]">
        ここにドロップして追加（追加先：{destination || "未分類"}）
      </div>
    </div>
  );
}

export function AppShell() {
  const activeTab = useStore((s) => s.activeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const focusMode = useStore((s) => s.focusMode);
  const focusPanel = useStore((s) => s.focusPanel);
  const focusPanelWidth = useStore((s) => s.focusPanelWidth);
  const activePaperId = useStore((s) => s.activePaperId);
  const activeJobs = useStore((s) => s.activeJobs);
  // Passages attached from the reader, waiting to be sent.
  const attachmentCount = useStore((s) => s.chatAttachments.filter((item) => item.paperId === s.activePaperId).length);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const queryClient = useQueryClient();
  const { data: activePaper, error: activePaperError } = usePaper(activePaperId);
  const lastCollectionPaper = useRef<string | null>(null);

  useEffect(() => {
    bindQueryClient(queryClient);
    bindReaderQueryClient(queryClient);
  }, [queryClient]);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    initUiStateSync().then((d) => { dispose = d; });
    return () => dispose?.();
  }, []);

  useJobEvents();
  useFileDrop();
  useCloseHandling();
  useBlockWebviewZoom();

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
  useHotkeys("f11", () => useStore.getState().setFocusMode(!useStore.getState().focusMode), { preventDefault: true });
  useHotkeys("esc", () => useStore.getState().setFocusMode(false), { enabled: focusMode });
  useHotkeys("ctrl+o, meta+o", () => importPdfs(), { preventDefault: true, enableOnFormTags: true });
  useHotkeys("ctrl+f, meta+f", () => {
    if (useStore.getState().activeTab === "reader" && useStore.getState().activePaperId)
      window.dispatchEvent(new Event("open-reader-search"));
    else focusSearch();
  }, { preventDefault: true, enableOnFormTags: true });
  useHotkeys("ctrl+shift+f, meta+shift+f", focusSearch, { preventDefault: true, enableOnFormTags: true });
  useHotkeys("ctrl+l, meta+l", () => {
    // Reveal the open paper in the library, clearing any search that hides it.
    focusSearch();
    const store = useStore.getState();
    if (!store.activePaperId) return;
    store.setLibrarySearch("");
    store.setSelectedFolder(null);
    const paperId = store.activePaperId;
    setTimeout(() => window.dispatchEvent(new CustomEvent("reveal-paper", { detail: { paperId, focus: true } })), 300);
  }, { preventDefault: true, enableOnFormTags: true });
  useHotkeys("ctrl+g, meta+g", focusPageInput, { preventDefault: true, enableOnFormTags: true });
  useHotkeys("ctrl+b, meta+b", () => {
    const store = useStore.getState();
    store.setSidebarCollapsed(!store.sidebarCollapsed);
  }, hotkeyOptions);
  useHotkeys("ctrl+t, meta+t", () => window.dispatchEvent(new Event("open-translate-dialog")), hotkeyOptions);
  useHotkeys("f2", () => {
    const store = useStore.getState();
    if (store.selectedFolder) renameFolder(store.selectedFolder);
    else if (store.activePaperId) renamePaperFile(store.activePaperId);
  }, hotkeyOptions);
  useHotkeys("ctrl+shift+n, meta+shift+n", () => {
    const store = useStore.getState();
    createFolder(store.selectedFolder ?? store.currentCollection);
  }, hotkeyOptions);
  useHotkeys("left", () => { if (useStore.getState().activeTab === "reader") movePage(-1); }, hotkeyOptions);
  useHotkeys("right", () => { if (useStore.getState().activeTab === "reader") movePage(1); }, hotkeyOptions);
  // Key names follow KeyboardEvent.code; Ctrl+; / Ctrl+Shift+; is "+" on Japanese keyboards.
  useHotkeys("ctrl+equal, meta+equal, ctrl+add, ctrl+semicolon, ctrl+shift+semicolon, ctrl+shift+equal", () => changeZoom(1), hotkeyOptions);
  useHotkeys("ctrl+minus, meta+minus, ctrl+subtract", () => changeZoom(-1), hotkeyOptions);
  useHotkeys("ctrl+0, meta+0", () => useStore.getState().setZoom(1), hotkeyOptions);
  useHotkeys("ctrl+1, ctrl+2, ctrl+3, ctrl+4", (_e, handler) => {
    const tab = TABS[Number(handler.keys?.join("")) - 1];
    if (!tab) return;
    const store = useStore.getState();
    // In focus mode Ctrl+1, or the open panel's own key, closes the side panel.
    if (store.focusMode && (tab === "reader" || store.focusPanel === tab)) store.setFocusPanel(null);
    else setActiveTab(tab);
  }, hotkeyOptions);

  const anyRunning = activeJobs.some(isRunning);

  if (focusMode) {
    return (
      <div className="flex h-screen w-full flex-col bg-background text-foreground overflow-hidden">
        <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0">
          <ResizablePanel id="focus-reader" minSize="480px" className="flex flex-col min-w-0 relative">
            <Reader />
          </ResizablePanel>
          {focusPanel && (
            <>
              <ResizableHandle className="w-1 bg-border hover:bg-primary/60 transition-colors cursor-col-resize" />
              <ResizablePanel
                id="focus-panel"
                defaultSize={`${focusPanelWidth}px`}
                minSize="320px"
                maxSize="70%"
                onResize={(size) => useStore.getState().setFocusPanelWidth(Math.round(size.inPixels))}
                className="flex flex-col min-w-0 bg-background"
              >
                {focusPanel === "summary" && <SummaryPane />}
                {focusPanel === "chat" && <ChatPane />}
                {focusPanel === "notes" && <NotesPane compact />}
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
        {anyRunning && <StatusBar />}
        <AppDialogs />
        <Lightbox />
        <DropOverlay />
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full flex-col bg-background text-foreground overflow-hidden">
      <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0">
        {!sidebarCollapsed && (
          <>
            <ResizablePanel
              id="sidebar"
              defaultSize={`${sidebarWidth}px`}
              minSize="200px"
              maxSize="480px"
              onResize={(size) => useStore.getState().setSidebarWidth(Math.round(size.inPixels))}
              className="bg-sidebar flex flex-col border-r"
            >
              <div
                className="h-12 flex items-center gap-2 px-4 font-semibold text-[15px] shrink-0 cursor-pointer hover:bg-muted/50 transition-colors"
                onClick={() => useStore.getState().setSidebarCollapsed(true)}
                title="左パネルを閉じる（Ctrl+B）"
              >
                <FileText className="w-5 h-5 text-primary" /> PaperDesk
              </div>
              <div className="flex-1 min-h-0">
                <LibrarySidebar />
              </div>
              <button
                className="h-10 border-t flex items-center gap-2 px-4 shrink-0 text-[13px] hover:bg-muted/50 transition-colors text-left"
                onClick={() => setIsSettingsOpen(true)}
              >
                <Settings2 className="w-4 h-4 text-muted-foreground" /> 接続・設定
              </button>
            </ResizablePanel>
            <ResizableHandle className="w-1 bg-border hover:bg-primary/60 transition-colors cursor-col-resize" />
          </>
        )}

        {sidebarCollapsed && (
          <div className="w-12 bg-sidebar border-r flex flex-col items-center py-2 gap-1 shrink-0">
            <button className="w-8 h-8 flex items-center justify-center hover:bg-muted rounded" title="ライブラリを表示（Ctrl+B）"
              onClick={() => useStore.getState().setSidebarCollapsed(false)}>
              <FileText className="w-5 h-5 text-primary" />
            </button>
            <button className="w-8 h-8 flex items-center justify-center hover:bg-muted rounded" title="PDFを追加（Ctrl+O）" onClick={importPdfs}>
              <FilePlus2 className="w-4 h-4 text-muted-foreground" />
            </button>
            <button className="mt-auto w-8 h-8 flex items-center justify-center hover:bg-muted rounded" title="接続・設定"
              onClick={() => setIsSettingsOpen(true)}>
              <Settings2 className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
        )}

        <ResizablePanel id="main" minSize="600px" className="flex flex-col min-w-0 bg-background">
          <Header />

          <Tabs value={activeTab} onValueChange={(value) => setActiveTab(String(value))} className="flex-1 flex flex-col min-h-0 gap-0">
            <div className="border-b px-4 shrink-0 bg-background/50">
              <TabsList variant="line" className="h-[40px] bg-transparent border-b-0 space-x-2">
                <TabsTrigger value="reader" title="Ctrl+1">PDFを読む</TabsTrigger>
                <TabsTrigger value="summary" title="Ctrl+2">サマリー</TabsTrigger>
                <TabsTrigger value="chat" title="Ctrl+3">
                  チャット
                  {attachmentCount > 0 && (
                    <span className="min-w-4 rounded-full bg-primary px-1 text-[10px] leading-4 text-primary-foreground" title={`添付 ${attachmentCount} 件`}>
                      {attachmentCount}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="notes" title="Ctrl+4">メモ・整理</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="reader" className="flex-1 p-0 m-0 overflow-hidden outline-none data-[state=active]:flex min-h-0">
              <Reader />
            </TabsContent>
            <TabsContent value="summary" className="flex-1 p-0 m-0 overflow-hidden outline-none data-[state=active]:flex min-h-0">
              <SummaryPane />
            </TabsContent>
            <TabsContent value="chat" className="flex-1 p-0 m-0 overflow-hidden outline-none data-[state=active]:flex min-h-0">
              <ChatPane />
            </TabsContent>
            <TabsContent value="notes" className="flex-1 p-0 m-0 overflow-hidden outline-none data-[state=active]:flex min-h-0">
              <NotesPane />
            </TabsContent>
          </Tabs>
        </ResizablePanel>
      </ResizablePanelGroup>

      <StatusBar />
      <SettingsDialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen} />
      <AppDialogs />
      <Lightbox />
      <DropOverlay />
    </div>
  );
}

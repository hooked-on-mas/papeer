import { lazyComponent, paneStates } from "@/components/LazyPanel";

// Split from the initial bundle, which then holds only what the reader needs: these bring in the
// Markdown renderer with KaTeX. They load when first shown, in a tab or the side panel, or once the
// app is idle (AppShell).
export const SummaryPane = lazyComponent(() => import("../features/summary/SummaryPane").then((m) => m.SummaryPane), paneStates);
export const ChatPane = lazyComponent(() => import("../features/chat/ChatPane").then((m) => m.ChatPane), paneStates);
export const NotesPane = lazyComponent(() => import("../features/notes/NotesPane").then((m) => m.NotesPane), paneStates);

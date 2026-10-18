import { MessageSquare, NotebookPen, ScrollText } from "lucide-react";
import type { SidePanel } from "./sidePanel";

/** Tabs that open beside the reader; their keys do so in focus mode, and open the tab otherwise. */
export const SIDE_PANEL_BUTTONS: { tab: SidePanel; label: string; icon: typeof ScrollText; key: string }[] = [
  { tab: "summary", label: "サマリー", icon: ScrollText, key: "Ctrl+2" },
  { tab: "chat", label: "チャット", icon: MessageSquare, key: "Ctrl+3" },
  { tab: "notes", label: "メモ", icon: NotebookPen, key: "Ctrl+4" },
];

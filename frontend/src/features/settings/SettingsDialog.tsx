import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BookOpen, FileText, Keyboard, LayoutTemplate, Palette, PlugZap, StickyNote, Tags, type LucideIcon } from "lucide-react";
import { cn } from "cn";
import { apiRequest } from "../../api/client";
import { usePaper, useSettings } from "../../api/hooks";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog";
import { Button } from "../../components/ui/button";
import { askConfirm } from "../../components/AppDialogs";
import { useStore } from "../../store";
import { showError } from "@/components/errorDialog";
import { ConnectionSection, useConnectionForm } from "./ConnectionSection";
import { AppearanceSection } from "./AppearanceSection";
import { PromptsSection, usePromptsForm } from "./PromptsSection";
import { ShortcutsSection } from "./ShortcutsSection";
import { TagManager } from "./TagsSection";
import { BackupSection } from "./BackupSection";
import { NoteTemplates, type TemplateLeaveGuard } from "../notes/NoteTemplates";
import { useSettingsNavigation, type SettingsSection } from "./settingsNavigation";
import { QK } from "@/lib/queryKeys";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SECTIONS: { id: SettingsSection; label: string; icon: LucideIcon; description: string }[] = [
  { id: "connection", label: "AI 接続", icon: PlugZap, description: "翻訳・解説・チャットに使う AI の接続先とモデル" },
  { id: "appearance", label: "表示", icon: Palette, description: "画面の見た目" },
  { id: "reading-status", label: "読書状態", icon: BookOpen, description: "読書状態の選択肢を追加・削除（自動保存）" },
  { id: "tags", label: "論文のタグ", icon: Tags, description: "論文に付けるタグを追加・削除（自動保存）" },
  { id: "sticky-labels", label: "付箋の分類", icon: StickyNote, description: "付箋の分類を追加・削除（自動保存）" },
  { id: "note-templates", label: "メモテンプレート", icon: LayoutTemplate, description: "すべての論文で使うテンプレートの作成・編集・複製・削除" },
  { id: "prompts", label: "プロンプト", icon: FileText, description: "AI へ渡す指示文のカスタマイズ" },
  { id: "shortcuts", label: "ショートカット", icon: Keyboard, description: "キーボード操作の一覧" },
  { id: "backup", label: "バックアップ", icon: FileText, description: "ライブラリ全体の保存と復元" },
];

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const queryClient = useQueryClient();
  const { section, setSection, templateNote } = useSettingsNavigation();
  const activePaperId = useStore(s => s.activePaperId);
  const { data: paper } = usePaper(activePaperId);
  const templateGuard = useRef<TemplateLeaveGuard>(null);
  const [saving, setSaving] = useState(false);
  const confirming = useRef(false);

  const { data: settings, isError } = useSettings(open);
  const connection = useConnectionForm(open, settings);
  const prompts = usePromptsForm(open);
  const dirty = connection.dirty || prompts.dirty;

  const requestClose = async () => {
    if (confirming.current) return;
    if (dirty) {
      confirming.current = true;
      const discard = await askConfirm("変更を破棄しますか？", "保存していない変更があります。", "破棄して閉じる", true);
      confirming.current = false;
      if (!discard) return;
    }
    if (templateGuard.current && !await templateGuard.current.beforeLeave()) return;
    onOpenChange(false);
  };

  const changeSection = async (next: SettingsSection) => {
    if (next === section) return;
    if (templateGuard.current && !await templateGuard.current.beforeLeave()) return;
    setSection(next);
  };

  const handleSave = async () => {
    if (templateGuard.current && !await templateGuard.current.beforeLeave()) return;
    setSaving(true);
    try {
      if (connection.dirty) await apiRequest("PUT", "/api/settings", connection.values());
      const promptChanges = prompts.pendingChanges();
      if (Object.keys(promptChanges).length) await apiRequest("PUT", "/api/prompts", promptChanges);
      // Model lists depend on the CLI path, and the plan usage on the connection.
      await Promise.all([QK.settings, QK.prompts, QK.models, QK.efforts, QK.usageLimits].map((root) =>
        queryClient.invalidateQueries({ queryKey: [root] })));
      useStore.getState().setStatus(connection.values().api_key
        ? "設定を保存しました。APIキーはこの起動中のみ保持します。"
        : "設定を保存しました。");
      onOpenChange(false);
    } catch (error) {
      showError(error, "設定を保存できませんでした");
    } finally {
      setSaving(false);
    }
  };

  const current = SECTIONS.find((s) => s.id === section)!;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (next) onOpenChange(true); else void requestClose(); }}>
      <DialogContent className="h-[640px] max-h-[calc(100vh-2rem)] grid-rows-[minmax(0,1fr)] gap-0 overflow-hidden p-0 text-[13px] sm:max-w-[900px]">
        <div className="flex h-full min-h-0">
          <nav className="flex w-[176px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r bg-sidebar p-3" aria-label="設定の項目">
            <DialogTitle className="mb-2 px-2 pt-1 text-[15px] font-semibold">設定</DialogTitle>
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                aria-current={section === id ? "page" : undefined}
                onClick={() => void changeSection(id)}
                className={cn(
                  "flex h-8 items-center gap-2 rounded-md px-2 text-left transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  section === id ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" />
                {label}
                {((id === "connection" && connection.dirty) || (id === "prompts" && prompts.dirty)) && (
                  <span className="ml-auto size-1.5 rounded-full bg-primary" aria-label="未保存の変更" />
                )}
              </button>
            ))}
          </nav>

          <div className="flex min-w-0 flex-1 flex-col">
            <header className="shrink-0 px-6 pt-5 pb-4 pr-12">
              <h2 className="text-[15px] font-semibold">{current.label}</h2>
              <DialogDescription className="text-[12px]">{current.description}</DialogDescription>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5">
              {isError ? (
                <p className="text-destructive">設定を読み込めませんでした。バックエンドが起動しているか確認してください。</p>
              ) : (
                <>
                  {section === "connection" && <ConnectionSection form={connection} />}
                  {section === "appearance" && <AppearanceSection />}
                  {section === "prompts" && <PromptsSection form={prompts} />}
                  {section === "shortcuts" && <ShortcutsSection />}
                  {section === "reading-status" && <TagManager key="status" kind="status" />}
                  {section === "tags" && <TagManager key="paper" kind="paper" />}
                  {section === "sticky-labels" && <TagManager key="sticky" kind="sticky" />}
                  {open && section === "note-templates" && <NoteTemplates embedded leaveRef={templateGuard} note={templateNote ?? paper?.note ?? ""} onInsert={() => undefined} />}
                  {section === "backup" && <BackupSection />}
                </>
              )}
            </div>

            <footer className="flex shrink-0 items-center gap-2 border-t bg-muted/20 px-6 py-3">
              {dirty && <span className="text-[12px] text-muted-foreground">未保存の変更があります</span>}
              <Button variant="outline" className="ml-auto" onClick={() => void requestClose()}>{dirty ? "キャンセル" : "閉じる"}</Button>
              {(dirty || section === "connection" || section === "prompts") && <Button onClick={handleSave} disabled={saving || !settings || !dirty}>
                {saving ? "保存中…" : "保存"}
              </Button>}
            </footer>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

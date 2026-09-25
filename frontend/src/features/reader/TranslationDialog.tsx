import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { apiRequest } from "@/api/client";
import { PROVIDER_LABELS, useReading, useSettings, type SettingsData } from "@/api/hooks";
import { showError, startJob } from "@/features/jobs/jobEvents";

interface TranslationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paperId: string;
  currentPage: number;
}

type Option = { id: string; name: string };

/** Same rules and messages as paperdesk.layout.page_selection, for feedback while typing. */
export function parsePageSelection(value: string, pageCount: number): number[] {
  const text = value.normalize("NFKC").replace(/、/g, ",").replace(/[～~–—−]/g, "-");
  if (!text.trim()) throw new Error("翻訳するページを入力してください。例: 1, 3-5, 8");
  const pages = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^\s*([0-9]+)\s*(?:-\s*([0-9]+)\s*)?$/.exec(part);
    if (!match) throw new Error("ページ番号と範囲をカンマで区切ってください。例: 1, 3-5, 8");
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    if (!(1 <= first && first <= last && last <= pageCount)) {
      throw new Error(`1～${pageCount}ページの範囲を、小さい番号から指定してください。`);
    }
    for (let page = first; page <= last; page++) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

function cliPath(settings: SettingsData | undefined): string {
  if (!settings) return "";
  return settings.provider === "claude" ? settings.claude_path
    : settings.provider === "gemini" ? settings.gemini_path
    : settings.provider === "codex" ? settings.codex_path : "";
}

export function TranslationDialog({ open, onOpenChange, paperId, currentPage }: TranslationDialogProps) {
  const [scope, setScope] = useState<"all" | "current" | "custom">("all");
  const [customRange, setCustomRange] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [starting, setStarting] = useState(false);

  const { data: settings } = useSettings();
  const { data: reading } = useReading(open ? paperId : null);
  const provider = settings?.provider ?? "";
  const pageCount = reading?.source_page_count ?? reading?.page_count ?? 0;

  const { data: models = [], isFetching: loadingModels } = useQuery({
    queryKey: ["models", provider, cliPath(settings)],
    queryFn: () => apiRequest<Option[]>("GET",
      `/api/providers/${provider}/models?cli_path=${encodeURIComponent(cliPath(settings))}`),
    enabled: open && !!provider,
    staleTime: 5 * 60_000,
  });

  const effectiveModel = model || settings?.model || "";
  const { data: efforts = [] } = useQuery({
    queryKey: ["efforts", provider, effectiveModel],
    queryFn: () => apiRequest<Option[]>("GET",
      `/api/providers/${provider}/efforts?model=${encodeURIComponent(effectiveModel)}&cli_path=${encodeURIComponent(cliPath(settings))}`),
    enabled: open && !!provider,
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (!open) return;
    setModel("");
    setEffort("");
    // Reopen with the previous request, as the old dialog did.
    const previous = reading?.preview?.target_pages;
    if (previous?.length && previous.length !== pageCount) {
      setScope("custom");
      setCustomRange(previous.join(", "));
    } else {
      setScope("all");
      setCustomRange("");
    }
  }, [open, paperId, !!reading]);

  useEffect(() => setEffort(""), [model]);

  const selection = useMemo((): { pages: number[] | null; error: string | null } => {
    if (!pageCount) return { pages: null, error: null };
    if (scope === "all") return { pages: Array.from({ length: pageCount }, (_, i) => i + 1), error: null };
    if (scope === "current") return { pages: [Math.min(currentPage, pageCount)], error: null };
    try {
      return { pages: parsePageSelection(customRange, pageCount), error: null };
    } catch (error) {
      return { pages: null, error: (error as Error).message };
    }
  }, [scope, customRange, currentPage, pageCount]);

  const handleStart = async () => {
    if (!selection.pages?.length) return;
    const pages = scope === "all" ? "" : selection.pages.join(",");
    setStarting(true);
    try {
      await startJob(`/api/papers/${paperId}/translate`,
        { pages, model: model || undefined, effort: effort || undefined },
        { kind: "translate", paperId });
      onOpenChange(false);
    } catch (error) {
      showError(error, "翻訳を開始できませんでした");
    } finally {
      setStarting(false);
    }
  };

  const connection = PROVIDER_LABELS[provider] ?? provider;
  const shownEffort = effort || settings?.reasoning_effort || "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>翻訳の設定</DialogTitle>
          <DialogDescription>今回の翻訳に使うモデルと推論の強さ (effort)</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          <div className="grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2">
            <label className="text-[13px]">モデル</label>
            <NativeSelect value={model} onChange={(e) => setModel(e.target.value)} disabled={loadingModels && !models.length}>
              <option value="">AI接続の設定と同じ</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </NativeSelect>
            {efforts.length > 0 && (
              <>
                <label className="text-[13px]">推論の強さ (effort)</label>
                <NativeSelect value={effort} onChange={(e) => setEffort(e.target.value)}>
                  <option value="">AI接続の設定と同じ</option>
                  {efforts.filter((e) => e.id).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </NativeSelect>
              </>
            )}
          </div>
          <p className="text-[12px] text-muted-foreground whitespace-pre-line">
            {`${connection}：${effectiveModel || "既定モデル"} / effort: ${shownEffort || "既定値"}\n`
              + "今回の翻訳にのみ適用します。接続先・解説・質問の設定は変更しません。"}
          </p>
          <p className="text-[12px] text-muted-foreground whitespace-pre-line leading-relaxed">
            {`全${pageCount}ページ。PDFの先頭を1ページとして指定します。\n`
              + "文が前後のページへ続く場合は、つながるページも翻訳対象に含めます。\n"
              + "同じモデルでは保存済みの訳文を再利用します（effortの変更は次のAI処理から適用）。\n"
              + "モデルを変更すると指定ページを再翻訳し、指定外の訳文は引き継がれません。"}
          </p>
          <div className="grid gap-2">
            <NativeSelect value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
              <option value="all">全ページ</option>
              <option value="current">現在のページ（{Math.min(currentPage, pageCount || currentPage)}ページ）</option>
              <option value="custom">ページを指定</option>
            </NativeSelect>
            <Input
              value={customRange}
              onChange={(e) => setCustomRange(e.target.value)}
              placeholder="例: 1, 3-5, 8"
              disabled={scope !== "custom"}
              onKeyDown={(e) => { if (e.key === "Enter") handleStart(); }}
            />
            <p className={`text-[12px] ${selection.error ? "text-destructive" : "text-muted-foreground"}`}>
              {selection.error ?? (selection.pages ? `翻訳対象: ${selection.pages.length}ページ` : "")}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>キャンセル</Button>
          <Button onClick={handleStart} disabled={!selection.pages?.length || starting}>翻訳を開始</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

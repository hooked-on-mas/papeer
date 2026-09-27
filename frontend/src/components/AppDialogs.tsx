import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CircleAlert } from "lucide-react";
import { useErrorDialog } from "@/components/errorDialog";
import { Toaster } from "@/components/Toaster";
import { errorAdvice, firstLine, reportDetails, type ErrorAction, type ErrorReport } from "@/lib/errorReports";
import { openSettings } from "@/features/settings/settingsNavigation";
import { ConnectionBanner } from "@/features/jobs/ConnectionBanner";

type Request =
  | { kind: "text"; title: string; label: string; defaultValue: string; resolve: (value: string | null) => void }
  | { kind: "confirm"; title: string; message: string; okLabel: string; destructive: boolean; resolve: (ok: boolean) => void }
  | { kind: "message"; title: string; message: string; resolve: () => void };

const useDialogQueue = create<{ current: Request | null; set: (r: Request | null) => void }>((set) => ({
  current: null,
  set: (current) => set({ current }),
}));

/** In-app replacement for window.prompt, which WebViews render poorly or not at all. */
export function askText(title: string, label: string, defaultValue = ""): Promise<string | null> {
  return new Promise((resolve) => useDialogQueue.getState().set({ kind: "text", title, label, defaultValue, resolve }));
}

export function askConfirm(title: string, message: string, okLabel = "OK", destructive = false): Promise<boolean> {
  return new Promise((resolve) => useDialogQueue.getState().set({ kind: "confirm", title, message, okLabel, destructive, resolve }));
}

export function showMessage(title: string, message: string): Promise<void> {
  return new Promise((resolve) => useDialogQueue.getState().set({ kind: "message", title, message, resolve }));
}

function PromptDialogs() {
  const { current, set } = useDialogQueue();
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (current?.kind === "text") {
      setValue(current.defaultValue);
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 30);
    }
  }, [current]);

  const finish = (result: string | boolean | null) => {
    if (!current) return;
    set(null);
    if (current.kind === "text") current.resolve(result as string | null);
    else if (current.kind === "confirm") current.resolve(result === true);
    else current.resolve();
  };

  return (
    <Dialog open={!!current} onOpenChange={(open) => { if (!open) finish(current?.kind === "confirm" ? false : null); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{current?.title}</DialogTitle>
          {current && current.kind !== "text" && (
            <DialogDescription className="whitespace-pre-wrap">{current.message}</DialogDescription>
          )}
        </DialogHeader>
        {current?.kind === "text" && (
          <form
            className="grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              finish(value);
            }}
          >
            <label className="text-[0.8125rem] text-muted-foreground">{current.label}</label>
            <Input ref={inputRef} value={value} onChange={(e) => setValue(e.target.value)} />
          </form>
        )}
        <DialogFooter>
          {current?.kind === "message" ? (
            <Button onClick={() => finish(null)}>OK</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => finish(current?.kind === "confirm" ? false : null)}>キャンセル</Button>
              <Button
                variant={current?.kind === "confirm" && current.destructive ? "destructive" : "default"}
                onClick={() => finish(current?.kind === "confirm" ? true : value)}
              >
                {current?.kind === "confirm" ? current.okLabel : "OK"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function JobErrorDialog() {
  const queue = useErrorDialog((s) => s.queue);
  const close = useErrorDialog((s) => s.close);
  const error = queue[0] ?? null;
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [error]);
  // Keep the last error on screen while the dialog animates closed.
  const shown = useRef<ErrorReport | null>(null);
  if (error) shown.current = error;
  const report = error ?? shown.current;
  const advice = report ? errorAdvice(report.message, { kind: report.kind, canResume: !!report.resume }) : null;
  const detailLine = report && advice && advice.cause !== "other" ? firstLine(report.message) : "";
  const waiting = queue.length - 1;

  const run = (action: ErrorAction) => {
    if (!report || !advice) return;
    if (action === "copy") {
      navigator.clipboard.writeText(reportDetails(report, advice)).then(() => setCopied(true), () => setCopied(false));
      return;
    }
    close();
    if (action === "settings") openSettings(advice.settingsSection);
    else report.resume?.run();
  };

  const label = (action: ErrorAction) =>
    action === "settings" ? (advice?.settingsSection === "connection" ? "AI接続の設定を開く" : "設定を開く")
      : action === "resume" ? (report?.resume?.label ?? "再開")
      : copied ? "コピーしました" : "詳細をコピー";

  return (
    <Dialog open={!!error} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CircleAlert className="size-4 shrink-0 text-destructive" aria-hidden="true" />
            {report?.title}
          </DialogTitle>
          {report?.paperTitle && (
            <p className="text-[0.8125rem] text-muted-foreground break-words">論文：{report.paperTitle}</p>
          )}
        </DialogHeader>
        <DialogDescription className="text-[0.875rem] text-foreground">{advice?.summary}</DialogDescription>
        {detailLine && detailLine !== advice?.summary && (
          <p className="text-[0.75rem] text-muted-foreground break-words">{detailLine}</p>
        )}
        <details key={report?.id} className="rounded-md border bg-muted/30 text-[0.75rem]">
          <summary className="cursor-pointer select-none px-3 py-1.5 text-muted-foreground hover:text-foreground">エラーの詳細</summary>
          <textarea
            readOnly
            aria-label="エラー詳細"
            value={report?.message ?? ""}
            className="block h-[200px] w-full resize-none border-t bg-transparent p-3 font-mono text-[0.75rem] leading-relaxed outline-none"
          />
        </details>
        <DialogFooter className="items-center">
          {waiting > 0 && (
            <span className="mr-auto text-[0.75rem] text-muted-foreground" aria-live="polite">ほかに {waiting} 件のエラーがあります</span>
          )}
          {advice?.actions.map((action) => (
            <Button key={action} variant={action === advice.primary ? "default" : "outline"} onClick={() => run(action)}>
              {label(action)}
            </Button>
          ))}
          <Button variant={advice && advice.primary ? "outline" : "default"} onClick={close}>
            {waiting > 0 ? "次のエラーへ" : "閉じる"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AppDialogs() {
  return (
    <>
      <PromptDialogs />
      <JobErrorDialog />
      <Toaster />
      <ConnectionBanner />
    </>
  );
}

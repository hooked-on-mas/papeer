import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CircleAlert } from "lucide-react";
import { useErrorDialog } from "@/components/errorDialog";
import { Toaster } from "@/components/Toaster";
import { errorAdvice, firstLine, reportDetails, type ErrorAction, type ErrorReport } from "@/lib/errorReports";
import { openSettings } from "@/features/settings/settingsNavigation";
import { ConnectionBanner } from "@/features/jobs/ConnectionBanner";
import { isAppClosing, onAppClosingChange } from "@/app/appClosing";
import { createDialogQueue, type DialogOptions, type QueuedDialog } from "@/lib/dialogQueue";

const dialogs = createDialogQueue();
// Once the closing is confirmed, a question from before would start work in the middle of it: those
// wait, hidden, and come back if the closing is called off (a save that failed, a sync that asked).
onAppClosingChange((closing) => dialogs.hold(closing));

/**
 * While the app is closing, what the close sequence asks (AppShell's close handling, the sync on
 * closing) goes ahead of any question left waiting from before.
 */
const withDefaults = (options: DialogOptions): DialogOptions => ({ ...options, urgent: options.urgent ?? isAppClosing() });

/** In-app replacement for window.prompt, which WebViews render poorly or not at all. */
export function askText(title: string, label: string, defaultValue = "", options: DialogOptions = {}): Promise<string | null> {
  return dialogs.ask({ kind: "text", title, label, defaultValue }, withDefaults(options));
}

/** `cancelLabel` names the button that answers false (キャンセル by default), for a question whose two answers are both fine. */
export type ConfirmOptions = DialogOptions & { cancelLabel?: string };

export function askConfirm(title: string, message: string, okLabel = "OK", destructive = false, options: ConfirmOptions = {}): Promise<boolean> {
  const { cancelLabel, ...queueOptions } = options;
  return dialogs.ask({ kind: "confirm", title, message, okLabel, destructive, ...(cancelLabel ? { cancelLabel } : {}) },
    withDefaults(queueOptions));
}

export function showMessage(title: string, message: string, options: DialogOptions = {}): Promise<void> {
  return dialogs.ask({ kind: "message", title, message }, withDefaults(options));
}

/** The questions, one at a time in the order of lib/dialogQueue.ts; a new one waits instead of replacing the one on screen. */
function PromptDialogs() {
  const current = useSyncExternalStore(dialogs.subscribe, dialogs.getShown);
  // Keep the last question on screen while the dialog animates closed.
  const shown = useRef<QueuedDialog | null>(null);
  if (current) shown.current = current;
  const entry = current ?? shown.current;
  const request = entry?.request ?? null;
  const [value, setValue] = useState("");
  // What was typed into a question that an urgent one pushed back, for when it comes back.
  const drafts = useRef(new Map<number, string>());
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);

  // Each question gets the focus where it would on opening, also when it follows another in the
  // open dialog (the focus would stay on the last one's button): the input, else キャンセル (OK for a message).
  useEffect(() => {
    if (!current) return;
    const draft = drafts.current.get(current.id);
    if (current.request.kind === "text") setValue(draft ?? current.request.defaultValue);
    const timer = setTimeout(() => {
      if (current.request.kind !== "text") {
        (current.request.kind === "message" ? okRef : cancelRef).current?.focus();
        return;
      }
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      // A default is there to be replaced; what the user typed before is there to be continued.
      if (draft === undefined) input.select();
      else input.setSelectionRange(input.value.length, input.value.length);
    }, 30);
    return () => clearTimeout(timer);
  }, [current]);

  const finish = (result: unknown) => {
    if (!current) return;
    drafts.current.delete(current.id);
    dialogs.answer(current.id, result);
  };
  const cancel = () => finish(null);
  const edit = (text: string) => {
    setValue(text);
    if (current) drafts.current.set(current.id, text);
  };

  return (
    <Dialog open={!!current} onOpenChange={(open) => { if (!open) cancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{request?.title}</DialogTitle>
          {request && request.kind !== "text" && (
            <DialogDescription className="whitespace-pre-wrap">{request.message}</DialogDescription>
          )}
        </DialogHeader>
        {request?.kind === "text" && (
          <form
            className="grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              finish(value);
            }}
          >
            <label className="text-[0.8125rem] text-muted-foreground">{request.label}</label>
            <Input ref={inputRef} value={value} onChange={(e) => edit(e.target.value)} />
          </form>
        )}
        <DialogFooter>
          {request?.kind === "message" ? (
            <Button ref={okRef} onClick={() => finish(null)}>OK</Button>
          ) : (
            <>
              <Button ref={cancelRef} variant="outline" onClick={cancel}>
                {request?.kind === "confirm" && request.cancelLabel ? request.cancelLabel : "キャンセル"}
              </Button>
              <Button
                variant={request?.kind === "confirm" && request.destructive ? "destructive" : "default"}
                onClick={() => finish(request?.kind === "confirm" ? true : value)}
              >
                {request?.kind === "confirm" ? request.okLabel : "OK"}
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

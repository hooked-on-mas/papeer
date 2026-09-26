import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useErrorDialog } from "@/components/errorDialog";

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
            <label className="text-[13px] text-muted-foreground">{current.label}</label>
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
  const { error, close } = useErrorDialog();
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [error]);

  return (
    <Dialog open={!!error} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{error?.title}</DialogTitle>
        </DialogHeader>
        <textarea
          readOnly
          aria-label="エラー詳細"
          value={error?.message ?? ""}
          className="h-[260px] w-full resize-none rounded-md border bg-muted/40 p-3 font-mono text-[12px] leading-relaxed outline-none"
        />
        <DialogFooter>
          <Button
            variant="outline"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(error?.message ?? "");
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? "コピーしました" : "エラーをコピー"}
          </Button>
          <Button onClick={close}>閉じる</Button>
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
    </>
  );
}

import { Toast } from "@base-ui/react/toast";
import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { toastManager } from "./toast";

const ICONS = {
  error: <CircleAlert className="size-4 shrink-0 text-destructive" aria-hidden="true" />,
  success: <CircleCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />,
  info: <Info className="size-4 shrink-0 text-primary" aria-hidden="true" />,
};

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => (
    <Toast.Root
      key={toast.id}
      toast={toast}
      className="pointer-events-auto w-full rounded-lg border bg-popover text-popover-foreground shadow-lg outline-none transition-[opacity,transform] duration-200 focus-visible:ring-2 focus-visible:ring-ring data-[type=error]:border-destructive/40 data-starting-style:translate-y-2 data-starting-style:opacity-0 data-ending-style:opacity-0 data-limited:hidden"
    >
      <Toast.Content className="flex items-start gap-2 p-3">
        {ICONS[(toast.type as keyof typeof ICONS) ?? "info"] ?? ICONS.info}
        <div className="min-w-0 flex-1">
          <Toast.Title className="text-[0.8125rem] font-medium leading-5 break-words" />
          <Toast.Description className="mt-0.5 text-[0.75rem] leading-5 text-muted-foreground break-words" />
          {toast.actionProps && (
            <Toast.Action className="mt-2 h-7 rounded-md border px-2.5 text-[0.75rem] hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring" />
          )}
        </div>
        <Toast.Close aria-label="通知を閉じる" className="-m-1 flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground">
          <X className="size-3.5" />
        </Toast.Close>
      </Toast.Content>
    </Toast.Root>
  ));
}

/** Where showToast's notices appear: above the status bar at the bottom right. F6 moves the focus into them. */
export function Toaster() {
  return (
    <Toast.Provider toastManager={toastManager} limit={4}>
      <Toast.Portal>
        <Toast.Viewport
          aria-label="通知"
          className="pointer-events-none fixed right-4 bottom-10 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col-reverse gap-2 outline-none"
        >
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

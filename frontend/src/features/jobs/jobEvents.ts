import { useEffect } from "react";
import { create } from "zustand";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { apiRequest, authToken, backendPort } from "@/api/client";
import { isRunning, useStore, type Job } from "@/store";
import { notifyIfAway, shell } from "@/shell";
import { removePendingImports, setPendingPages } from "@/app/pendingImports";
import { useLastUsage, usageSummary, type Usage } from "@/lib/usage";

export type JobFinished = {
  job_id: string;
  paper_id: string | null;
  kind: string;
  status: "succeeded" | "failed" | "cancelled";
  result?: any;
  error?: string;
  cancelled?: boolean;
};

type Watcher = (event: JobFinished) => void;

const watchers = new Map<string, Watcher[]>();
// A fast job can finish before its starter registers a watcher.
const recentlyFinished = new Map<string, JobFinished>();

/** Run `watcher` once when the job ends (immediately if it already has). */
export function watchJob(jobId: string, watcher: Watcher): void {
  const finished = recentlyFinished.get(jobId);
  if (finished) {
    watcher(finished);
    return;
  }
  watchers.set(jobId, [...(watchers.get(jobId) ?? []), watcher]);
}

/** Start a sidecar job and show it as running before the first progress event. */
export async function startJob(
  path: string,
  body: unknown,
  meta: { kind: string; paperId: string | null },
  watcher?: Watcher,
): Promise<string> {
  const response = await apiRequest<{ job_id: string }>("POST", path, body ?? {});
  useStore.getState().addJob({
    job_id: response.job_id,
    paper_id: meta.paperId,
    kind: meta.kind,
    message: "準備中...",
    status: "running",
  });
  if (watcher) watchJob(response.job_id, watcher);
  return response.job_id;
}

/** Cancel the jobs of the paper on screen and library-wide jobs, like the old 中止 button. */
export async function cancelVisibleJobs(): Promise<boolean> {
  const { activeJobs, activePaperId, setStatus } = useStore.getState();
  const targets = activeJobs.filter((j) => isRunning(j) && (j.paper_id === activePaperId || !j.paper_id));
  if (!targets.length) {
    setStatus("現在表示中の論文で実行中の処理はありません。他の論文の処理を中止する場合は、その論文を開いてから中止を押してください。");
    return false;
  }
  await Promise.all(targets.map((j) => apiRequest("POST", `/api/jobs/${j.job_id}/cancel`).catch(() => undefined)));
  setStatus("中止しています… API通信中の場合は応答またはタイムアウトまで待ちます。");
  return true;
}

// --- Error dialog -----------------------------------------------------------------

type ErrorDialogState = {
  error: { title: string; message: string } | null;
  show: (title: string, message: string) => void;
  close: () => void;
};

export const useErrorDialog = create<ErrorDialogState>((set) => ({
  error: null,
  show: (title, message) => set({ error: { title, message } }),
  close: () => set({ error: null }),
}));

export function showError(error: unknown, title = "処理を完了できませんでした"): void {
  const message = error instanceof Error ? error.message : String(error);
  useErrorDialog.getState().show(title, message);
}

// --- Completion messages -----------------------------------------------------------

function translateMessage(report: any): string {
  let message = `指定した${report.selected_pages?.length ?? 0}ページの翻訳処理が終了しました。`
    + `全${report.pages}ページ中${report.translated_pages?.length ?? 0}ページ翻訳済み。`;
  if (report.skipped_pages?.length) {
    message += " PDF生成に失敗したページは原文のままです：p." + report.skipped_pages.join(", ");
  }
  return message;
}

function handleSuccess(event: JobFinished, visible: boolean): void {
  const store = useStore.getState();
  const usage: Usage | null = event.result?.usage ?? null;
  if (usage) useLastUsage.setState({ usage, kind: event.kind });
  const status = (message: string) => {
    if (visible) store.setStatus(usage ? `${message}（${usageSummary(usage)}）` : message);
  };
  switch (event.kind) {
    case "translate": {
      const message = translateMessage(event.result ?? {});
      status(message);
      notifyIfAway("翻訳処理が終了しました", message);
      break;
    }
    case "article":
      status("解説を保存しました。ページ参照をクリックすると原文へ移動します。");
      notifyIfAway("解説ができました", "「サマリー」タブで確認できます。");
      if (event.paper_id && event.paper_id === store.activePaperId) store.setActiveTab("summary");
      break;
    case "ask":
      status("回答を保存しました。参照リンクから原文を確認できます。");
      notifyIfAway("回答ができました", "「チャット」タブで確認できます。");
      break;
    case "import": {
      const ids: string[] = event.result?.paper_ids ?? [];
      const message = `${event.result?.added ?? 0}件を追加しました。重複するPDFは既存の論文を開きます。`;
      if (ids.length) store.setActivePaperId(ids[ids.length - 1]);
      store.setStatus(message);
      notifyIfAway("PDFを追加しました", message);
      break;
    }
    case "check":
      status(String(event.result ?? "接続を確認しました。"));
      break;
    case "export":
      status(event.result?.kind === "bilingual" ? "対訳PDFを保存しました。" : "原文・日本語訳の交互PDFを保存しました。");
      break;
    case "interleaved":
      if (event.result?.path) {
        shell.openPath(event.result.path).catch(() =>
          store.setStatus("PDFを開けませんでした。既定のPDFアプリを確認してください。"));
      }
      break;
  }
}

function handleFinished(event: JobFinished, queryClient: QueryClient): void {
  const store = useStore.getState();
  const visible = !event.paper_id || event.paper_id === store.activePaperId;
  if (event.status === "succeeded") {
    handleSuccess(event, visible);
  } else if (event.status === "cancelled") {
    if (visible) store.setStatus(event.error || "中止しました。");
  } else {
    const message = event.error || "不明なエラー";
    if (visible) store.setStatus(message);
    notifyIfAway("処理を完了できませんでした", message);
    shell.setProgress("error").catch(() => undefined);
    useErrorDialog.getState().show("処理を完了できませんでした", message);
  }

  queryClient.invalidateQueries({ queryKey: ["papers"] });
  queryClient.invalidateQueries({ queryKey: ["collections"] });
  // A failed job may have hit the plan limit, so refresh after those too.
  if (["translate", "article", "ask"].includes(event.kind)) queryClient.invalidateQueries({ queryKey: ["usage-limits"] });
  if (event.paper_id) {
    queryClient.invalidateQueries({ queryKey: ["article", event.paper_id] });
    queryClient.invalidateQueries({ queryKey: ["messages", event.paper_id] });
    queryClient.invalidateQueries({ queryKey: ["reading", event.paper_id] });
    if (event.kind === "translate") {
      queryClient.invalidateQueries({ queryKey: ["paper-search", event.paper_id] });
    }
  }

  recentlyFinished.set(event.job_id, event);
  setTimeout(() => recentlyFinished.delete(event.job_id), 60_000);
  const pending = watchers.get(event.job_id) ?? [];
  watchers.delete(event.job_id);
  pending.forEach((watcher) => watcher(event));
}

function syncTaskbar(jobs: Job[]): void {
  const running = jobs.filter(isRunning);
  if (!running.length) {
    shell.setProgress("none").catch(() => undefined);
    return;
  }
  // Show the paper on screen first, like the old status line.
  const { activePaperId } = useStore.getState();
  const job = running.find((j) => j.paper_id === activePaperId) ?? running.find((j) => !j.paper_id) ?? running[0];
  if (job.total && job.total > 0 && job.done != null) shell.setProgress("normal", job.done, job.total).catch(() => undefined);
  else shell.setProgress("indeterminate").catch(() => undefined);
}

/** One WebSocket for the whole app; mounted at the root so focus mode keeps it alive. */
export function useJobEvents(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    let ws: WebSocket | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const refreshJobs = async () => {
      try {
        const serverJobs = await apiRequest<any[]>("GET", "/api/jobs");
        const running = serverJobs.filter((j) => j.running);
        useStore.setState({
          activeJobs: running.map((j) => ({
            job_id: j.job_id, paper_id: j.paper_id, kind: j.kind, message: j.message,
            done: j.done, total: j.total, status: "running" as const,
          })),
        });
      } catch {
        // The sidecar may still be starting; the next reconnect retries.
      }
    };

    const connect = () => {
      const url = new URL(`ws://127.0.0.1:${backendPort()}/ws/events`);
      const token = authToken();
      if (token) url.searchParams.set("token", token);
      ws = new WebSocket(url);
      ws.onopen = refreshJobs;
      ws.onmessage = (message) => {
        let data: any;
        try {
          data = JSON.parse(message.data);
        } catch {
          return;
        }
        const store = useStore.getState();
        if (data.type === "job.started") {
          store.addJob({ job_id: data.job_id, paper_id: data.paper_id, kind: data.kind, message: data.message, status: "running" });
        } else if (data.type === "job.progress") {
          store.addJob({
            job_id: data.job_id, paper_id: data.paper_id, kind: data.kind,
            message: data.message, done: data.done, total: data.total, status: "running",
          });
        } else if (data.type === "job.page_ready") {
          if (data.paper_id) {
            queryClient.invalidateQueries({ queryKey: ["reading", data.paper_id] });
            queryClient.invalidateQueries({ queryKey: ["paper-search", data.paper_id] });
          }
        } else if (data.type === "job.finished") {
          store.removeJob(data.job_id);
          handleFinished(data as JobFinished, queryClient);
        } else if (data.type === "library.changed") {
          queryClient.invalidateQueries({ queryKey: ["papers"] });
          queryClient.invalidateQueries({ queryKey: ["collections"] });
        } else if (data.type === "import.pages") {
          setPendingPages(data.pages ?? {});
        } else if (data.type === "import.item") {
          // Keep the placeholder until the real row is in the list, so nothing flickers.
          queryClient.invalidateQueries({ queryKey: ["collections"] });
          queryClient.invalidateQueries({ queryKey: ["papers"] }).finally(() => removePendingImports([data.path]));
        }
      };
      ws.onclose = () => {
        if (!disposed) reconnect = setTimeout(connect, 3000);
      };
    };

    connect();
    const unsubscribe = useStore.subscribe((s, prev) => {
      if (s.activeJobs !== prev.activeJobs || s.activePaperId !== prev.activePaperId) syncTaskbar(s.activeJobs);
    });
    return () => {
      disposed = true;
      clearTimeout(reconnect);
      unsubscribe();
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, [queryClient]);
}

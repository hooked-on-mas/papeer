import { useEffect } from "react";
import { useStore } from "@/store";
import { shell } from "@/shell";
import { Progress } from "@/components/ui/progress";

import { useQueryClient } from "@tanstack/react-query";

export function GlobalProgress() {
  const { activeJobs, addJob, updateJob, removeJob } = useStore();
  const queryClient = useQueryClient();

  useEffect(() => {
    let ws: WebSocket;
    let reconnectTimeout: ReturnType<typeof setTimeout>;

    const connect = () => {
      const port = import.meta.env.VITE_PAPERDESK_PORT || 8000;
      const token = import.meta.env.VITE_PAPERDESK_TOKEN || "";
      const url = new URL(`ws://127.0.0.1:${port}/ws/events`);
      if (token) {
        url.searchParams.set("token", token);
      }
      ws = new WebSocket(url);

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === "job.progress") {
            const { job_id, message, done, total, paper_id } = data;
            const existingJob = useStore.getState().activeJobs.find(j => j.job_id === job_id);
            if (existingJob) {
              updateJob(job_id, { message, done, total, status: "running" });
            } else {
              addJob({ job_id, paper_id, message, done, total, status: "running" });
            }
          } else if (data.type === "job.finished") {
            const { job_id, status, paper_id } = data;
            updateJob(job_id, { status });
            
            // Invalidate queries to refresh data
            queryClient.invalidateQueries({ queryKey: ["papers"] });
            if (paper_id) {
              queryClient.invalidateQueries({ queryKey: ["article", paper_id] });
              queryClient.invalidateQueries({ queryKey: ["messages", paper_id] });
              queryClient.invalidateQueries({ queryKey: ["reading"] });
              // Dispatch custom event to trigger PDF reload if needed
              window.dispatchEvent(new CustomEvent("pdf-translated", { detail: { paper_id } }));
            }

            // Remove the job after a short delay so the user can see completion state if needed
            setTimeout(() => {
              removeJob(job_id);
            }, 2000);
          }
        } catch (err) {
          console.error("Failed to parse websocket message", err);
        }
      };

      ws.onclose = () => {
        reconnectTimeout = setTimeout(connect, 3000);
      };
    };

    connect();

    return () => {
      clearTimeout(reconnectTimeout);
      if (ws) {
        ws.onclose = null; // Prevent reconnect on unmount
        ws.close();
      }
    };
  }, [addJob, updateJob, removeJob]);

  // Update OS shell progress based on active jobs
  useEffect(() => {
    const runningJobs = activeJobs.filter(j => j.status === "running");
    if (runningJobs.length === 0) {
      shell.setProgress("none");
      return;
    }

    let totalDone = 0;
    let totalTotal = 0;
    let hasIndeterminate = false;

    runningJobs.forEach(job => {
      if (job.total != null && job.total > 0 && job.done != null) {
        totalDone += job.done;
        totalTotal += job.total;
      } else {
        hasIndeterminate = true;
      }
    });

    if (totalTotal > 0) {
      shell.setProgress("normal", totalDone, totalTotal);
    } else if (hasIndeterminate) {
      shell.setProgress("indeterminate");
    } else {
      shell.setProgress("normal", 1, 1);
    }
  }, [activeJobs]);

  if (activeJobs.length === 0) {
    return null;
  }

  const currentJob = activeJobs[0];
  const percent = (currentJob.total && currentJob.total > 0)
    ? ((currentJob.done || 0) / currentJob.total) * 100
    : null;

  return (
    <div className="flex items-center gap-4 min-w-[250px] max-w-sm">
      <div className="flex-1 text-xs truncate" title={currentJob.message}>
        {currentJob.message || "Processing..."}
      </div>
      <Progress value={percent} className="w-24" />
    </div>
  );
}

import { create } from "zustand";
import type { ConnectionState } from "./jobList";

/** Whether the job event stream (useJobEvents' WebSocket) is open; ConnectionBanner shows the drops. */
export const useConnection = create<ConnectionState>(() => ({
  connected: false,
  everConnected: false,
  downSince: Date.now(),
}));

export function markConnected(): void {
  useConnection.setState({ connected: true, everConnected: true, downSince: null });
}

export function markDisconnected(): void {
  const state = useConnection.getState();
  // Each failed reconnect closes again; the banner counts from the first drop.
  if (!state.connected && state.downSince !== null) return;
  useConnection.setState({ connected: false, downSince: Date.now() });
}

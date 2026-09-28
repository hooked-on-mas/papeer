import { QueryClient } from "@tanstack/react-query";

/**
 * The app's one query client (App.tsx provides it). Code outside the components (actions.ts, the saves
 * of the memo pane, navigation.ts) reads and refreshes the cache through it; components use useQueryClient.
 * Not refetched on window focus: the sidecar announces every change (jobEvents.ts), and switching back to
 * the window would otherwise reload the whole library and the open paper each time.
 */
export const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

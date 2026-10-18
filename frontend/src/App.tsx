import { QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "./app/AppShell";
import { queryClient } from "./lib/queryClient";

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppShell />
    </QueryClientProvider>
  );
}

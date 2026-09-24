import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "./app/AppShell";
const queryClient = new QueryClient();

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppShell />
    </QueryClientProvider>
  );
}

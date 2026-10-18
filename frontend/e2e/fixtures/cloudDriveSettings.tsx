import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CloudDriveSection } from "../../src/features/settings/CloudDriveSection";
import "../../src/index.css";

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <main style={{ maxWidth: 800, margin: "40px auto", padding: 20 }}><CloudDriveSection /></main>
  </QueryClientProvider>,
);

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TranslationDialog } from "../../src/features/reader/TranslationDialog";
import "../../src/index.css";

function Fixture() {
  const [open, setOpen] = useState(true);
  return <TranslationDialog open={open} onOpenChange={setOpen} paperId="warning-test" currentPage={1} />;
}
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Fixture />
  </QueryClientProvider>,
);

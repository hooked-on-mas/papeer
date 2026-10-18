import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LibrarySidebar } from "../../src/features/library/LibrarySidebar";
import { OrganizeDialogHost } from "../../src/features/library/OrganizeDialog";
import { AppDialogs } from "../../src/components/AppDialogs";
import { libraryJobHandlers } from "../../src/app/libraryJobs";
import { useJobEvents } from "../../src/features/jobs/jobEvents";
import { registerJobHandlers } from "../../src/features/jobs/jobHandlers";
import { useStore } from "../../src/store";
import "../../src/index.css";

const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
registerJobHandlers(libraryJobHandlers);
useStore.setState({ uiStateLoaded: true });

/** The library's sidebar (its folders' menus), the organize dialog and the notices; the undo history is shown as text. */
function Fixture() {
  useJobEvents();
  const history = useStore((s) => s.moveHistory);
  return <div className="flex h-screen bg-background text-foreground">
    <div className="h-screen w-80 border-r bg-sidebar"><LibrarySidebar /></div>
    <output data-testid="history" className="p-2 text-xs">{JSON.stringify(history)}</output>
    <OrganizeDialogHost />
    <AppDialogs />
  </div>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={query}><Fixture /></QueryClientProvider>);

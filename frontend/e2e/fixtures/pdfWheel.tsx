import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Reader } from "../../src/features/reader/Reader";
import { useStore } from "../../src/store";
import { queryClient } from "../../src/lib/queryClient";
import "../../src/index.css";

const paper = "wheel-test";
queryClient.setDefaultOptions({ queries: { staleTime: Infinity, retry: false } });
queryClient.setQueryData(["reading", paper], { page_count: 3, source_page_count: 3, has_translated: true,
  has_article: false, preview: null, completed_pages: [1, 2, 3], empty_pages: [], original_mtime: 1,
  translated_pages: Object.fromEntries([1, 2, 3].map(n => [String(n), { file: "original.pdf", index: n - 1, mtime: 1 }])) });
queryClient.setQueryData(["sticky-notes", paper], []);
queryClient.setQueryData(["messages", paper], []);
queryClient.setQueryData(["ink-pages", paper], []);
useStore.setState({ activePaperId: paper, currentPage: 1, zoom: 1, translatedOnly: false, inkBarOpen: false });

function Fixture() {
  const page = useStore(s => s.currentPage), zoom = useStore(s => s.zoom);
  return <QueryClientProvider client={queryClient}>
    <output aria-label="Test page">{page}</output>
    <select aria-label="Test zoom" value={zoom} onChange={e => useStore.getState().setZoom(Number(e.target.value))}>
      <option value="1">100%</option><option value="3">300%</option>
    </select>
    <div style={{ width: 1200, height: 700 }}><Reader /></div>
  </QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);

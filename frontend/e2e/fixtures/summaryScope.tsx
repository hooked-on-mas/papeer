import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppDialogs } from "../../src/components/AppDialogs";
import { generateArticle } from "../../src/app/actions";
import { queryClient } from "../../src/lib/queryClient";
import "../../src/index.css";

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <button onClick={() => { void generateArticle("long"); void generateArticle("long"); }}>長い資料を要約</button>
    <button onClick={() => void generateArticle("no-outline")}>目次のない資料を要約</button>
    <button onClick={() => void generateArticle("existing")}>既存サマリーを再作成</button>
    <button onClick={() => void generateArticle("short")}>短い資料を要約</button>
    <AppDialogs />
  </QueryClientProvider>,
);

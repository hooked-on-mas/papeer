import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api, unwrap } from "../../src/api/client";
import { useSettings } from "../../src/api/hooks";
import { ConnectionSection, useConnectionForm } from "../../src/features/settings/ConnectionSection";
import "../../src/index.css";

function Fixture() {
  const { data: settings } = useSettings();
  const form = useConnectionForm(true, settings);
  const [saved, setSaved] = useState(0);
  return <main style={{ maxWidth: 800, margin: "40px auto", padding: 20 }}>
    <ConnectionSection form={form} />
    <button disabled={!form.dirty} onClick={async () => {
      await unwrap(api.PUT("/api/settings", { body: form.values() }));
      setSaved(previous => previous + 1);
    }}>保存</button>
    <p role="status">保存回数: {saved}</p>
  </main>;
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Fixture />
  </QueryClientProvider>,
);

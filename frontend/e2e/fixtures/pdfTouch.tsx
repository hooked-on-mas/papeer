// A real pair of PdfPanes, without a sidecar or the user's library.
import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PdfPane } from "../../src/features/reader/PdfPane";
import { createScrollSync } from "../../src/features/reader/scrollSync";
import { usePdfTouchOwner } from "../../src/features/reader/usePdfTouch";
import { useStore } from "../../src/store";
import { InkOverlay } from "../../src/features/reader/InkOverlay";
import type { InkEditor } from "../../src/features/reader/useInkEditor";
import "../../src/index.css";

function Fixture() {
  const zoom = useStore(s => s.zoom);
  const [ink, setInk] = useState(false);
  const left = useRef<HTMLDivElement>(null), right = useRef<HTMLDivElement>(null);
  const sync = useMemo(() => createScrollSync(() => usePdfTouchOwner.getState().pane), []);
  return <>
    <select aria-label="Test zoom" value={zoom} onChange={e => useStore.getState().setZoom(Number(e.target.value))}>
      <option value={zoom}>{zoom}</option>{[0, 0.8, 1, 2, 3, 4].filter(v => v !== zoom).map(v => <option key={v} value={v}>{v}</option>)}
    </select>
    <label><input type="checkbox" checked={ink} onChange={e => setInk(e.target.checked)} />Test ink overlay</label>
    <div style={{ display: "flex", marginLeft: 100, marginTop: 60, width: 1100, height: 600 }}>
      <div data-test-pane="left" style={{ width: 500 }}>
        <PdfPane url="/touch-fixture.pdf" pageNumber={1} zoom={zoom} scrollRef={left} onScroll={e => sync(e.currentTarget, right.current)} />
      </div>
      <div data-test-pane="right" style={{ width: 600 }}>
        <PdfPane url="/touch-fixture.pdf" pageNumber={1} zoom={zoom} scrollRef={right} onScroll={e => sync(e.currentTarget, left.current)} translated />
      </div>
    </div>
    {ink && <TestInkOverlay />}
  </>;
}

// Exercise the real ink layer's touch handlers with a selected rectangle, without saving ink.
function TestInkOverlay() {
  const editor = useMemo(() => {
    const stroke = { id: "test-rectangle", kind: "rectangle", color: "#000000", width: 0.003,
      points: [[0.05, 0.05], [0.95, 0.05], [0.95, 0.95], [0.05, 0.95], [0.05, 0.05]] };
    return { strokes: [stroke], selected: [stroke], selection: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 },
      tool: "region", color: "#000000", width: 0.003, preferences: { eraserRadius: 10 },
      selectedIds: [stroke.id], visible: true, locked: false, beforeCommand: { current: null },
      change: () => {}, setSelectedIds: () => {}, setTool: () => {}, remove: () => {},
    } as unknown as InkEditor;
  }, []);
  useEffect(() => {
    const surface = document.querySelector<HTMLElement>('[data-test-pane="left"] [data-pdf-surface]');
    if (!surface) return;
    // A nested root preserves native bubbling through PdfPane's event handlers. A portal from
    // this fixture would instead bubble through the fixture and bypass the scroller entirely.
    const mount = document.createElement("div");
    surface.appendChild(mount);
    const root = createRoot(mount), box = surface.getBoundingClientRect();
    root.render(<InkOverlay editor={editor} aspectRatio={box.height / box.width} onCapture={() => {}} />);
    return () => { queueMicrotask(() => { root.unmount(); mount.remove(); }); };
  }, [editor]);
  return null;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient()}><Fixture /></QueryClientProvider>);

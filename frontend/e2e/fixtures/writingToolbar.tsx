import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { WritingHistoryButtons, WritingTarget, WritingToolbarPortal, WritingToolbarProvider, WritingToolbarSlot, useWritingPane, useWritingToolbar, type WritingSide } from "../../src/features/reader/WritingToolbar";

function Pane({ side, presentation }: { side: WritingSide; presentation: "buttons" | "select" }) {
  const { servesToolbar, slot, activate } = useWritingPane(side, true);
  const [count, setCount] = useState(0);
  return <div data-pane={side} onPointerDownCapture={activate} onFocusCapture={activate}>
    {servesToolbar && <WritingToolbarPortal slot={slot}><div role="toolbar">
      <WritingTarget side={side} presentation={presentation} />
      <WritingHistoryButtons canUndo={count > 0} canRedo={false} onUndo={() => setCount(value => value - 1)} />
    </div></WritingToolbarPortal>}
    <button onClick={() => setCount(value => value + 1)}>Draw {side}</button><output>{count}</output>
  </div>;
}

function Demo({ name, presentation }: { name: string; presentation: "buttons" | "select" }) {
  const [translated, setTranslated] = useState(true);
  const [narrow, setNarrow] = useState(false);
  return <section aria-label={name} style={{ width: narrow ? 320 : 700 }}>
    <button onClick={() => setTranslated(value => !value)}>Toggle translation</button>
    <button onClick={() => setNarrow(value => !value)}>Resize</button>
    <WritingToolbarSlot />
    <Measurement />
    <Pane side="original" presentation={presentation} />
    {translated && <Pane side="translated" presentation={presentation} />}
  </section>;
}

function Measurement() { return <span data-width="">{useWritingToolbar()?.width}</span>; }

createRoot(document.getElementById("root")!).render(<StrictMode>
  <WritingToolbarProvider><Demo name="PC" presentation="buttons" /></WritingToolbarProvider>
  <WritingToolbarProvider><Demo name="Web" presentation="select" /></WritingToolbarProvider>
</StrictMode>);

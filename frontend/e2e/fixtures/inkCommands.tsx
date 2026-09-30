import { createRoot } from "react-dom/client";
import { InkOverlay } from "../../src/features/reader/InkOverlay";
import { useInkEditor, useInkTools } from "../../src/features/reader/useInkEditor";
import "../../src/index.css";

useInkTools.getState().setTool("arrow");
function Fixture() {
  const editor = useInkEditor("ink-command-fixture", "original", 1, 1.2);
  return <div ref={editor.scopeRef} onPointerDownCapture={editor.activate}>
    <output data-ready={editor.ink.ready}>{JSON.stringify(editor.strokes)}</output>
    <div style={{ position: "relative", width: 500, height: 600, margin: 30 }}>
      <InkOverlay editor={editor} aspectRatio={1.2} onCapture={() => {}} />
    </div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);

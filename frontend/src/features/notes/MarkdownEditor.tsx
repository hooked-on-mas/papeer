import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorView, placeholder } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { openSearchPanel } from "@codemirror/search";

export function MarkdownEditor({ value, visible = true, onChange, onBlur }: { value: string; visible?: boolean; onChange: (text: string) => void; onBlur: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onBlur });
  handlers.current = { onChange, onBlur };
  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({ parent: host.current, state: EditorState.create({ doc: value, extensions: [
      basicSetup, markdown(), EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": "論文のメモ", role: "textbox", "aria-multiline": "true" }),
      placeholder("論文に関するメモを自由に記述できます…"),
      EditorView.updateListener.of(update => { if (update.docChanged) handlers.current.onChange(update.state.doc.toString()); }),
      EditorView.domEventHandlers({ blur: () => handlers.current.onBlur() }),
      EditorView.theme({ "&": { height: "100%", background: "transparent", color: "inherit" },
        ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono, monospace)", fontSize: "0.875rem" },
        ".cm-content": { minHeight: "100%", padding: "12px 0" }, ".cm-gutters": { background: "transparent", color: "var(--muted-foreground)", border: "none" },
        ".cm-panels": { background: "var(--muted)", color: "var(--foreground)" }, ".cm-textfield": { background: "var(--background)", color: "var(--foreground)" },
        ".cm-button": { color: "var(--foreground)", background: "var(--background)" }, ".cm-cursor": { borderLeftColor: "currentColor" } }),
    ] }) });
    view.current = editor;
    return () => { view.current = null; editor.destroy(); };
    // A mounted editor belongs to one memo (keyed by its attachment ID). Changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);
  useEffect(() => {
    if (visible && view.current) { view.current.requestMeasure(); view.current.focus(); }
  }, [visible]);
  return <div className={`${visible ? "flex" : "hidden"} min-h-0 flex-1 flex-col gap-1`}>
    <button className="self-end text-xs text-muted-foreground hover:text-foreground" onClick={() => { if (view.current) openSearchPanel(view.current); }}>検索・置換</button>
    <div ref={host} className="min-h-0 flex-1 overflow-hidden rounded-lg border" />
  </div>;
}

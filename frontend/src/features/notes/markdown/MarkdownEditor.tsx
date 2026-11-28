import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorView, placeholder } from "@codemirror/view";
import { EditorState, StateEffect } from "@codemirror/state";
import type { Extension } from '@codemirror/state';
import { markdown } from "@codemirror/lang-markdown";
import { openSearchPanel } from "@codemirror/search";

type EditorStatePort = { getEditorState: () => EditorState | undefined; setEditorState: (state: EditorState) => void };
export function MarkdownEditor({ value, visible = true, onChange, onBlur, revealEnd, statePort, externalVersion = 0 }: { value: string; visible?: boolean; revealEnd?: number; externalVersion?: number; onChange: (text: string) => void; onBlur: () => void; statePort?: EditorStatePort }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onBlur });
  const configuration = useRef<Extension[]>([]);
  const acceptedExternalVersion = useRef(externalVersion);
  handlers.current = { onChange, onBlur };
  useEffect(() => {
    if (!host.current) return;
    const remembered = statePort?.getEditorState();
    const extensions = [
      basicSetup, markdown(), EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": "Markdownノート", role: "textbox", "aria-multiline": "true" }),
      placeholder("ノートを自由に記述できます…"),
      EditorView.updateListener.of(update => { statePort?.setEditorState(update.state); if (update.docChanged) handlers.current.onChange(update.state.doc.toString()); }),
      EditorView.domEventHandlers({ blur: () => handlers.current.onBlur() }),
      EditorView.theme({ "&": { height: "100%", background: "transparent", color: "inherit" },
        ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono, monospace)", fontSize: "0.875rem" },
        ".cm-content": { minHeight: "100%", padding: "12px 0" }, ".cm-gutters": { background: "transparent", color: "var(--muted-foreground)", border: "none" },
        ".cm-panels": { background: "var(--muted)", color: "var(--foreground)" }, ".cm-textfield": { background: "var(--background)", color: "var(--foreground)" },
        ".cm-button": { color: "var(--foreground)", background: "var(--background)" }, ".cm-cursor": { borderLeftColor: "currentColor" } }),
    ];
    configuration.current = extensions;
    // Rebind listeners to this owner while retaining CodeMirror's document, selection and history fields.
    const state = remembered?.doc.toString() === value ? remembered.update({ effects: StateEffect.reconfigure.of(extensions) }).state
      : EditorState.create({ doc: value, extensions });
    const editor = new EditorView({ parent: host.current, state });
    view.current = editor;
    return () => { statePort?.setEditorState(editor.state); view.current = null; editor.destroy(); };
    // A mounted editor belongs to one memo (keyed by its attachment ID). Changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    if (acceptedExternalVersion.current !== externalVersion) {
      // Remote adoption establishes a new editing base. Never put it in a local Undo group.
      editor.setState(EditorState.create({ doc: value, extensions: configuration.current }));
      statePort?.setEditorState(editor.state); acceptedExternalVersion.current = externalVersion;
    } else if (editor.state.doc.toString() !== value) {
      // Templates/append are local commands and remain undoable.
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    }
  }, [value, externalVersion, statePort]);
  useEffect(() => {
    if (visible && view.current) { view.current.requestMeasure(); view.current.focus(); }
  }, [visible]);
  useEffect(() => {
    if (revealEnd && view.current) view.current.dispatch({ selection: { anchor: view.current.state.doc.length }, scrollIntoView: true });
  }, [revealEnd]);
  return <div className={`${visible ? "flex" : "hidden"} min-h-0 flex-1 flex-col gap-1`}>
    <button className="self-end text-xs text-muted-foreground hover:text-foreground" onClick={() => { if (view.current) openSearchPanel(view.current); }}>検索・置換</button>
    <div ref={host} className="min-h-0 flex-1 overflow-hidden rounded-lg border" />
  </div>;
}

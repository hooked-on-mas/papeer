import { useEffect, useState } from "react";
import { api, authorizedUrl, unwrap } from "@/api/client";
import { useStore } from "@/store";
import type { Bounds } from "./inkGeometry";
import type { InkSide } from "./inkStore";
import { flushInkSaves } from "./inkStore";

export function InkCapture({ paperId, page, side, box, onClose }: { paperId: string; page: number; side: InkSide; box: Bounds; onClose: () => void }) {
  const [file, setFile] = useState("");
  const [error, setError] = useState("");
  const [includeInk, setIncludeInk] = useState(false);
  useEffect(() => {
    let alive = true;
    setFile(""); setError("");
    (async () => {
      if (includeInk) await flushInkSaves(paperId, side);
      if (!alive) return null;
      return await unwrap(api.POST("/api/papers/{paper_id}/ink-capture-v2", { params: { path: { paper_id: paperId } },
        body: { ...box, page, side, include_ink: includeInk } })) as { file: string };
    })()
      .then(value => { if (alive && value) setFile(value.file); }).catch(e => { if (alive) setError(String(e.message)); });
    return () => { alive = false; };
  }, [paperId, page, side, box, includeInk]);
  const url = file ? authorizedUrl(`/api/papers/${paperId}/${file}`) : "";
  const copy = async () => {
    try {
      if (!navigator.clipboard?.write) throw new Error("この環境では画像コピーが使えません。「メモに追加」を利用してください。");
      // Start the clipboard operation during the user's click, keeping browser permission valid.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": fetch(url).then(r => {
        if (!r.ok) throw new Error("画像を取得できませんでした。"); return r.blob();
      }) })]);
      useStore.getState().setStatus("選択範囲を画像としてコピーしました。画像を貼り付けられるアプリで利用できます。");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return <div className="absolute z-30 top-2 right-2 w-72 max-w-[95%] max-h-[90%] overflow-auto rounded border bg-background p-3 shadow-lg text-xs" role="dialog" aria-label="範囲の切り取り">
    <div className="flex justify-between mb-2"><span>切り取り・p.{page}</span><button onClick={onClose}>閉じる</button></div>
    <label className="flex items-center gap-1 mb-2"><input type="checkbox" checked={includeInk} onChange={e => { setFile(""); setIncludeInk(e.target.checked); }} />書き込みを含める</label>
    {!file && !error && <p>画像を作成しています…</p>}
    {file && <><img src={url} alt={`p.${page}の図・数式`} className="w-full rounded border mb-2" />
      <div className="flex gap-2"><button className="border rounded px-2 py-1" onClick={() => void copy()}>画像をコピー</button>
        <button className="bg-primary text-primary-foreground rounded px-2 py-1" onClick={() => {
          const store = useStore.getState();
          store.setNoteInsert({ paperId, text: `\n\n![p.${page} ${side === "original" ? "原文" : "日本語訳"}の図・数式](${file})\n\n[出典 p.${page}](papeer://${paperId}/${page})\n` });
          store.openSidePanel("notes"); onClose();
        }}>メモに追加</button></div></>}
    {error && <p role="alert" className="mt-2 text-destructive">{error}</p>}
  </div>;
}

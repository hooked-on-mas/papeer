import { useState } from "react";
import { api, unwrap } from "@/api/client";
import { Button } from "@/components/ui/button";
import { showError } from "@/components/errorDialog";
import { shell } from "@/shell";

type Term = { source: string; target: string };
type Conflict = { source: string; existing: string; imported: string };
type ImportResult = { terms: Term[]; added: Term[]; skipped: number; conflicts: Conflict[] };
const filters = [{ name: "専門用語辞書 (JSON)", extensions: ["json"] }];

export function GlossaryTransfer({ terms, disabled, onPending, onImport }: {
  terms: Term[];
  disabled: boolean;
  onPending: (pending: boolean) => void;
  onImport: (terms: Term[], added: Term[]) => void;
}) {
  const [message, setMessage] = useState("");
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const transfer = async (importing: boolean) => {
    if (disabled) return;
    onPending(true);
    try {
      const paths = importing ? await shell.openFiles(filters) : [];
      if (paths.length > 1) throw new Error("辞書ファイルを1つ選択してください。");
      const path = importing ? paths[0] : await shell.saveFile("Papeer-glossary.json", filters);
      if (!path) return;
      const entries = terms.filter(t => t.source.trim() || t.target.trim());
      if (importing) {
        const result = await unwrap(api.POST("/api/glossary/import", { body: { path, terms: entries } })) as ImportResult;
        if (result.added.length) onImport(result.terms, result.added);
        setConflicts(result.conflicts);
        setMessage(`${result.added.length}件を追加候補として読み込みました。重複${result.skipped}件は既存の訳語を保持しました。確認・修正後に「辞書を保存」で反映できます。`);
      } else {
        const result = await unwrap(api.POST("/api/glossary/export", { body: { path, terms: entries } })) as { count: number };
        setMessage(`${result.count}件の辞書を保存しました：${path}`);
      }
    } catch (error) {
      showError(error, importing ? "辞書を読み込めませんでした" : "辞書をエクスポートできませんでした");
    } finally {
      onPending(false);
    }
  };
  return <div className="border-t mt-3 pt-3 space-y-2">
    <div className="flex gap-2">
      <Button variant="outline" disabled={disabled} onClick={() => void transfer(false)}>辞書をエクスポート</Button>
      <Button variant="outline" disabled={disabled} onClick={() => void transfer(true)}>辞書を読み込み</Button>
    </div>
    <p className="text-muted-foreground">JSON形式。エクスポートには未保存の編集・追加候補を含む全件が入ります。読み込みは既存の訳語を保持して追加します。</p>
    {message && <p role="status" className="break-all">{message}</p>}
    {!!conflicts.length && <details>
      <summary className="cursor-pointer">訳語が異なる重複（{conflicts.length}件）</summary>
      <div className="max-h-40 overflow-auto"><table className="w-full text-left">
        <thead><tr><th>原語</th><th>既存の訳語（保持）</th><th>読み込んだ訳語</th></tr></thead>
        <tbody>{conflicts.map(c => <tr key={c.source}><td>{c.source}</td><td>{c.existing}</td><td>{c.imported}</td></tr>)}</tbody>
      </table></div>
    </details>}
  </div>;
}

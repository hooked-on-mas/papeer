import { useState } from "react";
import type { GlossaryWarning } from "@/api/hooks";
import { emitAppEvent } from "@/lib/appEvents";
import { jumpToPage } from "./navigation";

/** Shown before "show all": a long list is for skimming, and every item is on the page anyway. */
const SHOWN = 50;

/**
 * Paragraphs whose translation lacks the rendering of a glossary term found in the source (the
 * check after translation, translation-report.json glossary_warnings). Choosing one opens its
 * paragraph in the translation editor; spelling differences are not listed.
 */
export function GlossaryWarnings({ warnings }: { warnings: GlossaryWarning[] }) {
  const [all, setAll] = useState(false);
  if (!warnings.length) return null;
  const sorted = [...warnings].sort((a, b) => a.page - b.page);
  const shown = all ? sorted : sorted.slice(0, SHOWN);
  return <div className="space-y-2 pt-2">
    <p className="font-medium">辞書の訳語が見当たらない段落（{warnings.length}件）</p>
    <p className="text-xs text-muted-foreground">原文に辞書の語があるのに、訳文に登録した訳語がありません。文脈に合わせた訳し分けなら直す必要はありません。</p>
    {shown.map(warning => <button key={warning.unit} className="block w-full text-left border rounded p-3 hover:bg-muted"
      onClick={() => {
        jumpToPage(warning.page);
        emitAppEvent("open-paragraph-editor", { page: warning.page, side: "original", text: warning.excerpt, unit: warning.unit });
      }}>
      <span>p.{warning.page} — {warning.terms.map(term => `${term.source} → ${term.target}`).join("、")}</span>
      <span className="block text-xs text-muted-foreground truncate">{warning.excerpt}</span>
    </button>)}
    {sorted.length > shown.length && <button className="text-xs underline text-muted-foreground" onClick={() => setAll(true)}>
      残り{sorted.length - shown.length}件を表示</button>}
  </div>;
}

import { useEffect, useMemo, useState } from "react";
import { Settings2, Tags } from "lucide-react";
import type { PaperData } from "@/api/hooks";
import { TagChip } from "@/components/ui/TagChip";
import { openSettings } from "@/features/settings/settingsNavigation";

export function LibraryTags({ papers, selected, onSelect }: {
  papers: PaperData[]; selected: string; onSelect: (name: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (selected && !papers.some(p => p.tags?.includes(selected))) onSelect("");
  }, [papers, selected, onSelect]);
  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    papers.forEach(paper => paper.tags?.forEach(name => counts.set(name, (counts.get(name) ?? 0) + 1)));
    return [...counts].sort((a, b) => a[0].localeCompare(b[0], "ja"));
  }, [papers]);
  const visible = expanded ? tags : tags.filter(([name], i) => i < 6 || name === selected);
  return <section className="rounded-lg border bg-background/60 px-2.5 py-2 space-y-2" aria-label="タグで絞り込み">
    <div className="flex items-center justify-between text-[0.75rem]">
      <span className="flex items-center gap-1.5 font-medium text-muted-foreground"><Tags className="size-3.5" />タグ<span className="tabular-nums opacity-60">{tags.length}</span></span>
      <button className="flex items-center gap-1 rounded px-1 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => openSettings("tags")}><Settings2 className="size-3" />管理</button>
    </div>
    {tags.length ? <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto p-0.5">
      <button aria-pressed={!selected} onClick={() => onSelect("")}
        className={`rounded-full border px-2 text-[0.75rem] leading-5 ${!selected ? "bg-foreground text-background border-foreground" : "text-muted-foreground hover:bg-muted"}`}>すべて</button>
      {visible.map(([name, count]) => <TagChip key={name} name={name} count={count} selected={selected === name} onClick={() => onSelect(selected === name ? "" : name)} />)}
      {(expanded || tags.length > visible.length) && <button className="px-1 text-[0.75rem] text-muted-foreground hover:text-foreground" onClick={() => setExpanded(!expanded)}>
        {expanded ? "折りたたむ" : `ほか${tags.length - visible.length}件を表示`}</button>}
    </div> : <p className="text-[0.75rem] text-muted-foreground leading-relaxed">「管理」でタグを追加し、論文の「メモ・整理」で選択できます。</p>}
  </section>;
}

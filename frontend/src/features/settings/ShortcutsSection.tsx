import { SHORTCUT_GROUPS } from "../../app/hotkeys";
import { shortcutKeys, withShortcutLabels } from "@/lib/platform";
import { useState } from "react";
import { Input } from "@/components/ui/input";

export function ShortcutsSection() {
  const [query, setQuery] = useState("");
  const terms = query.toLocaleLowerCase().replace(/\+/g, " ").trim().split(/\s+/).filter(Boolean);
  const groups = SHORTCUT_GROUPS.map(group => ({ ...group, items: group.items.filter(item => {
    const text = `${group.title} ${withShortcutLabels(item.label)} ${shortcutKeys(item.keys).join(" ")}`.toLocaleLowerCase();
    const keys = shortcutKeys(item.keys).join(" ").toLocaleLowerCase().split(/[^a-z0-9]+/);
    return terms.every(term => /^[a-z0-9]$/.test(term) ? keys.includes(term) : text.includes(term));
  }) })).filter(group => group.items.length);
  return (
    <div className="space-y-5">
      <Input type="search" aria-label="ショートカットを検索" placeholder="操作名やキーで検索（例：検索 / Ctrl F）" value={query} onChange={e => setQuery(e.target.value)} />
      {!groups.length && <p role="status" className="text-muted-foreground">一致する操作がありません。検索語を変えてください。</p>}
      {groups.map((group) => (
        <section key={group.title}>
          <h3 className="mb-1.5 text-[0.75rem] font-medium text-muted-foreground">{group.title}</h3>
          <ul className="divide-y rounded-lg border">
            {group.items.map((item) => (
              <li key={item.label} className="flex items-center justify-between gap-4 px-3 py-2">
                <span>{withShortcutLabels(item.label)}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {shortcutKeys(item.keys).map((key) => (
                    <kbd key={key} className="min-w-6 rounded border bg-muted px-1.5 py-0.5 text-center font-sans text-[0.75rem] text-muted-foreground">
                      {key}
                    </kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className="text-[0.75rem] text-muted-foreground">文字入力中はページ移動などのショートカットは働きません。</p>
    </div>
  );
}

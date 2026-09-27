import { SHORTCUT_GROUPS } from "../../app/hotkeys";

export function ShortcutsSection() {
  return (
    <div className="space-y-5">
      {SHORTCUT_GROUPS.map((group) => (
        <section key={group.title}>
          <h3 className="mb-1.5 text-[0.75rem] font-medium text-muted-foreground">{group.title}</h3>
          <ul className="divide-y rounded-lg border">
            {group.items.map((item) => (
              <li key={item.label} className="flex items-center justify-between gap-4 px-3 py-2">
                <span>{item.label}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {item.keys.map((key) => (
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

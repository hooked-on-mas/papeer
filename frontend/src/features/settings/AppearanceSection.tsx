import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "cn";
import { useTheme } from "../../app/ThemeProvider";

const THEMES = [
  { id: "light", label: "ライト", icon: Sun },
  { id: "dark", label: "ダーク", icon: Moon },
  { id: "system", label: "システムに合わせる", icon: Monitor },
] as const;

export function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="space-y-2">
      <h3 className="font-medium">テーマ</h3>
      <div role="radiogroup" aria-label="テーマ" className="grid grid-cols-3 gap-2">
        {THEMES.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={theme === id}
            onClick={() => setTheme(id)}
            className={cn(
              "flex flex-col items-center gap-2 rounded-lg border px-3 py-4 transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              theme === id ? "border-primary bg-primary/5 text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            <Icon className="size-5" />
            {label}
          </button>
        ))}
      </div>
      <p className="text-[0.75rem] text-muted-foreground">テーマはすぐに反映され、保存ボタンを押す必要はありません。</p>
    </div>
  );
}

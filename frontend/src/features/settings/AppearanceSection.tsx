import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "cn";
import { useTheme } from "../../app/ThemeProvider";
import { useStore } from "@/store";
import { PAGE_FILTERS, pageAppearance, type PageFilter } from "../reader/pageAppearance";

const THEMES = [
  { id: "light", label: "ライト", icon: Sun },
  { id: "dark", label: "ダーク", icon: Moon },
  { id: "system", label: "システムに合わせる", icon: Monitor },
] as const;

const optionClass = (checked: boolean) => cn(
  "flex flex-col items-center gap-2 rounded-lg border px-3 py-4 transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
  checked ? "border-primary bg-primary/5 text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
);

export function AppearanceSection() {
  const { theme, setTheme, dark } = useTheme();
  const pageFilter = useStore((s) => s.pageFilter);
  const setPageFilter = useStore((s) => s.setPageFilter);
  return (
    <div className="space-y-6">
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
              className={optionClass(theme === id)}
            >
              <Icon className="size-5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="font-medium">ダークテーマでのPDFページ</h3>
        <div role="radiogroup" aria-label="ダークテーマでのPDFページ" className="grid grid-cols-3 gap-2">
          {PAGE_FILTERS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={pageFilter === id}
              onClick={() => setPageFilter(id)}
              className={optionClass(pageFilter === id)}
            >
              <PagePreview filter={id} />
              {label}
            </button>
          ))}
        </div>
        <p className="text-[0.75rem] text-muted-foreground leading-relaxed">
          {"白いページがまぶしいときに、原文・翻訳のPDFの見た目だけを変えます。"}
          {"「反転」は紙を暗く、文字を明るくします。図や写真も明るさが反転します（色合いはおおむね保たれます）。書き込みは色合いを保ち、黒いペンは明るく表示します。"}
          {"「セピア」は紙を暗めの生成り色にします。"}
          {!dark && "ライトテーマでは常に通常の見た目です。"}
          {"図・数式のコピーやPDFの保存には影響しません。"}
        </p>
      </div>

      <p className="text-[0.75rem] text-muted-foreground">どちらの設定もすぐに反映され、保存ボタンを押す必要はありません。</p>
    </div>
  );
}

/** A small page drawn with the filter it would get under the dark theme. */
function PagePreview({ filter }: { filter: PageFilter }) {
  return (
    <span aria-hidden className="flex h-12 w-9 flex-col gap-1 rounded-sm border bg-white p-1.5" style={{ filter: pageAppearance(filter, true).filter }}>
      <span className="h-0.5 w-full bg-neutral-800" />
      <span className="h-0.5 w-4/5 bg-neutral-800" />
      <span className="h-3 w-full rounded-[1px] bg-sky-500" />
      <span className="h-0.5 w-full bg-neutral-800" />
      <span className="h-0.5 w-3/5 bg-neutral-800" />
    </span>
  );
}

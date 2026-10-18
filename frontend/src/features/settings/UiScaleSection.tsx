import { cn } from "cn";
import { useUiScale } from "@/app/uiScale";
import { UI_SCALES } from "@/lib/uiScale";
import { withShortcutLabels } from "@/lib/platform";

/** 設定「表示」の「文字の大きさ」: the size of the whole UI (lib/uiScale.ts), apart from the PDF zoom. */
export function UiScaleSection() {
  const scale = useUiScale((s) => s.scale);
  const setScale = useUiScale((s) => s.setScale);
  return (
    <div className="space-y-2">
      <h3 className="font-medium">文字の大きさ</h3>
      <div role="radiogroup" aria-label="文字の大きさ" className="grid grid-cols-5 gap-2">
        {UI_SCALES.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={scale === value}
            onClick={() => setScale(value)}
            className={cn(
              "flex flex-col items-center gap-1 rounded-lg border px-2 py-2 tabular-nums transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              scale === value ? "border-primary bg-primary/5 text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            {/* Each sample is as large as body text would be with that choice, whatever the current one. */}
            <span aria-hidden="true" className="font-medium leading-none" style={{ fontSize: `${value / scale}em` }}>あA</span>
            {label}
          </button>
        ))}
      </div>
      <p className="text-[0.75rem] text-muted-foreground leading-relaxed">
        画面全体の文字とボタンに反映します。
        {withShortcutLabels("PDFの倍率は別に変更できます（Ctrl + / Ctrl − / Ctrl+ホイール）。")}
      </p>
    </div>
  );
}

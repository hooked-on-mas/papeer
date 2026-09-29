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
              "flex flex-col items-center gap-1 rounded-lg border px-2 py-3 tabular-nums transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
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
        メニュー・ライブラリ・サマリー・チャット・メモなど、画面全体の文字とボタンの大きさを変えます。
        {withShortcutLabels("PDFの表示倍率はリーダーの拡大・縮小（Ctrl + / Ctrl − / Ctrl+ホイール）で別に変えられます。")}
        すぐに反映され、保存ボタンを押す必要はありません。
      </p>
    </div>
  );
}

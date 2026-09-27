import { Hash, X } from "lucide-react";
import { cn } from "@/lib/utils";

const tones = [
  "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/20",
  "bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/20",
  "bg-teal-500/10 text-teal-700 dark:text-teal-300 border-teal-500/20",
  "bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/20",
];

export function TagChip({ name, count, selected, onClick, onRemove, disabled }: {
  name: string; count?: number; selected?: boolean; onClick?: () => void; onRemove?: () => void; disabled?: boolean;
}) {
  const hash = Array.from(name).reduce((value, char) => (value * 31 + char.codePointAt(0)!) >>> 0, 0);
  const content = <><Hash className="size-3 shrink-0 opacity-60" /><span className="truncate">{name}</span>
    {count !== undefined && <span className="ml-0.5 tabular-nums opacity-65">{count}</span>}</>;
  return <span className={cn("inline-flex max-w-full items-center rounded-full border text-[0.75rem] font-medium leading-5", tones[hash % tones.length],
    selected && "ring-1 ring-current", disabled && "opacity-50")}
    onPointerDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
    {onClick ? <button type="button" disabled={disabled} aria-pressed={selected} title={`${name}で絞り込み`}
      className="inline-flex min-w-0 items-center gap-1 rounded-full px-2 hover:brightness-90 focus-visible:outline-2 focus-visible:outline-offset-2"
      onClick={e => { e.stopPropagation(); onClick(); }}>{content}</button>
      : <span className="inline-flex min-w-0 items-center gap-1 px-2" title={name}>{content}</span>}
    {onRemove && <button type="button" disabled={disabled} aria-label={`「${name}」をこの論文から外す`} title="この論文からタグを外す"
      className="mr-0.5 rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/15 focus-visible:outline-2"
      onClick={e => { e.stopPropagation(); onRemove(); }}><X className="size-3" /></button>}
  </span>;
}

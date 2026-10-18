import { ChevronDown, PanelRight } from "lucide-react";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";
import { SIDE_PANEL_BUTTONS } from "./sidePanelButtons";
import type { SidePanel } from "./sidePanel";

/** Same controls on desktop and Web; no store, API, provider or keyboard binding. */
export function SidePanelChooser({ selected, available, onChange, className, titleFor }: {
  selected: SidePanel | null; available: readonly SidePanel[]; onChange: (panel: SidePanel | null) => void;
  className?: string; titleFor?: (label: string, key: string) => string;
}) {
  const choices = SIDE_PANEL_BUTTONS.filter(choice => available.includes(choice.tab));
  if (!choices.length) return null;
  const label = choices.find(choice => choice.tab === selected)?.label ?? "右パネル";
  return <DropdownMenu>
    <DropdownMenuTrigger className={className} aria-label="右パネルを選択" title={selected ? `${label}を右に表示中` : "サマリー・チャット・メモを右に表示"}>
      <PanelRight className="size-3.5" />{label}<ChevronDown className="size-3" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-44">
      {choices.map(({ tab, label, icon: Icon, key }) => <DropdownMenuCheckboxItem key={tab} checked={selected === tab} closeOnClick
        aria-label={`${label}を右に表示`} title={titleFor?.(label, key)} onCheckedChange={() => onChange(selected === tab ? null : tab)}>
        <Icon /> {label}
      </DropdownMenuCheckboxItem>)}
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={!selected} onClick={() => onChange(null)}>右パネルを閉じる</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}

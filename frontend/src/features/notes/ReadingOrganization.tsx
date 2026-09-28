import { openSettings } from "@/features/settings/settingsNavigation";
import { ChevronDown, Settings2 } from "lucide-react";
import type { PaperData } from "@/api/hooks";
import { useTagChoices } from "@/api/tagChoices";
import { setPaperReadStatus, tagPaper } from "@/app/actions";
import { useShownOrganization } from "@/app/useOrganizing";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { TagCombobox } from "./TagCombobox";

/**
 * The paper's reading status and tags. Each change is saved at once, and shown before the sidecar has
 * answered, so that tags can be put on one after another (sent as differences: tagQueue.ts); a tag that
 * does not exist yet is made by typing its name.
 */
export function ReadingOrganization({ paper }: { paper: PaperData }) {
  const { data: tags = [], isError } = useTagChoices("paper");
  const { data: statuses = [], isError: statusError, isSuccess: statusesLoaded } = useTagChoices("status");
  const { tags: selectedTags, status: currentStatus } = useShownOrganization(paper.id, paper.tags, paper.read_status ?? "未読");
  return <section className="space-y-3">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-[0.8125rem] font-semibold">読書状態・タグ</h3>
      <button type="button" onClick={() => openSettings("tags")}
        className="flex items-center gap-1 rounded px-1 py-0.5 text-[0.75rem] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
        <Settings2 className="size-3" aria-hidden="true" />タグを管理
      </button>
    </div>
    <div className="grid grid-cols-[64px_minmax(0,1fr)] items-start gap-2 text-[0.8125rem]">
      <span id="reading-status-label" className="py-1.5">読書状態</span>
      <DropdownMenu>
        <DropdownMenuTrigger aria-labelledby="reading-status-label reading-status-value"
          className="flex w-full min-w-0 items-center gap-2 border rounded bg-background px-2 py-1.5 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
          <span id="reading-status-value" className="min-w-0 flex-1 truncate">{currentStatus || "未設定"}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="min-w-56" aria-label="読書状態">
          <DropdownMenuGroup>
            <DropdownMenuLabel>読書状態</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={currentStatus} onValueChange={value => {
              if (value !== currentStatus) void setPaperReadStatus(paper.id, value, { quiet: true });
            }}>
              {!currentStatus && <DropdownMenuRadioItem value="">未設定</DropdownMenuRadioItem>}
              {!!currentStatus && !statuses.includes(currentStatus) && <DropdownMenuRadioItem value={currentStatus} disabled>{currentStatus}{statusesLoaded ? "（削除済み）" : ""}</DropdownMenuRadioItem>}
              {statuses.map(status => <DropdownMenuRadioItem key={status} value={status}>{status}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => openSettings("reading-status")}>読書状態を管理…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <span id="paper-tags-label" className="py-1.5">タグ</span>
      <TagCombobox choices={tags} selected={selectedTags} labelledBy="paper-tags-label"
        onToggle={(name, add) => void tagPaper(paper.id, name, add, { quiet: true })} />
    </div>
    <p className="text-[0.75rem] text-muted-foreground">論文を開くと「未読」は「読書中」になります。</p>
    {(isError || statusError) && <p role="alert" className="text-xs text-destructive">読書状態・タグを読み込めませんでした。</p>}
  </section>;
}

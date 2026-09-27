import { openSettings } from "@/features/settings/settingsNavigation";
import { useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/api/client";
import type { PaperData } from "@/api/hooks";
import { useTagChoices } from "@/api/tagChoices";
import { showError } from "@/components/errorDialog";
import { TagChip } from "@/components/ui/TagChip";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuCheckboxItem, DropdownMenuSeparator, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { QK } from "@/lib/queryKeys";

export function ReadingOrganization({ paper }: { paper: PaperData }) {
  const client = useQueryClient();
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);
  const { data: tags = [], isError } = useTagChoices("paper");
  const { data: statuses = [], isError: statusError, isSuccess: statusesLoaded } = useTagChoices("status");
  const currentStatus = paper.read_status ?? "未読";
  const selectedTags = paper.tags ?? [];
  const tagChoices = Array.from(new Set([...tags, ...selectedTags]));
  const save = async (values: { tags?: string[]; read_status?: string }) => {
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    try {
      await apiRequest("PATCH", `/api/papers/${paper.id}`, values);
      await Promise.all([client.invalidateQueries({ queryKey: [QK.papers] }), client.invalidateQueries({ queryKey: [QK.tags] }), client.invalidateQueries({ queryKey: [QK.librarySearch] })]);
    } catch (error) { showError(error, "読書状態・タグを保存できませんでした"); }
    finally { saveInFlight.current = false; setSaving(false); }
  };
  return <section className="space-y-3">
    <h3 className="text-[0.8125rem] font-semibold">読書状態・タグ</h3>
    <div className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2 text-[0.8125rem]">
      <span id="reading-status-label">読書状態</span>
      <DropdownMenu>
        <DropdownMenuTrigger aria-labelledby="reading-status-label reading-status-value"
          className="flex w-full min-w-0 items-center gap-2 border rounded bg-background px-2 py-1.5 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
          <span id="reading-status-value" className="min-w-0 flex-1 truncate">{currentStatus || "未設定"}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="min-w-56" aria-label="読書状態">
          <DropdownMenuGroup>
            <DropdownMenuLabel>読書状態</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={currentStatus} onValueChange={value => { if (value !== currentStatus) void save({ read_status: value }); }}>
              {!currentStatus && <DropdownMenuRadioItem value="" disabled={saving}>未設定</DropdownMenuRadioItem>}
              {!!currentStatus && !statuses.includes(currentStatus) && <DropdownMenuRadioItem value={currentStatus} disabled>{currentStatus}{statusesLoaded ? "（削除済み）" : ""}</DropdownMenuRadioItem>}
              {statuses.map(status => <DropdownMenuRadioItem key={status} value={status} disabled={saving}>{status}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => openSettings("reading-status")}>読書状態を管理…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <span id="paper-tags-label">タグ</span>
      <DropdownMenu>
        <DropdownMenuTrigger aria-labelledby="paper-tags-label paper-tags-value"
          className="flex w-full min-w-0 items-center gap-2 border rounded bg-background px-2 py-1.5 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
          <span id="paper-tags-value" className="min-w-0 flex-1 truncate">{selectedTags.length ? `${selectedTags.length}個選択中` : "タグを選択"}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="min-w-56" aria-label="論文のタグ">
          <DropdownMenuGroup>
            <DropdownMenuLabel>論文のタグ（複数選択）</DropdownMenuLabel>
            {tagChoices.map(name => <DropdownMenuCheckboxItem key={name} checked={selectedTags.includes(name)} disabled={saving}
              closeOnClick={false} onCheckedChange={checked => void save({ tags: checked ? [...new Set([...selectedTags, name])] : selectedTags.filter(item => item !== name) })}>
              <span className="min-w-0 break-all">{name}</span>
            </DropdownMenuCheckboxItem>)}
            {!tagChoices.length && <DropdownMenuItem disabled>タグはまだありません</DropdownMenuItem>}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => openSettings("tags")}>＋ タグを追加</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {!!paper.tags?.length && <div className="col-start-2 flex flex-wrap gap-1.5">{paper.tags.map(name => <TagChip key={name} name={name} disabled={saving}
        onRemove={() => void save({ tags: paper.tags?.filter(item => item !== name) })} />)}</div>}
    </div>
    {(isError || statusError) && <p role="alert" className="text-xs text-destructive">読書状態・タグを読み込めませんでした。</p>}
  </section>;
}

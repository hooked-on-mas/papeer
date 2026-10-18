import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, Plus } from "lucide-react";
import { TagChip } from "@/components/ui/TagChip";
import { movedOption, tagOptions, tagProblem, type TagOption } from "./tagOptions";
import { pyStrip } from "@/lib/pyWhitespace";
import { isImeKey } from "@/lib/imeKeys";

/**
 * The paper's tags as a combobox (the ARIA pattern: focus stays in the input, ↑↓ move among the options,
 * Enter chooses): typing filters the library's tags, and a name no tag has is put on as a new tag. The
 * list stays open after choosing, so that several tags go on in a row. The tags the paper has are chips
 * below, each with a button that takes it off. `onToggle` saves one tag put on (`add`) or taken off, as a
 * difference rather than the whole list, which may be out of date by the time it is sent (tagQueue.ts).
 */
export function TagCombobox({ choices, selected, labelledBy, onToggle }: {
  choices: readonly string[];
  selected: readonly string[];
  labelledBy: string;
  onToggle: (name: string, add: boolean) => void;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [problem, setProblem] = useState("");
  // Said by screen readers after choosing, since the list itself stays as it was.
  const [announcement, setAnnouncement] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const listId = `${id}-list`;
  const hintId = `${id}-hint`;
  const problemId = `${id}-problem`;
  const options = useMemo(() => tagOptions(choices, selected, text), [choices, selected, text]);
  const shown = open && options.length > 0;
  const activeOption = shown && active >= 0 && active < options.length ? active : -1;

  const choose = (option: TagOption) => {
    const trouble = tagProblem(option.name, selected);
    if (trouble) {
      setProblem(trouble);
      return;
    }
    const removing = option.kind === "tag" && option.selected;
    onToggle(option.name, !removing);
    setProblem("");
    setAnnouncement(removing ? `タグ「${option.name}」を外しました。` : option.kind === "create"
      ? `新しいタグ「${option.name}」を付けました。` : `タグ「${option.name}」を付けました。`);
    // A name typed to find or make a tag has done its work; the list stays open for the next one.
    if (text) {
      setText("");
      setActive(-1);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isImeKey(e.nativeEvent)) return;
    if (["ArrowDown", "ArrowUp"].includes(e.key) || (shown && ["Home", "End"].includes(e.key) && !text)) {
      e.preventDefault();
      setOpen(true);
      setActive((current) => movedOption(open ? current : -1, e.key, options.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // The option moved to, or, while typing, the first: the best matching tag, or the new one.
      const option = options[activeOption >= 0 ? activeOption : pyStrip(text) ? 0 : -1];
      if (option) choose(option);
      else setOpen(true);
    } else if (e.key === "Escape") {
      if (!open && !text) return; // Left to whatever holds the field (a dialog, the pane).
      e.preventDefault();
      e.stopPropagation();
      if (text) setText("");
      else setOpen(false);
      setActive(-1);
    } else if (e.key === "Backspace" && !text && selected.length) {
      // As in most tag fields: Backspace in an empty field takes the last tag off.
      e.preventDefault();
      const last = selected[selected.length - 1];
      choose({ kind: "tag", name: last, selected: true });
    }
  };

  return (
    <div className="space-y-1.5 min-w-0">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-labelledby={labelledBy}
          aria-describedby={problem ? `${problemId} ${hintId}` : hintId}
          aria-expanded={shown}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeOption >= 0 ? `${id}-option-${activeOption}` : undefined}
          aria-invalid={problem ? true : undefined}
          value={text}
          maxLength={200}
          placeholder={selected.length ? `${selected.length}個のタグ。入力して追加・検索` : "タグを入力して追加・検索"}
          className="w-full min-w-0 border rounded bg-background px-2 py-1.5 text-[0.8125rem] outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive"
          onChange={(e) => { setText(e.target.value); setOpen(true); setActive(-1); setProblem(""); }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onBlur={() => { setOpen(false); setActive(-1); }}
          onKeyDown={onKeyDown}
        />
        <ul
          id={listId}
          role="listbox"
          aria-label="タグの候補"
          aria-multiselectable="true"
          hidden={!shown}
          className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border bg-popover p-1 text-[0.8125rem] text-popover-foreground shadow-md"
        >
          {options.map((option, index) => (
            <li
              key={`${option.kind}:${option.name}`}
              id={`${id}-option-${index}`}
              role="option"
              aria-selected={option.kind === "tag" && option.selected}
              // The input keeps the focus (and the list stays open) when an option is clicked.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { choose(option); inputRef.current?.focus(); }}
              onMouseMove={() => { if (active !== index) setActive(index); }}
              className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1 ${index === activeOption ? "bg-accent text-accent-foreground" : ""}`}
            >
              {option.kind === "create"
                ? <><Plus className="size-3.5 shrink-0" aria-hidden="true" /><span className="min-w-0 break-all">「{option.name}」を新しいタグとして追加</span></>
                : <><Check className={`size-3.5 shrink-0 ${option.selected ? "" : "invisible"}`} aria-hidden="true" />
                  <span className="min-w-0 break-all">{option.name}</span></>}
            </li>
          ))}
        </ul>
      </div>
      <p id={hintId} className="sr-only">上下の矢印キーで候補を選び、Enter で付け外しします。候補にない名前は新しいタグとして追加します。</p>
      {problem && <p id={problemId} role="alert" className="text-[0.75rem] text-destructive">{problem}</p>}
      <p className="sr-only" role="status">{announcement}</p>
      {!!selected.length && (
        <div className="flex flex-wrap gap-1.5" aria-label="この論文のタグ" role="group">
          {selected.map((name) => (
            <TagChip key={name} name={name} onRemove={() => choose({ kind: "tag", name, selected: true })} />
          ))}
        </div>
      )}
    </div>
  );
}

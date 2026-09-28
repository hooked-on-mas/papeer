/**
 * Putting tags on one paper or taking them off, as differences: each change is "this tag on" or "this tag
 * off", applied, when its turn comes, to the tags the sidecar holds then. A paper's changes are sent one
 * after another in the order they were made.
 *
 * Sending the whole list as the screen showed it when clicked would lose a tag: the paper's query may be
 * loaded again between two clicks (after the previous save, or on paper.changed) with the tags as they
 * were before a change still waiting its turn, and while the automatic sync runs the requests wait for it
 * (libraryBusy.ts), which widens that gap to seconds. Kept apart from actions.ts so that it can be tested.
 */
export type TagChange = { name: string; add: boolean };

export type TagQueueDeps = {
  /** The paper's tags as the sidecar holds them now. */
  read: (paperId: string) => Promise<string[]>;
  write: (paperId: string, tags: string[]) => Promise<void>;
  /** Called whenever the changes waiting (what `shown` adds) change, for the screen to follow. */
  onWaitingChange?: () => void;
};

export function applyTagChange(tags: readonly string[], change: TagChange): string[] {
  const others = tags.filter((name) => name !== change.name);
  return change.add ? [...others, change.name] : others;
}

export function createTagQueue(deps: TagQueueDeps) {
  const turns = new Map<string, Promise<unknown>>();
  const waiting = new Map<string, TagChange[]>();

  /** Applies the change in its turn: "unchanged" when the tags already were so; rejects when it failed. */
  function change(paperId: string, tagChange: TagChange): Promise<"done" | "unchanged"> {
    waiting.set(paperId, [...(waiting.get(paperId) ?? []), tagChange]);
    deps.onWaitingChange?.();
    const task = (turns.get(paperId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      try {
        const tags = await deps.read(paperId);
        if (tags.includes(tagChange.name) === tagChange.add) return "unchanged" as const;
        await deps.write(paperId, applyTagChange(tags, tagChange));
        return "done" as const;
      } finally {
        const rest = (waiting.get(paperId) ?? []).filter((item) => item !== tagChange);
        if (rest.length) waiting.set(paperId, rest);
        else waiting.delete(paperId);
        deps.onWaitingChange?.();
      }
    });
    turns.set(paperId, task);
    void task.catch(() => undefined).then(() => { if (turns.get(paperId) === task) turns.delete(paperId); });
    return task;
  }

  /** `tags` (as loaded) with the paper's changes not yet saved applied, as the screen should show them. */
  function shown(paperId: string, tags: readonly string[]): string[] {
    return (waiting.get(paperId) ?? []).reduce<string[]>(applyTagChange, [...tags]);
  }

  return { change, shown };
}

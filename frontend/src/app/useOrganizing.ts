import { useSyncExternalStore } from "react";
import { currentOrganizing, shownStatus, shownTags, subscribeOrganizing } from "./actions";

/**
 * The paper's tags and reading status as the screen shows them: as loaded, with the changes still being
 * saved (actions.ts, shownTags and shownStatus); renders again as those change.
 */
export function useShownOrganization(paperId: string, tags: readonly string[] | undefined, status: string): { tags: string[]; status: string } {
  useSyncExternalStore(subscribeOrganizing, currentOrganizing);
  return { tags: shownTags(paperId, tags ?? []), status: shownStatus(paperId, status) };
}

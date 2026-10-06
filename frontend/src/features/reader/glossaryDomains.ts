/**
 * When the translation dialog checks the applicability of existing translations. Dictionary splitting
 * is an explicit management action. Kept free of React and the API so that
 * tests/glossaryDomains.test.ts can check the rules.
 */
import { GENERAL_DOMAIN, type DomainSelection, type Term } from "./translationStart.ts";

/** GET /api/papers/{id}/glossary-domains. */
export type PaperDomains = {
  /** The domain dictionaries chosen (not 共通, which always applies). */
  domains: string[];
  /** A domain that does not exist yet, whose name the paper's new terms take. */
  new_domain: string | null;
  /** Who chose them; null: nothing is recorded for the paper. */
  chosen_by: "ai" | "user" | null;
  /** The domain dictionaries there were when they were chosen. */
  known_domains: string[];
  /** The domain dictionaries there are now. */
  available: string[];
  /** The dictionaries changed since the choice. */
  stale: boolean;
  /** Suggested size for manual dictionary organization (never triggers a split automatically). */
  split_at: number;
  scope_terms?: Term[];
  scope_stale?: boolean;
  selection_key?: string;
};

/** The domain dictionaries with the terms in each, for the rules below. */
export type DomainCounts = Readonly<Record<string, number>>;

export type AutoGlossaryJobs = {
  /** Start glossary-select. */
  select: boolean;
  /** The dictionary to start glossary-split on. */
  split: string | null;
};

/**
 * Check the meanings once the shared dictionary loads, including legacy choices without a term scope.
 * A user's domain choices stay fixed, while the translations inside them are still checked.
 */
export function autoGlossaryJobs({ availableDomains, record, dirty, running }: {
  availableDomains: readonly string[];
  domainCounts: DomainCounts;
  record: { chosen_by: "ai" | "user" | null; stale: boolean; scope_stale?: boolean; selection_key?: string } | null;
  dirty: boolean;
  running: boolean;
  /** Term counts of the dictionaries at the time they were last split (readSplitChecked). */
  splitChecked: DomainCounts;
  splitAt: number;
}): AutoGlossaryJobs {
  if (dirty || running) return { select: false, split: null };
  // Organizing the shared dictionary is an explicit management action, never a prerequisite to reading.
  const needsChoice = !record || record.chosen_by === null || record.scope_stale
    || (record.chosen_by === "ai" && record.stale);
  return { select: availableDomains.length > 0 && needsChoice, split: null };
}

export type AutoStart =
  | { kind: "split"; domain: string }
  | { kind: "select"; key: string };

/**
 * What the dialog starts now, if anything: autoGlossaryJobs, less what this window started already, so that a
 * job that did not go through (or whose result is not read yet) is not started again in a loop.
 * The key includes the paper, available domains, and dictionary/source fingerprint.
 */
export function nextAutoStart({ paperId, tried, ...rules }: Parameters<typeof autoGlossaryJobs>[0] & {
  paperId: string;
  tried: { splits: DomainCounts; selects: ReadonlySet<string> };
}): AutoStart | null {
  if (!autoGlossaryJobs(rules).select) return null;
  const key = selectionAttemptKey(paperId, rules.availableDomains, rules.record?.selection_key);
  return tried.selects.has(key) ? null : { kind: "select", key };
}

export function selectionAttemptKey(paperId: string, domains: readonly string[], contentKey?: string): string {
  return `${paperId}:${domains.join("\n")}:${contentKey ?? ""}`;
}

/** The number of terms each dictionary has: 共通 and every domain that has a term. */
export function countDomainTerms(terms: readonly { domain?: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const term of terms) {
    const name = (term.domain ?? "").trim() || GENERAL_DOMAIN;
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

const SPLIT_CHECKED_KEY = "papeer-glossary-split-checked";

/** What this window recorded, for when the storage cannot keep it (disabled, full): the same dictionary is not sent twice per session. */
const splitCheckedMemory = new Map<string, number>();

/**
 * The term counts the dictionaries had when they were last split, so that the same dictionary of the
 * same size is not sent to the AI again: what the storage holds, and what this window recorded (which
 * wins). The storage comes through a getter: reading `localStorage` itself can throw when storage is disabled.
 */
export function readSplitChecked(storage: () => Pick<Storage, "getItem"> | undefined, memory: ReadonlyMap<string, number> = splitCheckedMemory): Record<string, number> {
  let stored: Record<string, number> = {};
  try {
    const value: unknown = JSON.parse(storage()?.getItem(SPLIT_CHECKED_KEY) ?? "{}");
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      stored = Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
    }
  } catch {
    // Storage may be disabled or hold something else; only the memory is left.
  }
  return { ...stored, ...Object.fromEntries(memory) };
}

/** Remember `counts` (dictionary name: terms it had after a split), in the memory and, if it can, the storage. */
export function recordSplitChecked(storage: () => Pick<Storage, "getItem" | "setItem"> | undefined, counts: Readonly<Record<string, number>>,
  memory: Map<string, number> = splitCheckedMemory): void {
  for (const [name, count] of Object.entries(counts)) memory.set(name, count);
  try {
    const store = storage();
    if (!store) return;
    store.setItem(SPLIT_CHECKED_KEY, JSON.stringify({ ...readSplitChecked(() => store, new Map()), ...counts }));
  } catch {
    // Only a convenience: the dictionary may be sent to the AI once more.
  }
}

/**
 * The term counts to record after a split of `launched` (a domain's name, or 共通) that had `before` terms:
 * every domain dictionary the result lists; the launched one too, which the result leaves out when it has
 * no term left (a domain) or is not a domain at all (共通, which lost the terms that moved).
 */
export function splitCheckedCounts(result: { moved: number; domains: readonly { name: string; count: number }[] }, launched: string, before: number): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(result.domains.map((d) => [d.name, d.count]));
  if (launched === GENERAL_DOMAIN) counts[GENERAL_DOMAIN] = Math.max(0, before - result.moved);
  else counts[launched] ??= 0;
  return counts;
}

// --- What the dialog shows -----------------------------------------------------------------------

/** The domain of a term as a dictionary name: no domain is 共通. */
export function domainNameOf(term: { domain?: string }): string {
  return (term.domain ?? "").trim() || GENERAL_DOMAIN;
}

/** The domain dictionaries (not 共通) the terms are in, in the order they first appear. */
export function domainNamesIn(terms: readonly { domain?: string }[]): string[] {
  const names: string[] = [];
  for (const term of terms) {
    const name = domainNameOf(term);
    if (name !== GENERAL_DOMAIN && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Whether a term is in the dictionary the list is narrowed to (null: every dictionary). */
export function inDomainFilter(term: { domain?: string }, filter: string | null): boolean {
  return filter === null || domainNameOf(term) === filter;
}

/** The term in `domain` (a dictionary name, 共通 or blank for none): the `domain` key is dropped for 共通. */
export function withDomain<T extends Term>(term: T, domain: string): T {
  const { domain: _previous, ...rest } = term;
  const name = domain.trim();
  return (name && name !== GENERAL_DOMAIN ? { ...rest, domain: name } : rest) as T;
}

/** The recorded choice: null while unreviewed, when only common and paper-local terms apply. */
export function selectionOf(record: Pick<PaperDomains, "domains" | "new_domain" | "chosen_by" | "scope_terms" | "scope_stale"> | undefined): DomainSelection | null {
  return record && record.chosen_by !== null ? { domains: record.domains, new_domain: record.new_domain,
    scope_terms: record.scope_stale ? [] : record.scope_terms ?? [] } : null;
}

/** The domain dictionaries checked in the list: only those explicitly chosen. */
export function checkedDomains(record: Pick<PaperDomains, "domains" | "chosen_by" | "available">): string[] {
  return record.chosen_by === null ? [] : [...record.domains];
}

/**
 * The choice after `name` is checked or unchecked, for the PUT: the order of the others stays (the first
 * is where new terms go), a name that is checked now comes last, and one no longer in the glossary goes.
 */
export function toggledChoice(record: Pick<PaperDomains, "domains" | "new_domain" | "chosen_by" | "available">, name: string, checked: boolean):
  { domains: string[]; newDomain: string | null } {
  const kept = checkedDomains(record).filter((n) => n !== name && record.available.includes(n));
  return { domains: checked && record.available.includes(name) ? [...kept, name] : kept, newDomain: record.new_domain };
}

/** The dictionaries added since the user chose, which they have not been asked about. */
export function unchosenNewDomains(record: Pick<PaperDomains, "chosen_by" | "stale" | "known_domains" | "available"> | undefined): string[] {
  if (record?.chosen_by !== "user" || !record.stale) return [];
  return record.available.filter((name) => !record.known_domains.includes(name));
}

export function unchosenNewDomainsMessage(names: readonly string[]): string | null {
  return names.length ? `新しい分野 ${names.join("、")} は未選択です。「使う分野を変更」で選ぶと適用対象になります。` : null;
}

export type DomainJob = "select" | "split";

/** What the dialog says while the AI works on the dictionaries. */
export function domainJobMessage(running: DomainJob | null): string | null {
  switch (running) {
    case "select": return "AIが原文の使われ方を見て、適用する訳語を選んでいます…";
    case "split": return "AIが辞書を分野ごとに分けています…";
    default: return null;
  }
}

/** What the dialog says when that work failed: no error dialog is raised, and the choice can be made by hand. */
export function domainFailureMessage(job: DomainJob, error: string | null): string {
  const reason = error?.trim() || "不明なエラー";
  return job === "select"
    ? `AIが訳語の適用を判定できませんでした（${reason}）。未確認の分野の訳語は適用しません。「AIで適用する訳語を選び直す」で再試行できます。`
    : `AIが辞書を分けられませんでした（${reason}）。「辞書全体」タブの「分野の整理」で、もう一度実行できます。`;
}

/** What the dialog says when a split ended. */
export function splitDoneMessage(moved: number): string {
  return moved > 0 ? `辞書を分野ごとに分けました（${moved}件を分野辞書へ移しました）。` : "辞書を確認しましたが、分野辞書へ移す語はありませんでした。";
}

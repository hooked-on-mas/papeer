/**
 * What the translation dialog offers before a run: the AI's check for unregistered terms is
 * optional, and is not even suggested when it would tell nothing new. Kept free of React and
 * the API so that tests/translationStart.test.ts can check the rules.
 */

/** The domain name of the terms that apply to every paper; a term of it has no `domain` key. */
export const GENERAL_DOMAIN = "共通";

/** A glossary term; without `domain` it is in 共通. */
export type Term = { source: string; target: string; domain?: string };
export type GlossaryCandidate = Term & { reason?: string; context?: string };

/** The domain dictionaries a paper uses besides 共通 (GET /api/papers/{id}/glossary-domains); null: nothing recorded. */
export type DomainSelection = { domains: readonly string[]; new_domain: string | null; scope_terms?: readonly Term[] };

/** GET /api/papers/{id}/translation-plan: what starting with these pages and model would do. */
export type TranslationPlan = {
  model: string;
  /** The requested pages with the pages their sentences continue on. */
  selected_pages: number[];
  /** Pages taken from saved translations, without asking the model. */
  reusable_pages: number[];
  /** Pages the model translates. */
  pending_pages: number[];
  /** Pending pages that show a translation now. */
  retranslated_pages: number[];
  /** Models the retranslated pages were translated with. */
  previous_models: string[];
  needs_ai: boolean;
};

/** Why the check for unregistered terms is not suggested this time. */
export type ReviewSkip =
  | "reusable" // Every page comes from saved translations: starting only redraws the PDF.
  | "resume" // The run continues an interrupted one, started after the user's decision then.
  | "unchanged" // The dictionary this paper uses is as it was when its terms were last checked.
  | null;

/** The domain of a term as the sidecar keeps it: blank and 共通 are no domain at all. */
function domainOf(term: Term): string {
  const domain = (term.domain ?? "").trim();
  return domain === GENERAL_DOMAIN ? "" : domain;
}

/** The glossary as the dialog saves it: blank rows dropped, both sides trimmed, no `domain` key for 共通. */
export function normalizeTerms(terms: readonly Term[]): Term[] {
  return terms.filter((t) => t.source.trim() || t.target.trim()).map((t) => {
    const domain = domainOf(t);
    return { source: t.source.trim(), target: t.target.trim(), ...(domain ? { domain } : {}) };
  });
}

/**
 * The terms a paper uses: 共通 and the domains selected (new_domain too), in the glossary's order, and
 * for a source in several of them the first (as the sidecar's effective glossary). Nothing recorded
 * (`selection` null): only common terms, until the contextual selection is ready.
 */
export function effectiveTerms(terms: readonly Term[], selection: DomainSelection | null): Term[] {
  if (!selection) return terms.filter((t) => !domainOf(t));
  const chosen = new Set(selection.domains);
  if (selection.new_domain) chosen.add(selection.new_domain);
  const keyOf = (t: Term) => JSON.stringify([domainOf(t), t.source.toLocaleLowerCase(), t.target]);
  const allowed = new Set((selection.scope_terms ?? []).map(keyOf));
  const seen = new Set<string>();
  const result: Term[] = [];
  for (const term of terms) {
    const domain = domainOf(term);
    if (domain && !chosen.has(domain)) continue;
    if (domain && !allowed.has(keyOf(term))) continue;
    const key = term.source.trim().toLocaleLowerCase();
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    result.push(term);
  }
  return result;
}

/** Where a term registered for this paper goes: the new domain, else the first domain selected, else 共通. */
export function primaryDomain(selection: DomainSelection | null): string {
  return selection?.new_domain || selection?.domains[0] || GENERAL_DOMAIN;
}

/**
 * A short key of a glossary's content (after normalizeTerms), whatever the order of its terms. Pass
 * effectiveTerms, so that editing a dictionary the paper does not use changes nothing. Only the source
 * and target are hashed, as the sidecar sends nothing else: moving a term between domains the paper uses
 * changes nothing it is translated with, and a glossary of 共通 alone hashes as it did before domains existed.
 */
export function glossaryKey(terms: readonly Term[]): string {
  const text = JSON.stringify(normalizeTerms(terms).map((t) => [t.source, t.target]).sort(
    (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));
  // cyrb53: enough to tell glossaries apart without keeping their text in storage.
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${text.length}-${(h2 >>> 0).toString(36)}${(h1 >>> 0).toString(36)}`;
}

/** An unfinished run whose target includes every page asked for now is resumed, not started over. */
export function isResuming(preview: { complete: boolean; target_pages?: number[] } | null | undefined,
  pages: readonly number[] | null): boolean {
  if (!preview || preview.complete || !pages?.length || !preview.target_pages) return false;
  const target = new Set(preview.target_pages);
  return pages.every((page) => target.has(page));
}

export function glossaryReviewSkip({ plan, glossaryDirty, resuming, reviewedKey, currentKey }: {
  /** The plan for the pages and model on screen (undefined while it loads). */
  plan: TranslationPlan | undefined;
  /** Unsaved glossary edits are saved on start and change what the pages need. */
  glossaryDirty: boolean;
  resuming: boolean;
  /** glossaryKey of the glossary a translation of this paper last started with after the check. */
  reviewedKey: string | null;
  /** glossaryKey of the glossary this start would use. */
  currentKey: string;
}): ReviewSkip {
  if (plan && !plan.needs_ai && !glossaryDirty) return "reusable";
  if (resuming) return "resume";
  if (reviewedKey !== null && reviewedKey === currentKey) return "unchanged";
  return null;
}

export function reviewSkipMessage(skip: ReviewSkip): string {
  switch (skip) {
    case "reusable": return "指定ページはすべて保存済みの訳文を使えます。AIには送らず、PDFだけを作り直します。";
    case "resume": return "中断した翻訳の続きを行います。用語の確認は省略します（辞書は下の欄で確認・修正できます）。";
    case "unchanged": return "前回この論文の用語を確認したときから、この論文に使う辞書が変わっていないため、用語の確認は省略します。";
    default: return "通常はそのまま翻訳できます。「訳語を確認する」では、判断が読解に影響する語だけ最大5件を確認します（利用枠を使います）。";
  }
}

/** The main button: after the check it applies the (edited) candidates and starts. */
export function startButtonLabel({ skip }: { reviewed: boolean; skip: ReviewSkip }): string {
  if (skip === "reusable") return "保存済みの訳文でPDFを作り直す";
  return "翻訳を開始";
}

/**
 * A warning before usage is spent again on pages that already have a translation. `hasDomains`: the glossary
 * has domain dictionaries, so a change in which of them the paper uses may be the reason.
 */
export function retranslationWarning(plan: TranslationPlan | undefined, hasDomains = false): string | null {
  if (!plan?.needs_ai || !plan.retranslated_pages.length) return null;
  const count = plan.retranslated_pages.length;
  const others = plan.previous_models.filter((m) => m !== plan.model);
  if (others.length) {
    return `翻訳済みの${count}ページを新しいモデル（${plan.model || "既定モデル"}）で訳し直します（利用枠を使います）。前回のモデル: ${others.join(", ")}`;
  }
  const domains = hasDomains ? "この論文に使う分野辞書の選択が変わったことも原因になります。" : "";
  return `翻訳済みの${count}ページも訳し直します（保存済みの訳文と原文・辞書などの条件が異なるため。${domains}利用枠を使います）。`;
}

/** Translated pages whose saved writing may no longer point at the same words after this run. */
export function retranslatedInkPages(plan: TranslationPlan | undefined,
  inkPages: readonly { side: string; page: number; count: number }[]): number[] {
  if (!plan?.needs_ai) return [];
  const affected = new Set(plan.retranslated_pages);
  return [...new Set(inkPages.filter((item) => item.side === "translated" && item.count > 0 && affected.has(item.page))
    .map((item) => item.page))].sort((a, b) => a - b);
}

/** "翻訳対象" under the page selection: with the plan, the pages the run covers (the requested ones and
 * the pages their sentences continue on) and how many of them come from saved translations. */
export function translationTargetText(requested: number, plan: TranslationPlan | undefined): string {
  if (!plan) return `翻訳対象: ${requested}ページ`;
  const pages = plan.selected_pages.length;
  const added = pages > requested ? `（文が続く${pages - requested}ページを含む）` : "";
  const reused = plan.reusable_pages.length ? `。うち${plan.reusable_pages.length}ページは保存済みの訳文を使い、AIには送りません` : "";
  return `翻訳対象: ${pages}ページ${added}${reused}`;
}

/**
 * Add the AI's candidates that the glossary does not have yet in `domain` (the paper's primary domain;
 * the user may have added some meanwhile). The same source in another domain is not known.
 */
export function mergeDraftTerms(glossary: readonly Term[], candidates: readonly Term[], domain: string = GENERAL_DOMAIN):
  { glossary: Term[]; added: Term[] } {
  const target = domain.trim() === GENERAL_DOMAIN ? "" : domain.trim();
  const keyOf = (source: string, of: string) => `${of}\u0000${source.trim().toLocaleLowerCase()}`;
  const known = new Set(glossary.map((t) => keyOf(t.source, domainOf(t))));
  const added: Term[] = [];
  for (const candidate of candidates) {
    const term = { source: candidate.source, target: candidate.target };
    const key = keyOf(term.source, target);
    if (!term.source.trim() || known.has(key)) continue;
    known.add(key);
    added.push(target ? { ...term, domain: target } : term);
  }
  return { glossary: [...glossary, ...added], added };
}

export function draftResultMessage(count: number): string {
  return count
    ? `確認候補は${count}件です。使いたい訳語だけ選んでください。この論文だけに適用します。`
    : "訳語の判断が必要な未登録語はありません。既存の辞書を使って翻訳できます。";
}

const REVIEW_PREFIX = "papeer-glossary-reviewed:";

/**
 * The glossaryKey recorded when this paper's terms were last checked and translated, if any.
 * The storage comes through a getter: reading `localStorage` itself can throw when storage is disabled.
 */
export function readReviewedGlossary(storage: () => Pick<Storage, "getItem"> | undefined, paperId: string): string | null {
  try {
    return storage()?.getItem(REVIEW_PREFIX + paperId) ?? null;
  } catch {
    return null; // Storage may be disabled; the check is then suggested as before.
  }
}

export function recordReviewedGlossary(storage: () => Pick<Storage, "setItem"> | undefined, paperId: string, key: string): void {
  try {
    storage()?.setItem(REVIEW_PREFIX + paperId, key);
  } catch {
    // Only a convenience: the next start suggests the check again.
  }
}

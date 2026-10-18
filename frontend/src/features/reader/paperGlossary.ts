import type { GlossaryCandidate, Term } from "./translationStart.ts";

export type PaperGlossary = { terms: Term[]; dismissed: string[] };

export const sourceKey = (source: string) => source.trim().toLocaleLowerCase();

/** Only explicitly checked suggestions become paper overrides; others are remembered as declined. */
export function applyGlossaryReview(base: PaperGlossary, candidates: readonly GlossaryCandidate[], selected: ReadonlySet<string>): PaperGlossary {
  const accepted = candidates.filter((t) => selected.has(sourceKey(t.source)));
  const replaced = new Set(accepted.map((t) => sourceKey(t.source)));
  const terms = [...base.terms.filter((t) => !replaced.has(sourceKey(t.source))),
    ...accepted.map((t) => ({ source: t.source, target: t.target }))];
  const dismissed = new Set(base.dismissed);
  for (const t of candidates) {
    const key = sourceKey(t.source);
    if (selected.has(key)) dismissed.delete(key);
    else dismissed.add(key);
  }
  return { terms, dismissed: [...dismissed].slice(-2000) };
}

export function withPaperTerms(shared: readonly Term[], local: readonly Term[]): Term[] {
  const overridden = new Set(local.map((t) => sourceKey(t.source)));
  return [...local, ...shared.filter((t) => !overridden.has(sourceKey(t.source)))];
}

/** A bulk move preserves other entries and refuses conflicting translations in the destination. */
export function moveGlossaryTerms(terms: readonly Term[], selected: ReadonlySet<number>, domain: string): Term[] {
  const destination = domain.trim() === "共通" ? "" : domain.trim();
  const result = terms.map((term, index) => selected.has(index)
    ? { source: term.source, target: term.target, ...(destination ? { domain: destination } : {}) } : term);
  const unique = new Map<string, Term>();
  for (const term of result) {
    const key = `${term.domain?.trim() ?? ""}\0${sourceKey(term.source)}`;
    const previous = unique.get(key);
    if (previous && previous.target !== term.target) throw new Error(`「${term.source}」は移動先に別の訳語があります。訳語を確認してください。`);
    if (!previous) unique.set(key, term);
  }
  return [...unique.values()];
}

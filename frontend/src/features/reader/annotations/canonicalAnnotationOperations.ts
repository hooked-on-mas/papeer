import type { AnnotationChange, Page, PageExpectation, Point, StickyNote, TextHighlight, UnindexedTextRange } from '../../../runtime/edits/contracts.ts';
import { assertAnnotation, canonicalJson, EditRejected } from '../../../runtime/edits/editModel.ts';
import { pageExpectation } from '../../../runtime/edits/documentPages.ts';

export type AnnotationDraftField = 'text' | 'label' | 'color' | 'anchor' | 'deleted';
/** Canonical geometry only. Capture tokens, DOM proof and creation identity stay outside this seed. */
export type AnnotationHighlightSeed = {
  quote: string; range: Readonly<UnindexedTextRange>; quads: readonly (readonly Readonly<Point>[])[];
  anchor: Readonly<Point>; backgroundRevision: string;
};
export type AnnotationDraftStart = { kind: 'create-sticky'; anchor: Point } | { kind: 'edit-sticky'; annotation: StickyNote }
  | { kind: 'create-highlight'; seed: AnnotationHighlightSeed } | { kind: 'edit-highlight'; annotation: TextHighlight };
type DraftAnnotation = StickyNote | TextHighlight;
export type AnnotationDraftPatch = { text?: string; label?: string; color?: string | null; anchor?: Point; deleted?: boolean };
export type DocumentAnnotationDraft = {
  draftId: string; pageId: string; page: Page; baseVersion: string; expected: PageExpectation;
  original: DraftAnnotation | null; initial: DraftAnnotation; annotation: DraftAnnotation; deleted: boolean; dirtyFields: readonly AnnotationDraftField[];
};
const fields = ['text', 'label', 'color', 'anchor', 'deleted'] as const;
const reject = (reason: string): never => { throw new EditRejected(reason); };
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const dirtyFields = (initial: DraftAnnotation, annotation: DraftAnnotation, deleted: boolean): AnnotationDraftField[] => fields.filter(field => {
  if (field === 'deleted') return deleted;
  if (field === 'label') return initial.metadata.label !== annotation.metadata.label;
  return !same(initial[field], annotation[field]);
});

/** Freeze the target and complete original payload before any form or pointer callback can yield. */
export function beginCanonicalAnnotationDraft(page: Page, baseVersion: string, draftId: string,
  input: AnnotationDraftStart, createIdentity: { id: string; createdAt: string }): DocumentAnnotationDraft {
  const payloadField = input.kind === 'create-sticky' ? 'anchor' : input.kind === 'create-highlight' ? 'seed' : 'annotation';
  if (Object.keys(input).some(key => !['kind', payloadField].includes(key))) reject('annotation-draft-fields');
  let original: DraftAnnotation | null = null, initial: DraftAnnotation;
  if (input.kind === 'create-sticky') {
    initial = { kind: 'sticky', id: createIdentity.id, text: '', anchor: structuredClone(input.anchor), color: null,
      metadata: { label: '', createdAt: createIdentity.createdAt } };
  } else if (input.kind === 'create-highlight') {
    if (page.background.kind !== 'pdf') reject('annotation-highlight-pdf-required');
    if (Object.keys(input.seed).some(key => !['quote', 'range', 'quads', 'anchor', 'backgroundRevision'].includes(key))) reject('annotation-draft-fields');
    if (input.seed.range?.kind !== 'unindexed') reject('annotation-highlight-unindexed-required');
    initial = { kind: 'highlight', id: createIdentity.id, text: '', color: '#facc15',
      quote: input.seed.quote, range: structuredClone(input.seed.range),
      quads: input.seed.quads.map(quad => quad.map(point => structuredClone(point))),
      anchor: structuredClone(input.seed.anchor), backgroundRevision: input.seed.backgroundRevision,
      metadata: { label: '', createdAt: createIdentity.createdAt } };
  } else if (input.kind === 'edit-sticky' || input.kind === 'edit-highlight') {
    const found = page.annotations.find(annotation => annotation.id === input.annotation.id);
    if (!found || found.kind === 'ink' || found.kind !== (input.kind === 'edit-sticky' ? 'sticky' : 'highlight')) return reject('annotation-original-changed');
    if (!same(found, input.annotation)) reject('annotation-original-changed');
    original = structuredClone(found); initial = structuredClone(found);
  } else return reject('annotation-draft-kind');
  if (!original && page.annotations.some(annotation => annotation.id === initial.id)) reject('annotation-id-exists');
  assertAnnotation(initial, page.backgroundRevision);
  return { draftId, pageId: page.id, page: structuredClone(page), baseVersion, expected: pageExpectation(page), original,
    initial, annotation: structuredClone(initial), deleted: false, dirtyFields: [] };
}

/** Only these fields can change; unknown fields, createdAt, quote and identity are never accepted as form input. */
export function updateCanonicalAnnotationDraft(draft: DocumentAnnotationDraft, patch: AnnotationDraftPatch): DocumentAnnotationDraft {
  if (Object.keys(patch).some(key => !(fields as readonly string[]).includes(key))) reject('annotation-draft-fields');
  const annotation = structuredClone(draft.annotation);
  if ('text' in patch) annotation.text = patch.text!;
  if ('label' in patch) annotation.metadata.label = patch.label!;
  if ('color' in patch) annotation.color = patch.color!;
  if ('anchor' in patch) annotation.anchor = structuredClone(patch.anchor!);
  const deleted = 'deleted' in patch ? patch.deleted! : draft.deleted;
  if (typeof deleted !== 'boolean') reject('annotation-draft-fields');
  assertAnnotation(annotation, draft.expected.backgroundRevision);
  return { ...draft, annotation, deleted, dirtyFields: dirtyFields(draft.initial, annotation, deleted) };
}

/** Build one finite page operation from the retained draft; a caller cannot supply replacement changes. */
export function canonicalAnnotationDraftChanges(page: Page, baseVersion: string, draft: DocumentAnnotationDraft): AnnotationChange[] {
  if (typeof draft.deleted !== 'boolean') reject('annotation-draft-fields');
  if (draft.baseVersion !== baseVersion) reject('annotation-draft-stale-version');
  if (page.id !== draft.pageId || !same(pageExpectation(page), draft.expected)
    || !same(pageExpectation(draft.page), draft.expected)) reject('annotation-draft-stale-page');
  const current = page.annotations.find(annotation => annotation.id === draft.initial.id);
  if (draft.original ? !same(current ?? null, draft.original) || !same(draft.initial, draft.original) : !!current) reject('annotation-original-changed');
  assertAnnotation(draft.annotation, page.backgroundRevision);
  const rebuilt = { ...draft.initial, text: draft.annotation.text, color: draft.annotation.color,
    anchor: draft.annotation.anchor, metadata: { ...draft.initial.metadata, label: draft.annotation.metadata.label } };
  if (!same(rebuilt, draft.annotation) || !same(dirtyFields(draft.initial, draft.annotation, draft.deleted), draft.dirtyFields)) reject('annotation-draft-fields');
  if (draft.deleted) return draft.original ? [{ type: 'delete', id: draft.original.id }] : [];
  if (!draft.original) return [{ type: 'create', annotation: structuredClone(draft.annotation) }];
  return same(draft.original, draft.annotation) ? [] : [{ type: 'update', annotation: structuredClone(draft.annotation) }];
}

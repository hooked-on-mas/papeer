import { newPage, validateNoteDocument, type NoteDocument, type NotePage } from '../../runtime/noteDocuments.ts';
import { paperResizeLayout } from '../../runtime/edits/pageCoordinates.ts';

/** Legacy normalized storage uses the same physical resize policy as canonical paper pages. */
export function changeNotebookPaper(note: NoteDocument, pageId: string, spec: Partial<NotePage>, fit = false): NoteDocument {
  const old = note.document?.pages.find(page => page.id === pageId);
  if (!old) throw new Error('変更するページが見つかりません。');
  const page = { ...newPage({ ...old, ...spec }), id: old.id };
  const { scale, dx, dy } = paperResizeLayout(old.width_mm, old.height_mm, page.width_mm, page.height_mm, fit);
  const dimensionChanged = old.width_mm !== page.width_mm || old.height_mm !== page.height_mm;
  const strokes = note.ink?.[old.id] ?? [];
  const ink = dimensionChanged ? strokes.map(stroke => ({ ...stroke, width: stroke.width * old.width_mm * scale / page.width_mm,
    points: stroke.points.map(([x, y]): [number, number] => [(x * old.width_mm * scale + dx) / page.width_mm, (y * old.height_mm * scale + dy) / page.height_mm]) })) : strokes;
  if (ink.some(stroke => stroke.points.some(point => point.some(value => value < -1e-8 || value > 1 + 1e-8)))) throw new Error('変更後の用紙から内容がはみ出します。等比縮小して収める方法を選んでください。');
  const result: NoteDocument = { ...note, document: { ...note.document!, revision: note.document!.revision + 1,
    pages: note.document!.pages.map(value => value.id === old.id ? page : value) },
    ink: { ...note.ink, [old.id]: ink.map(stroke => ({ ...stroke, points: stroke.points.map(([x, y]) => [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))]) })) } };
  return validateNoteDocument(result);
}

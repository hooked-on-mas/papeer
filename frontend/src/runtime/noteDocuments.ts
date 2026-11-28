import type { InkStroke } from '../features/ink/inkGeometry';
import type { NotebookPaper } from '../features/notebooks/paperSpec';
import { conflictTitle } from './edits/textPolicy.ts';
import { pyStrip } from '../lib/pyWhitespace.ts';
export type NotePage = Required<NotebookPaper> & { id: string; width_mm: number; height_mm: number };
export type NoteDocument = {
  id: string; kind: 'markdown' | 'notebook'; title: string; parent_id: string | null;
  collection_name: string; note_position: number; revision: string; content?: string;
  document?: { version: 1; revision: number; pages: NotePage[] }; ink?: Record<string, InkStroke[]>;
};
export type NoteOperation = { version: 1; id: string; library_id: string; note_id: string; base: string | null;
  blob?: { id: string; sha256: string; size: number }; note?: NoteDocument | null };
export function validateNoteDocument(value: unknown): NoteDocument {
  const note = value as NoteDocument;
  const identity = /^[a-f0-9]{32}$/;
  if (!note || !identity.test(note.id) || !['markdown', 'notebook'].includes(note.kind)
    || typeof note.title !== 'string' || !pyStrip(note.title) || Array.from(note.title).length > 200
    || (note.parent_id !== null && !identity.test(note.parent_id)) || typeof note.collection_name !== 'string'
    || !Number.isSafeInteger(note.note_position) || note.note_position < 0) throw new Error('保存されたノートの形式が不正です。');
  if (note.kind === 'markdown') {
    if (typeof note.content !== 'string') throw new Error('Markdown本文が不正です。');
  } else {
    const pages = note.document?.pages;
    if (!pages?.length || pages.length > 500 || new Set(pages.map(p => p.id)).size !== pages.length || !note.ink) throw new Error('ノートのページが不正です。');
    for (const page of pages) {
      if (!identity.test(page.id) || !['A4', 'B5', 'A5', 'Letter', '16:9'].includes(page.size)
        || !['portrait', 'landscape'].includes(page.orientation) || !['white', 'cream', 'dark'].includes(page.color)
        || !['blank', 'ruled7', 'ruled6', 'ruled5', 'grid5', 'grid10', 'dot5', 'cornell'].includes(page.template)) throw new Error('用紙の形式が不正です。');
      const expected = newPage(page);
      if (expected.width_mm !== page.width_mm || expected.height_mm !== page.height_mm) throw new Error('用紙の寸法が不正です。');
    }
    for (const [id, strokes] of Object.entries(note.ink)) {
      if (!pages.some(page => page.id === id) || !Array.isArray(strokes)) throw new Error('描画ページが不正です。');
      for (const stroke of strokes) if (!stroke || !/^#[a-f0-9]{6}$/i.test(stroke.color) || !(stroke.width > 0 && stroke.width <= .08)
        || !Array.isArray(stroke.points) || !stroke.points.length || stroke.points.length > 20000
        || stroke.points.some(p => !Array.isArray(p) || p.length !== 2 || p.some(n => !Number.isFinite(n) || n < 0 || n > 1))) throw new Error('描画データが不正です。');
    }
  }
  return note;
}
export function newPage(paper: Required<NotebookPaper>): NotePage {
  const sizes = { A4: [210, 297], B5: [182, 257], A5: [148, 210], Letter: [215.9, 279.4], '16:9': [180, 320] };
  const [a, b] = sizes[paper.size];
  return { ...paper, id: crypto.randomUUID().replace(/-/g, ''), width_mm: paper.orientation === 'portrait' ? a : b, height_mm: paper.orientation === 'portrait' ? b : a };
}
export function replayNotes(base: NoteDocument[], operations: NoteOperation[], applied: string[]) {
  const notes = new Map(base.map(note => [note.id, note]));
  const conflicts: string[] = [];
  const pending = new Map(operations.filter(op => !applied.includes(op.id)).map(op => [op.id, op]));
  while (pending.size) {
    const ready = [...pending.values()].filter(op => !op.base || !pending.has(op.base)).sort((a, b) => a.id.localeCompare(b.id));
    if (!ready.length) throw new Error('ノートの変更履歴が循環しています。');
    for (const op of ready) {
      pending.delete(op.id);
      const current = notes.get(op.note_id);
      const conflict = (current?.revision ?? null) !== op.base;
      if (op.note) {
        const id = conflict ? op.id.replace(/-/g, '') : op.note_id;
        notes.set(id, { ...op.note, id, revision: op.id, ...(conflict ? { title: conflictTitle(op.note.title), parent_id: null } : {}) });
        if (conflict) conflicts.push(id);
      } else if (!conflict) {
        notes.delete(op.note_id);
        for (const child of notes.values()) if (child.parent_id === op.note_id) notes.set(child.id, { ...child, parent_id: null, collection_name: current?.collection_name ?? child.collection_name });
      }
      else if (current) conflicts.push(current.id);
    }
  }
  return { notes: [...notes.values()], conflicts };
}

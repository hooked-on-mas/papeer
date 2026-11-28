import type { LibraryItem } from '../edits/contracts.ts';
import { pyStrip } from '../../lib/pyWhitespace.ts';

/** Reserved catalog role, shared by local storage, publication and replication. */
export const NOTE_TEMPLATE_METADATA_KEY = 'papeer.note-template';
export const NOTE_TEMPLATE_METADATA_VALUE = 'v1';
export const NOTE_TEMPLATE_BUILTIN_NAME = '読書メモ';
export const NOTE_TEMPLATE_NAME_LIMIT = 80;
export const NOTE_TEMPLATE_BODY_LIMIT = 50_000;

export function noteTemplateMetadata(): Record<string, string> {
  return { [NOTE_TEMPLATE_METADATA_KEY]: NOTE_TEMPLATE_METADATA_VALUE };
}
export function isNoteTemplate(item: Pick<LibraryItem, 'metadata'>): boolean {
  return item.metadata[NOTE_TEMPLATE_METADATA_KEY] === NOTE_TEMPLATE_METADATA_VALUE;
}
export function validateTemplateInput(name: string, content: string): { name: string; content: string } {
  const trimmed = pyStrip(name);
  if (!trimmed || Array.from(trimmed).length > NOTE_TEMPLATE_NAME_LIMIT || trimmed === NOTE_TEMPLATE_BUILTIN_NAME)
    throw new Error('note-template-name');
  if (!pyStrip(content) || Array.from(content).length > NOTE_TEMPLATE_BODY_LIMIT)
    throw new Error('note-template-content');
  return { name: trimmed, content };
}

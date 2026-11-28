import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/api/client';
import { queryClient } from '@/lib/queryClient';
import type { PaperData } from '@/api/hooks';

export type NoteRecord = PaperData & { kind: 'markdown' | 'notebook'; content?: string; revision: string; updated_at?: string; note_position: number };
export const noteApi = {
  list: () => apiRequest<NoteRecord[]>('GET', '/api/notes'),
  read: (id: string) => apiRequest<NoteRecord>('GET', `/api/notes/${id}`),
  update: (id: string, revision: string, changes: Record<string, unknown>) => apiRequest<NoteRecord>('PATCH', `/api/notes/${id}`, { revision, ...changes }),
};
export const useNotes = () => useQuery({ queryKey: ['notes'], queryFn: noteApi.list });
export async function refreshNotes() {
  await Promise.all(['notes', 'papers', 'notebooks', 'attachments'].map(key => queryClient.invalidateQueries({ queryKey: [key] })));
}

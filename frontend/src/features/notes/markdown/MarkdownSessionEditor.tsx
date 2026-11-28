import { useEffect, type ReactNode } from 'react';
import { MarkdownEditorPanel } from './MarkdownEditorPanel';
import type { NoteEditSession } from '../noteEditSession';
import { useNoteEditorOwner } from '../useNoteEditorOwner';
import { useNoteAutosave } from '../useNoteAutosave';
import { traceFeature } from '../../../runtime/featureTrace';

/** Both hosts type, insert templates, retry and autosave through the same edit-start base. */
export function MarkdownSessionEditor({ session, renderPreview, renderTemplates, showStatus = true }: {
  session: NoteEditSession; renderPreview: (content: string) => ReactNode; showStatus?: boolean;
  renderTemplates?: (content: string, insert: (text: string) => void) => ReactNode;
}) {
  const { state, owner, editable } = useNoteEditorOwner(session);
  const text = state.note.content ?? '';
  useEffect(() => { traceFeature('notes.markdown-editor', state.note.id, 'render'); }, [state.note.id]);
  useNoteAutosave({ dirty: state.pending, value: text, revision: state.note.revision,
    save: session.flush, onError: () => undefined, flushOnUnmount: true });
  if (!editable) return <p role="status">このノートは別の表示面で編集中です。</p>;
  return <MarkdownEditorPanel content={text} dirty={state.pending} saving={state.saving} durable={state.durable} error={state.error}
    statePort={session} externalVersion={state.textGeneration} revealEnd={state.insertToken}
    onChange={value => session.editText(value, owner)} onBlur={() => void session.flush().catch(() => undefined)}
    onRetry={() => void session.flush().catch(() => undefined)} renderPreview={renderPreview} renderTemplates={renderTemplates} showStatus={showStatus}
    recoveredDrafts={state.recoveredDrafts} onClearRecovered={session.clearRecoveredDrafts}
    saveCopy={session.canSaveCopy() ? async () => {
      try { await session.saveCopy(); }
      catch (error) { session.reportError(error); throw error; }
    } : undefined} />;
}

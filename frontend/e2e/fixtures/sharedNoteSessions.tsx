import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NoteDocumentEditor } from '../../src/features/notes/NoteDocumentEditor';
import { MarkdownNote } from '../../src/features/notes/MarkdownNote';
import { WebNoteEditor } from '../../src/web/WebNotes';
import { WebNoteStore } from '../../src/web/noteStore';
import { newPage, type NoteDocument } from '../../src/runtime/noteDocuments';
import { DEFAULT_PAPER } from '../../src/features/notebooks/paperSpec';
import { subscribeFeatureTrace, type FeatureTrace } from '../../src/runtime/featureTrace';
import type { DriveSession, Manifest } from '../../src/web/drive';
import '../../src/index.css';

declare global { interface Window { sharedNoteTrace: (FeatureTrace & { host: string })[]; sharedNoteHost: string } }
window.sharedNoteTrace = []; window.sharedNoteHost = 'desktop';
subscribeFeatureTrace(event => window.sharedNoteTrace.push({ ...event, host: window.sharedNoteHost }));
const markdownId = 'a'.repeat(32), notebookId = 'b'.repeat(32);
const manifest: Manifest = { version: 1, revision: 'fixture', updated_at: '', items: [], attachments: [], files: {} };
const store = new WebNoteStore({ noteFiles: async () => [], saveNote: async () => undefined } as unknown as DriveSession, 'shared-session-fixture', manifest);
await store.start();
const base = { parent_id: null, collection_name: '', note_position: 0, revision: '' };
store.edit({ ...base, id: markdownId, kind: 'markdown', title: 'Markdown fixture', content: 'base' });
const note: NoteDocument = { ...base, id: notebookId, kind: 'notebook', title: 'Notebook fixture',
  document: { version: 1, revision: 1, pages: [newPage({ ...DEFAULT_PAPER, template: 'blank' })] }, ink: {} };
store.edit(note); await store.flush();
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function App() {
  const [host, setHost] = useState('desktop'), [kind, setKind] = useState('markdown');
  const [placement, setPlacement] = useState(0), [duplicate, setDuplicate] = useState(false);
  const view = () => host === 'web' ? <WebNoteEditor store={store} id={kind === 'markdown' ? markdownId : notebookId} manifest={manifest} onClose={() => undefined} />
    : kind === 'markdown' ? <MarkdownNote id={markdownId} /> : <NoteDocumentEditor id={notebookId} />;
  return <main style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
    <nav>{['desktop', 'web'].map(value => <button key={value} onClick={() => { window.sharedNoteHost = value; setHost(value); }}>{value}</button>)}
      <button onClick={() => setKind('markdown')}>Markdown fixture</button><button onClick={() => setKind('notebook')}>Notebook fixture</button>
      <button onClick={() => setPlacement(value => value + 1)}>表示面を作り直す</button><button onClick={() => setDuplicate(value => !value)}>二重表示を切替</button>
      {host === 'web' && <button onClick={() => { const current = store.getSnapshot().notes.find(value => value.id === markdownId)!; store.edit({ ...current, content: 'peer update' }, current); }}>外部の本文を受信</button>}
    </nav>
    <section key={`${host}:${kind}:${placement}`} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>{view()}</section>
    {duplicate && <section data-duplicate style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>{view()}</section>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={queryClient}><App /></QueryClientProvider>);

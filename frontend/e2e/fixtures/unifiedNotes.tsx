import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WebNoteStore } from '../../src/web/noteStore';
import { WebNotesNavigation, WebNoteEditor } from '../../src/web/WebNotes';
import type { DriveSession, Manifest } from '../../src/web/drive';
import '../../src/index.css';
const manifest: Manifest = { version: 1, revision: 'fixture', updated_at: '', items: [], attachments: [], files: {} };
const store = new WebNoteStore({ noteFiles: async () => [], saveNote: async () => undefined } as unknown as DriveSession, 'notes-fixture', manifest);
function App() {
  const [selected, setSelected] = useState('');
  useEffect(() => { void store.start(); }, []);
  return <main style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
    {selected ? <WebNoteEditor store={store} id={selected} manifest={manifest} onClose={() => setSelected('')} /> : <WebNotesNavigation store={store} manifest={manifest} onOpen={setSelected} />}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);

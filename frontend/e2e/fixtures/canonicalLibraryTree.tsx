import { useState } from 'react';
import '../../src/index.css';
import { createRoot } from 'react-dom/client';
import { LibraryHierarchy } from '../../src/features/library/tree/LibraryHierarchy';
import { canonicalLibraryRows } from '../../src/features/library/tree/canonicalLibraryTree';
import type { LibraryItem } from '../../src/runtime/edits/contracts';

// Presentation-only component contract. No repository, binding, session, admission or durable writer.
const items: LibraryItem[] = Array.from({ length: 2000 }, (_, index) => ({ id: `root-${index}`, kind: 'markdown', title: `Root ${index}`,
  folderId: null, ownerId: null, position: index, tags: [], read: false, metadata: {} }));
for (let index = 0; index < 9; index++) items.push({ id: `child-${index}`, kind: 'markdown', title: `Child ${index}`,
  folderId: 'folder', ownerId: null, position: index, tags: [], read: false, metadata: {} });
function App() {
  const [expanded, setExpanded] = useState(new Set(['folder:folder'])), [focused, setFocused] = useState<string | null>('folder:folder');
  const [request, setRequest] = useState(0), [opened, setOpened] = useState('none');
  const rows = canonicalLibraryRows({ items, folders: [{ id: 'folder', title: 'Children', parentId: null, position: -1 }], expanded });
  return <main><button onClick={() => { setFocused('item:child-8'); setExpanded(new Set(['folder:folder'])); setRequest(value => value + 1); }}>Reveal hidden child</button>
    <output aria-label="Opened item">{opened}</output><output aria-label="Full projected rows">{rows.length}</output>
    <section aria-label="Catalog clip" style={{ height: 260, overflow: 'auto', border: '1px solid' }}><div style={{ height: 120 }}>Representative catalog controls</div>
    <LibraryHierarchy rows={rows} focusedKey={focused} focusRequest={request} selectedFolderId={null} focus={setFocused}
      toggle={(key, open) => setExpanded(values => { const next = new Set(values); if (open) next.add(key); else next.delete(key); return next; })}
      selectFolder={() => {}} selectItem={() => {}} openItem={setOpened} renderItem={id => <button onClick={() => setOpened(id)}>{items.find(item => item.id === id)!.title}</button>} />
    </section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);

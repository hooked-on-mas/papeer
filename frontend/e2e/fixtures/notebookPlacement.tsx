import { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '../../src/lib/queryClient';
import { LegacyReaderAreaConnection } from '../../src/app/LegacyReaderAreaConnection';
import { useStore } from '../../src/store';
import { openPaper } from '../../src/features/library/selectionStore';
import { selectMemo } from '../../src/features/notes/memoState';
import '../../src/index.css';

const owner = 'a'.repeat(32), notebook = 'b'.repeat(32);
useStore.setState({ activePaperId: notebook, activeTab: 'reader', sidePanel: null, uiStateLoaded: true, currentPage: 1 });
function Fixture() {
  return <main style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
    <button onClick={() => { openPaper(owner, ''); useStore.getState().setSidePanel('notes'); selectMemo(owner, notebook); }}>親資料の右ノートへ</button>
    <section style={{ flex: 1, minHeight: 0, display: 'flex' }}><Suspense fallback={<p>読み込み中…</p>}><LegacyReaderAreaConnection /></Suspense></section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={queryClient}><Fixture /></QueryClientProvider>);

import type { ReactNode } from 'react';

/** Layout only: callers supply one editor and a read-only reference. */
export function ReaderWorkspace({ placement, editor, reference }: {
  placement: 'center' | 'right'; editor: ReactNode; reference: ReactNode;
}) {
  return <div className="document-workspace min-h-0 min-w-0 flex-1" data-editor-placement={placement}>
    <div className={`document-workspace-columns ${placement === 'right' ? 'document-workspace-docked' : ''}`}>
      {placement === 'center' ? <section key="center" aria-label="中央の編集" className="min-h-0 min-w-0 overflow-hidden">
        {editor}
      </section> : <>
        <section key="reference" aria-label="参照表示" className="document-workspace-reference min-h-0 min-w-0 overflow-hidden">
          {reference}
        </section>
        <aside key="right" aria-label="右側の編集" className="min-h-0 min-w-0 overflow-hidden border-l">
          {editor}
        </aside>
      </>}
    </div>
  </div>;
}

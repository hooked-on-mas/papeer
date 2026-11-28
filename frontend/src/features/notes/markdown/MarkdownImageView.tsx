import { useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../components/ui/dialog';
import { useWorkspaceFocusBlocker } from '../../workspace/WorkspaceCommandContext';

/** Image UI only. The resource loader owns URL validation, acquisition and release. */
export function MarkdownImageView({ src, alt = '画像', title, failed, retry, onError }: {
  src?: string; alt?: string; title?: string; failed?: boolean; retry(): void; onError(): void;
}) {
  const [opened, setOpened] = useState(''), [loaded, setLoaded] = useState('');
  const openedRef = useRef(false); openedRef.current = !!src && opened === src;
  useWorkspaceFocusBlocker(() => !openedRef.current);
  const label = alt || '画像';
  return <span className="inline-block max-w-full">
    {src ? <button type="button" aria-label={`${label}を拡大`} className="max-w-full cursor-zoom-in" onClick={() => { openedRef.current = true; setOpened(src); }}>
      <img src={src} alt={alt} title={title} className="max-w-full h-auto" onLoad={() => setLoaded(src)} onError={onError} />
    </button> : <span role="status">{label}（{failed ? '読み込めませんでした' : '読み込み中…'}）</span>}
    {src && loaded !== src && <span role="status">{label}（読み込み中…）</span>}
    {failed && <button type="button" className="ml-2 underline" onClick={retry}>画像を再試行: {label}</button>}
    <Dialog open={!!src && opened === src} onOpenChange={open => { openedRef.current = !!open && !!src; setOpened(open && src ? src : ''); }}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-4xl">
        <DialogHeader><DialogTitle>画像の拡大表示</DialogTitle><DialogDescription>{label}</DialogDescription></DialogHeader>
        {src && <img src={src} alt={alt} title={title} className="max-h-[75vh] max-w-full object-contain" onError={onError} />}
      </DialogContent>
    </Dialog>
  </span>;
}

export function ExternalMarkdownImage({ src, alt, title }: { src: string; alt?: string; title?: string }) {
  const [attempt, setAttempt] = useState(0), [failed, setFailed] = useState<string>();
  const key = `${src}:${attempt}`;
  return <MarkdownImageView key={key} src={failed === key ? undefined : src} alt={alt} title={title} failed={failed === key}
    onError={() => setFailed(key)} retry={() => { setFailed(undefined); setAttempt(value => value + 1); }} />;
}

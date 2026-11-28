import { useState } from 'react';
import { Button } from '../../../components/ui/button';
import type { MarkdownSnapshot } from '../../../runtime/edits/contracts';

/** The panel has no storage or commit authority; the target session owns every action. */
export type MarkdownConflictPort = {
  heads: readonly string[];
  busy: boolean;
  canDiscardRejected: boolean;
  compare(): readonly MarkdownSnapshot[];
  checkout(version: string): Promise<boolean>;
  adopt(version: string, heads: readonly string[]): Promise<boolean>;
  discardRejected(): Promise<boolean>;
};

export function MarkdownConflictPanel({ port }: { port: MarkdownConflictPort }) {
  const [compared, setCompared] = useState<readonly MarkdownSnapshot[]>([]);
  const [message, setMessage] = useState('');
  const current = compared.length > 1 && JSON.stringify(compared.map(value => value.version).sort()) === JSON.stringify([...port.heads].sort());
  return <section aria-label="ノートの競合" className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs">
    <p>複数の版があります。内容を比較してから、採用または編集する版を選んでください。</p>
    <div className="flex flex-wrap gap-1.5">
      <Button type="button" variant="outline" size="xs" disabled={port.busy} onClick={() => { setCompared(port.compare()); setMessage(''); }}>版を比較</Button>
      {compared.length > 0 && <Button type="button" variant="ghost" size="xs" disabled={port.busy} onClick={() => { setCompared([]); setMessage('両方の版を保持します。'); }}>両方を保持</Button>}
      {port.canDiscardRejected && <Button type="button" variant="outline" size="xs" disabled={port.busy} onClick={() => { void port.discardRejected().then(ok => { if (ok) { setCompared([]); setMessage('最新の版をもう一度比較してください。'); } }); }}>拒否された採用を取り消す</Button>}
    </div>
    {compared.map(value => <article key={value.version} className="space-y-1.5 rounded border bg-background p-2">
      <h3 className="font-medium">版 {value.version.slice(0, 8)}</h3>
      <pre className="max-h-40 overflow-auto rounded border bg-muted/30 p-2 text-xs whitespace-pre-wrap break-all">{value.content}</pre>
      <div className="flex flex-wrap gap-1.5">
        <Button type="button" variant="outline" size="xs" disabled={port.busy || !current} onClick={() => { void port.checkout(value.version).then(ok => setMessage(ok ? 'この版を表示しています。ほかの版も保持されています。' : '版を開けませんでした。')); }}>この版を編集</Button>
        <Button type="button" size="xs" disabled={port.busy || !current} onClick={() => { void port.adopt(value.version, compared.map(item => item.version)).then(ok => setMessage(ok ? 'この内容を採用しました。' : '採用を確認できません。保存状態を確認してください。')); }}>この内容を採用</Button>
      </div>
    </article>)}
    {!current && compared.length > 0 && <p role="status" className="text-muted-foreground">版が変わりました。もう一度比較してください。</p>}
    {message && <p role="status" className="text-muted-foreground">{message}</p>}
  </section>;
}

import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { NativeSelect } from '../../../components/ui/native-select';
import type { NoteAppendState } from './NoteAppendSession';

export type NoteAppendActions = {
  state: NoteAppendState; canCancel: boolean;
  submit(noteId: string): void; retry(): void; cancel(): void; dismiss(): void; openTarget(): void;
  createAndSubmit?(input: { title: string }): void;
};

/** Both hosts use the same destination selection and retained request actions. */
export function NoteAppendDialog({ append }: { append: NoteAppendActions }) {
  const state = append.state;
  const [selected, setSelected] = useState('');
  const [title, setTitle] = useState('');
  const picker = useRef<HTMLSelectElement>(null);
  useEffect(() => { setSelected(''); setTitle(''); }, [state.request?.id]);
  useEffect(() => { if (state.phase === 'choosing') picker.current?.focus(); }, [state.request?.id, state.phase]);
  if (!state.request) return state.error ? <div role="alert" className="flex flex-wrap items-center gap-2 border-t bg-destructive/10 p-2.5 text-xs text-destructive">
    <span>保存された追記を読み込めません。元のデータを保持しています。</span>
    <Button type="button" variant="outline" size="xs" disabled={state.busy} onClick={append.retry}>追記の復旧を再試行</Button>
  </div> : null;
  if (state.phase === 'idle' || state.phase === 'canceled') return null;
  const destination = state.destinationId ?? selected;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
    <div role="dialog" aria-label="引用をノートへ追加" className="w-full max-w-md space-y-3 rounded-lg border bg-background p-4 text-sm shadow-lg">
      <div className="font-semibold">引用をノートへ追加</div>
      {state.phase === 'accepted' ? <>
        <p role="status" className="text-muted-foreground">ノートに追加しました。</p>
        {state.error && <div role="alert" className="flex flex-wrap items-center gap-2 rounded border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
          <span>追記は保存済みですが、復旧情報を整理できませんでした。</span>
          <Button type="button" variant="outline" size="xs" disabled={state.busy} onClick={append.retry}>再試行</Button>
        </div>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={append.openTarget}>追加先を開く</Button>
          <Button type="button" size="sm" onClick={append.dismiss}>閉じる</Button>
        </div>
      </> : <>
        <p className="text-muted-foreground">{state.request.input.kind === 'annotations' ? `一覧の注釈 ${state.request.input.result.rows.length}件と出典を追加します。`
          : state.request.input.kind === 'quote' ? '選択した文章を引用として追加します。' : '選択範囲の画像と出典を追加します。'}</p>
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">追加先のノート</span>
          <NativeSelect ref={picker} aria-label="追加先のノート" value={destination} disabled={state.busy || !!state.destinationId}
            onChange={event => setSelected(event.target.value)}>
            <option value="">ノートを選択</option>
            {state.candidates.map(note => <option key={note.id} value={note.id}>{note.title}</option>)}
          </NativeSelect>
        </label>
        {!state.busy && !state.candidates.length && <p className="text-xs text-muted-foreground">追加先のMarkdownノートがありません。</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" disabled={state.busy || !destination || !!state.destinationId}
            onClick={() => append.submit(destination)}>ノートへ追加</Button>
        </div>
        {append.createAndSubmit && state.request.input.kind === 'annotations' && <div className="space-y-2 border-t pt-3">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">新しいノートの名前</span>
            <Input aria-label="新しいノートの名前" value={state.creation?.input.title ?? title}
              disabled={state.busy || !!state.destinationId || !!state.creation} onChange={event => setTitle(event.target.value)} />
          </label>
          <Button type="button" variant="outline" size="sm" disabled={state.busy || !!state.destinationId || !!state.creation || !title.trim()}
            onClick={() => append.createAndSubmit?.({ title })}>ノートを作成して追加</Button>
        </div>}
        {state.creation && <p className="text-xs text-muted-foreground">作成の再試行では同じノートを使います。追加を取り消しても、作成済みのノートは残ります。</p>}
        {state.busy && <p role="status" className="text-xs text-muted-foreground">追加しています…</p>}
        {state.phase === 'failed' && <div role="alert" className="flex flex-wrap items-center gap-2 rounded border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
          <span>追加できませんでした。内容を保持しています。</span>
          <Button type="button" variant="outline" size="xs" disabled={state.busy} onClick={append.retry}>再試行</Button>
        </div>}
        <div className="flex flex-wrap justify-end gap-2 border-t pt-3">
          <Button type="button" variant="outline" size="sm" disabled={!append.canCancel} onClick={append.cancel}>追加を取り消す</Button>
          {state.destinationId && <Button type="button" variant="outline" size="sm" disabled={state.busy}
            onClick={append.openTarget}>追加先を開く</Button>}
        </div>
      </>}
    </div>
  </div>;
}

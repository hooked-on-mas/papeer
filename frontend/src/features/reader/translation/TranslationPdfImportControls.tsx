import { useRef, type MutableRefObject } from 'react';
import { FileUp } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { NativeSelect } from '../../../components/ui/native-select';
import type { TranslationPdfImportController } from './useTranslationPdfImport';
import { useFocusFileChooser } from '../../workspace/useFocusFileChooser';

const errorMessage = (code: string) => /size/.test(code)
  ? '空でない128 MiB以下の訳文PDFを選んでください。'
  : /stale|changed|version|head/.test(code)
  ? '準備中に文書の版が変わりました。取込を取り消して、最新の文書でPDFを選び直してください。'
  : /mapping|original|unselected/.test(code)
    ? '各訳文ページに対応する原文ページ、または「対応なし」を選んでください。'
    : /blocked|draft|input|guard|refused/.test(code)
      ? '編集中の入力や保存を確認してから、もう一度実行してください。'
      : '訳文PDFを準備できませんでした。PDFを確認して再試行してください。';

export function TranslationPdfImportControls({ controller, openPickerRef, showTrigger = true }: {
  controller: TranslationPdfImportController;
  openPickerRef?: MutableRefObject<(() => void) | null>;
  showTrigger?: boolean;
}) {
  const chooser = useFocusFileChooser();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const attach = (node: HTMLInputElement | null) => { inputRef.current = node; chooser.attach(node); };
  if (openPickerRef) openPickerRef.current = () => { inputRef.current?.click(); };
  const { state } = controller;
  const busy = state.phase === 'reading' || state.phase === 'submitting';
  const visible = showTrigger || state.phase !== 'idle' || !!state.error;
  return <section data-document-import-command aria-label="訳文PDFの取込"
    className={visible ? 'space-y-2 border-b bg-muted/30 px-3 py-2 text-xs' : 'hidden'}>
    <input ref={attach} type="file" accept="application/pdf,.pdf" className="hidden" aria-label="取り込む訳文PDF"
      disabled={!controller.available || state.phase !== 'idle'} onClick={chooser.begin} onChange={event => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
        chooser.selected(file ? controller.stage(file) : undefined);
      }} />
    {showTrigger && state.phase === 'idle' && (
      <Button type="button" variant="outline" size="xs" disabled={!controller.available} onClick={() => inputRef.current?.click()}>
        <FileUp className="size-3.5" />訳文PDFを取り込む
      </Button>
    )}
    {state.phase !== 'idle' && <>
      <p className="font-medium">{controller.name}</p>
      {state.pages.length > 0 && <>
        <p className="text-muted-foreground">PDFのページ順から対応を推測しません。各ページの対応先を選んでください。</p>
        <div className="flex flex-wrap gap-2">
          {state.pages.map((page, index) => <label key={page.pageId} className="inline-flex items-center gap-1.5">
            <span>訳文 {page.pdfPage}ページ →</span>
            <NativeSelect aria-label={`訳文${page.pdfPage}ページに対応する原文ページ`} className="h-7 w-auto text-xs"
              disabled={busy} value={page.originalPageId === undefined ? '' : page.originalPageId ?? 'none'}
              onChange={event => { if (event.target.value) controller.setMapping(index, event.target.value === 'none' ? null : event.target.value); }}>
              <option value="" disabled>未選択</option><option value="none">対応なし</option>
              {state.originalPages.map(original => <option key={original.pageId} value={original.pageId}>原文 {original.pageNumber}ページ</option>)}
            </NativeSelect>
          </label>)}
        </div>
        <p className="text-muted-foreground">同じ原文ページに複数の訳文を指定すると、対応が一つに決まるまでその訳文の表示を保留します。</p>
        {state.replacing && <p className="text-muted-foreground">登録済みの訳文PDFを入れ替えます。以前の訳文と注釈は編集履歴に保持します。</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="xs" disabled={busy || !controller.available || state.pages.some(page => page.originalPageId === undefined)}
            onClick={() => { void controller.submit(); }}>{state.replacing ? '訳文PDFを入れ替える' : '訳文PDFを登録する'}</Button>
          <Button type="button" variant="ghost" size="xs" disabled={state.phase === 'submitting'} onClick={controller.cancel}>訳文PDFの取込を取り消す</Button>
        </div>
      </>}
      {state.phase === 'reading' && <p role="status" className="text-muted-foreground">訳文PDFを確認しています…</p>}
      {state.phase === 'error' && !state.pages.length && <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="xs" disabled={!controller.available}
          onClick={() => { void controller.retry(); }}>訳文PDFの準備を再試行</Button>
        <Button type="button" variant="ghost" size="xs" onClick={controller.cancel}>訳文PDFの取込を取り消す</Button>
      </div>}
    </>}
    {state.error && <p role="alert" className="text-destructive">{errorMessage(state.error)}</p>}
  </section>;
}

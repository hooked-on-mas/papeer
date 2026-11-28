import { useRef, useState, type MutableRefObject } from 'react';
import { FileUp } from 'lucide-react';
import { Button } from '../../../../components/ui/button';
import { NativeSelect } from '../../../../components/ui/native-select';
import type { DocumentPdfImportController } from './useDocumentPdfImport';
import { useFocusFileChooser } from '../../../workspace/useFocusFileChooser';

export function DocumentPdfImportControls({ controller, notebook = true, openPickerRef, showTrigger = true }: {
  controller: DocumentPdfImportController;
  notebook?: boolean;
  openPickerRef?: MutableRefObject<(() => void) | null>;
  showTrigger?: boolean;
}) {
  const [physical, setPhysical] = useState(1), [mode, setMode] = useState<'insert' | 'insert-all' | 'replace'>(notebook ? 'insert' : 'replace');
  const chooser = useFocusFileChooser();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const attach = (node: HTMLInputElement | null) => { inputRef.current = node; chooser.attach(node); };
  if (openPickerRef) openPickerRef.current = () => { inputRef.current?.click(); };
  const { state } = controller, busy = state.phase === 'reading' || state.phase === 'submitting';
  const message = /page-limit/.test(state.error) ? 'ノートは500ページまでです。追加するPDFページを減らしてください。'
    : /highlight/.test(state.error) ? '本文ハイライトがあるページは背景を置き換えられません。先にハイライトを確認してください。'
    : /overflow/.test(state.error) ? '書き込みや付箋が新しいPDFページからはみ出すため置き換えません。'
    : /size/.test(state.error) ? '空でない128 MiB以下のPDFを選んでください。'
    : /stale/.test(state.error) ? '文書が更新されました。取込を取り消し、ページを選び直してください。'
    : 'PDFを準備または保存できません。入力と保存状態を確認してください。';
  const visible = showTrigger || state.phase !== 'idle' || !!state.error;
  return <section data-document-import-command aria-label={notebook ? 'ノートにPDFを取り込む' : '原文PDFの背景を差し替える'}
    className={visible ? 'flex flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-1.5 text-xs' : 'hidden'}>
    <input ref={attach} type="file" accept="application/pdf,.pdf" className="hidden"
      aria-label={notebook ? 'ノートに取り込むPDF' : '差し替える原文PDF'}
      disabled={!controller.available || state.phase !== 'idle'}
      onClick={chooser.begin}
      onChange={event => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
        if (file) { setPhysical(1); chooser.selected(controller.stage(file)); } else chooser.selected();
      }} />
    {showTrigger && state.phase === 'idle' && (
      <Button type="button" variant="outline" size="xs" disabled={!controller.available} onClick={() => inputRef.current?.click()}>
        <FileUp className="size-3.5" />{notebook ? 'PDFを取り込む' : '原文PDFを差し替える'}
      </Button>
    )}
    {state.phase !== 'idle' && <>
      <span className="font-medium">{controller.name}</span>
      {state.pages.length > 0 && <>
        <label className="inline-flex items-center gap-1">PDFページ
          <NativeSelect aria-label="取り込むPDFページ" className="h-7 w-20 text-xs" disabled={busy} value={physical} onChange={event => setPhysical(Number(event.target.value))}>
            {state.pages.map((_, index) => <option key={index} value={index + 1}>{index + 1}</option>)}
          </NativeSelect>
        </label>
        {notebook && <label className="inline-flex items-center gap-1">配置
          <NativeSelect aria-label="PDFページの配置" className="h-7 w-auto text-xs" disabled={busy} value={mode} onChange={event => setMode(event.target.value as 'insert' | 'insert-all' | 'replace')}>
            <option value="insert">現在のページの後に追加</option><option value="insert-all">全ページを後に追加</option><option value="replace">現在のページの背景を置き換える</option>
          </NativeSelect>
        </label>}
        {mode === 'replace' && <p className="text-muted-foreground">ページIDと収まる書き込み・付箋を保持します。元の本文ハイライトがある場合や、書き込みがはみ出す場合は置き換えません。</p>}
        <Button type="button" size="xs" disabled={busy || !controller.available} onClick={() => { void controller.submit(mode, physical); }}>PDFページを適用</Button>
      </>}
      {state.phase === 'reading' && <span role="status" className="text-muted-foreground">PDFを確認しています…</span>}
      {state.phase === 'error' && <Button type="button" variant="outline" size="xs" disabled={!controller.available} onClick={() => { void controller.retry(); }}>PDFの準備を再試行</Button>}
      <Button type="button" variant="ghost" size="xs" disabled={state.phase === 'submitting'} onClick={controller.cancel}>PDF取込を取り消す</Button>
    </>}
    {state.error && <p role="alert" className="text-destructive">{message}</p>}
  </section>;
}

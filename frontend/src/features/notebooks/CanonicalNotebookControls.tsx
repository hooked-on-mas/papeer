import { useState } from 'react';
import { FilePlus2, MoreVertical } from 'lucide-react';
import type { Page, PaperSpec } from '../../runtime/edits/contracts';
import { pageExpectation } from '../../runtime/edits/documentPages';
import type { DocumentLibraryView } from '../reader/DocumentLibraryConnection';
import { PAPER_SIZES, PAPER_TEMPLATES } from './paperSpec';
import { CanonicalPaperBackground } from './CanonicalPaperBackground';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../../components/ui/dropdown-menu';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { NativeSelect } from '../../components/ui/native-select';

const PT_PER_MM = 72 / 25.4;
const sizes = { A4: [210 * PT_PER_MM, 297 * PT_PER_MM], B5: [182 * PT_PER_MM, 257 * PT_PER_MM],
  A5: [148 * PT_PER_MM, 210 * PT_PER_MM], Letter: [612, 792], '16:9': [180 * PT_PER_MM, 320 * PT_PER_MM] } as const;
type Size = keyof typeof sizes | 'custom';
function preset(page: Page): Size {
  return PAPER_SIZES.find(size => Math.abs(Math.min(page.widthPt, page.heightPt) - sizes[size][0]) < .001
    && Math.abs(Math.max(page.widthPt, page.heightPt) - sizes[size][1]) < .001) ?? 'custom';
}
function paperError(reason: string) {
  if (reason.includes('paper-content-overflow')) return '書き込みが用紙からはみ出します。サイズを戻すか、縦横比を保って収めてください。';
  if (reason.includes('stale')) return 'ページが更新されています。入力内容を確認し、設定を開き直してください。';
  if (reason.includes('pending') || reason.includes('input')) return '入力と保存を確認してから適用してください。';
  return '用紙を変更できません。入力した寸法と保存状態を確認してください。';
}

function PaperDialog({ view, page, close }: { view: DocumentLibraryView; page: Page; close(): void }) {
  const originalWidth = String(page.widthPt / PT_PER_MM), originalHeight = String(page.heightPt / PT_PER_MM);
  const [width, setWidth] = useState(originalWidth), [height, setHeight] = useState(originalHeight);
  const [size, setSize] = useState<Size>(() => preset(page));
  const [spec, setSpec] = useState<PaperSpec>(() => page.background.kind === 'paper' ? page.background.spec : { template: 'blank', color: 'white' });
  const [error, setError] = useState(''), [saving, setSaving] = useState(false), [overflow, setOverflow] = useState(false);
  const widthPt = width === originalWidth ? page.widthPt : Number(width) * PT_PER_MM;
  const heightPt = height === originalHeight ? page.heightPt : Number(height) * PT_PER_MM;
  const landscape = widthPt > heightPt;
  const chooseSize = (size: Size) => {
    setSize(size);
    if (size !== 'custom') {
      const [short, long] = sizes[size];
      setWidth(String((landscape ? long : short) / PT_PER_MM)); setHeight(String((landscape ? short : long) / PT_PER_MM));
    }
  };
  const apply = async (fit = false) => {
    if (!view.notebook || saving) return;
    if (!width.trim() || !height.trim() || ![widthPt, heightPt].every(value => Number.isFinite(value) && value > 0)) {
      setError('幅と高さに正の数を入力してください。'); return;
    }
    setSaving(true); setError('');
    try {
      const result = await view.notebook.applyPaper({ pageId: page.id, expected: pageExpectation(page), widthPt, heightPt, spec, fit });
      if (result.status === 'refused') {
        setError(paperError(result.reason)); setOverflow(result.reason.includes('paper-content-overflow'));
      } else close();
    } catch { setError('用紙を変更できません。入力内容は保持しています。'); }
    finally { setSaving(false); }
  };
  const preview = Number.isFinite(widthPt + heightPt) && widthPt > 0 && heightPt > 0
    ? { ...page, widthPt, heightPt, background: { kind: 'paper' as const, spec } } : page;
  return <Dialog open onOpenChange={open => { if (!open && !saving) close(); }}>
    <DialogContent showCloseButton={!saving} className="canonical-paper-dialog max-h-[90vh] overflow-auto sm:max-w-xl">
      <DialogHeader><DialogTitle>用紙設定</DialogTitle><DialogDescription>書き込みの実寸と位置を保ちます。はみ出す場合は、縦横比を保って収める方法を選べます。</DialogDescription></DialogHeader>
      <div className="flex gap-4">
        <div className="relative w-28 shrink-0 self-start overflow-hidden rounded border" style={{ aspectRatio: preview.widthPt / preview.heightPt }}>
          <CanonicalPaperBackground page={preview} />
        </div>
        <fieldset disabled={saving} className="grid min-w-0 flex-1 grid-cols-2 gap-3 text-xs">
          <label className="space-y-1"><span className="text-muted-foreground">サイズ</span><NativeSelect autoFocus aria-label="用紙サイズ" className="h-7 text-xs" value={size} onChange={event => chooseSize(event.target.value as Size)}>
            {PAPER_SIZES.map(size => <option key={size} value={size}>{size}</option>)}<option value="custom">カスタム</option>
          </NativeSelect></label>
          <label className="space-y-1"><span className="text-muted-foreground">向き</span><NativeSelect aria-label="用紙の向き" className="h-7 text-xs" value={landscape ? 'landscape' : 'portrait'} onChange={event => {
            const short = Math.min(widthPt, heightPt), long = Math.max(widthPt, heightPt);
            setWidth(String((event.target.value === 'landscape' ? long : short) / PT_PER_MM));
            setHeight(String((event.target.value === 'landscape' ? short : long) / PT_PER_MM));
          }}><option value="portrait">縦</option><option value="landscape">横</option></NativeSelect></label>
          <label className="space-y-1"><span className="text-muted-foreground">幅（mm）</span><Input aria-label="幅（mm）" className="h-7 text-xs" type="number" step="any" value={width} onChange={event => { setWidth(event.target.value); setSize('custom'); }} /></label>
          <label className="space-y-1"><span className="text-muted-foreground">高さ（mm）</span><Input aria-label="高さ（mm）" className="h-7 text-xs" type="number" step="any" value={height} onChange={event => { setHeight(event.target.value); setSize('custom'); }} /></label>
          <label className="col-span-2 space-y-1"><span className="text-muted-foreground">罫線</span><NativeSelect aria-label="罫線" className="h-7 text-xs" value={spec.template} onChange={event => setSpec({ ...spec, template: event.target.value as PaperSpec['template'] })}>
            {PAPER_TEMPLATES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </NativeSelect></label>
          <label className="col-span-2 space-y-1"><span className="text-muted-foreground">色</span><NativeSelect aria-label="用紙色" className="h-7 text-xs" value={spec.color} onChange={event => setSpec({ ...spec, color: event.target.value as PaperSpec['color'] })}>
            <option value="white">白</option><option value="cream">クリーム</option><option value="dark">ダーク</option>
          </NativeSelect></label>
        </fieldset>
      </div>
      {error && <p role="alert" className="my-3 text-sm text-destructive">{error}</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-3">
        <Button type="button" variant="outline" disabled={saving} onClick={close}>キャンセル</Button>
        {overflow && <Button type="button" variant="outline" disabled={saving} onClick={() => { void apply(true); }}>縦横比を保って収める</Button>}
        <Button type="button" disabled={saving} onClick={() => { void apply(); }}>{saving ? '適用中…' : '適用'}</Button>
      </div>
    </DialogContent>
  </Dialog>;
}

export function CanonicalNotebookControls({ view, onImportPdf }: { view: DocumentLibraryView; onImportPdf?: () => void }) {
  const [paperPage, setPaperPage] = useState<Page | null>(null);
  if (!view.notebook || !view.page) return null;
  const busy = view.loading || view.state.inputActive || !view.editable || !view.notebookPdfImport?.canLeave();
  const page = view.page;
  return <>
    <Button type="button" variant="ghost" size="sm" aria-label="ページ追加" title="ページ追加" disabled={busy || view.pageCount >= 500}
      onClick={() => { void view.notebook?.insert(); }}>
      <FilePlus2 className="size-3.5" /><span className="hidden sm:inline">ページ追加</span>
    </Button>
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="ページ操作" title="ページ操作" disabled={busy}
        className="inline-flex h-7 items-center gap-1 rounded px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50">
        <MoreVertical className="size-3.5" /><span className="hidden xl:inline">ページ操作</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-max min-w-44">
        <DropdownMenuItem disabled={busy || page.background.kind !== 'paper'} onClick={() => setPaperPage(page)}>用紙設定</DropdownMenuItem>
        <DropdownMenuItem disabled={busy || view.pageCount >= 500} onClick={() => { void view.notebook?.duplicate(); }}>ページ複製</DropdownMenuItem>
        <DropdownMenuItem disabled={busy || view.pageIndex === 0} onClick={() => { void view.notebook?.reorder(-1); }}>前へ移動</DropdownMenuItem>
        <DropdownMenuItem disabled={busy || view.pageIndex + 1 >= view.pageCount} onClick={() => { void view.notebook?.reorder(1); }}>後ろへ移動</DropdownMenuItem>
        {view.notebookPdfImport && onImportPdf && (
          <DropdownMenuItem disabled={!view.notebookPdfImport.available || view.notebookPdfImport.state.phase !== 'idle'} onClick={onImportPdf}>PDFを取り込む…</DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" disabled={busy || view.pageCount <= 1} onClick={() => { void view.notebook?.remove(); }}>ページ削除</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {paperPage && <PaperDialog view={view} page={paperPage} close={() => setPaperPage(null)} />}
  </>;
}

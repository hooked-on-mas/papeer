import { Download, Scan } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { NativeSelect } from '../../../components/ui/native-select';
import type { DocumentOutputController } from './useDocumentOutput';

export function DocumentOutputControls({ output, blocked, startCapture, captureAvailable }: {
  output: DocumentOutputController; blocked: boolean; startCapture(): void; captureAvailable: boolean;
}) {
  return <div className="space-y-4 text-sm" role="group" aria-label="資料の書き出し">
    <div className="space-y-2 rounded-lg border p-3">
      <div className="font-medium">PDFを書き出す</div>
      <div className="grid grid-cols-[6rem_1fr] items-center gap-2 text-xs">
        <span className="text-muted-foreground">出力対象</span>
        <NativeSelect aria-label="出力するページ" className="h-7 text-xs" value={output.pool} disabled={output.busy}
          onChange={e => output.setPool(e.target.value as 'original' | 'translated')}><option value="original">原文</option><option value="translated">訳文</option></NativeSelect>
      </div>
      {output.pool === 'translated' && <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={output.translatedOnly} disabled={output.busy}
          onChange={e => output.setTranslatedOnly(e.target.checked)} />翻訳済みページだけ
      </label>}
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" aria-label="出力に注釈を含める" checked={output.includeAnnotations} disabled={output.busy}
          onChange={e => output.setIncludeAnnotations(e.target.checked)} />注釈を含める
      </label>
      <Button type="button" size="sm" disabled={blocked || output.busy} onClick={() => { void output.exportPdf(); }}>
        <Download className="size-3.5" />PDFを書き出す
      </Button>
    </div>

    <div className="space-y-2 rounded-lg border p-3">
      <div className="font-medium">範囲を切り抜く</div>
      <div className="grid grid-cols-[6rem_1fr] items-center gap-2 text-xs">
        <span className="text-muted-foreground">切り抜き先</span>
        <NativeSelect aria-label="切り抜き先" className="h-7 text-xs" value={output.destination} disabled={output.busy}
          onChange={e => output.setDestination(e.target.value as 'note' | 'download' | 'clipboard')}>
          <option value="note">ノートへ追記</option><option value="download">画像を保存</option><option value="clipboard">画像をコピー</option>
        </NativeSelect>
      </div>
      <Button type="button" variant="outline" size="sm" disabled={blocked || output.busy || !captureAvailable} onClick={startCapture}>
        <Scan className="size-3.5" />範囲を切り抜く
      </Button>
    </div>

    <div className="flex flex-wrap items-center gap-2 text-xs">
      {output.busy && <Button type="button" variant="ghost" size="xs" disabled={!output.canCancel} onClick={output.cancel}>出力を取り消す</Button>}
      {output.canDownloadCapture && <Button type="button" variant="outline" size="xs" disabled={output.busy || blocked} onClick={() => { void output.downloadCapture(); }}>生成した画像をダウンロード</Button>}
      {output.status && <span role="status" className="text-muted-foreground">{output.status}</span>}
      {output.error && <span role="alert" className="text-destructive">{output.error}</span>}
    </div>
  </div>;
}

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Page } from '../../../runtime/edits/contracts';
import type { DocumentEditSession } from '../edit/DocumentEditSession';
import type { DocumentLibraryBinding } from '../DocumentLibraryBinding';
import type { CaptureBounds } from '../pdf/canonicalPdfCapturePlan';
import { captureCanonicalPdf } from '../pdf/canonicalPdfCapture';
import { SnapshotSession } from './SnapshotSession';

export type CaptureDestination = 'note' | 'download' | 'clipboard';
function outputError(cause: unknown) {
  const code = cause instanceof Error ? cause.message : '';
  if (/input-pending/.test(code)) return '描画や文字入力を確定または取り消してから出力してください。';
  if (/font/.test(code)) return '出力に必要な文字やフォントを利用できません。内容は保持しています。';
  if (/resource-limit|page-limit/.test(code)) return '一度に出力できる上限（PDF合計128MiB・10,000ページ）を超えています。';
  if (/translation/.test(code)) return '訳文の対応が未確定、または訳文のないページがあります。出力対象を確認してください。';
  if (/signed|signature|acroform/.test(code)) return '署名やフォームを保全できないため、このPDFの書き出しを中止しました。';
  if (/scope|version|resource/.test(code)) return '資料の版や保存データを確認できません。再読み込みしてから出力してください。';
  if (/timeout/.test(code)) return '出力に時間がかかりすぎたため中止しました。内容は保持しています。';
  return '出力できませんでした。保存先や資料を確認して再試行してください。';
}
export function useDocumentOutput({ binding, session, active, inputBlocked, title }: {
  binding: DocumentLibraryBinding; session: DocumentEditSession; active(): boolean; inputBlocked(): boolean; title: string;
}) {
  const providers = useRef({ active, inputBlocked }); providers.current = { active, inputBlocked };
  const mounted = useRef(false), controller = useRef<AbortController | null>(null);
  const delivered = useRef(false);
  const snapshots = useMemo(() => new SnapshotSession({ repository: binding.repository, state: session.getSnapshot,
    active: () => mounted.current && providers.current.active(), inputBlocked: () => providers.current.inputBlocked() }), [binding, session]);
  const [pool, setPool] = useState<'original' | 'translated'>('original'), [translatedOnly, setTranslatedOnly] = useState(false);
  const [includeAnnotations, setIncludeAnnotations] = useState(true), [destination, setDestination] = useState<CaptureDestination>('note');
  const [status, setStatus] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const fallback = useRef<{ bytes: Uint8Array; name: string } | null>(null);
  const [canDownloadCapture, setCanDownloadCapture] = useState(false);
  const [delivering, setDelivering] = useState(false);
  const saveOutput = async (bytes: Uint8Array, mediaType: 'application/pdf' | 'image/png', name: string) => {
    if (!binding.outputFile || !providers.current.active()) throw new Error('output-save-unavailable');
    controller.current?.signal.throwIfAborted();
    // This scope-owned fence survives component unmount until the native dialog/write settles.
    const release = binding.sessions.registerScopeViewGuard(() => false); setDelivering(true);
    try { const result = await binding.outputFile.save(bytes, mediaType, name); delivered.current = result !== 'cancelled'; return result; }
    finally { release(); if (mounted.current) setDelivering(false); }
  };
  useEffect(() => {
    mounted.current = true;
    const hide = () => { controller.current?.abort(); }, show = () => { mounted.current = true; };
    window.addEventListener('pagehide', hide); window.addEventListener('pageshow', show);
    const release = binding.sessions.registerScopeViewGuard(() => !controller.current);
    return () => { mounted.current = false; controller.current?.abort(); release(); window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', show); };
  }, [binding.sessions]);
  const filename = (extension: string) => `${(title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 140) || '資料').replace(/\.pdf$/i, '')}-注釈.${extension}`;
  async function run(operation: (signal: AbortSignal) => Promise<string>) {
    if (controller.current) return;
    const current = new AbortController(); controller.current = current; delivered.current = false; setBusy(true); setError(''); setStatus('開始時点の内容で出力しています…');
    try {
      const message = await operation(current.signal);
      if (!delivered.current) current.signal.throwIfAborted(); if (mounted.current && providers.current.active()) setStatus(message);
    } catch (cause) { if (mounted.current) { setStatus(''); setError(current.signal.aborted ? '出力を取り消しました。' : outputError(cause)); } }
    finally { if (controller.current === current) controller.current = null; if (mounted.current) setBusy(false); }
  }
  const exportPdf = () => run(async signal => {
    const captured = snapshots.capture({ pool, translatedOnly, includeAnnotations });
    if (!binding.outputFile) throw new Error('output-save-unavailable');
    const resources = await snapshots.resources(captured, signal), fonts = await binding.outputFile.fonts(captured.snapshot.pages, signal);
    snapshots.assertActive(captured, signal);
    const bytes = await binding.outputFile.renderPdf({ snapshot: captured.snapshot, resources, fonts }, signal);
    snapshots.assertActive(captured, signal);
    const saved = await saveOutput(bytes, 'application/pdf', filename('pdf'));
    return saved === 'cancelled' ? '保存を取り消しました。' : `PDFを${saved === 'saved' ? '保存' : 'ダウンロード'}しました。${captured.persistence !== 'idle' ? '未耐久の確定済み変更を含みます。' : ''}${captured.heads.length > 1 ? '選択した競合版の出力です。競合は未解決です。' : ''}`;
  });
  const capture = (page: Page, bounds: CaptureBounds) => run(async signal => {
    const captured = snapshots.capture();
    const frozen = structuredClone(page);
    if (!binding.outputFile) throw new Error('output-save-unavailable');
    const fonts = await binding.outputFile.fonts([{ ...frozen, annotations: includeAnnotations ? frozen.annotations : [] }], signal);
    snapshots.assertActive(captured, signal);
    const png = await captureCanonicalPdf({ page: frozen, resources: binding.repository, bounds, includeAnnotations, fonts, signal });
    snapshots.assertActive(captured, signal);
    const name = filename('png');
    if (destination === 'clipboard') {
      try {
        setDelivering(true); await binding.outputFile.copyImage(png.bytes); delivered.current = true;
        fallback.current = null; if (mounted.current) setCanDownloadCapture(false); return '画像をコピーしました。';
      } catch {
        snapshots.assertActive(captured, signal); fallback.current = { bytes: png.bytes, name }; setCanDownloadCapture(true);
        return '画像をコピーできません。生成した画像をダウンロードできます。';
      } finally { if (mounted.current) setDelivering(false); }
    }
    const saved = await saveOutput(png.bytes, 'image/png', name);
    return saved === 'cancelled' ? '保存を取り消しました。' : `画像を${saved === 'saved' ? '保存' : 'ダウンロード'}しました。`;
  });
  return { pool, setPool, translatedOnly, setTranslatedOnly, includeAnnotations, setIncludeAnnotations, destination, setDestination, canRelayout: () => !controller.current,
    busy, status, error, exportPdf, capture, canCancel: busy && !delivering, cancel: () => { if (!delivering) controller.current?.abort(); }, canDownloadCapture,
    downloadCapture: () => run(async signal => {
      const value = fallback.current; if (!value || !providers.current.active()) throw new Error('capture-unavailable');
      signal.throwIfAborted(); const saved = await saveOutput(value.bytes, 'image/png', value.name); return saved === 'cancelled' ? '保存を取り消しました。' : '画像を保存しました。';
    }) };
}
export type DocumentOutputController = ReturnType<typeof useDocumentOutput>;

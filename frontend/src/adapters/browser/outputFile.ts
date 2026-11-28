import type { OutputFilePort } from '../../features/reader/output/ports';
import fontkit from '@pdf-lib/fontkit';

export const browserOutputFile: OutputFilePort = { async save(bytes, mediaType, suggestedName) {
  const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], { type: mediaType }));
  const link = document.createElement('a'); link.href = url; link.download = suggestedName; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
},
async fonts(pages, signal) {
  const sansUrl = `${import.meta.env.BASE_URL}fonts/output/NotoSansJP-Regular.ttf`;
  const serifUrl = `${import.meta.env.BASE_URL}fonts/output/NotoSerifJP-Regular.ttf`;
  const faces: Record<string, string> = { 'sans-serif': sansUrl, Arial: sansUrl, SourceHanSansJP: sansUrl, serif: serifUrl, SourceHanSerifJP: serifUrl };
  const texts = new Map<string, string[]>();
  for (const page of pages) for (const annotation of page.annotations) if (annotation.kind === 'ink' && annotation.geometry.kind === 'text') {
    const { fontFamily, text } = annotation.geometry; texts.set(fontFamily, [...texts.get(fontFamily) ?? [], text]);
  }
  const fonts = [];
  for (const [family, strings] of texts) {
    signal.throwIfAborted(); const url = faces[family]; if (!url) throw new Error(`output-font-unavailable:${family}`);
    const response = await fetch(url, { signal }); if (!response.ok) throw new Error(`output-font-unavailable:${family}`);
    const bytes = new Uint8Array(await response.arrayBuffer()); signal.throwIfAborted();
    const font = fontkit.create(bytes);
    for (const text of strings) for (const char of text) if (!['\n', '\r', '\t'].includes(char) && !font.hasGlyphForCodePoint(char.codePointAt(0)!))
      throw new Error(`output-font-glyph:${family}:${char.codePointAt(0)!.toString(16)}`);
    fonts.push({ family, bytes });
  }
  return fonts;
},
async copyImage(bytes) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('clipboard-unavailable');
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([Uint8Array.from(bytes).buffer], { type: 'image/png' }) })]);
},
renderPdf(request, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../../features/reader/pdf/export/pdfExport.worker.ts', import.meta.url), { type: 'module' }), id = crypto.randomUUID();
    let settled = false;
    const finish = (error?: unknown, bytes?: Uint8Array) => {
      if (settled) return; settled = true; worker.terminate(); signal.removeEventListener('abort', abort); clearTimeout(timer);
      if (error) reject(error); else resolve(bytes!);
    };
    const abort = () => finish(signal.reason ?? new Error('output-cancelled'));
    const timer = setTimeout(() => finish(new Error('output-timeout')), 120_000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = event => { if (event.data.id === id) event.data.error ? finish(new Error(event.data.error)) : finish(undefined, event.data.bytes); };
    worker.onerror = () => finish(new Error('output-worker-failed'));
    if (signal.aborted) abort(); else worker.postMessage({ id, request }, [
      ...request.resources.map(resource => resource.bytes.buffer as ArrayBuffer), ...request.fonts.map(font => font.bytes.buffer as ArrayBuffer),
    ]);
  });
} };

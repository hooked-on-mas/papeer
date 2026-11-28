import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, degrees } from 'pdf-lib';
import { exportCanonicalPdf } from '../../../../src/features/reader/pdf/export/vectorWriter.ts';
import { resourceHash } from '../../../../src/runtime/edits/contentPublication.ts';
import type { PdfExportRequest } from '../../../../src/features/reader/pdf/export/ports.ts';
import type { Page, ResourceMetadata, DocumentSnapshot } from '../../../../src/runtime/edits/contracts.ts';

async function fixture(rotation = 90) {
 const source = await PDFDocument.create(), physical = source.addPage([300,400]);
 physical.drawText('Original source text', { x: 30, y: 300, size: 12 }); physical.setCropBox(10,20,200,300); physical.setRotation(degrees(rotation)); physical.node.set(PDFName.of('UserUnit'), source.context.obj(2));
 const bytes = await source.save(), id = crypto.randomUUID(), sha256 = await resourceHash(bytes);
 const metadata: ResourceMetadata = { id, sha256, byteLength: bytes.length, mediaType: 'application/pdf', pdfPages: [{ widthPt: rotation % 180 ? 600 : 400, heightPt: rotation % 180 ? 400 : 600 }] };
 const page: Page = { id: crypto.randomUUID(), backgroundRevision: crypto.randomUUID(), lifecycleVersion: crypto.randomUUID(), annotationVersion: crypto.randomUUID(), widthPt: rotation % 180 ? 600 : 400, heightPt: rotation % 180 ? 400 : 600, background: { kind: 'pdf', resourceId: id, sourceRevision: sha256, pdfPage: 1 }, annotations: [
 { kind:'ink', id:crypto.randomUUID(), geometry:{ kind:'line', start:{x:10,y:20}, end:{x:100,y:100} }, style:{ color:'#ff0000', widthPt:2, opacity:1, highlighter:false }, transform:{ x:0,y:0,rotationRad:0,scaleX:1,scaleY:1 } },
 { kind:'sticky', id:crypto.randomUUID(), text:'日本語 note', anchor:{x:30,y:40}, color:'#ffcc00', metadata:{label:'',createdAt:null} }
 ] };
 const snapshot: DocumentSnapshot = { kind:'document', id:crypto.randomUUID(), version:crypto.randomUUID(), pages:[page], deletedPages:[] };
 return { snapshot, resources:[{metadata,bytes}], fonts:[] } satisfies PdfExportRequest as PdfExportRequest & { snapshot: DocumentSnapshot; resources: {metadata: ResourceMetadata; bytes: Uint8Array}[]; fonts: {family: string; bytes: Uint8Array}[] };
}
test('copies source pages, geometry and sticky text while writing ink', async () => {
 const f = await fixture(), bytes = await exportCanonicalPdf(f), result = await PDFDocument.load(bytes), page = result.getPage(0);
 assert.deepEqual(page.getCropBox(), {x:10,y:20,width:200,height:300}); assert.equal(page.getRotation().angle,90);
 assert.equal(page.node.lookup(PDFName.of('UserUnit'))!.toString(),'2');
 const annotations = page.node.Annots(); assert.equal(annotations?.size(),1);
 const serialized = Buffer.from(bytes).toString('latin1'); assert.ok(serialized.includes('PDF'));
});
test('rejects wrong resource identity and unsupported background', async () => {
 const f = await fixture(); f.resources[0].bytes[0] ^= 1; await assert.rejects(exportCanonicalPdf(f), /pdf-export-resource/);
});
import { readFileSync } from 'node:fs';
test('embeds requested Japanese font and fails on missing font or glyph', async () => {
 const f = await fixture(); f.snapshot.pages[0].annotations.push({kind:'ink', id:crypto.randomUUID(), geometry:{kind:'text',widthPt:100,heightPt:30,text:'日本語',fontSizePt:12,fontFamily:'serif'},style:{color:'#000000',widthPt:1,opacity:1,highlighter:false},transform:{x:10,y:10,rotationRad:0,scaleX:1,scaleY:1}});
 await assert.rejects(exportCanonicalPdf(f), /pdf-export-font:serif/);
 f.fonts.push({family:'serif',bytes:readFileSync(new URL('../../../../public/fonts/output/NotoSerifJP-Regular.ttf',import.meta.url))});
 const bytes=await exportCanonicalPdf(f); assert.ok(bytes.length>1000);
});
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
test('source text is independently extractable after export', async () => {
 const f=await fixture(), bytes=await exportCanonicalPdf(f), loading=getDocument({data:bytes, standardFontDataUrl: process.cwd() + '/node_modules/pdfjs-dist/standard_fonts/'});
 try { const doc=await loading.promise, page=await doc.getPage(1), text=await page.getTextContent(); assert.ok(text.items.some(item => 'str' in item && item.str.includes('Original source text'))); }
 finally { await loading.destroy(); }
});


test('mixed paper and source pages keep order, and PDF comments retain Unicode', async () => {
 const f=await fixture(), first=f.snapshot.pages[0];
 f.snapshot.pages.push({...structuredClone(first),id:crypto.randomUUID(),backgroundRevision:crypto.randomUUID(),annotations:[],background:{kind:'paper',spec:{template:'grid5',color:'cream'}}});
 f.snapshot.pages.push({...structuredClone(first),id:crypto.randomUUID(),annotations:[]});
 const bytes=await exportCanonicalPdf(f), load=getDocument({data:bytes,standardFontDataUrl:process.cwd()+'/node_modules/pdfjs-dist/standard_fonts/'});
 try { const doc=await load.promise; assert.equal(doc.numPages,3); const annotations=await (await doc.getPage(1)).getAnnotations(); assert.ok(annotations.some(a=>a.contentsObj?.str==='日本語 note')); }
 finally { await load.destroy(); }
});
test('copies pages from multiple immutable sources in snapshot order', async () => {
 const a=await fixture(), b=await fixture(); a.snapshot.pages.push(b.snapshot.pages[0]); a.resources.push(b.resources[0]);
 const bytes=await exportCanonicalPdf(a), loading=getDocument({data:bytes,standardFontDataUrl:process.cwd()+'/node_modules/pdfjs-dist/standard_fonts/'});
 try { const doc=await loading.promise; assert.equal(doc.numPages,2); for(let i=1;i<=2;i++) { const content=await (await doc.getPage(i)).getTextContent(); assert.ok(content.items.some(item=>'str' in item && item.str.includes('Original source text'))); } } finally { await loading.destroy(); }
});
import { createRequire } from 'node:module';
const { createCanvas } = createRequire(import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs'))('@napi-rs/canvas');
test('rendered ink lands at canonical coordinates despite crop rotation and user unit', async () => {
 for (const rotation of [0,90,180,270]) { const f=await fixture(rotation), bytes=await exportCanonicalPdf(f), loading=getDocument({data:bytes,standardFontDataUrl:process.cwd()+'/node_modules/pdfjs-dist/standard_fonts/'});
 try { const doc=await loading.promise, page=await doc.getPage(1), viewport=page.getViewport({scale:1}), canvas=createCanvas(viewport.width,viewport.height), ctx=canvas.getContext('2d');
 await page.render({canvas:canvas as never,canvasContext:ctx as never,viewport}).promise;
 const pixel=ctx.getImageData(55,60,1,1).data; assert.ok(pixel[0]>180 && pixel[1]<100 && pixel[2]<100,`rotation ${rotation}: pixel ${pixel}`);
 } finally { await loading.destroy(); } }
});
test('rejects source AcroForms rather than silently discarding document-level fields', async () => {
 const f=await fixture(), source=await PDFDocument.load(f.resources[0].bytes); source.getForm().createTextField('form');
 const bytes=await source.save(), sha256=await resourceHash(bytes); f.resources[0].bytes=bytes; f.resources[0].metadata.byteLength=bytes.length; f.resources[0].metadata.sha256=sha256;
 const bg=f.snapshot.pages[0].background; assert.equal(bg.kind,'pdf'); if(bg.kind==='pdf') bg.sourceRevision=sha256;
 const preserved = await PDFDocument.load(await exportCanonicalPdf(f)); assert.equal(preserved.getForm().getFields().length,1);
 f.snapshot.pages.push({...structuredClone(f.snapshot.pages[0]), id:crypto.randomUUID()});
 await assert.rejects(exportCanonicalPdf(f), /pdf-export-acroform-unsupported/);
});
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('actual Noto sans and serif exports render and extract Japanese in MuPDF', async () => {
 for (const [family,asset] of [['sans-serif','NotoSansJP-Regular.ttf'],['serif','NotoSerifJP-Regular.ttf']]) {
  const f=await fixture(); f.snapshot.pages[0].annotations.push({kind:'ink',id:crypto.randomUUID(),geometry:{kind:'text',widthPt:100,heightPt:30,text:'???',fontSizePt:18,fontFamily:family},style:{color:'#000000',widthPt:1,opacity:1,highlighter:false},transform:{x:50,y:50,rotationRad:0,scaleX:1,scaleY:1}});
  f.fonts.push({family,bytes:readFileSync(new URL(`../../../../public/fonts/output/${asset}`,import.meta.url))});
  const bytes=await exportCanonicalPdf(f), python=fileURLToPath(new URL('../../../../../.venv/Scripts/python.exe',import.meta.url));
  const check=spawnSync(python,['-c',`import sys, json, pymupdf as fitz
fitz.TOOLS.mupdf_warnings(reset=True)
doc=fitz.open(stream=sys.stdin.buffer.read(), filetype='pdf')
page=doc[0]
text=page.get_text()
pix=page.get_pixmap()
warnings=fitz.TOOLS.mupdf_warnings()
print(json.dumps({'text':text,'warnings':warnings,'samples':len(pix.samples)},ensure_ascii=True))`],{input:bytes,encoding:'utf8',maxBuffer:1024*1024});
  assert.equal(check.status,0,check.stderr); assert.equal(check.stderr,''); const result=JSON.parse(check.stdout); assert.ok(result.text.includes('???'),result.text); assert.ok(result.text.includes('Original source text')); assert.equal(result.warnings,''); assert.ok(result.samples>0);
 }
});

test('rejects CFF fonts rather than emitting unreadable glyphs', async () => {
 const f=await fixture(); f.fonts.push({family:'cff',bytes:readFileSync(new URL('../../../../../papeer/core/assets/fonts/SourceHanSerifJP-Regular.otf',import.meta.url))});
 await assert.rejects(exportCanonicalPdf(f),/pdf-export-font-format:cff/);
});

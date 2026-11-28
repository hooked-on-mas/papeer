import { PDFDocument, PDFSignature, PDFHexString, PDFName, PDFNumber, rgb, setFillingColor, setStrokingColor,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, setGraphicsState, setLineWidth,
  setLineCap, setLineJoin, LineCapStyle, LineJoinStyle, moveTo, lineTo, closePath, stroke, fill } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { assertSnapshot } from '../../../../runtime/edits/editModel.ts';
import { assertResourceMetadata, resourceHash } from '../../../../runtime/edits/contentPublication.ts';
import { pdfPageCoordinates } from '../../../../runtime/edits/pageCoordinates.ts';
import { geometryPoints } from '../../../../runtime/edits/annotationGeometry.ts';
import type { PdfExportRequest } from './ports.ts';
import { drawPaper } from './paper.ts';

const color = (value: string) => {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) throw new Error(`pdf-export-color:${value}`);
  const n = parseInt(match[1], 16); return rgb((n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

/** Preserve source content as PDF objects and fail the whole request on any invalid input. */
export async function exportCanonicalPdf(input: PdfExportRequest): Promise<Uint8Array> {
  const request = structuredClone(input); assertSnapshot(request.snapshot);
  if (request.snapshot.kind !== 'document' || !request.snapshot.pages.length) throw new Error('pdf-export-pages');
  const sources = new Map<string, { doc: PDFDocument; metadata: PdfExportRequest['resources'][number]['metadata'] }>();
  for (const resource of request.resources) {
    const m = resource.metadata; assertResourceMetadata(m);
    if (sources.has(m.id) || m.mediaType !== 'application/pdf' || resource.bytes.length !== m.byteLength || await resourceHash(resource.bytes) !== m.sha256) throw new Error(`pdf-export-resource:${m.id}`);
    const doc = await PDFDocument.load(resource.bytes, { updateMetadata: false });
    if (doc.catalog.has(PDFName.of('AcroForm')) && doc.getForm().getFields().some(field => field instanceof PDFSignature)) throw new Error(`pdf-export-signature-unsupported:${m.id}`);
    if (doc.getPageCount() !== m.pdfPages?.length) throw new Error(`pdf-export-resource-pages:${m.id}`);
    sources.set(m.id, { doc, metadata: m });
  }
  const pages = request.snapshot.pages, first = pages[0].background;
  const wholeSource = first.kind === 'pdf' ? sources.get(first.resourceId) : undefined;
  const preserveDocument = first.kind === 'pdf' && !!wholeSource && pages.length === wholeSource.doc.getPageCount() && pages.every((page, index) =>
    page.background.kind === 'pdf' && page.background.resourceId === first.resourceId && page.background.sourceRevision === first.sourceRevision && page.background.pdfPage === index + 1);
  if (!preserveDocument) for (const [id, source] of sources) if (source.doc.catalog.has(PDFName.of('AcroForm'))) throw new Error(`pdf-export-acroform-unsupported:${id}`);
  const output = preserveDocument ? wholeSource!.doc : await PDFDocument.create(); output.registerFontkit(fontkit);
  const fonts = new Map<string, Awaited<ReturnType<typeof output.embedFont>>>();
  for (const item of request.fonts) {
    if (!item.family || !item.bytes.length || fonts.has(item.family)) throw new Error(`pdf-export-font:${item.family}`);
    // fontkit's CFF embedding and TrueType subsetting can produce unreadable CJK glyphs.
    if (item.bytes.length < 4 || item.bytes[0] !== 0 || item.bytes[1] !== 1 || item.bytes[2] !== 0 || item.bytes[3] !== 0) throw new Error(`pdf-export-font-format:${item.family}`);
    fonts.set(item.family, await output.embedFont(item.bytes, { subset: false }));
  }
  for (const sourcePage of request.snapshot.pages) {
    let page: ReturnType<typeof output.addPage>, matrix: ReturnType<typeof pdfPageCoordinates>['toPdf'], userUnit = 1;
    if (sourcePage.background.kind === 'paper') {
      page = output.addPage([sourcePage.widthPt, sourcePage.heightPt]);
      drawPaper(page, sourcePage.widthPt, sourcePage.heightPt, sourcePage.background.spec);
      matrix = [1, 0, 0, -1, 0, sourcePage.heightPt];
    } else {
      const bg = sourcePage.background, source = sources.get(bg.resourceId);
      if (!source || source.metadata.sha256 !== bg.sourceRevision || bg.pdfPage > source.doc.getPageCount()) throw new Error(`pdf-export-resource:${bg.resourceId}`);
      const src = source.doc.getPage(bg.pdfPage - 1), crop = src.getCropBox(), rotate = src.getRotation().angle;
      const userUnitObject = src.node.lookupMaybe(PDFName.of('UserUnit'), PDFNumber); userUnit = userUnitObject?.asNumber() ?? 1;
      const coords = pdfPageCoordinates([crop.x, crop.y, crop.x + crop.width, crop.y + crop.height], userUnit, rotate);
      const physical = source.metadata.pdfPages?.[bg.pdfPage - 1];
      if (!physical || Math.abs(coords.widthPt - sourcePage.widthPt) > .001 || Math.abs(coords.heightPt - sourcePage.heightPt) > .001 || Math.abs(physical.widthPt - coords.widthPt) > .001 || Math.abs(physical.heightPt - coords.heightPt) > .001) throw new Error(`pdf-export-page:${sourcePage.id}`);
      if (preserveDocument) page = output.getPage(bg.pdfPage - 1);
      else { [page] = await output.copyPages(source.doc, [bg.pdfPage - 1]); output.addPage(page); }
      matrix = coords.toPdf;
    }
    const opacity = (value: number) => page.node.newExtGState('ExportAlpha', output.context.obj({ Type: 'ExtGState', CA: value, ca: value }));
    const note = (x: number, y: number, text: string, shade: string, label: string) => {
      const [a,b,c,d,e,f] = matrix, px = a*x+c*y+e, py = b*x+d*y+f;
      const tint = color(shade);
      const dict = output.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [px, py, px + 12 / userUnit, py + 12 / userUnit], Contents: PDFHexString.fromText(text), T: PDFHexString.fromText(label), C: [tint.red,tint.green,tint.blue], Name: 'Comment', F: 4 });
      page.node.addAnnot(output.context.register(dict));
    };
    for (const annotation of sourcePage.annotations) {
      if (annotation.kind === 'sticky') { note(annotation.anchor.x, annotation.anchor.y, annotation.text, annotation.color ?? '#f59e0b', annotation.metadata.label); continue; }
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...matrix));
      if (annotation.kind === 'highlight') {
        page.pushOperators(setGraphicsState(opacity(.3)), setFillingColor(color(annotation.color)));
        for (const quad of annotation.quads) { page.pushOperators(moveTo(quad[0].x,quad[0].y), ...quad.slice(1).map(p => lineTo(p.x,p.y)), closePath(), fill()); }
        page.pushOperators(popGraphicsState()); if (annotation.text || annotation.metadata.label) note(annotation.anchor.x, annotation.anchor.y, annotation.text, annotation.color, annotation.metadata.label); continue;
      }
      const t = annotation.transform, c = Math.cos(t.rotationRad), s = Math.sin(t.rotationRad), g = annotation.geometry, style = annotation.style;
      page.pushOperators(concatTransformationMatrix(c*t.scaleX,s*t.scaleX,-s*t.scaleY,c*t.scaleY,t.x,t.y), setGraphicsState(opacity(style.opacity)));
      if (g.kind === 'text') {
        const font = fonts.get(g.fontFamily); if (!font) throw new Error(`pdf-export-font:${g.fontFamily}`);
        const supported = new Set(font.getCharacterSet());
        for (const char of g.text) if (char !== '\n' && !supported.has(char.codePointAt(0)!)) throw new Error(`pdf-export-glyph:${g.fontFamily}:${char.codePointAt(0)!.toString(16)}`);
        for (const [i,line] of g.text.split('\n').entries()) {
          page.pushOperators(pushGraphicsState(), concatTransformationMatrix(1,0,0,-1,0,g.fontSizePt*(.9+i*1.3)));
          page.drawText(line, { x: 0, y: 0, size: g.fontSizePt, font, color: color(style.color) }); page.pushOperators(popGraphicsState());
        }
      } else {
        const points = geometryPoints(g); if (!points.length) throw new Error(`pdf-export-geometry:${annotation.id}`);
        page.pushOperators(setStrokingColor(color(style.color)), setLineWidth(style.widthPt), setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round), moveTo(points[0].x,points[0].y));
        if (points.length === 1) page.pushOperators(lineTo(points[0].x,points[0].y));
        else page.pushOperators(...points.slice(1).map(p => lineTo(p.x,p.y)));
        if (g.kind === 'rect' || g.kind === 'ellipse') page.pushOperators(closePath());
        page.pushOperators(stroke());
      }
      page.pushOperators(popGraphicsState());
    }
  }
  return output.save();
}

import { rgb, type PDFPage } from 'pdf-lib';
import type { PaperSpec } from '../../../../runtime/edits/contracts.ts';

/** Same physical paper pattern as CanonicalPaperBackground, in PDF coordinates. */
export function drawPaper(page: PDFPage, width: number, height: number, spec: PaperSpec): void {
 const MM=72/25.4, margin=15*MM, spacing=(spec.template==='grid10'?10:spec.template==='ruled7'||spec.template==='cornell'?7:spec.template==='ruled6'?6:5)*MM;
 const background=spec.color==='dark'?rgb(.12,.14,.17):spec.color==='cream'?rgb(1,.97,.88):rgb(1,1,1);
 const shade=spec.color==='dark'?rgb(.35,.39,.45):rgb(.75,.79,.83);
 page.drawRectangle({x:0,y:0,width,height,color:background});
 const line=(x1:number,y1:number,x2:number,y2:number)=>page.drawLine({start:{x:x1,y:height-y1},end:{x:x2,y:height-y2},thickness:.35,color:shade});
 const ruled=spec.template.startsWith('ruled')||spec.template==='cornell', grid=spec.template.startsWith('grid'), dots=spec.template==='dot5';
 const bottom=height-(spec.template==='cornell'?35*MM:margin);
 if ((ruled||grid) && width>2*margin) for(let y=ruled?margin+spacing:margin;y<bottom;y+=spacing) line(margin,y,width-margin,y);
 if(grid && height>2*margin) for(let x=margin;x<width-margin;x+=spacing) line(x,margin,x,height-margin);
 if(dots) for(let x=margin;x<width-margin;x+=spacing) for(let y=margin;y<bottom;y+=spacing) page.drawCircle({x,y:height-y,size:.45,borderColor:shade,borderWidth:.35});
 if(spec.template==='cornell') { line(width*.28,margin,width*.28,bottom); line(margin,bottom,width-margin,bottom); }
}

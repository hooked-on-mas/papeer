import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import type { NoteDocument, NotePage } from '../../runtime/noteDocuments';
import { newPage } from '../../runtime/noteDocuments';
import { InkDrawing } from '../reader/InkDrawing';
import { fitInk, hitInk, textPoints, type InkStroke, type InkTool, type Point } from '../ink/inkGeometry';
import { advanceInkDraft, beginInkDraft, finishInkDraft, type DrawingKind } from '../ink/inkDraft';
import { PAPER_SIZES, PAPER_TEMPLATES } from '../notebooks/paperSpec';
import type { NoteEditSession } from './noteEditSession';
import { useNoteEditorOwner } from './useNoteEditorOwner';
import { traceFeature } from '../../runtime/featureTrace';
import { changeNotebookPaper } from './notebookPaper';

const button = 'min-h-11 min-w-11 rounded border px-2';
export function HandwrittenNote({ session }: { session: NoteEditSession }) {
  const { state, owner, editable } = useNoteEditorOwner(session);
  const note = state.note;
  useEffect(() => { traceFeature('notes.handwriting-editor', note.id, 'render'); }, [note.id]);
  const onDrawingChange = (drawing: boolean) => session.setDrawingFrom(owner, drawing);
  const [pageId, setPageId] = useState(note.document!.pages[0].id);
  const [tool, setTool] = useState<InkTool>('pen');
  const [color, setColor] = useState('#202020');
  const [width, setWidth] = useState(.003);
  const [selection, setSelection] = useState<string | null>(null);
  const [draft, setDraft] = useState<InkStroke | null>(null);
  const [text, setText] = useState('');
  const [fitPaper, setFitPaper] = useState(false);
  const contact = useRef<{ pointer: number; stroke: InkStroke; start: Point; ratio: number; commit: (stroke: InkStroke) => void } | null>(null);
  useLayoutEffect(() => session.registerEditorFinalizer(owner, () => {
    const current = contact.current; contact.current = null;
    if (!current) return;
    const stroke = finishInkDraft(current.stroke, current.ratio);
    if (stroke) current.commit(stroke);
    session.setDrawingFrom(owner, false);
  }), [session, owner]);
  useEffect(() => {
    const interrupt = () => { contact.current = null; setDraft(null); session.setDrawingFrom(owner, false); };
    window.addEventListener('blur', interrupt);
    return () => { window.removeEventListener('blur', interrupt); session.setDrawingFrom(owner, false); };
  }, [session, owner]);
  const pages = note.document!.pages;
  const page = pages.find(p => p.id === pageId) ?? pages[0];
  const index = pages.indexOf(page);
  const ratio = page.height_mm / page.width_mm;
  const strokes = note.ink?.[page.id] ?? [];
  const change = (next: NoteDocument) => session.editFrom(owner, next);
  const changeInk = (items: InkStroke[]) => {
    // A prior stroke can be acknowledged while this gesture is still active.
    // Keep its page/content snapshot, but use the session's latest local revision.
    const current = session.getSnapshot().note;
    if (!current.document?.pages.some(value => value.id === page.id)) return;
    change({ ...current, ink: { ...current.ink, [page.id]: items } });
  };
  const changePages = (items: NotePage[], ink = note.ink) => change({ ...note, document: { ...note.document!, revision: note.document!.revision + 1, pages: items }, ink });
  const point = (event: PointerEvent<SVGSVGElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))];
  };
  const down = (event: PointerEvent<SVGSVGElement>) => {
    if (!editable || contact.current || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const at = point(event);
    if (tool === 'select' || tool === 'eraser') {
      const hit = [...strokes].reverse().find(s => hitInk(s, at, .015, ratio));
      if (tool === 'select') setSelection(hit?.id ?? null);
      else if (hit) changeInk(strokes.filter(s => s.id !== hit.id));
      return;
    }
    if (tool === 'text') {
      if (text.trim()) changeInk([...strokes, ...fitInk([{ id: crypto.randomUUID(), kind: 'text', text, points: textPoints(text, at, .025, ratio), width, color }], ratio)]);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const stroke = beginInkDraft(crypto.randomUUID(), tool as DrawingKind, at, color, width);
    contact.current = { pointer: event.pointerId, stroke, start: at, ratio, commit: item => changeInk([...strokes, item]) }; setDraft(stroke); onDrawingChange?.(true);
  };
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const current = contact.current;
    if (!current || event.pointerId !== current.pointer) return;
    current.stroke = advanceInkDraft(current.stroke, current.start, [point(event)], ratio, { shift: event.shiftKey });
    setDraft(current.stroke);
  };
  const up = (event: PointerEvent<SVGSVGElement>) => {
    const current = contact.current;
    if (!current || event.pointerId !== current.pointer) return;
    const stroke = finishInkDraft(advanceInkDraft(current.stroke, current.start, [point(event)], ratio, { shift: event.shiftKey }), ratio);
    contact.current = null; setDraft(null);
    if (stroke) changeInk([...strokes, stroke]);
    onDrawingChange?.(false);
  };
  const cancel = (event: PointerEvent<SVGSVGElement>) => {
    if (contact.current?.pointer !== event.pointerId) return;
    contact.current = null; setDraft(null); onDrawingChange?.(false);
  };
  const paperChange = (changes: Partial<NotePage>) => {
    try { change(changeNotebookPaper(note, page.id, changes, fitPaper)); }
    catch (error) { session.reportError(error); }
  };
  const spacing = page.template === 'grid10' ? 10 : page.template === 'ruled7' || page.template === 'cornell' ? 7 : page.template === 'ruled6' ? 6 : 5;
  const shade = page.color === 'dark' ? '#596473' : '#bfc9d3';
  const horizontal: number[] = [], vertical: number[] = [];
  for (let y = 15 + (page.template.startsWith('ruled') || page.template === 'cornell' ? spacing : 0); y < page.height_mm - (page.template === 'cornell' ? 35 : 15); y += spacing) horizontal.push(y);
  for (let x = 15; x < page.width_mm - 15; x += spacing) vertical.push(x);
  if (!editable) return <p role="status">このノートは別の表示面で編集中です。</p>;
  return <div className="flex flex-1 min-h-0 flex-col overflow-auto gap-2 p-2">
    <div role="toolbar" aria-label="ノートの道具" className="flex flex-wrap gap-1" inert={!!draft}>
      {([['pen', 'ペン'], ['eraser', '消しゴム'], ['select', '選択'], ['highlighter', '蛍光ペン'], ['line', '直線'], ['arrow', '矢印'], ['rectangle', '四角'], ['ellipse', '丸'], ['text', '文字']] as const).map(([key, label]) => <button key={key} className={button} aria-pressed={tool === key} onClick={() => setTool(key)}>{label}</button>)}
      <input type="color" aria-label="色" value={color} onChange={e => setColor(e.target.value)} className="min-h-11" />
      <input type="range" aria-label="太さ" min="0.001" max="0.03" step="0.001" value={width} onChange={e => setWidth(Number(e.target.value))} />
      <button className={button} disabled={!state.canUndo} onClick={() => session.undo(owner)}>元に戻す</button>
      <button className={button} disabled={!state.canRedo} onClick={() => session.redo(owner)}>やり直す</button>
      {selection && <button className={button} onClick={() => { changeInk(strokes.filter(s => s.id !== selection)); setSelection(null); }}>選択を削除</button>}
      {tool === 'text' && <input aria-label="挿入する文字" placeholder="入力して用紙をタップ" maxLength={2000} value={text} onChange={e => setText(e.target.value)} />}
    </div>
    <div className="flex flex-wrap items-center gap-1" inert={!!draft}>
      <select className={button} aria-label="ページ" value={page.id} onChange={e => { setPageId(e.target.value); setSelection(null); }}>{pages.map((p, i) => <option key={p.id} value={p.id}>{i + 1} / {pages.length}</option>)}</select>
      <button className={button} disabled={pages.length >= 500} onClick={() => { const added = newPage(page); changePages([...pages, added]); setPageId(added.id); }}>＋ ページ</button>
      <details><summary className={button}>ページ操作・用紙</summary><div className="flex flex-wrap gap-1">
        <label><input type="checkbox" checked={fitPaper} onChange={event => setFitPaper(event.target.checked)} />内容を等比縮小して用紙内に収める</label>
        <button className={button} disabled={pages.length >= 500} onClick={() => { const copy = newPage(page); const next = [...pages]; next.splice(index + 1, 0, copy); changePages(next, { ...note.ink, [copy.id]: strokes.map(s => ({ ...s, id: crypto.randomUUID() })) }); setPageId(copy.id); }}>複製</button>
        <button className={button} disabled={pages.length === 1} onClick={() => { const ink = { ...note.ink }; delete ink[page.id]; changePages(pages.filter(p => p.id !== page.id), ink); setPageId(pages[Math.max(0, index - 1)].id); }}>ページ削除</button>
        {[-1, 1].map(direction => <button key={direction} className={button} disabled={index + direction < 0 || index + direction >= pages.length} onClick={() => { const next = [...pages]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; changePages(next); }}>{direction < 0 ? '前へ移動' : '後へ移動'}</button>)}
        <select className={button} aria-label="用紙サイズ" value={page.size} onChange={e => paperChange({ size: e.target.value as NotePage['size'] })}>{PAPER_SIZES.map(size => <option key={size}>{size}</option>)}</select>
        <select className={button} aria-label="用紙の向き" value={page.orientation} onChange={e => paperChange({ orientation: e.target.value as NotePage['orientation'] })}><option value="portrait">縦</option><option value="landscape">横</option></select>
        <select className={button} aria-label="罫線" value={page.template} onChange={e => paperChange({ template: e.target.value as NotePage['template'] })}>{PAPER_TEMPLATES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        <select className={button} aria-label="用紙の色" value={page.color} onChange={e => paperChange({ color: e.target.value as NotePage['color'] })}><option value="white">白</option><option value="cream">クリーム</option><option value="dark">ダーク</option></select>
      </div></details>
    </div>
    <svg className="w-full max-w-3xl self-center shrink-0 border shadow" viewBox={`0 0 1000 ${1000 * ratio}`} style={{ touchAction: 'none', background: page.color === 'dark' ? '#1f242b' : page.color === 'cream' ? '#fff7e0' : '#ffffff' }} aria-label="手書きノートの用紙" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} onLostPointerCapture={cancel}>
      <g transform={`scale(${1000 / page.width_mm})`} stroke={shade} strokeWidth=".124">
        {(page.template.startsWith('ruled') || page.template.startsWith('grid') || page.template === 'cornell') && horizontal.map(y => <line key={y} x1="15" y1={y} x2={page.width_mm - 15} y2={y} />)}
        {page.template.startsWith('grid') && vertical.map(x => <line key={x} x1={x} y1="15" x2={x} y2={page.height_mm - 15} />)}
        {page.template === 'dot5' && vertical.flatMap(x => horizontal.map(y => <circle key={`${x}:${y}`} cx={x} cy={y} r=".159" fill={shade} />))}
        {page.template === 'cornell' && <path d={`M${page.width_mm * .28} 15V${page.height_mm - 35}M15 ${page.height_mm - 35}H${page.width_mm - 15}`} />}
      </g>
      {[...strokes, ...(draft ? [draft] : [])].map(stroke => <g key={stroke.id} opacity={selection && selection !== stroke.id ? .4 : 1}><InkDrawing stroke={stroke} ratio={ratio} /></g>)}
    </svg>
  </div>;
}

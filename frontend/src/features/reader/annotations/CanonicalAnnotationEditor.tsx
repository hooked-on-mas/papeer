import type { AnnotationDraftPatch, AnnotationHighlightSeed, DocumentAnnotationDraft } from '../edit/DocumentEditSession';
import type { Point, StickyNote, TextHighlight } from '../../../runtime/edits/contracts';
import { AnnotationForm } from '../AnnotationForm';

export type EditableCanonicalAnnotation = StickyNote | TextHighlight;

export type CanonicalAnnotationMode = 'ink' | 'sticky-place' | 'annotation-select' | 'annotation-move';
/** Page-owned operations; the private editing token never crosses this facade. */
export type CanonicalAnnotationFacade = {
  mode: CanonicalAnnotationMode; draft: DocumentAnnotationDraft | null; available: boolean; cancelAllowed: boolean; busy: boolean;
  setMode(mode: CanonicalAnnotationMode): boolean;
  edit(annotation: EditableCanonicalAnnotation): boolean;
  canSelectText(): boolean;
  canCreateHighlight(): boolean;
  createHighlight(seed: AnnotationHighlightSeed): boolean;
  change(draftId: string, patch: AnnotationDraftPatch): boolean;
  commit(draftId: string): void; cancel(draftId: string): boolean;
  beginGesture(): string | null; endGesture(id: string, point: Point | null): boolean;
  canReposition(): boolean;
};

export function CanonicalAnnotationEditor({ annotation, description }: { annotation: CanonicalAnnotationFacade; description: string }) {
  const draft = annotation.draft; if (!draft) return null;
  const value = draft.annotation, id = draft.draftId;
  const colors = [...new Set(['#facc15', '#f59e0b', '#f87171', '#60a5fa', '#a78bfa', '#34d399', ...(value.color ? [value.color] : [])])];
  return <section role="region" aria-label="注釈を編集" className="space-y-2 border-b bg-background p-3">
    <h3>{value.kind === 'highlight' ? draft.original ? '本文ハイライトを編集' : '本文ハイライトを作成' : draft.original ? '付箋を編集' : '付箋を貼る'}</h3><p className="text-xs">{description}</p>
    <AnnotationForm quote={value.quote ?? ''} label={value.kind === 'highlight' ? '本文ハイライトのコメント' : '付箋のメモ'} value={value.text} busy={annotation.busy} disabled={!annotation.available}
      cancelEnabled={annotation.cancelAllowed}
      onChange={text => annotation.change(id, { text })} onSave={() => annotation.commit(id)} onCancel={() => { annotation.cancel(id); }}
      controls={<>
        <label>分類 <input aria-label="注釈の分類" maxLength={40} value={value.metadata.label} disabled={!annotation.available || annotation.busy}
          onChange={event => annotation.change(id, { label: event.target.value })} /></label>
        <label>色 <select aria-label="注釈の色" value={value.color ?? ''} disabled={!annotation.available || annotation.busy}
          onChange={event => annotation.change(id, { color: event.target.value || null })}>
          {value.kind === 'sticky' && <option value="">色なし</option>}{colors.map(color => <option key={color} value={color}>{color}</option>)}
        </select></label>
      </>} />
    <div className="flex flex-wrap gap-2">
      <button type="button" aria-pressed={annotation.mode === 'annotation-move'} disabled={!annotation.available || annotation.busy || draft.deleted}
        onClick={() => annotation.setMode(annotation.mode === 'annotation-move' ? 'annotation-select' : 'annotation-move')}>{value.kind === 'highlight' ? 'コメント位置を変更' : '注釈の位置を変更'}</button>
      {draft.original && <button type="button" disabled={!annotation.available || annotation.busy || draft.deleted}
        onClick={() => annotation.change(id, { deleted: true })}>この注釈を削除</button>}
    </div>
    {draft.deleted && <p role="status">この注釈を削除します。「確定」で保存し、「キャンセル」で元の内容を残します。</p>}
    {annotation.mode === 'annotation-move' && <p role="status">ページ上で{value.kind === 'highlight' ? 'コメント' : '付箋'}の新しい位置を選んでください。</p>}
  </section>;
}

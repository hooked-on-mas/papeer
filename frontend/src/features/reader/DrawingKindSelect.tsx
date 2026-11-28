import { DRAWING_KINDS, type DrawingKind } from '../ink/inkDraft';
import { SHAPE_KINDS } from '../ink/inkGeometry';

/** Both hosts use the same tool choices, independent of preferences and persistence. */
export function DrawingKindSelect({ value, onChange, shapesOnly = false, className, disabled = false }: {
  value: string; onChange: (kind: DrawingKind) => void; shapesOnly?: boolean; className?: string; disabled?: boolean;
}) {
  const choices = DRAWING_KINDS.filter(([kind]) => !shapesOnly || SHAPE_KINDS.includes(kind));
  const selected = choices.some(([kind]) => kind === value) ? value : '';
  return <select aria-label={shapesOnly ? '図形の種類' : '描画の種類'} className={className} disabled={disabled}
    value={selected} onChange={event => onChange(event.target.value as DrawingKind)}>
    {!selected && <option value="" disabled>{shapesOnly ? '図形' : '描画の種類'}</option>}
    {choices.map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
  </select>;
}

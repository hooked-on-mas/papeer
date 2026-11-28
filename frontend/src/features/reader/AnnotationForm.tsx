import type { ReactNode } from 'react';
import { AnnotationTextEditor } from './AnnotationTextEditor';

/** Pure shared annotation form. Persistence and private ownership stay with its connection. */
export function AnnotationForm({ quote, controls, maxLength = 2000, ...editor }: {
  quote: string; controls?: ReactNode; label: string; value: string; busy?: boolean; disabled?: boolean; cancelEnabled?: boolean; error?: string; maxLength?: number;
  onChange(value: string): void; onSave(): void; onCancel(): void;
}) {
  return <>
    {quote && <details className="min-w-0 text-xs"><summary className="cursor-pointer text-muted-foreground">引用を確認</summary>
      <blockquote aria-label="選択した文章（変更不可）" className="mt-2 max-h-28 max-w-full overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere] border-l-2 border-amber-400 pl-2">{quote}</blockquote>
    </details>}
    <AnnotationTextEditor {...editor} embedded allowEmpty maxLength={maxLength} controls={controls} />
  </>;
}

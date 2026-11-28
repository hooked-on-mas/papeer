import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { BIBLIOGRAPHY_FIELDS, normalizeBibliographyField, type LibraryBibliographyField } from '../canonicalLibraryOperations';

export type LibraryBibliographyDraft = {
  itemId: string;
  title: string;
  values: Record<LibraryBibliographyField, string>;
  expectedMetadata: Record<LibraryBibliographyField, string>;
};

const FIELD_SPECS: { field: LibraryBibliographyField; label: string; placeholder: string }[] = [
  { field: 'author', label: '筆頭著者', placeholder: '例：Smith / 山田太郎' },
  { field: 'year', label: '出版年', placeholder: '例：2024' },
  { field: 'venue', label: '掲載誌', placeholder: '例：ICLR 2024' },
  { field: 'doi', label: 'DOI', placeholder: '例：10.1000/xyz123' },
  { field: 'arxiv_id', label: 'arXiv ID', placeholder: '例：2101.00001' },
];

function fieldProblem(field: LibraryBibliographyField, value: string): string | null {
  try {
    normalizeBibliographyField(field, value);
    return null;
  } catch {
    if (field === 'author') return '筆頭著者は200文字以内で入力してください。';
    if (field === 'year') return '出版年は半角数字4桁で入力してください（不明なら空欄）。';
    if (field === 'venue') return '掲載誌は300文字以内で入力してください。';
    if (field === 'doi') return 'DOIは「10.」で始まる形式（例：10.1000/xyz123）で空白を含めずに入力してください。';
    return 'arXiv IDは「2101.00001」のような形式で入力してください。';
  }
}

export function LibraryBibliographyEditor({ draft, targetAvailable, busy, canApply, change, save, cancel }: {
  draft: LibraryBibliographyDraft;
  targetAvailable: boolean;
  busy: boolean;
  canApply: boolean;
  change: (update: (current: LibraryBibliographyDraft) => LibraryBibliographyDraft) => void;
  save: () => void;
  cancel: () => void;
}) {
  const problems = FIELD_SPECS.map(spec => fieldProblem(spec.field, draft.values[spec.field])).filter((msg): msg is string => msg !== null);
  return <form aria-label="書誌情報の編集" className="space-y-4 text-sm" onSubmit={event => {
    event.preventDefault();
    if (!problems.length && targetAvailable && canApply && !busy) save();
  }}>
    <p className="font-medium text-foreground">「{draft.title}」の書誌情報</p>
    {!targetAvailable && <p role="alert" className="text-xs text-destructive">対象の資料が一覧にないため適用できません。入力は保持しています。</p>}
    {problems[0] && <p role="alert" className="text-xs text-destructive">{problems[0]}</p>}
    <div className="grid gap-3">
      {FIELD_SPECS.map(({ field, label, placeholder }) => (
        <label key={field} className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          <Input aria-label={label} value={draft.values[field]} placeholder={placeholder} disabled={busy}
            onChange={event => {
              const nextValue = event.target.value;
              change(current => ({ ...current, values: { ...current.values, [field]: nextValue } }));
            }} />
        </label>
      ))}
    </div>
    <div className="flex justify-end gap-2 pt-2">
      <Button type="button" variant="outline" disabled={busy} onClick={cancel}>書誌情報の編集を閉じる</Button>
      <Button type="submit" disabled={!canApply || busy || !targetAvailable || problems.length > 0}>書誌情報を保存</Button>
    </div>
  </form>;
}

export function createBibliographyDraft(itemId: string, title: string, metadata: Readonly<Record<string, unknown>>): LibraryBibliographyDraft {
  const values = Object.fromEntries(
    BIBLIOGRAPHY_FIELDS.map(field => [field, typeof metadata[field] === 'string' ? metadata[field] : '']),
  ) as Record<LibraryBibliographyField, string>;
  return { itemId, title, values, expectedMetadata: { ...values } };
}


import type { LegacyBookmark } from '../../src/migrations/legacyBookmarks.ts';

/** Native raw table format, including the SQLite UTC timestamp and independent navigation anchor. */
export function legacyBookmarkFixture(paper = 'old-paper', page = 1, side: 'original' | 'translated' = 'original'): LegacyBookmark[] {
  const base: LegacyBookmark = { id: 1, paper_id: paper, page, side, quote: ' 引用文\n日本語😀 ', label: '重要', note: ' コメント\n本文 ',
    anchor_x: .12, anchor_y: .34, kind: 'note', color: '', rects: '[]', created_at: '2024-02-29 12:34:56' };
  return [base, { ...base, id: '9223372036854775807', label: '独自分類😀', created_at: '2026-10-25 01:02:03.123456' },
    ...['yellow', 'green', 'blue', 'pink', 'purple'].map((color, index): LegacyBookmark => ({ ...base, id: index + 2,
      kind: 'highlight', color, rects: JSON.stringify([[.2, .3, .25, .025], [.1, .35, .4, .03]]), label: index ? '' : '引用' }))];
}

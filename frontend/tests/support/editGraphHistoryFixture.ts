import type { DocumentSnapshot, PageEditBatch } from '../../src/runtime/edits/contracts.ts';

export const graphFixtureId = (number: number) => `00000000-0000-0000-0000-${String(number).padStart(12, '0')}`;
/** One page, twenty points added per immutable edit; no PDFs or user storage. */
export function editGraphHistoryFixture(count: number) {
  const libraryId = graphFixtureId(1), version = graphFixtureId(2);
  const root: DocumentSnapshot = { kind: 'document', id: graphFixtureId(3), version, deletedPages: [], pages: [{
    id: graphFixtureId(4), backgroundRevision: version, lifecycleVersion: version, annotationVersion: version,
    widthPt: 595, heightPt: 842, background: { kind: 'paper', spec: { template: 'blank', color: 'white' } }, annotations: [],
  }] };
  const batches: PageEditBatch[] = [];
  for (let index = 0; index < count; index++) {
    const parent = index ? batches[index - 1].id : version;
    batches.push({ kind: 'page', id: graphFixtureId(1000 + index), libraryId, targetId: root.id, parents: [parent],
      expected: { pageId: root.pages[0].id, backgroundRevision: version, lifecycleVersion: version, annotationVersion: parent },
      changes: [{ type: 'create', annotation: { kind: 'ink', id: graphFixtureId(100000 + index),
        geometry: { kind: 'path', points: Array.from({ length: 20 }, (_, point) => ({ x: point, y: index % 100 })) },
        style: { color: '#123456', widthPt: 1, opacity: 1, highlighter: false },
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotationRad: 0 } } }],
    });
  }
  return { version: 1 as const, libraryId, root, batches };
}

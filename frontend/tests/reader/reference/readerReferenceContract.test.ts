import type { DocumentReferenceView } from '../../../src/features/reader/reference/DocumentReferenceSurface.tsx';
// Compile-only negative contract: a readonly reference does not expose writers.
export function referenceHasNoWriter(view: DocumentReferenceView) {
  // @ts-expect-error A reference cannot invoke edit/capture/undo through its surface.
  void view.editor;
  // @ts-expect-error A reference cannot append or create annotations.
  void view.annotation;
  // @ts-expect-error A reference cannot capture a document edit.
  void view.capture;
}

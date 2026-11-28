import { useLayoutEffect } from 'react';
import type { Page } from '../../../runtime/edits/contracts';

/** One lifecycle-fenced readiness registration for all three rendering adapters. */
export function useCanonicalAnnotationReadiness({ page, ready, available, generation, report }: {
  page: Page | null; ready: boolean; available: boolean; generation: number;
  report(pageId: string, backgroundRevision: string, ready: boolean, generation: number): void;
}) {
  const pageId = page?.id, revision = page?.backgroundRevision;
  useLayoutEffect(() => {
    if (!pageId || !revision || !ready || !available) return;
    report(pageId, revision, true, generation);
    return () => report(pageId, revision, false, generation);
  }, [pageId, revision, ready, available, generation, report]);
}

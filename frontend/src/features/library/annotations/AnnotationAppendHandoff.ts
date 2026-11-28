import type { NoteAppendSession } from '../../notes/append/NoteAppendSession';
import type { AnnotationBrowserExport } from './canonicalAnnotationBrowser';

/** One temporary handoff; an explicit cancel can settle only its own request. */
export class AnnotationAppendHandoff {
  private flight?: { id: string; canceled: boolean };
  private readonly append: NoteAppendSession;
  constructor(append: NoteAppendSession) { this.append = append; }
  async begin(result: AnnotationBrowserExport, alive: () => boolean): Promise<boolean> {
    if (this.flight || !alive()) return false;
    const previous = this.append.getSnapshot().request?.id;
    const pending = this.append.begin({ kind: 'annotations', result });
    const id = this.append.getSnapshot().request?.id;
    if (!id || id === previous) { await pending; return false; }
    const flight = { id, canceled: false }; this.flight = flight;
    try {
      const accepted = await pending;
      if (!alive() || this.flight !== flight) return false;
      return accepted || flight.canceled || this.append.getSnapshot().request?.id === id;
    } finally { if (this.flight === flight) this.flight = undefined; }
  }
  cancel(): boolean {
    const id = this.append.getSnapshot().request?.id;
    if (!id || !this.append.cancel()) return false;
    if (this.flight?.id === id) this.flight.canceled = true;
    this.append.dismiss();
    return true;
  }
}

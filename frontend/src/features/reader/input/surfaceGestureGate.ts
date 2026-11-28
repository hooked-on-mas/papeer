/** A surface-selection gesture owns every subsequent pointer until all of them leave. */
export class SurfaceGestureGate {
  private readonly pointers = new Set<number>();
  begin(pointerId: number) { this.pointers.add(pointerId); }
  down(pointerId: number): boolean {
    if (!this.pointers.size) return false;
    this.pointers.add(pointerId); return true;
  }
  owns(pointerId: number) { return this.pointers.has(pointerId); }
  get active() { return this.pointers.size > 0; }
  end(pointerId: number) { return this.pointers.delete(pointerId); }
  clear() { this.pointers.clear(); }
}
/** A current pointer may be excluded only for its own inactive-surface activation. */
export type SurfaceActivationOrigin = { kind: 'pointer'; pointerId: number; target: EventTarget | null }
  | { kind: 'keyboard' | 'programmatic' };


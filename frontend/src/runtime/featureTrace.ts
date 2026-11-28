export type FeatureTrace = { entry: string; targetId: string; action: string };
const listeners = new Set<(event: FeatureTrace) => void>();
/** Opt-in verification hook. No text, coordinates, credentials or document payloads are logged. */
export function subscribeFeatureTrace(listener: (event: FeatureTrace) => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function traceFeature(entry: string, targetId: string, action: string): void {
  for (const listener of listeners) { try { listener({ entry, targetId, action }); } catch { /* Verification observers cannot change edit/save outcomes. */ } }
}

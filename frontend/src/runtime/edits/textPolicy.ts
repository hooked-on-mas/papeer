import { CONFLICT_SUFFIX, EDIT_LIMITS } from './contracts.ts';
export { CONFLICT_SUFFIX } from './contracts.ts';
export function conflictTitle(title: string): string {
  return Array.from(title).slice(0, EDIT_LIMITS.title - Array.from(CONFLICT_SUFFIX).length).join('') + CONFLICT_SUFFIX;
}

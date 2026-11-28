import type { EditScope } from '../../runtime/edits/ports.ts';
import type { ContentNavigationResult, ContentNavigationSession } from '../reader/navigation/ContentNavigationSession.ts';
export type ContentTarget = Readonly<{ id: string; kind: 'pdf' | 'notebook' | 'markdown' | 'attachment' }>;
export type WorkspacePlacement = 'center' | 'right';
export type WorkspaceFocusRole = 'settings' | 'catalog' | 'annotation-session' | 'annotation-panel' | 'reader';
export type WorkspaceOwner = { readonly identity: object; readonly target: ContentTarget; moveEditor?(placement: WorkspacePlacement, stillCurrent: () => boolean): Promise<boolean> };
const sameScope = (a: EditScope, b: EditScope) => a.accountId === b.accountId && a.libraryId === b.libraryId && a.epoch === b.epoch;
const sameTarget = (a: ContentTarget, b: ContentTarget) => a.id === b.id && a.kind === b.kind;
const blocked = (reason: string): ContentNavigationResult => ({ status: 'blocked', reason });
/** Pure coordinator: content, commit, authority and placement writers remain with their existing owners. */
export class WorkspaceCommandSession {
  readonly scope: Readonly<EditScope>;
  private readonly navigation: Pick<ContentNavigationSession, 'scope' | 'openDocument' | 'getSnapshot'>;
  private readonly active: () => boolean;
  private readonly validateTarget: (target: ContentTarget) => boolean;
  private owner?: WorkspaceOwner;
  private readonly observe: (listener: () => void) => () => void;
  private readonly readiness: () => string;
  private readonly focusOwners = new Map<WorkspaceFocusRole, Map<object, () => boolean>>();
  private readonly focusPreparers = new Map<() => boolean, () => void>();
  private readonly focusListeners = new Set<() => void>();
  private readonly focusBlockers = new Map<object, () => boolean>();
  private readonly panelGuards = new Map<object, () => boolean>();
  private readonly panelListeners = new Set<() => void>();
  private panelOpen = false;
  private focused = false;
  private focusBusy = false;
  constructor(options: { navigation: Pick<ContentNavigationSession, 'scope' | 'openDocument' | 'getSnapshot'>; active: () => boolean; validateTarget(target: ContentTarget): boolean; observe?: (listener: () => void) => () => void; readiness?: () => string }) {
    this.navigation = options.navigation; this.scope = Object.freeze({ ...options.navigation.scope }); this.active = options.active; this.validateTarget = options.validateTarget; this.observe = options.observe ?? (() => () => {}); this.readiness = options.readiness ?? (() => '');
  }
  private available() { return this.active() && sameScope(this.scope, this.navigation.scope); }
  subscribe = (listener: () => void) => this.observe(listener);
  getSnapshot = () => this.readiness();
  getFocusSnapshot = () => this.focused;
  subscribeFocus = (listener: () => void) => { this.focusListeners.add(listener); return () => { this.focusListeners.delete(listener); }; };
  registerFocusGuard(role: WorkspaceFocusRole, identity: object, canChange: () => boolean, beforeHide?: () => void): () => void {
    const owners = this.focusOwners.get(role) ?? new Map<object, () => boolean>();
    owners.set(identity, canChange); this.focusOwners.set(role, owners);
    if (beforeHide) this.focusPreparers.set(canChange, beforeHide);
    return () => { if (owners.get(identity) === canChange) owners.delete(identity); this.focusPreparers.delete(canChange); };
  }
  registerFocusBlocker(identity: object, canChange: () => boolean): () => void {
    this.focusBlockers.set(identity, canChange);
    return () => { if (this.focusBlockers.get(identity) === canChange) this.focusBlockers.delete(identity); };
  }
  setFocusMode(next: boolean): boolean {
    if (this.focusBusy || !this.available()) return false;
    if (next === this.focused) return true;
    const roles: WorkspaceFocusRole[] = next ? ['settings', 'catalog', 'annotation-session', 'annotation-panel', 'reader'] : ['reader'];
    const snapshot = roles.map(role => this.focusOwners.get(role));
    if (snapshot.some(owners => !owners || owners.size !== 1)) return false;
    const checks = snapshot.map(owners => [...owners!.entries()][0]);
    const blockers = [...this.focusBlockers.entries()];
    this.focusBusy = true;
    try {
      try { for (let pass = 0; pass < 2; pass++) {
        if (!this.available() || roles.some((role, index) => this.focusOwners.get(role) !== snapshot[index]
          || snapshot[index]!.size !== 1 || snapshot[index]!.get(checks[index][0]) !== checks[index][1])) return false;
        if (checks.some(([, canChange]) => !canChange()) || blockers.some(([, canChange]) => !canChange())) return false;
      }
      if (next) for (const [, callback] of checks) this.focusPreparers.get(callback)?.();
      if (!this.available() || this.focusBlockers.size !== blockers.length || blockers.some(([identity, callback]) => this.focusBlockers.get(identity) !== callback)
        || roles.some((role, index) => this.focusOwners.get(role) !== snapshot[index]
        || snapshot[index]!.size !== 1 || snapshot[index]!.get(checks[index][0]) !== checks[index][1])) return false;
      } catch { return false; }
      this.focused = next; this.focusListeners.forEach(listener => listener()); return true;
    } finally { this.focusBusy = false; }
  }
  getRelatedPanelSnapshot = () => this.panelOpen;
  subscribeRelatedPanel = (listener: () => void) => { this.panelListeners.add(listener); return () => { this.panelListeners.delete(listener); }; };
  registerRelatedPanelGuard(identity: object, canChange: () => boolean): () => void {
    this.panelGuards.set(identity, canChange);
    return () => { if (this.panelGuards.get(identity) === canChange) this.panelGuards.delete(identity); };
  }
  setRelatedPanelOpen(next: boolean): boolean {
    if (!this.available() || this.focusBusy || this.focused || typeof next !== 'boolean') return false;
    if (next === this.panelOpen) return true; // No width change; not a guard admission.
    const roles: WorkspaceFocusRole[] = ['settings', 'catalog', 'annotation-session', 'annotation-panel', 'reader'];
    const owners = roles.map(role => this.focusOwners.get(role));
    if (owners.some(owner => !owner || owner.size !== 1) || this.panelGuards.size !== 1) return false;
    const checks = owners.map(owner => [...owner!.entries()][0]), [panel] = this.panelGuards.entries();
    const blockers = [...this.focusBlockers.entries()]; this.focusBusy = true;
    const current = () => this.available() && !this.focused && roles.every((role, index) => this.focusOwners.get(role) === owners[index]
      && owners[index]!.size === 1 && owners[index]!.get(checks[index][0]) === checks[index][1])
      && this.panelGuards.size === 1 && this.panelGuards.get(panel[0]) === panel[1]
      && this.focusBlockers.size === blockers.length && blockers.every(([identity, guard]) => this.focusBlockers.get(identity) === guard);
    try {
      try {
        for (let pass = 0; pass < 2; pass++) {
          if (!current() || checks.some(([, guard]) => !guard()) || !panel[1]() || blockers.some(([, guard]) => !guard())) return false;
        }
        if (!current()) return false;
      } catch { return false; }
      this.panelOpen = next; this.panelListeners.forEach(listener => listener()); return true;
    } finally { this.focusBusy = false; }
  }
  registerOwner(owner: WorkspaceOwner): void {
    const target = Object.freeze({ id: owner.target.id, kind: owner.target.kind });
    if (!this.available() || this.navigation.getSnapshot().documentId !== target.id || !this.validateTarget(target)) return;
    // Readiness changes for the same mounted controller do not invalidate an in-flight ticket.
    if (this.owner?.identity === owner.identity && sameTarget(this.owner.target, target)) return;
    this.owner = Object.freeze({ identity: owner.identity, target, ...(owner.moveEditor ? { moveEditor: owner.moveEditor } : {}) });
  }
  releaseOwner(identity: object): void { if (this.owner?.identity === identity) this.owner = undefined; }
  async openContent(target: ContentTarget, catalogVersion?: string): Promise<ContentNavigationResult> {
    const fixed = Object.freeze({ ...target });
    if (!this.available() || !this.validateTarget(fixed)) return blocked('target-unavailable');
    const result = await this.navigation.openDocument(fixed.id, catalogVersion);
    // Navigation owns catalog revalidation; do not reinterpret its accepted result using a later cached catalog snapshot.
    if (!this.available() || result.status !== 'blocked' && this.navigation.getSnapshot().documentId !== fixed.id) return blocked('stale');
    return result;
  }
  async moveEditor(target: ContentTarget, placement: WorkspacePlacement): Promise<boolean> {
    const owner = this.owner, fixed = Object.freeze({ ...target });
    if (placement !== 'center' && placement !== 'right' || !this.available() || !owner || !sameTarget(owner.target, fixed) || !owner.moveEditor
      || this.navigation.getSnapshot().documentId !== fixed.id || !this.validateTarget(fixed)) return false;
    let invalidated = false;
    const stillCurrent = () => {
      if (!invalidated && (!this.available() || this.owner !== owner || this.navigation.getSnapshot().documentId !== fixed.id || !this.validateTarget(fixed))) invalidated = true;
      return !invalidated;
    };
    const unsubscribe = this.observe(() => { stillCurrent(); });
    try {
      if (!stillCurrent()) return false;
      const changed = await owner.moveEditor(placement, stillCurrent);
      return changed && stillCurrent();
    } finally { unsubscribe(); }
  }
}

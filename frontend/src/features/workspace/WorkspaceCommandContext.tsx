import { createContext, useContext, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { ContentTarget, WorkspaceCommandSession, WorkspaceFocusRole, WorkspacePlacement } from './WorkspaceCommandSession';
export const WorkspaceCommandContext = createContext<WorkspaceCommandSession | null>(null);
/** One mounted controller owns its original guarded placement method. */
export function useWorkspaceEditor(target: ContentTarget, move: (placement: WorkspacePlacement, stillCurrent?: () => boolean) => Promise<boolean>) {
  const commands = useContext(WorkspaceCommandContext), current = useRef(move); current.current = move;
  const identity = useRef<object>({});
  const { id, kind } = target;
  const revision = useSyncExternalStore(commands?.subscribe ?? (() => () => {}), commands?.getSnapshot ?? (() => ''), commands?.getSnapshot ?? (() => ''));
  // Cleanup tracks controller/scope/target lifetime, not ordinary readiness changes.
  useLayoutEffect(() => { const token = identity.current; return () => commands?.releaseOwner(token); }, [commands, id, kind]);
  useLayoutEffect(() => { commands?.registerOwner({ identity: identity.current, target: { id, kind }, moveEditor: (placement, ticket) => current.current(placement, ticket) }); }, [commands, id, kind, revision]);
  return (placement: WorkspacePlacement) => commands ? commands.moveEditor(target, placement) : move(placement, () => true);
}
export const useWorkspaceCommands = () => useContext(WorkspaceCommandContext);
export function useWorkspaceFocusGuard(role: WorkspaceFocusRole, canChange: () => boolean, beforeHide?: () => void) {
  const commands = useContext(WorkspaceCommandContext), current = useRef(canChange), prepare = useRef(beforeHide), identity = useRef<object>({});
  current.current = canChange; prepare.current = beforeHide;
  useLayoutEffect(() => commands?.registerFocusGuard(role, identity.current, () => current.current(), () => prepare.current?.()), [commands, role]);
}
export function useWorkspaceFocusBlocker(canChange: () => boolean) {
  const commands = useContext(WorkspaceCommandContext), current = useRef(canChange), identity = useRef<object>({});
  current.current = canChange;
  useLayoutEffect(() => commands?.registerFocusBlocker(identity.current, () => current.current()), [commands]);
}

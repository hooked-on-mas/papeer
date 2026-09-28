/**
 * The line of questions the app puts to the user (askText / askConfirm / showMessage in
 * components/AppDialogs.tsx), one on screen at a time. Kept free of React and the stores so that
 * tests/dialogQueue.test.ts can check the rules.
 *
 * - A question asked while another is on screen waits its turn; none replaces another, so every
 *   caller gets its answer (an answer of "cancel" at worst) and no promise is left hanging.
 * - An urgent question (closing the app) goes ahead of the ordinary ones, the one on screen
 *   included: that one steps back to the head of the line and comes back once the urgent ones are
 *   answered. Urgent ones among themselves keep their order.
 * - A question with a `key` that is already in the line (the window's close button pressed again
 *   while its confirmation is up) is not asked twice: the second caller is answered "cancel" at once.
 * - While the ordinary questions are held (the app is closing, after its confirmation), only urgent
 *   ones are shown: an ordinary one answered then would start work in the middle of the closing.
 *   The held ones stay in the line and come back when the closing is called off.
 */

export type DialogRequest =
  | { kind: "text"; title: string; label: string; defaultValue: string }
  /** cancelLabel: the other button's label, キャンセル when left out; either way it answers false. */
  | { kind: "confirm"; title: string; message: string; okLabel: string; destructive: boolean; cancelLabel?: string }
  | { kind: "message"; title: string; message: string };

export type DialogAnswer<R extends DialogRequest> =
  R extends { kind: "text" } ? string | null : R extends { kind: "confirm" } ? boolean : undefined;

export type DialogOptions = {
  /** Asked at most once at a time; see the module comment. */
  key?: string;
  /** Goes ahead of the ordinary questions, even the one on screen. */
  urgent?: boolean;
};

export type QueuedDialog = {
  id: number;
  request: DialogRequest;
  key?: string;
  urgent: boolean;
};

/** The answer a question gets when it is dismissed (Esc, キャンセル, the × button, or asked twice). */
export function cancelAnswer(kind: DialogRequest["kind"]): string | boolean | null | undefined {
  return kind === "text" ? null : kind === "confirm" ? false : undefined;
}

/** `value` as the answer to a question of `kind`: text gives a string or null, confirm a boolean. */
export function normalizeAnswer(kind: DialogRequest["kind"], value: unknown): string | boolean | null | undefined {
  if (kind === "text") return typeof value === "string" ? value : null;
  if (kind === "confirm") return value === true;
  return undefined;
}

/** The question to show: the first in the line, or, while ordinary ones are held, the first urgent one. */
export function shownDialog<T extends { urgent: boolean }>(queue: readonly T[], held: boolean): T | null {
  return (held ? queue.find((entry) => entry.urgent) : queue[0]) ?? null;
}

/** `queue` with `entry` in its place: at the back, or, when urgent, behind the urgent ones only. */
export function insertDialog<T extends { urgent: boolean }>(queue: readonly T[], entry: T): T[] {
  if (!entry.urgent) return [...queue, entry];
  const index = queue.findIndex((queued) => !queued.urgent);
  return index < 0 ? [...queue, entry] : [...queue.slice(0, index), entry, ...queue.slice(index)];
}

export type DialogQueue = {
  /** The line, in order. */
  getQueue: () => readonly QueuedDialog[];
  /** The question on screen (shownDialog), or null; the same object while it stays on screen. */
  getShown: () => QueuedDialog | null;
  /** Hold the ordinary questions back (true) or let them show again (false). */
  hold: (held: boolean) => void;
  subscribe: (listener: () => void) => () => void;
  ask: <R extends DialogRequest>(request: R, options?: DialogOptions) => Promise<DialogAnswer<R>>;
  /** Answer question `id` (already answered: nothing happens), which shows the next one. */
  answer: (id: number, value: unknown) => void;
};

export function createDialogQueue(): DialogQueue {
  let queue: QueuedDialog[] = [];
  let held = false;
  let nextId = 0;
  const resolvers = new Map<number, (value: unknown) => void>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());

  return {
    getQueue: () => queue,
    getShown: () => shownDialog(queue, held),
    hold: (value) => {
      if (held === value) return;
      held = value;
      emit();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ask: <R extends DialogRequest>(request: R, options: DialogOptions = {}) => {
      if (options.key && queue.some((queued) => queued.key === options.key)) {
        return Promise.resolve(cancelAnswer(request.kind) as DialogAnswer<R>);
      }
      return new Promise<DialogAnswer<R>>((resolve) => {
        const id = ++nextId;
        resolvers.set(id, resolve as (value: unknown) => void);
        queue = insertDialog(queue, { id, request, key: options.key, urgent: options.urgent ?? false });
        emit();
      });
    },
    answer: (id, value) => {
      const entry = queue.find((queued) => queued.id === id);
      const resolve = resolvers.get(id);
      if (!entry || !resolve) return;
      queue = queue.filter((queued) => queued.id !== id);
      resolvers.delete(id);
      emit();
      resolve(normalizeAnswer(entry.request.kind, value));
    },
  };
}

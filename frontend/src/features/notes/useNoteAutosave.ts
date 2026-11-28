import { useEffect, useRef } from 'react';

/** Shared edit cadence; each host retains its own persistence and conflict protocol. */
export function useNoteAutosave({ dirty, value, revision, save, onError, flushOnUnmount = false }: {
  dirty: boolean; value: unknown; revision?: unknown;
  save: () => void | Promise<void>; onError: (error: unknown) => void; flushOnUnmount?: boolean;
}) {
  const latest = useRef({ save, onError }); latest.current = { save, onError };
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(() => {
      try { void Promise.resolve(latest.current.save()).catch(error => latest.current.onError(error)); }
      catch (error) { latest.current.onError(error); }
    }, 600);
    return () => clearTimeout(timer);
  }, [dirty, value, revision]);
  useEffect(() => () => {
    if (!flushOnUnmount) return;
    try { void Promise.resolve(latest.current.save()).catch(() => undefined); }
    catch { /* The host retains the draft and reports its own persistence failure. */ }
  }, [flushOnUnmount]);
}

export function noteSaveStatus({ saving = false, dirty, durable, saved = '保存済み' }: {
  saving?: boolean; dirty: boolean; durable: boolean; saved?: string;
}) {
  return saving ? '保存中…' : dirty ? durable ? '端末に保存' : '未保存の変更があります' : saved;
}

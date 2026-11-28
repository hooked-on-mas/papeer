import { validateLegacyMigrationHold } from '../runtime/edits/contracts.ts';

/** Both entries must read admission before importing any old stores or recovery side effects.
 * Admission at startup does not claim that an already running editor has stopped writing.
 */
export function startGuardedApplication(root: HTMLElement, host: { readHold(signal: AbortSignal): Promise<unknown>;
  readLegacyPresence?(signal: AbortSignal): Promise<'clear' | 'legacy-present'>; readRecoveryRequired?(signal: AbortSignal): Promise<boolean>;
  loadRecovery?(signal: AbortSignal): Promise<boolean>; load(): Promise<void> },
  { admissionTimeoutMs = 10_000 }: { admissionTimeoutMs?: number } = {}): Promise<void> {
  let pending = false, started = false, generation = 0;
  let cancel: (() => void) | undefined;
  const message = (state: 'loading' | 'held' | 'legacy-present' | 'unavailable', content: string, retry: boolean) => {
    root.dataset.startupState = state;
    const main = document.createElement('main'); main.className = 'startup-gate';
    const title = document.createElement('h1'); title.textContent = 'Papeer';
    const status = document.createElement('p'); status.setAttribute('role', state === 'unavailable' ? 'alert' : 'status'); status.textContent = content;
    main.append(title, status);
    if (retry) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = '起動を再試行';
      button.addEventListener('click', () => void attempt()); main.append(button);
    } else if (cancel) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = '確認を中止';
      button.addEventListener('click', () => cancel?.()); main.append(button);
    }
    root.replaceChildren(main);
  };
  const attempt = async () => {
    if (pending || started) return; pending = true;
    const current = ++generation, controller = new AbortController();
    const abort = () => controller.abort(new Error('startup-admission-cancelled'));
    cancel = abort;
    message('loading', '保存状態を確認しています…', false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      // Some hosts cannot abort an open request. Race the entire inquiry as well as
      // signalling cancellation, so a blocked IndexedDB open cannot strand the gate.
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      timer = setTimeout(abort, admissionTimeoutMs);
      const inspect = async () => {
        const hold = await host.readHold(controller.signal);
        controller.signal.throwIfAborted();
        if (hold !== null && hold !== undefined) validateLegacyMigrationHold(hold);
        const recovery = host.readRecoveryRequired ? await host.readRecoveryRequired(controller.signal) : false;
        if (recovery) return { hold, recovery, presence: 'clear' as const };
        if (hold !== null && hold !== undefined) return { hold, recovery, presence: 'clear' as const };
        const presence = host.readLegacyPresence === undefined ? 'clear' : await host.readLegacyPresence(controller.signal);
        if (presence !== 'clear' && presence !== 'legacy-present') throw new Error('startup-presence-unverifiable');
        return { hold, recovery, presence };
      };
      const { hold, presence, recovery } = await Promise.race([inspect(), cancelled]);
      if (current !== generation) return;
      controller.signal.throwIfAborted();
      if (recovery || hold !== null && hold !== undefined) {
        if (host.loadRecovery && await Promise.race([host.loadRecovery(controller.signal), cancelled])) { clearTimeout(timer); cancel = undefined; started = true; root.dataset.startupState = 'recovery'; return; }
        clearTimeout(timer); cancel = undefined;
        message('held', 'データの移行が完了するまで、編集画面の起動を待機しています。', true);
      } else if (presence === 'legacy-present') {
        if (host.loadRecovery && await Promise.race([host.loadRecovery(controller.signal), cancelled])) { clearTimeout(timer); cancel = undefined; started = true; root.dataset.startupState = 'recovery'; return; }
        clearTimeout(timer); cancel = undefined;
        message('legacy-present', '以前の保存データが見つかりました。移行・復旧を確認するまで、編集画面の起動を保留しています。', true);
      } else {
        // Admission is complete; mounting is no longer a cancellable inquiry.
        clearTimeout(timer); cancel = undefined;
        message('loading', '編集画面を起動しています…', false);
        await host.load(); started = true; root.dataset.startupState = 'running';
      }
    } catch {
      if (current !== generation) return;
      message('unavailable', '移行状態を確認できないため、起動を保留しています。保存領域と接続を確認して再試行してください。', true);
    } finally {
      clearTimeout(timer);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      if (current === generation) { cancel = undefined; pending = false; }
    }
  };
  return attempt();
}

import { pyStrip } from '../../../lib/pyWhitespace.ts';
import { EDIT_LIMITS } from '../../../runtime/edits/contracts.ts';
import type { ProviderGrant, ProviderOperationOutcome, ProviderOwnerFacade, ProviderRecoveryRequest, RemoteLibraryHandle } from '../bootstrapPorts.ts';
import type { ScopeLeaveResult } from '../../reader/DocumentEditSessions.ts';
import type { ProviderConnectionBridge, ProviderConnectionController, ProviderConnectionPhase, ProviderConnectionState, ProviderRequestView } from './providerConnectionPorts.ts';

type Frame = { signal: AbortSignal; alive(): boolean };
type FixedRequest = { requestId: string; action: 'create' | 'join'; title: string; handle?: RemoteLibraryHandle; recoverable: boolean };
type View = Pick<ProviderConnectionState, 'phase' | 'connected' | 'choices' | 'request' | 'error'>;
const unsettled = (status: string) => ['preparing', 'pending', 'unknown', 'not-found'].includes(status);
const refused = (): ScopeLeaveResult => ({ status: 'refused', reason: 'provider-operation-pending', targets: [] });
const needsReconnect = (error: unknown) => error instanceof Error && /principal|grant-invalid|grant-stale|auth-changed|operation-invalid|lease-invalid/.test(error.message);
function explanation(error: unknown, fallback: string): string {
  const reason = error instanceof Error ? error.message : '';
  if (reason === 'offline-pending') return '編集中の入力や保存途中の内容があります。端末への保存を確認してから、もう一度接続してください。';
  if (reason.includes('cloud-cache-in-use')) return 'このブラウザーの別のタブでGoogle Driveのライブラリを開いています。そのタブを閉じてから再確認してください。';
  if (reason.includes('locks-unavailable')) return 'このブラウザーではGoogle Driveのライブラリを開けません。この端末のライブラリは引き続き使えます。';
  if (reason.includes('owner-write-required')) return 'このライブラリの所有者として読み書きできるGoogleアカウントで接続してください。';
  return fallback;
}

/** View coordination only. Provider identity, durable requests and all admissions belong to the facade. */
export class ProviderConnectionSession implements ProviderConnectionController {
  private readonly bridge: ProviderConnectionBridge;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private unsubscribeProvider: (() => void) | null = null;
  private facade: ProviderOwnerFacade | null = null;
  private grant: ProviderGrant | null = null;
  private configured = false;
  private fixed: FixedRequest | null = null;
  private backlog: readonly ProviderRecoveryRequest[] = [];
  private generation = 0;
  private controller = new AbortController();
  private flight: Promise<unknown> | null = null;
  private reserved = false;
  private closing = false;
  private retiringGrant = false;
  private closed = false;
  private closeFlight: Promise<ScopeLeaveResult> | null = null;
  private wasLocked = false;
  private autoReconnectAttempted = false;
  private view: View = { phase: 'idle', connected: false, choices: [], request: null, error: '' };
  private state!: ProviderConnectionState;

  constructor(bridge: ProviderConnectionBridge) {
    this.bridge = bridge;
    this.wasLocked = !!bridge.retained()?.locked;
    this.publish();
    this.unsubscribe = bridge.subscribe(() => {
      const retained = bridge.retained(), locked = !!retained?.locked;
      if (retained?.kind === 'google-drive' && locked && !this.wasLocked) {
        this.providerLost();
      }
      this.wasLocked = locked;
      this.publish();
    });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  private publish(fields: Partial<View> = {}): void {
    this.view = { ...this.view, ...fields };
    const retained = this.bridge.retained(), busy = this.reserved || this.flight !== null;
    if (!retained && this.view.phase === 'ready') this.view = { ...this.view, phase: 'choosing' };
    const pendingGuard = !!this.view.request && unsettled(this.view.request.status)
      || this.backlog.some(request => unsettled(request.status));
    const available = !this.closed && !this.closing && !busy;
    const begin = available && this.view.connected && !retained && !pendingGuard && this.backlog.length === 0;
    const next: ProviderConnectionState = Object.freeze({ ...this.view, busy, pendingGuard,
      canConnect: available && this.configured && !!this.facade && !this.grant,
      canCreate: begin, canJoin: begin,
      canRefresh: available && this.view.connected && !pendingGuard,
      canRetry: available && this.view.connected && !!this.fixed && this.view.request?.status !== 'rejected',
      canOpenInstalled: available && this.view.connected && this.view.request?.status === 'accepted'
        && !retained && this.backlog.filter(request => request.requestId !== this.fixed?.requestId).length === 0,
      canDisconnect: available && this.view.connected && !pendingGuard,
    });
    if (this.state && (Object.keys(next) as (keyof ProviderConnectionState)[]).every(key => next[key] === this.state[key])) return;
    this.state = next;
    this.listeners.forEach(listener => listener());
  }
  private invalidate(): void { this.generation++; this.controller.abort(); this.controller = new AbortController(); }
  private providerLost = (): void => {
    if (this.closed || this.retiringGrant || (this.view.phase === 'connecting' && !this.grant)) return;
    // Sign-in itself revokes the old credential generation before issuing the new grant.
    this.invalidate(); this.grant = null;
    if (this.view.request && unsettled(this.view.request.status)) this.requestStatus('unknown');
    this.publish({ connected: false, choices: [], phase: this.configured ? 'connect-ready' : 'unavailable',
      error: '編集前のGoogleアカウントで再接続してください。保存途中の内容は保持しています。' });
  };
  private operate<T>(phase: ProviderConnectionPhase, body: (frame: Frame) => Promise<T>, fallback: T, duringClose = false): Promise<T> | null {
    if (this.closed || (this.closing && !duringClose) || this.flight || this.reserved) return null;
    this.invalidate(); const generation = this.generation, signal = this.controller.signal;
    const frame: Frame = { signal, alive: () => !this.closed && generation === this.generation && !signal.aborted };
    this.reserved = true; this.publish({ phase, error: '' });
    // Call the body immediately: connect must reach the facade in this same click stack.
    let started: Promise<T>;
    try { started = body(frame); } catch (error) { started = Promise.reject(error); }
    const flight = started.catch(error => {
      if (frame.alive()) {
        if (needsReconnect(error)) this.providerLost();
        else this.publish({ phase: this.grant ? 'choosing' : this.configured ? 'connect-ready' : 'unavailable',
          error: explanation(error, '操作を完了できませんでした。もう一度確認してください。') });
      }
      return fallback;
    }).finally(() => { if (this.flight === flight) { this.flight = null; this.reserved = false; this.publish(); } });
    this.flight = flight; this.publish(); return flight;
  }
  private requestStatus(status: ProviderRequestView['status']): void {
    if (!this.fixed) return;
    this.backlog = this.backlog.map(request => request.requestId === this.fixed!.requestId ? Object.freeze({ ...request, status: status === 'preparing' ? 'pending' : status }) : request);
    this.publish({ request: Object.freeze({ requestId: this.fixed.requestId, action: this.fixed.action, title: this.fixed.title, status }) });
  }

  private async retireSavedGrant(facade: ProviderOwnerFacade, grant: ProviderGrant): Promise<void> {
    const retire = facade.releaseOnClose ?? facade.disconnect;
    this.retiringGrant = true;
    try { await retire(grant, new AbortController().signal).catch(() => undefined); }
    finally { this.retiringGrant = false; }
  }

  prepare = (): Promise<void> => {
    if (this.closed || this.closing || this.configured || this.flight) return Promise.resolve();
    return this.operate('preloading', async frame => {
      try {
        const facade = await this.bridge.getFacade(); if (!frame.alive()) return;
        if (!facade) { this.publish({ phase: 'unavailable', error: 'この環境ではGoogle Driveへの接続が設定されていません。' }); return; }
        if (facade !== this.facade) {
          this.unsubscribeProvider?.();
          this.facade = facade;
          this.unsubscribeProvider = facade.subscribeInvalidation?.(this.providerLost) ?? null;
        }
        const result = await facade.preload(frame.signal); if (!frame.alive()) return;
        this.configured = result.configured;
        if (result.configured && !this.autoReconnectAttempted && !this.grant && facade.reconnectSaved) {
          this.autoReconnectAttempted = true;
          const saved = await facade.reconnectSaved(frame.signal).catch(() => null);
          if (saved) {
            if (!frame.alive()) {
              await this.retireSavedGrant(facade, saved);
              return;
            }
            try {
              await this.afterConnected(facade, saved, frame);
              if (!frame.alive() && this.grant === saved) {
                this.grant = null;
                await this.retireSavedGrant(facade, saved);
              }
              return;
            } catch {
              if (this.grant === saved) this.grant = null;
              await this.retireSavedGrant(facade, saved);
              if (!frame.alive()) return;
              this.publish({ connected: false, choices: [], phase: 'connect-ready', error: '' });
              return;
            }
          }
          if (!frame.alive()) return;
        }
        this.publish({ phase: result.configured ? 'connect-ready' : 'unavailable',
          error: result.configured ? '' : 'Google Driveへの接続設定を確認してください。この端末のライブラリは引き続き使えます。' });
      } catch (error) { if (frame.alive()) this.publish({ phase: 'unavailable', error: explanation(error, 'Googleへの接続を準備できませんでした。再確認してください。') }); }
    }, undefined) ?? Promise.resolve();
  };

  private async afterConnected(facade: ProviderOwnerFacade, grant: ProviderGrant, frame: Frame): Promise<void> {
    this.grant = grant; this.publish({ connected: true });
    const retained = this.bridge.retained();
    if (retained?.kind === 'google-drive') {
      if (!retained.requestId) throw new Error('provider-retained-request-missing');
      const target = await facade.openInstalled(grant, retained.requestId, frame.signal); if (!frame.alive()) return;
      if (target.requestId !== retained.requestId || !await this.bridge.openInstalled(target, frame.signal)) throw new Error('provider-retained-open-refused');
      if (!frame.alive()) return;
    }
    const recoveries = await facade.recoveries(grant, frame.signal); if (!frame.alive()) return;
    this.backlog = recoveries.map(request => Object.freeze({ ...request }));
    if (!this.fixed && this.backlog.length) this.selectRecovery(this.backlog[0]);
    else if (this.fixed && this.view.request && unsettled(this.view.request.status)
      && !this.backlog.some(request => request.requestId === this.fixed!.requestId)) {
      const outcome = await facade.query(grant, this.fixed.requestId, frame.signal); if (!frame.alive()) return;
      if (outcome.requestId !== this.fixed.requestId) throw new Error('provider-request-mismatch');
      if (outcome.status !== 'not-found') this.requestStatus(outcome.status);
    }
    const choices = await facade.list(grant, frame.signal); if (!frame.alive()) return;
    this.publish({ choices: Object.freeze(choices.map(choice => Object.freeze({ ...choice }))),
      phase: this.bridge.retained()?.kind === 'google-drive' ? 'ready' : 'choosing', error: '' });
  }

  connect = (): Promise<void> => {
    const facade = this.facade; if (!facade || !this.state.canConnect) return Promise.resolve();
    return this.operate('connecting', async frame => {
      try {
        const grant = await facade.connect(frame.signal); if (!frame.alive()) return;
        await this.afterConnected(facade, grant, frame);
      } catch (error) {
        if (!frame.alive()) return;
        this.grant = null; this.publish({ connected: false, choices: [], phase: 'connect-ready',
          error: explanation(error, 'Googleに接続できませんでした。同じアカウントで再確認してください。') });
      }
    }, undefined) ?? Promise.resolve();
  };
  /** A persisted page return never initiates OAuth or replaces the retained editor owner. */
  resumeRetained = (): Promise<boolean> => {
    const facade = this.facade, expected = this.bridge.retained();
    if (!facade?.resumeRetained || expected?.kind !== 'google-drive' || !expected.locked || !expected.requestId) return Promise.resolve(false);
    const requestId = expected.requestId;
    return this.operate('opening', async frame => {
      let resumed: ProviderGrant | undefined, accepted = false;
      try {
      const result = await facade.resumeRetained!(requestId, frame.signal);
      resumed = result?.grant;
      if (!frame.alive()) return false;
      const retained = this.bridge.retained();
      if (!result) { this.providerLost(); return false; }
      if (retained?.kind !== 'google-drive' || !retained.locked || retained.requestId !== requestId || result.target.requestId !== requestId)
        throw new Error('provider-retained-request-mismatch');
      let acknowledged = false;
      if (!await this.bridge.openInstalled(result.target, frame.signal, async () => {
        if (!frame.alive()) throw new Error('provider-resume-stale');
        await facade.settleRetainedResume?.(result.grant, true);
        if (!frame.alive()) throw new Error('provider-resume-stale');
        acknowledged = true;
      }) || !frame.alive() || !acknowledged) throw new Error('provider-retained-open-refused');
      accepted = true;
      this.grant = result.grant;
      this.publish({ connected: true, phase: 'ready', error: '' }); return true;
      } catch { if (frame.alive()) this.providerLost(); return false; }
      finally { if (resumed && !accepted) await facade.settleRetainedResume?.(resumed, false); }
    }, false) ?? Promise.resolve(false);
  };
  cancelConnect = async (): Promise<void> => {
    if (this.view.phase !== 'connecting') return;
    this.invalidate(); const flight = this.flight; this.grant = null;
    this.publish({ connected: false, phase: 'connect-ready', error: '' });
    await flight?.catch(() => undefined);
  };
  refresh = (): Promise<void> => {
    const facade = this.facade, grant = this.grant; if (!facade || !grant || !this.state.canRefresh) return Promise.resolve();
    return this.operate('choosing', async frame => {
      const choices = await facade.list(grant, frame.signal); if (frame.alive()) this.publish({ choices: Object.freeze(choices.map(choice => Object.freeze({ ...choice }))) });
    }, undefined) ?? Promise.resolve();
  };
  private selectRecovery(request: ProviderRecoveryRequest): void {
    this.fixed = { requestId: request.requestId, action: request.action, title: request.title, recoverable: true };
    this.requestStatus(request.status);
  }
  private async openCurrent(frame: Frame): Promise<void> {
    const fixed = this.fixed, facade = this.facade, grant = this.grant;
    if (!fixed || !facade || !grant) return;
    this.publish({ phase: 'opening' });
    const target = await facade.openInstalled(grant, fixed.requestId, frame.signal); if (!frame.alive()) return;
    if (target.requestId !== fixed.requestId || !await this.bridge.openInstalled(target, frame.signal)) throw new Error('provider-open-refused');
    if (!frame.alive()) return;
    this.publish({ phase: 'ready', error: '' });
    try { await facade.acknowledge(grant, fixed.requestId, frame.signal); if (frame.alive()) this.backlog = this.backlog.filter(request => request.requestId !== fixed.requestId); }
    catch { if (frame.alive()) this.publish({ error: 'ライブラリは保存されています。操作の確認を完了できなかったため、後でもう一度確認してください。' }); }
  }
  private async advance(outcome: ProviderOperationOutcome, frame: Frame): Promise<void> {
    const fixed = this.fixed, facade = this.facade, grant = this.grant;
    if (!fixed || !facade || !grant || !frame.alive()) return;
    if (outcome.requestId !== fixed.requestId) throw new Error('provider-request-mismatch');
    if (outcome.status === 'pending') {
      this.requestStatus('pending'); this.publish({ phase: 'executing' });
      outcome = await facade.execute(grant, fixed.requestId, frame.signal); if (!frame.alive()) return;
      if (outcome.requestId !== fixed.requestId) throw new Error('provider-request-mismatch');
    }
    this.requestStatus(outcome.status === 'not-found' ? 'unknown' : outcome.status);
    this.publish({ phase: 'choosing' });
    if (outcome.status === 'accepted' || outcome.status === 'rejected') {
      const other = this.backlog.filter(request => request.requestId !== fixed.requestId);
      if (other.length || outcome.status === 'rejected') {
        await facade.acknowledge(grant, fixed.requestId, frame.signal); if (!frame.alive()) return;
        this.backlog = other;
        if (other.length) this.selectRecovery(other[0]);
        else if (outcome.status === 'rejected') { this.fixed = null; this.publish({ request: null, error: 'ライブラリの操作を完了できませんでした。保存元を確認してください。' }); }
      } else await this.openCurrent(frame);
    }
  }
  private failedRequest(error: unknown, frame: Frame): void {
    if (!frame.alive()) return;
    console.warn('[papeer:provider] request failed:', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    if (needsReconnect(error)) { this.providerLost(); return; }
    if (this.view.request?.status !== 'accepted') this.requestStatus('unknown');
    this.publish({ phase: 'choosing', error: explanation(error, '保存結果を確認できませんでした。内容を保持したまま、同じ処理の状況を再確認してください。') });
  }
  create = (title: string): Promise<void> => {
    const facade = this.facade, grant = this.grant; if (!facade || !grant || !this.state.canCreate) return Promise.resolve();
    const normalized = pyStrip(title);
    if (!normalized || Array.from(normalized).length > EDIT_LIMITS.title) {
      this.publish({ error: `ライブラリの名前は${EDIT_LIMITS.title}文字以内で入力してください。` });
      return Promise.resolve();
    }
    this.fixed = { requestId: crypto.randomUUID(), action: 'create', title: normalized, recoverable: false };
    this.requestStatus('preparing');
    return this.operate('preparing', async frame => {
      try { await this.advance(await facade.prepareCreate(grant, this.fixed!.title, this.fixed!.requestId, frame.signal), frame); }
      catch (error) { this.failedRequest(error, frame); }
    }, undefined) ?? Promise.resolve();
  };
  join = (handle: RemoteLibraryHandle): Promise<void> => {
    const facade = this.facade, grant = this.grant;
    const choice = this.view.choices.find(choice => choice.handle === handle && choice.status === 'available');
    if (!facade || !grant || !this.state.canJoin || !choice) return Promise.resolve();
    return this.operate('opening', async frame => {
      let preparing = false;
      try {
        const installed = await facade.openSelected(grant, handle, frame.signal); if (!frame.alive()) return;
        if (installed) {
          this.fixed = { requestId: installed.requestId, action: 'join', title: choice.title, recoverable: true };
          this.requestStatus('accepted');
          if (!await this.bridge.openInstalled(installed, frame.signal)) throw new Error('provider-open-refused');
          if (frame.alive()) this.publish({ phase: 'ready' }); return;
        }
        this.fixed = { requestId: crypto.randomUUID(), action: 'join', title: choice.title, handle, recoverable: false };
        preparing = true;
        this.requestStatus('preparing'); this.publish({ phase: 'preparing' });
        await this.advance(await facade.prepareJoin(grant, handle, this.fixed.requestId, frame.signal), frame);
      } catch (error) { if (preparing) this.failedRequest(error, frame); else throw error; }
    }, undefined) ?? Promise.resolve();
  };
  retry = (): Promise<void> => {
    const fixed = this.fixed, facade = this.facade, grant = this.grant;
    if (!fixed || !facade || !grant || !this.state.canRetry) return Promise.resolve();
    return this.operate('preparing', async frame => {
      try {
        let outcome = await facade.query(grant, fixed.requestId, frame.signal); if (!frame.alive()) return;
        if (outcome.requestId !== fixed.requestId) throw new Error('provider-request-mismatch');
        if (outcome.status === 'not-found') {
          if (fixed.recoverable || (fixed.action === 'join' && !fixed.handle)) throw new Error('provider-retained-request-missing');
          outcome = fixed.action === 'create' ? await facade.prepareCreate(grant, fixed.title, fixed.requestId, frame.signal)
            : await facade.prepareJoin(grant, fixed.handle!, fixed.requestId, frame.signal);
        }
        await this.advance(outcome, frame);
      } catch (error) { this.failedRequest(error, frame); }
    }, undefined) ?? Promise.resolve();
  };
  openInstalled = (): Promise<void> => {
    if (!this.state.canOpenInstalled) return Promise.resolve();
    return this.operate('opening', async frame => {
      try { await this.openCurrent(frame); } catch (error) { this.failedRequest(error, frame); }
    }, undefined) ?? Promise.resolve();
  };
  canLeave = (): boolean => !this.state.pendingGuard && !this.state.busy;
  private disconnectCurrent(closing = false): Promise<ScopeLeaveResult> {
    if (this.state.pendingGuard || this.flight || this.reserved) return Promise.resolve(refused());
    if (!closing) this.autoReconnectAttempted = true;
    return this.operate('disconnecting', async frame => {
      const allowed = await this.bridge.prepareDisconnect(); if (!frame.alive() || allowed.status !== 'allowed') return allowed;
      const facade = this.facade, grant = this.grant;
      if (facade && grant) {
        this.retiringGrant = true;
        try {
          if (closing && facade.releaseOnClose) await facade.releaseOnClose(grant, frame.signal);
          else await facade.disconnect(grant, frame.signal);
        } finally { this.retiringGrant = false; }
      }
      if (!frame.alive()) return refused();
      this.grant = null; this.fixed = null; this.backlog = [];
      this.publish({ connected: false, phase: this.configured ? 'connect-ready' : 'idle', choices: [], request: null, error: '' });
      return { status: 'allowed' } as ScopeLeaveResult;
    }, refused(), true) ?? Promise.resolve(refused());
  }
  disconnect = (): Promise<ScopeLeaveResult> => this.closing ? Promise.resolve(refused()) : this.disconnectCurrent();
  close = (): Promise<ScopeLeaveResult> => {
    if (this.closed) return Promise.resolve({ status: 'allowed' });
    if (this.closeFlight) return this.closeFlight;
    if (this.state.pendingGuard) return Promise.resolve(refused());
    this.closing = true; this.invalidate(); const active = this.flight;
    const flight = (async () => {
      await active?.catch(() => undefined);
      const allowed = await this.disconnectCurrent(true);
      if (allowed.status !== 'allowed') { this.closing = false; this.publish(); return allowed; }
      this.closed = true; this.unsubscribe(); this.unsubscribeProvider?.(); this.unsubscribeProvider = null;
      this.publish({ phase: 'closed' }); return allowed;
    })().finally(() => { if (this.closeFlight === flight) this.closeFlight = null; });
    this.closeFlight = flight; return flight;
  };
}

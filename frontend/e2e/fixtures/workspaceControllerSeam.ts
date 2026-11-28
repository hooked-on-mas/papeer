import { DocumentEditSession } from '../../src/features/reader/edit/DocumentEditSession';
import { ReaderSession } from '../../src/features/reader/ReaderSession';

// Component-seam instrumentation: retain the actual methods and only defer one
// retry's already-completed return. No result, storage or admission is changed.
const retry = DocumentEditSession.prototype.retry, refresh = DocumentEditSession.prototype.refresh;
const placement = ReaderSession.prototype.setPlacement;
const evidence = { armed: false, waiting: false, released: false, refreshAfterHold: 0, placementAfterHold: 0, release: undefined as undefined | (() => void) };
DocumentEditSession.prototype.retry = async function () {
  await retry.call(this);
  if (!evidence.armed) return;
  evidence.armed = false; evidence.waiting = true;
  await new Promise<void>(resolve => { evidence.release = resolve; });
  evidence.waiting = false; evidence.released = true;
};
DocumentEditSession.prototype.refresh = function (...args) {
  if (evidence.waiting || evidence.released) evidence.refreshAfterHold++;
  return refresh.apply(this, args);
};
ReaderSession.prototype.setPlacement = function (...args) {
  if (evidence.waiting || evidence.released) evidence.placementAfterHold++;
  return placement.apply(this, args);
};
Object.assign(window, { workspaceControllerSeam: evidence });
await import('../../src/web/main');

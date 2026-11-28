import { startGuardedApplication } from '../app/startup';
import { readLegacyHoldRecordReadonly } from '../adapters/browser/legacyHoldReadonly';
import { readLegacyWebPresenceReadonly } from '../adapters/browser/legacyPresenceReadonly';
import './style.css';

void startGuardedApplication(document.getElementById('root')!, {
  readHold: signal => readLegacyHoldRecordReadonly(signal),
  readLegacyPresence: signal => readLegacyWebPresenceReadonly(signal),
  async load() { await (await import('./WebApp')).mountWebApp(); },
});

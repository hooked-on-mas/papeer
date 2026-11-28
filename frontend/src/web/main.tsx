import { startGuardedApplication } from '../app/startup';
import './style.css';

void startGuardedApplication(document.getElementById('root')!, {
  readHold: async () => null,
  async load() { await (await import('./WebApp')).mountWebApp(); },
});

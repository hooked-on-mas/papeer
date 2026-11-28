import { selectedTapPassed } from './canonical-pdf-resource-tap.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// This file is intended to be installed at frontend/scripts/.
const frontend = fileURLToPath(new URL('../', import.meta.url));
const root = path.resolve(frontend, '..');
if (!process.env.PDF_SPIKE_SOURCE_MANIFEST) throw new Error('PDF_SPIKE_SOURCE_MANIFEST must name the reviewed install-time snapshot');
const manifestPath = path.resolve(root, process.env.PDF_SPIKE_SOURCE_MANIFEST);
const testFile = 'e2e/webCanonicalPdfSurface.browser.test.ts';
const names = [
  'canonical PDF resource/Document lifetime and real Reader history',
  'canonical PDF controlled delayed reads, old scope/hash/attempt and initial bad page',
  'canonical actual-PDF inspection fences persistent Reader min-fit normalization',
];
const cases = ['chromium', 'webkit'].flatMap(engine => names.map(name => `${name} (${engine})`));
const sha = data => createHash('sha256').update(data).digest('hex');
const manifestBytes = fs.readFileSync(manifestPath);
const manifestHash = sha(manifestBytes);
const manifest = JSON.parse(manifestBytes);
const roots = manifest.roots;
const snapshot = () => {
  const result = {};
  const rootFiles = fs.readdirSync(frontend, { withFileTypes: true })
    .filter(item => item.isFile() && item.name !== 'tsconfig.node.tsbuildinfo')
    .map(item => `frontend/${item.name}`).sort();
  const sourceDirs = new Set(['frontend/e2e', 'frontend/scripts', 'frontend/src', 'frontend/tests']);
  const expectedRootFiles = roots.filter(item => /^frontend\/[^/]+$/.test(item) && !sourceDirs.has(item)).sort();
  if (JSON.stringify(rootFiles) !== JSON.stringify(expectedRootFiles)) throw new Error('frontend root file set changed');
  const visit = relative => {
    const absolute = path.join(root, relative);
    const entry = fs.lstatSync(absolute);
    if (entry.isSymbolicLink()) throw new Error(`symlink in source scope: ${relative}`);
    if (entry.isDirectory()) for (const name of fs.readdirSync(absolute).sort()) visit(`${relative}/${name}`);
    else if (entry.isFile()) result[relative] = sha(fs.readFileSync(absolute));
    else throw new Error(`unsupported source entry: ${relative}`);
  };
  for (const item of roots) visit(item);
  return result;
};
const verify = () => {
  if (sha(fs.readFileSync(manifestPath)) !== manifestHash) throw new Error('source manifest changed during run');
  const actual = snapshot(), expected = manifest.files;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('source snapshot differs from reviewed manifest');
  return sha(JSON.stringify(actual));
};
if (process.versions.node.split('.')[0] !== '24') throw new Error('Node 24 is required for the reviewed TAP format');
const initialHash = verify();
const runId = randomUUID();
const runDir = path.join(root, 'output/canonical-pdf-resource-isolated-runs', runId);
fs.mkdirSync(path.dirname(runDir), { recursive: true });
// A crash or unresolved run leaves this lock for an executor to inspect.
const lockPath = path.join(path.dirname(runDir), 'executor-confirmation-required.lock');
fs.writeFileSync(lockPath, runId, { flag: 'wx' });
fs.mkdirSync(runDir, { recursive: false });
const write = (name, value) => fs.writeFileSync(path.join(runDir, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
write('run.json', { runId, cases, sourceManifestSha256: manifestHash, sourceSnapshotSha256: initialHash,
  node: process.version, executable: process.execPath, testFile, conditions: { moduleOnlyWarmup: true, navigationMs: 15000,
    readinessMs: 25000, caseTimeoutMs: 180000, parentWatchdogMs: 240000, childExitGraceMs: 10000,
    isolation: 'one Node test invocation per case, serial', retry: false, calibration: false } });
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const results = [];
let active;
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; if (active) active.kill(); });
for (let i = 0; i < cases.length; i++) {
  const caseId = cases[i], prefix = `${String(i + 1).padStart(2, '0')}`;
  const marker = path.join(runDir, `${prefix}-cleanup.json`);
  const stdoutPath = path.join(runDir, `${prefix}-stdout.tap`), stderrPath = path.join(runDir, `${prefix}-stderr.log`);
  const out = fs.openSync(stdoutPath, 'wx'), err = fs.openSync(stderrPath, 'wx');
  const env = { ...process.env, PDF_SPIKE_RUN_ID: runId, PDF_SPIKE_CASE_ID: caseId, PDF_SPIKE_CLEANUP_MARKER: marker };
  delete env.PDF_SPIKE_READY_CALIBRATION;
  const args = ['--test', '--test-concurrency=1', '--test-reporter=tap', `--test-name-pattern=^${escapeRegex(caseId)}$`, testFile];
  const state = { caseId, args, timedOut: false, exitCode: null, signal: null, spawnError: null, childPid: null };
  try {
    active = spawn(process.execPath, args, { cwd: frontend, env, shell: false, stdio: ['ignore', out, err] });
    state.childPid = active.pid ?? null;
    const ended = await new Promise(resolve => {
      let done = false;
      const finish = value => { if (!done) { done = true; clearTimeout(watchdog); clearTimeout(grace); resolve(value); } };
      let grace;
      const watchdog = setTimeout(() => {
        state.timedOut = true;
        active.kill();
        grace = setTimeout(() => finish(false), 10000);
      }, 240000);
      active.once('error', error => { state.spawnError = String(error); finish(false); });
      active.once('exit', (code, signal) => { state.exitCode = code; state.signal = signal; finish(true); });
    });
    state.childExited = ended;
    if (!ended) active.unref();
  } finally { fs.closeSync(out); fs.closeSync(err); active = undefined; }
  let cleanup;
  try { cleanup = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { cleanup = null; }
  const tap = fs.readFileSync(stdoutPath, 'utf8');
  const markerOk = cleanup?.runId === runId && cleanup.caseId === caseId && Number.isInteger(cleanup.childWorkerPid)
    && cleanup.childWorkerPid > 0 && cleanup.cleanupComplete === true
    && ['workerTasksComplete', 'browserCloseComplete', 'serverCloseComplete', 'teardownComplete'].every(key => cleanup.statuses?.[key] === true);
  const tapOk = selectedTapPassed(tap, caseId);
  let sourceUnchanged = false;
  try { sourceUnchanged = verify() === initialHash; } catch {}
  const pass = !interrupted && !state.timedOut && state.childExited && state.exitCode === 0 && state.signal === null
    && !state.spawnError && markerOk && tapOk && sourceUnchanged;
  results.push({ ...state, markerOk, cleanup, tapOk, sourceUnchanged, pass });
  write(`${prefix}-result.json`, results.at(-1));
  if (!pass) break; // On every failure stop, including any unresolved cleanup.
}
let sourceUnchanged = false;
try { sourceUnchanged = verify() === initialHash; } catch {}
if (results.length === 6 && results.every(result => result.pass) && sourceUnchanged) {
  write('full6.json', { runId, result: 'process-isolated full6 6/6', sourceSnapshotSha256: initialHash, cases: results });
  if (fs.readFileSync(lockPath, 'utf8') !== runId) throw new Error('run lock ownership changed');
  fs.unlinkSync(lockPath);
  console.log(`process-isolated full6 6/6: ${runDir}`);
} else {
  write('incomplete.json', { runId, result: 'failed or unresolved; executor must inspect cleanup before any new run', sourceUnchanged, cases: results });
  console.error(`failed or unresolved; inspect ${runDir} before any new run`);
  process.exitCode = 1;
}

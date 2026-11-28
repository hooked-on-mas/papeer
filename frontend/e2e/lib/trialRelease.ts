/** Installed trial only: real release frontend/sidecar, with no development server or seeded owner. */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser, type Page } from 'playwright-core';
import { freePort, isListening } from './processes.ts';
import { isInside, pathWithoutAiClis, userDataDir } from './env.ts';

const REPO = path.resolve(import.meta.dirname, '../../..');
const IDENTITY = 'local.paperdesk.shared-trial';
const EXPECTED_INSTALL = path.join(REPO, 'output/shared-trial-install');
const EXPECTED_RUNTIME = path.join(REPO, 'output/shared-trial-runtime');
const digest = (body: Uint8Array | string) => createHash('sha256').update(body).digest('hex');
const hashFile = (file: string) => digest(fs.readFileSync(file));
const samePath = (left: string, right: string) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;

type Artifact = { path: string; sha256: string };
export type TrialInstalledManifest = {
  version: 1; kind: 'papeer-shared-trial-installed'; installed: true;
  identity: typeof IDENTITY; productName: string; installRoot: string;
  executable: Artifact; sidecar: Artifact;
  runtime: { root: string; markerPath: string; markerSha256: string; library: string; device: string; webview: string; windowState: string };
};
type Process = { pid: number; parent: number; name: string; executable: string; created: string; commandLine: string };
type Metadata = [string, number, number, boolean];
type Snapshot = { roots: string[]; files: number; sha256: string; protectedSha256: string; protectedFiles: number; volatileSha256: string; volatileFiles: number; entries: Metadata[] };
type Launch = { child: ChildProcess; owner: Process; processes: Process[]; browser: Browser; page: Page; port: number; cdp: number; profile: string };

function powershell(script: string): string {
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); " + script],
  { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`trial inspection failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}
function json<T>(value: string): T { return JSON.parse(value || 'null') as T; }
async function until<T>(read: () => Promise<T | false> | T | false, description: string, milliseconds = 30_000): Promise<T> {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    const result = await read(); if (result !== false) return result;
    assert.ok(Date.now() < deadline, `${description}: timeout`); await delay(150);
  }
}
function noLinks(file: string) {
  assert.ok(path.isAbsolute(file), `absolute path required: ${file}`);
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    if (fs.existsSync(current)) assert.equal(fs.lstatSync(current).isSymbolicLink(), false, `reparse path refused: ${current}`);
    if (path.dirname(current) === current) break;
  }
}
function knownFolders(): { local: string; roaming: string } {
  return json(powershell("@{local=[Environment]::GetFolderPath('LocalApplicationData');roaming=[Environment]::GetFolderPath('ApplicationData')} | ConvertTo-Json -Compress"));
}
function validateManifest(file: string): { manifest: TrialInstalledManifest; folders: ReturnType<typeof knownFolders> } {
  noLinks(file);
  const value = json<TrialInstalledManifest>(fs.readFileSync(file, 'utf8'));
  assert.equal(value.version, 1); assert.equal(value.kind, 'papeer-shared-trial-installed'); assert.equal(value.installed, true);
  assert.equal(value.identity, IDENTITY); assert.match(value.productName, /trial/i);
  assert.ok(samePath(value.installRoot, EXPECTED_INSTALL)); assert.ok(samePath(value.runtime.root, EXPECTED_RUNTIME));
  const folders = knownFolders(), local = path.join(folders.local, IDENTITY), roaming = path.join(folders.roaming, IDENTITY);
  assert.equal(powershell("([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"), 'False', 'launch trial harness without elevation so WebView debugging environment is honored');
  for (const name of ['executable', 'sidecar'] as const) {
    const item = value[name]; noLinks(item.path); assert.ok(isInside(item.path, value.installRoot));
    assert.match(item.sha256, /^[0-9a-f]{64}$/); assert.equal(hashFile(item.path), item.sha256);
  }
  assert.ok(/trial/i.test(path.basename(value.executable.path)), 'must launch the trial executable, never normal papeer.exe');
  assert.ok(isInside(value.sidecar.path, path.join(value.installRoot, 'sidecar')));
  for (const name of ['library', 'device', 'markerPath'] as const) {
    noLinks(value.runtime[name]); assert.ok(isInside(value.runtime[name], value.runtime.root));
  }
  assert.ok(isInside(value.runtime.webview, local)); assert.ok(isInside(value.runtime.windowState, roaming));
  for (const item of [value.installRoot, value.runtime.root, value.runtime.webview, value.runtime.windowState]) noLinks(item);
  assert.match(value.runtime.markerSha256, /^[0-9a-f]{64}$/);
  assert.equal(hashFile(value.runtime.markerPath), value.runtime.markerSha256);
  // A machine/user policy can override the normal identifier-derived WebView directory.
  const overrides = json<string[]>(powershell(`$found=@(); foreach($base in @('HKCU:\\Software\\Policies\\Microsoft\\Edge\\WebView2','HKLM:\\Software\\Policies\\Microsoft\\Edge\\WebView2','HKCU:\\Software\\Policies\\Microsoft\\EmbeddedBrowserWebView\\LoaderOverride','HKLM:\\Software\\Policies\\Microsoft\\EmbeddedBrowserWebView\\LoaderOverride')) { if(Test-Path -LiteralPath $base) { $found += $base } }; ConvertTo-Json -InputObject @($found) -Compress`));
  assert.deepEqual(overrides, [], 'review existing WebView policy overrides before launching trial');
  return { manifest: value, folders };
}
function processes(manifest: TrialInstalledManifest, appPid?: number): Process[] {
  return json<Process[]>(powershell(`$install=${quote(manifest.installRoot)}; $profile=${quote(manifest.runtime.webview)}; $app=${appPid ?? 0};
  @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and ( ($app -gt 0 -and $_.ProcessId -eq $app) -or ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($install+'\\',[StringComparison]::OrdinalIgnoreCase)) -or ($_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf($profile,[StringComparison]::OrdinalIgnoreCase) -ge 0)) } |
  ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;name=$_.Name;executable=$_.ExecutablePath;created=$_.CreationDate.ToUniversalTime().ToString('o');commandLine=$_.CommandLine} }) | ConvertTo-Json -Compress -Depth 3`)) ?? [];
}
function arrayProcesses(value: Process[] | Process): Process[] { return Array.isArray(value) ? value : [value]; }
function ownedTree(rows: Process[], owner: Process, manifest: TrialInstalledManifest): Process[] {
  const result = new Map<number, Process>([[owner.pid, owner]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (!result.has(row.pid) && result.has(row.parent) && row.created >= owner.created) {
      const browser = row.name.toLowerCase() === 'msedgewebview2.exe';
      assert.ok(browser || samePath(row.executable, manifest.sidecar.path), 'unexpected trial descendant executable');
      result.set(row.pid, row); changed = true;
    }
  }
  return [...result.values()];
}
function normalRoots(folders: ReturnType<typeof knownFolders>): string[] {
  const roots = [path.join(folders.local, 'Papeer'), path.join(folders.local, 'PaperDesk'),
    path.join(folders.local, 'PapeerSync'), path.join(folders.local, 'local.paperdesk'), path.join(folders.roaming, 'local.paperdesk')];
  const setting = path.join(folders.local, 'PapeerSync/storage-location.json');
  if (fs.existsSync(setting)) {
    noLinks(setting); const selected = json<{ path?: unknown; pending?: { source?: unknown; destination?: unknown } }>(fs.readFileSync(setting, 'utf8'));
    assert.ok(typeof selected.path === 'string' && path.isAbsolute(selected.path), 'normal storage selection unreadable'); roots.push(selected.path);
    if (selected.pending !== undefined) for (const name of ['source', 'destination'] as const) {
      const value: unknown = selected.pending?.[name]; assert.ok(typeof value === 'string' && path.isAbsolute(value), 'normal pending storage selection unreadable'); roots.push(value);
    }
  }
  for (const library of roots.slice(0, 2).concat(roots.slice(5))) {
    roots.push(path.join(path.dirname(library), '.' + path.basename(library) + '-shared-app'));
    roots.push(path.join(path.dirname(library), '.' + path.basename(library) + '-shared-app-backups'));
  }
  return [...new Set(roots.map(value => path.resolve(value)))].sort();
}
function actualSpelling(file: string): string {
  let ancestor = path.resolve(file); const suffix: string[] = [];
  while (!fs.existsSync(ancestor)) {
    suffix.unshift(path.basename(ancestor)); const parent = path.dirname(ancestor); assert.notEqual(parent, ancestor); ancestor = parent;
  }
  return path.join(fs.realpathSync.native(ancestor), ...suffix);
}
function observe(roots: string[], volatileRoots: readonly string[]): Snapshot {
  const entries: Metadata[] = [];
  const scan = (file: string) => {
    if (!fs.existsSync(file)) { entries.push([file, -1, 0, false]); return; }
    const info = fs.lstatSync(file); assert.ok(entries.length < 200_000, 'normal-folder metadata bound exceeded');
    entries.push([file, info.size, info.mtimeMs, info.isSymbolicLink()]);
    if (info.isDirectory() && !info.isSymbolicLink()) for (const name of fs.readdirSync(file).sort()) scan(path.join(file, name));
  };
  roots.forEach(scan);
  // Only the fixed regular HTTP/GPU/shader cache subtrees are volatile. Reparse entries remain protected.
  const isVolatile = (row: Metadata) => !row[3] && volatileRoots.some(root => isInside(row[0], root));
  const volatile = entries.filter(isVolatile);
  const protectedEntries = entries.filter(row => !isVolatile(row));
  return { roots, files: entries.length, sha256: digest(JSON.stringify(entries)), entries,
    protectedSha256: digest(JSON.stringify(protectedEntries)), protectedFiles: protectedEntries.length,
    volatileSha256: digest(JSON.stringify(volatile)), volatileFiles: volatile.length };
}
function environment(cdp: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    const upper = name.toUpperCase();
    if (/^(PAPEER_|PAPERDESK_|WEBVIEW2_|VITE_PAPEER|VITE_PAPERDESK)/.test(upper) || upper.endsWith('_API_KEY') ||
        ['VIRTUAL_ENV', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PATH'].includes(upper)) continue;
    env[name] = value;
  }
  env.Path = pathWithoutAiClis(process.env.Path ?? process.env.PATH ?? '');
  env.PAPEER_SHARED_TRIAL_CDP_PORT = String(cdp);
  return env;
}

/** Owns only a manifest-pinned installed trial. Data/profile are kept for review, never deleted. */
export class InstalledTrial {
  readonly manifestFile: string;
  readonly manifest: TrialInstalledManifest;
  readonly resultDirectory: string;
  readonly evidence: Record<string, unknown> = { launches: [], cleanup: [], ownedProfileChecks: [], browserObservations: [] };
  private readonly normal: Snapshot;
  private readonly volatileCaches: readonly string[];
  private ownedProfileVerified = false;
  private launchAttempt = 0;
  private readonly harnessSources: { path: string; sha256: string }[];
  private current?: Launch;
  private owner?: Process;
  private spawned?: { pid: number; earliest: number };
  private readonly proven = new Map<number, Process>();
  private finishing?: Promise<void>;
  private ending = false;
  constructor(manifestFile: string, results: string, scenario = 'frontend/e2e/tests/trial/installedRelease.test.ts') {
    assert.ok(/^frontend\/e2e\/tests\/trial\/[a-zA-Z0-9.-]+\.test\.ts$/.test(scenario), 'trial scenario must be an explicit source file');
    this.harnessSources = ['frontend/e2e/lib/trialRelease.ts', scenario]
      .map(name => ({ path: path.join(REPO, name), sha256: hashFile(path.join(REPO, name)) }));
    this.manifestFile = manifestFile;
    const { manifest, folders } = validateManifest(manifestFile); this.manifest = manifest;
    this.resultDirectory = path.resolve(results);
    assert.ok(isInside(this.resultDirectory, path.join(REPO, 'checkpoints')), 'results must remain in checkpoints'); noLinks(this.resultDirectory);
    assert.equal(fs.existsSync(this.resultDirectory), false, 'use a new evidence directory'); fs.mkdirSync(this.resultDirectory, { recursive: true });
    this.volatileCaches = ['Default/Cache/Cache_Data', 'Default/DawnGraphiteCache', 'Default/DawnWebGPUCache',
      'Default/GPUCache', 'GrShaderCache', 'ShaderCache'].map(relative => path.join(folders.local, 'local.paperdesk/EBWebView', relative));
    this.volatileCaches.forEach(noLinks);
    this.normal = observe(normalRoots(folders), this.volatileCaches);
    for (const normal of this.normal.roots) for (const trial of [manifest.installRoot, manifest.runtime.root, manifest.runtime.webview, manifest.runtime.windowState]) {
      const actual = actualSpelling(normal);
      assert.ok(!isInside(trial, actual) && !isInside(actual, trial), 'trial path intersects existing normal library/device/profile selection');
    }
    Object.assign(this.evidence, { manifest: path.resolve(manifestFile), manifestSha256: hashFile(manifestFile), normalBefore: this.summary(this.normal),
      executable: manifest.executable, sidecar: manifest.sidecar, installed: true, runtime: manifest.runtime, harnessSources: this.harnessSources });
    this.evidence.normalMonitoringPolicy = { protected: 'Native libraries, canonical siblings, device/settings, window state and all browser state including IDB/localStorage; only the six exact regular HTTP/GPU/shader cache subtrees below are separated',
      volatileRoots: this.volatileCaches, reason: 'r3 HTTP data_0/data_1 and r4 five additional GPU/shader data_1 mtime writes came from the running ordinary WebView caches; these regenerable caches are recorded separately rather than classified as user-data change',
      prerequisite: 'Volatile changes are accepted only after an actual owned trial WebView profile and CDP listener have been verified; all metadata remains strict before that point',
      baselineEvidence: ['installed-release-run-r3.json: two HTTP cache files changed, other 26025 metadata entries unchanged',
        'installed-release-run-r4.json: those two HTTP entries plus one data_1 entry in each of the five named GPU/shader directories changed; other 26020 entries unchanged'],
      externalWriterFreezeClaimed: false, reparseEntriesProtected: true };
    fs.writeFileSync(path.join(this.resultDirectory, 'started.json'), JSON.stringify(this.evidence, null, 2) + '\n', { flag: 'wx' });
  }
  private summary(value: Snapshot) { const { entries: _entries, ...summary } = value; return summary; }
  private unchanged() {
    const after = observe(this.normal.roots, this.volatileCaches);
    if (after.sha256 !== this.normal.sha256) {
      const before = new Map(this.normal.entries.map(row => [row[0], row]));
      const current = new Map(after.entries.map(row => [row[0], row]));
      const changed = [...new Set([...before.keys(), ...current.keys()])].sort().filter(name => JSON.stringify(before.get(name)) !== JSON.stringify(current.get(name)))
        .map(name => ({ path: name, before: before.get(name) ?? null, after: current.get(name) ?? null }));
      this.evidence.normalMetadataChanges = changed;
      const isVolatile = (row: typeof changed[number]) => this.volatileCaches.some(root => isInside(row.path, root)) && !row.before?.[3] && !row.after?.[3];
      this.evidence.normalVolatileCacheChanges = changed.filter(isVolatile);
      this.evidence.normalProtectedMetadataChanges = changed.filter(row => !isVolatile(row));
    }
    const field = this.ownedProfileVerified ? 'protectedSha256' : 'sha256';
    assert.equal(after[field], this.normal[field], 'normal protected Papeer metadata changed (changed paths recorded in result.json)');
  }
  private remember(rows: Process[]) { for (const row of rows) this.proven.set(row.pid, row); return rows; }
  async launch(): Promise<Page> {
    assert.equal(this.ending, false, 'trial cleanup already started');
    assert.equal(this.current, undefined); this.unchanged(); validateManifest(this.manifestFile);
    const existing = arrayProcesses(processes(this.manifest)); assert.equal(existing.length, 0, 'trial processes already running');
    const cdp = await freePort(); assert.equal(await isListening(cdp), false);
    assert.equal(this.ending, false, 'trial cleanup already started');
    const earliest = Date.now();
    const child = spawn(this.manifest.executable.path, [], { cwd: this.manifest.installRoot, env: environment(cdp), windowsHide: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    const pid = child.pid; assert.ok(pid, 'installed trial could not be started');
    const attempt = ++this.launchAttempt;
    this.spawned = { pid, earliest };
    let owner: Process | undefined, browser: Browser | undefined;
    try {
      owner = await until(() => {
        assert.equal(child.exitCode, null, 'trial exited before readiness');
        return arrayProcesses(processes(this.manifest, pid)).find(row => row.pid === pid) ?? false;
      }, 'trial process identity');
      assert.ok(samePath(owner.executable, this.manifest.executable.path));
      assert.equal(owner.parent, process.pid, 'trial owner must be the process spawned by this harness');
      this.owner = owner; this.remember([owner]);
      assert.equal(this.ending, false, 'trial cleanup started during launch');
      const observed = await until(() => {
        const rows = this.remember(ownedTree(arrayProcesses(processes(this.manifest, pid)), owner!, this.manifest));
        const browsers = rows.filter(row => row.name.toLowerCase() === 'msedgewebview2.exe' && userDataDir(row.commandLine));
        if (!browsers.length) return false;
        for (const row of browsers) assert.ok(isInside(userDataDir(row.commandLine)!, this.manifest.runtime.webview), 'WebView escaped trial profile');
        return { rows, profile: userDataDir(browsers[0].commandLine)! };
      }, 'owned WebView profile', 45_000);
      await until(async () => await isListening(cdp), 'trial CDP port', 45_000);
      assert.equal(this.ending, false, 'trial cleanup started during WebView readiness');
      const listeners = json<number[]>(powershell(`ConvertTo-Json -InputObject @((Get-NetTCPConnection -State Listen -LocalPort ${cdp} -ErrorAction Stop).OwningProcess | Select-Object -Unique) -Compress`));
      assert.ok(listeners.length > 0 && listeners.every(pid => this.proven.get(pid)?.name.toLowerCase() === 'msedgewebview2.exe'), 'CDP listener is not an observed owned WebView');
      this.ownedProfileVerified = true;
      (this.evidence.ownedProfileChecks as unknown[]).push({ attempt, appPid: pid, profile: observed.profile, cdpListenerOwned: true });
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdp}`, { timeout: 15_000 });
      this.observeBrowser(browser, attempt);
      const page = await until(() => browser!.contexts().flatMap(context => context.pages())
        .find(candidate => /^https?:\/\/tauri\.localhost(?:\/|$)|^tauri:\/\/localhost(?:\/|$)/.test(candidate.url())) ?? false, 'built release page');
      page.setDefaultTimeout(30_000);
      await page.waitForFunction(() => {
        const host = window as unknown as { __PAPEER_PORT?: unknown; __PAPEER_TOKEN?: unknown };
        return Number.isSafeInteger(host.__PAPEER_PORT) && typeof host.__PAPEER_TOKEN === 'string' && host.__PAPEER_TOKEN.length === 64;
      });
      const backend = await page.evaluate(() => {
        const host = window as unknown as { __PAPEER_PORT: number; __PAPEER_TOKEN: string };
        return { port: host.__PAPEER_PORT, token: host.__PAPEER_TOKEN };
      });
      const response = await fetch(`http://127.0.0.1:${backend.port}/api/instance`, { headers: { Authorization: 'Bearer ' + backend.token } });
      assert.equal(response.status, 200);
      const instance = await response.json() as { pid: number; port: number; launcher: string; data_dir: string };
      const rows = this.remember(ownedTree(arrayProcesses(processes(this.manifest, pid)), owner, this.manifest));
      const sidecar = rows.find(row => row.pid === instance.pid); assert.ok(sidecar);
      assert.ok(samePath(sidecar.executable, this.manifest.sidecar.path));
      assert.equal(instance.launcher, 'app'); assert.equal(instance.port, backend.port); assert.ok(samePath(instance.data_dir, this.manifest.runtime.library));
      const discovery = path.join(this.manifest.runtime.device, 'instances', digest(path.resolve(this.manifest.runtime.library).toLowerCase()) + '.json');
      noLinks(discovery);
      const record = json<{ pid: number; port: number; token: string; data_dir: string }>(fs.readFileSync(discovery, 'utf8'));
      assert.equal(record.pid, sidecar.pid); assert.equal(record.port, backend.port); assert.equal(record.token, backend.token);
      assert.ok(samePath(record.data_dir, this.manifest.runtime.library));
      assert.equal(this.ending, false, 'trial cleanup started during backend readiness');
      this.unchanged();
      this.current = { child, owner, processes: rows, browser, page, port: backend.port, cdp, profile: observed.profile };
      (this.evidence.launches as unknown[]).push({ appPid: pid, sidecarPid: sidecar.pid, port: backend.port, cdpPort: cdp,
        appCreated: owner.created, profile: observed.profile, url: page.url(), packagedSidecar: sidecar.executable, dataDirectory: instance.data_dir,
        deviceDiscovery: discovery, deviceDiscoveryIdentityMatched: true, cdpListenerOwned: true });
      return page;
    } catch (error) {
      if (browser) try { await this.captureBrowserFailure(browser, attempt, error); }
      catch (failure) { this.evidence.browserDiagnosticFailure = this.safeDiagnostic(String(failure)); }
      if (owner) await this.forceOwned(owner);
      else if (arrayProcesses(processes(this.manifest, pid)).length) throw new Error(`trial launch failed before process ownership could be proven; manual review required: ${String(error)}`);
      // CDP Browser.close would close the actual browser; owned OS cleanup already handles it.
      throw error;
    }
  }
  private safeDiagnostic(value: string): string {
    return value.replace(/[a-f0-9]{64}/gi, '<redacted-64hex>').replace(/([?&](?:token|key|secret|authorization)=)[^&#\s]*/gi, '$1<redacted>').slice(0, 2500);
  }
  private diagnosticUrl(value: string): string {
    try { const url = new URL(value); const base = url.origin === 'null' ? value.split(/[?#]/)[0] : url.origin + url.pathname;
      return this.safeDiagnostic(base + (url.search ? '?<query omitted>' : '') + (url.hash ? '#<fragment omitted>' : '')); }
    catch { return this.safeDiagnostic(value); }
  }
  private observeBrowser(browser: Browser, attempt: number) {
    const events: unknown[] = [], attached = new WeakSet<Page>();
    (this.evidence.browserObservations as unknown[]).push({ attempt, events, limit: 250, requestBodiesAndHeadersCaptured: false });
    const add = (value: Record<string, unknown>) => { if (events.length < 250) events.push({ at: new Date().toISOString(), ...value }); };
    const attach = (page: Page) => {
      if (attached.has(page)) return; attached.add(page);
      add({ kind: 'page', url: this.diagnosticUrl(page.url()) });
      page.on('console', message => add({ kind: 'console', type: message.type(), text: this.safeDiagnostic(message.text()) }));
      page.on('pageerror', error => add({ kind: 'pageerror', text: this.safeDiagnostic(String(error)) }));
      page.on('requestfailed', request => add({ kind: 'requestfailed', method: request.method(), url: this.diagnosticUrl(request.url()), error: this.safeDiagnostic(request.failure()?.errorText ?? '') }));
      page.on('response', response => { if (response.status() >= 400) add({ kind: 'http-error', status: response.status(), url: this.diagnosticUrl(response.url()) }); });
      page.on('framenavigated', frame => { if (frame === page.mainFrame()) add({ kind: 'navigation', url: this.diagnosticUrl(frame.url()) }); });
    };
    for (const context of browser.contexts()) { context.on('page', attach); context.pages().forEach(attach); }
  }
  private async captureBrowserFailure(browser: Browser, attempt: number, error: unknown) {
    const contexts = browser.contexts(), pages: unknown[] = [];
    this.evidence.browserFailure = { attempt, error: this.safeDiagnostic(String(error)), contextCount: contexts.length,
      contexts: contexts.map((context, index) => ({ index, pageCount: context.pages().length, urls: context.pages().map(page => this.diagnosticUrl(page.url())) })), pages };
    for (const [index, page] of contexts.flatMap(context => context.pages()).slice(0, 4).entries()) {
      const detail: Record<string, unknown> = { index, url: this.diagnosticUrl(page.url()), closed: page.isClosed() }; pages.push(detail);
      try { detail.title = this.safeDiagnostic(await Promise.race([page.title(), delay(2000).then(() => '<title timeout>')])); }
      catch (failure) { detail.titleError = this.safeDiagnostic(String(failure)); }
      try { detail.startup = await page.evaluate(() => ({ state: document.getElementById('root')?.dataset.startupState,
        text: document.body.innerText.slice(0, 4000) })); }
      catch (failure) { detail.startupError = this.safeDiagnostic(String(failure)); }
      const screenshot = path.join(this.resultDirectory, `launch-${attempt}-failure-page-${index}.png`);
      try { await page.screenshot({ path: screenshot, timeout: 5000 }); detail.screenshot = screenshot; }
      catch (failure) { detail.screenshotError = this.safeDiagnostic(String(failure)); }
    }
  }
  private async forceOwned(owner: Process) {
    const current = arrayProcesses(processes(this.manifest, owner.pid));
    const live = current.find(row => row.pid === owner.pid && row.created === owner.created && samePath(row.executable, owner.executable));
    if (live) this.remember(ownedTree(current, live, this.manifest));
    // Revalidate identity immediately before each PID-only kill. Never kill an unobserved process tree.
    const rows = [...this.proven.values()].sort((left, right) => Number(right.pid === owner.pid) - Number(left.pid === owner.pid));
    for (const proven of rows) {
      const actual = arrayProcesses(processes(this.manifest, proven.pid)).find(row => row.pid === proven.pid && row.created === proven.created && samePath(row.executable, proven.executable));
      if (!actual) continue;
      spawnSync('taskkill', ['/PID', String(actual.pid), '/F'], { encoding: 'utf8', windowsHide: true });
    }
    await until(() => arrayProcesses(processes(this.manifest)).length === 0, 'owned trial cleanup', 45_000);
    (this.evidence.cleanup as unknown[]).push({ forced: true, appPid: owner.pid, observedOwnedPids: rows.map(row => row.pid) });
    this.owner = undefined; this.spawned = undefined; this.proven.clear();
  }
  async coldRestart(): Promise<Page> {
    assert.ok(this.current); const previous = this.current;
    await this.forceOwned(previous.owner); this.current = undefined; this.unchanged();
    assert.equal(await isListening(previous.port), false, 'packaged sidecar port survived cold stop');
    return this.launch();
  }
  async closeNormally(): Promise<void> {
    assert.ok(this.current); const launch = this.current;
    // WM_CLOSE only. The production frontend must decide when it is safe to exit.
    powershell(`Add-Type -Namespace Trial -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'; $p=Get-Process -Id ${launch.owner.pid}; if($p.MainWindowHandle -eq 0){throw 'trial main window unavailable'}; if(-not [Trial.Native]::PostMessage($p.MainWindowHandle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'WM_CLOSE failed'}`);
    await until(async () => arrayProcesses(processes(this.manifest)).length === 0 && !await isListening(launch.port), 'natural release app/sidecar shutdown', 45_000);
    this.current = undefined; this.owner = undefined; this.spawned = undefined; this.proven.clear(); this.unchanged();
    this.evidence.normalClose = { observedBeforeCleanup: true, appAndPackagedSidecarGone: true, sidecarPortClosed: true };
  }
  finish(passed: boolean, failure?: unknown): Promise<void> {
    this.ending = true;
    return this.finishing ??= this.finishOnce(passed, failure);
  }
  private async finishOnce(passed: boolean, failure?: unknown) {
    const errors: string[] = [];
    let normalUnchanged = false, normalAfter: Omit<Snapshot, 'entries'> | null = null;
    if (!passed && this.current) {
      try { await this.captureBrowserFailure(this.current.browser, this.launchAttempt, failure); }
      catch (error) { this.evidence.browserDiagnosticFailure = this.safeDiagnostic(String(error)); }
    }
    try {
      if (!this.owner && this.spawned) {
        const spawned = this.spawned;
        const actual = arrayProcesses(processes(this.manifest, spawned.pid)).find(row => row.pid === spawned.pid && row.parent === process.pid &&
          samePath(row.executable, this.manifest.executable.path) && Date.parse(row.created) >= spawned.earliest - 1000);
        if (actual) { this.owner = actual; this.remember([actual]); }
      }
      if (this.owner) await this.forceOwned(this.owner);
      assert.equal(arrayProcesses(processes(this.manifest)).length, 0, 'unowned or residual trial processes remain');
    } catch (error) { errors.push(String(error)); }
    this.current = undefined;
    try { this.unchanged(); normalUnchanged = true; normalAfter = this.summary(observe(this.normal.roots, this.volatileCaches)); } catch (error) { errors.push(String(error)); }
    try { validateManifest(this.manifestFile); this.evidence.pinnedArtifactsUnchanged = true; } catch (error) { errors.push(String(error)); }
    try { for (const item of this.harnessSources) assert.equal(hashFile(item.path), item.sha256); this.evidence.harnessSourcesUnchanged = true; } catch (error) { errors.push(String(error)); }
    const result = { ...this.evidence, passed: passed && errors.length === 0, failure: failure === undefined ? null : String(failure),
      cleanupSucceeded: errors.length === 0, cleanupErrors: errors, normalAfter,
      dataPreserved: true, installPreserved: true, normalPapeerUnchanged: normalUnchanged, normalPapeerUnchangedScope: 'protected metadata; six fixed ordinary HTTP/GPU/shader cache subtrees are separate',
      normalAllMetadataUnchanged: normalAfter?.sha256 === this.normal.sha256, normalProtectedMetadataUnchanged: normalUnchanged };
    fs.writeFileSync(path.join(this.resultDirectory, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    assert.deepEqual(errors, [], 'trial cleanup or normal metadata verification failed; see result.json');
  }
}

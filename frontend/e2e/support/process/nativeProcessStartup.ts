import type { ChildProcess } from 'node:child_process';

type StartupOptions = {
  mode: 'initial' | 'resume';
  generation: number;
  redactions: readonly string[];
};

const STARTUP_DEADLINE_MS = 20_000;
const RAW_TAIL_BYTES = 16_384;
const FIRST_LINE_BYTES = 4_096;

/** Fixture diagnostics only: retain counts and bounded, credential/path-redacted output. */
function safeTail(bytes: Buffer, truncated: boolean, redactions: readonly string[]): string {
  let text = bytes.toString('utf8');
  // A truncated first line could contain only a fragment of a known secret or path.
  if (truncated) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '[truncated line]';
  for (const value of [...redactions].filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(value).join('[fixture-value]');
    text = text.split(value.split('\\').join('/')).join('[fixture-value]');
    text = text.split(value.split('\\').join('\\\\')).join('[fixture-value]');
  }
  return text
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [credential]')
    .replace(/\b(?:https?|file):\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/\bFile\s+["'][^"'\r\n]+["']/g, 'File [path]')
    .replace(/\b[A-Z]:[\\/][^\r\n"'<>]*/gi, '[path]')
    .replace(/(?:^|[\s("'])\/(?:[^\s"'<>]+\/?)+/gm, ' [path]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]')
    .replace(/\b[A-Za-z0-9_+/=-]{32,}\b/g, '[opaque]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '?')
    .slice(-1_024);
}

/** Await the existing first-line port protocol; no retry, process termination or health probe. */
export function waitForNativeProcessPort(launched: ChildProcess, options: StartupOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false, stdoutBytes = 0, stderrBytes = 0;
    let stdoutTail: Buffer = Buffer.alloc(0), stderrTail: Buffer = Buffer.alloc(0), firstLine: Buffer = Buffer.alloc(0);
    let sawFirstLine = false;
    let cause: 'process-exit' | 'spawn-error' | 'malformed-port-line' | 'startup-timeout' | undefined;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let spawnErrorCode: string | null = null;
    const clean = () => {
      clearTimeout(timer);
      launched.stdout?.off('data', onStdout);
      launched.stderr?.off('data', onStderr);
      launched.off('exit', onExit);
      launched.off('close', onClose);
      // Keep this inert after settlement: a late child 'error' must not become unhandled.
    };
    const fail = (finalizedBy: 'close' | 'deadline', closed: typeof exited) => {
      if (settled) return;
      settled = true;
      clean();
      const evidence = {
        mode: options.mode, generation: options.generation, finalizedBy,
        cause: cause ?? 'startup-timeout', exited, closed, spawnErrorCode,
        stdoutBytes, stderrBytes,
        stdoutTail: safeTail(stdoutTail, stdoutBytes > stdoutTail.length, options.redactions),
        stderrTail: safeTail(stderrTail, stderrBytes > stderrTail.length, options.redactions),
      };
      const error = new Error(`Native fixture startup failed: ${JSON.stringify(evidence)}`);
      // No helper/source path in the diagnostic payload or this error's own stack.
      error.stack = `${error.name}: ${error.message}`;
      reject(error);
    };
    const append = (tail: Buffer, chunk: Buffer) => Buffer.concat([tail, chunk.subarray(-RAW_TAIL_BYTES)]).subarray(-RAW_TAIL_BYTES);
    const onStdout = (value: Buffer | string) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      stdoutBytes += chunk.length; stdoutTail = append(stdoutTail, chunk);
      if (sawFirstLine || cause) return;
      const newline = chunk.indexOf(10), piece = newline < 0 ? chunk : chunk.subarray(0, newline);
      if (firstLine.length + piece.length > FIRST_LINE_BYTES) { cause = 'malformed-port-line'; return; }
      firstLine = Buffer.concat([firstLine, piece]);
      if (newline < 0) return;
      sawFirstLine = true;
      try {
        const record: unknown = JSON.parse(firstLine.toString('utf8'));
        const port = record && typeof record === 'object' && 'port' in record ? record.port : undefined;
        if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
          cause = 'malformed-port-line'; return;
        }
        settled = true; clean(); resolve(port);
      } catch { cause = 'malformed-port-line'; }
    };
    const onStderr = (value: Buffer | string) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      stderrBytes += chunk.length; stderrTail = append(stderrTail, chunk);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      exited = { code, signal }; cause ??= 'process-exit';
      // 'exit' precedes final stdio drain; only 'close' or the same deadline rejects.
    };
    const onError = (error: Error & { code?: unknown }) => {
      if (settled) return;
      spawnErrorCode = typeof error.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'unclassified';
      cause ??= 'spawn-error';
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cause ??= 'process-exit'; fail('close', { code, signal });
    };
    const timer = setTimeout(() => { cause ??= 'startup-timeout'; fail('deadline', null); }, STARTUP_DEADLINE_MS);
    launched.stdout!.on('data', onStdout);
    launched.stderr!.on('data', onStderr);
    launched.on('error', onError);
    launched.on('exit', onExit);
    launched.on('close', onClose);
  });
}

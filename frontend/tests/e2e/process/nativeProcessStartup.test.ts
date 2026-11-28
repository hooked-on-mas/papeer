import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { test } from 'node:test';
import { waitForNativeProcessPort } from '../../../e2e/support/process/nativeProcessStartup.ts';

const child = () => Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
type FakeChild = ReturnType<typeof child>;
const options = { mode: 'initial' as const, generation: 1, redactions: ['fixture-private-token', 'C:\\private\\stage', 'fixture test secret'] };
const wait = (process: FakeChild, generation = 1) => waitForNativeProcessPort(process as unknown as ChildProcess, { ...options, generation });
const observe = (promise: Promise<number>) => promise.then(value => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
const evidence = (error: unknown): Record<string, unknown> => {
  assert.ok(error instanceof Error);
  assert.ok(error.message.startsWith('Native fixture startup failed: '));
  return JSON.parse(error.message.slice('Native fixture startup failed: '.length)) as Record<string, unknown>;
};

test('Native startup accepts the existing fragmented first-line port protocol once', async () => {
  const process = child(), outcome = observe(wait(process));
  process.stdout.emit('data', Buffer.from('{"po')); process.stdout.emit('data', Buffer.from('rt":4321}\n'));
  assert.equal((await outcome).value, 4321);
  process.emit('error', new Error('late ignored error')); process.emit('exit', 2, null); process.emit('close', 2, null);
});

test('Native startup waits for close after exit and retains final drained stderr and exit identity', async () => {
  const process = child(); let settled = false;
  const outcome = observe(wait(process)).then(value => { settled = true; return value; });
  process.stderr.emit('data', Buffer.from('before\n')); process.emit('exit', 7, null);
  await Promise.resolve(); await Promise.resolve(); assert.equal(settled, false);
  process.stderr.emit('data', Buffer.from('final traceback\n')); process.stdout.emit('data', Buffer.from('late output\n'));
  process.emit('close', 7, null);
  const actual = evidence((await outcome).error);
  assert.deepEqual(actual.exited, { code: 7, signal: null }); assert.deepEqual(actual.closed, { code: 7, signal: null });
  assert.equal(actual.finalizedBy, 'close'); assert.equal(actual.cause, 'process-exit');
  assert.equal(actual.stderrBytes, Buffer.byteLength('before\nfinal traceback\n')); assert.equal(actual.stdoutBytes, 12);
  assert.match(String(actual.stderrTail), /final traceback/);
});

test('Native startup malformed first line is a bounded rejection rather than an event callback throw', async () => {
  const process = child(), outcome = observe(wait(process));
  assert.doesNotThrow(() => process.stdout.emit('data', Buffer.from('not json\n')));
  process.stdout.emit('data', Buffer.from('{"port":4321}\n')); process.emit('exit', 1, null); process.emit('close', 1, null);
  assert.equal(evidence((await outcome).error).cause, 'malformed-port-line');
});

test('Native startup rejects malformed or oversized port records without accepting a later line', async () => {
  for (const line of ['{"port":0}', '{"port":65536}', '{"port":"4321"}', '{}', 'x'.repeat(4097)]) {
    const process = child(), outcome = observe(wait(process));
    assert.doesNotThrow(() => process.stdout.emit('data', Buffer.from(line + '\n{"port":4321}\n')));
    process.emit('close', 1, null);
    assert.equal(evidence((await outcome).error).cause, 'malformed-port-line');
  }
});

test('Native startup keeps the exact 20 second deadline and records incomplete stdio closure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const process = child(); let settled = false;
  const outcome = observe(wait(process)).then(value => { settled = true; return value; });
  t.mock.timers.tick(19_999); await Promise.resolve(); assert.equal(settled, false);
  t.mock.timers.tick(1);
  const actual = evidence((await outcome).error);
  assert.equal(actual.cause, 'startup-timeout'); assert.equal(actual.finalizedBy, 'deadline');
  assert.equal(actual.closed, null); assert.equal(actual.stdoutBytes, 0);
});

test('Native startup exit without close still fails at the original deadline with signal retained', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const process = child(), outcome = observe(wait(process));
  process.emit('exit', null, 'SIGTERM'); process.stderr.emit('data', Buffer.from('last line\n'));
  t.mock.timers.tick(20_000);
  const actual = evidence((await outcome).error);
  assert.equal(actual.finalizedBy, 'deadline'); assert.deepEqual(actual.exited, { code: null, signal: 'SIGTERM' });
  assert.equal(actual.closed, null); assert.equal(actual.cause, 'process-exit');
});

test('Native startup spawn failure retains only a bounded error code and drained output', async () => {
  const process = child(), outcome = observe(wait(process));
  process.emit('error', Object.assign(new Error('C:\\private\\stage credential fixture-private-token'), { code: 'ENOENT' }));
  process.stderr.emit('data', Buffer.from('final error\n')); process.emit('close', -4058, null);
  const result = await outcome, actual = evidence(result.error);
  assert.equal(actual.spawnErrorCode, 'ENOENT'); assert.equal(actual.cause, 'spawn-error');
  assert.equal(actual.stderrBytes, 12); assert.doesNotMatch(String(result.error), /fixture-private-token|private\\stage/);
});

test('Native startup diagnostics bound output and redact known fixtures, paths, URLs and bearer values', async () => {
  const process = child(), outcome = observe(wait(process));
  const text = 'x'.repeat(20_000) + '\nFile "C:\\private\\stage\\source.py", line 1\n' +
    'Bearer another-secret-value http://user:password@localhost/private fixture-private-token fixture test secret\n';
  process.emit('exit', 1, null); process.stderr.emit('data', Buffer.from(text)); process.emit('close', 1, null);
  const result = await outcome, actual = evidence(result.error);
  assert.equal(actual.stderrBytes, Buffer.byteLength(text)); assert.ok(String(actual.stderrTail).length <= 1024);
  assert.match(String(actual.stderrTail), /File \[path\]/);
  assert.doesNotMatch(String(result.error), /fixture-private-token|another-secret-value|user:password|source\.py|fixture test secret|C:\\/);
  assert.ok(result.error instanceof Error); assert.doesNotMatch(result.error.stack ?? '', /nativeProcessStartup\.ts/);
});

test('Native startup late data after exit cannot turn a failed launch into a successful port', async () => {
  const process = child(), outcome = observe(wait(process));
  process.emit('exit', 0, null); process.stdout.emit('data', Buffer.from('{"port":4321}\n')); process.emit('close', 0, null);
  assert.equal((await outcome).value, null); assert.equal(evidence((await outcome).error).cause, 'process-exit');
});

test('Native startup old child events cannot settle a new generation promise', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const old = child(), current = child(), first = observe(wait(old));
  t.mock.timers.tick(20_000); assert.equal(evidence((await first).error).generation, 1);
  let settled = false; const second = observe(wait(current, 2)).then(value => { settled = true; return value; });
  old.stdout.emit('data', Buffer.from('{"port":1111}\n')); old.stderr.emit('data', Buffer.from('late\n'));
  old.emit('error', new Error('late old failure')); old.emit('exit', 9, null); old.emit('close', 9, null);
  await Promise.resolve(); assert.equal(settled, false);
  current.stdout.emit('data', Buffer.from('{"port":2222}\n')); assert.equal((await second).value, 2222);
});

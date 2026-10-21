import assert from "node:assert/strict";
import { test } from "node:test";
import { installPdfStreamCompatibility } from "../src/features/reader/pdfStreamCompatibility.ts";

function legacyStream() {
  class Stream<T> extends ReadableStream<T> {}
  Object.defineProperty(Stream.prototype, Symbol.asyncIterator, { configurable: true, writable: true, value: undefined });
  installPdfStreamCompatibility(Stream);
  return Stream;
}

test("PDF text streams are iterable without a native async iterator and release their reader", async () => {
  const Stream = legacyStream();
  const stream = new Stream<string>({ start(controller) { controller.enqueue("原文"); controller.enqueue("日本語訳"); controller.close(); } });
  const chunks = [];
  for await (const value of stream) chunks.push(value);
  assert.deepEqual(chunks, ["原文", "日本語訳"]);
  assert.equal(stream.locked, false);
  const iterator = Reflect.get(Stream.prototype, Symbol.asyncIterator);
  installPdfStreamCompatibility(Stream);
  assert.equal(Reflect.get(Stream.prototype, Symbol.asyncIterator), iterator, "existing iterators are preserved");
  assert.equal(Object.getOwnPropertyDescriptor(Stream.prototype, Symbol.asyncIterator)?.enumerable, false);
});

test("leaving iteration cancels the text stream and releases the lock", async () => {
  const Stream = legacyStream();
  let cancelled = false;
  const stream = new Stream<string>({ start(controller) { controller.enqueue("text"); }, cancel() { cancelled = true; } });
  for await (const value of stream) { assert.equal(value, "text"); break; }
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test("preventCancel leaves remaining text available to a new reader", async () => {
  const Stream = legacyStream();
  let cancelled = false;
  const stream = new Stream<string>({
    start(controller) { controller.enqueue("first"); controller.enqueue("second"); controller.close(); },
    cancel() { cancelled = true; },
  });
  for await (const value of stream[Symbol.asyncIterator]({ preventCancel: true })) { assert.equal(value, "first"); break; }
  assert.equal(cancelled, false);
  assert.equal(stream.locked, false);
  const reader = stream.getReader();
  assert.deepEqual(await reader.read(), { done: false, value: "second" });
  reader.releaseLock();
});

test("text stream errors retain their reason and release the lock", async () => {
  const Stream = legacyStream();
  const reason = new Error("failed to extract PDF text");
  const stream = new Stream<string>({ start(controller) { controller.error(reason); } });
  await assert.rejects(async () => { for await (const value of stream) assert.fail(value); }, error => error === reason);
  assert.equal(stream.locked, false);
});

test("a native stream iterator is never replaced", () => {
  const iterator = ReadableStream.prototype[Symbol.asyncIterator];
  installPdfStreamCompatibility();
  assert.equal(ReadableStream.prototype[Symbol.asyncIterator], iterator);
});

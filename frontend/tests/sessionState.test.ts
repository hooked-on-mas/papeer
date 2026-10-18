import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionStateFor, type SessionState } from "../src/lib/useSessionState.ts";

const fresh = () => ({ edits: null as string[] | null });

test("the dialog's state stays while it is open for the same paper", () => {
  const state: SessionState<ReturnType<typeof fresh>> = { session: "p1", value: { edits: ["x"] } };
  assert.equal(sessionStateFor(state, "p1", fresh), state);
});

test("closing keeps the state for the closing animation, and opening again starts over", () => {
  const open: SessionState<ReturnType<typeof fresh>> = { session: "p1", value: { edits: ["x"] } };
  const closed = sessionStateFor(open, null, fresh);
  assert.deepEqual(closed, { session: null, value: { edits: ["x"] } });
  assert.equal(sessionStateFor(closed, null, fresh), closed);
  // The same paper again: the previous opening's edits are gone.
  assert.deepEqual(sessionStateFor(closed, "p1", fresh), { session: "p1", value: { edits: null } });
});

test("another paper while open starts over", () => {
  const open: SessionState<ReturnType<typeof fresh>> = { session: "p1", value: { edits: ["x"] } };
  assert.deepEqual(sessionStateFor(open, "p2", fresh), { session: "p2", value: { edits: null } });
});

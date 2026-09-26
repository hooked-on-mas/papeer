import assert from "node:assert/strict";
import { test } from "node:test";
import { canResumeShape, SHAPE_LIFT_GRACE_MS } from "../src/features/reader/inkInteraction.ts";

const lift = {
  kind: "rectangle" as const, pointerType: "pen", elapsed: 100,
  previous: [0.5, 0.5] as [number, number], next: [0.51, 0.51] as [number, number], width: 800, height: 1200,
};

test("a brief Pencil lift resumes each shape at the dragged end", () => {
  for (const kind of ["rectangle", "ellipse", "line", "arrow"] as const) {
    assert.equal(canResumeShape({ ...lift, kind }), true);
    assert.equal(canResumeShape({ ...lift, kind, elapsed: SHAPE_LIFT_GRACE_MS }), true);
  }
});

test("intentional new shapes and freehand strokes remain separate", () => {
  assert.equal(canResumeShape({ ...lift, elapsed: SHAPE_LIFT_GRACE_MS + 1 }), false);
  assert.equal(canResumeShape({ ...lift, next: [0.6, 0.5] }), false);
  for (const kind of ["pen", "highlighter", "text"] as const) assert.equal(canResumeShape({ ...lift, kind }), false);
  for (const pointerType of ["mouse", "touch"]) assert.equal(canResumeShape({ ...lift, pointerType }), false);
});

test("recontact tolerance uses displayed pixels along both page axes", () => {
  assert.equal(canResumeShape({ ...lift, next: [0.52, 0.5], width: 1000 }), true);
  assert.equal(canResumeShape({ ...lift, next: [0.52, 0.5], width: 2000 }), false);
  assert.equal(canResumeShape({ ...lift, next: [0.5, 0.52], height: 1000 }), true);
  assert.equal(canResumeShape({ ...lift, next: [0.5, 0.52], height: 2000 }), false);
});

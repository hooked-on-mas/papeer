import assert from "node:assert/strict";
import { test } from "node:test";
import { canResumeShape, inkChanged, mayEditSelectedShape, pressTarget, shapeToolTarget, SHAPE_LIFT_GRACE_MS } from "../src/features/reader/inkInteraction.ts";

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

test("a press acts on the selection when it lands in its frame, else on the writing under it", () => {
  const a = { id: "a", color: "#f00", width: 0.003, kind: "rectangle" as const, points: [[0.2, 0.2], [0.4, 0.2], [0.4, 0.4], [0.2, 0.4], [0.2, 0.2]] as [number, number][] };
  const b = { id: "b", color: "#f00", width: 0.003, kind: "line" as const, points: [[0.6, 0.6], [0.9, 0.6]] as [number, number][] };
  assert.deepEqual(pressTarget([a, b], ["a"], [0.3, 0.3], 1), ["a"]);
  assert.deepEqual(pressTarget([a, b], ["a"], [0.75, 0.605], 1), ["b"]);
  assert.deepEqual(pressTarget([a, b], [], [0.3, 0.2], 1), ["a"]);
  assert.equal(pressTarget([a, b], ["a"], [0.6, 0.9], 1), null);
});

test("a shape tool only edits the selected shape and can click another of the same kind", () => {
  const a = { id: "a", color: "#f00", width: 0.003, kind: "rectangle" as const,
    points: [[0.1, 0.1], [0.8, 0.1], [0.8, 0.8], [0.1, 0.8], [0.1, 0.1]] as [number, number][] };
  const b = { id: "b", color: "#f00", width: 0.003, kind: "rectangle" as const,
    points: [[0.3, 0.3], [0.5, 0.3], [0.5, 0.5], [0.3, 0.5], [0.3, 0.3]] as [number, number][] };
  const notSelected = shapeToolTarget([a, b], undefined, "rectangle", [0.4, 0.4], 0.01, 1);
  assert.equal(notSelected.selected, undefined);
  assert.equal(notSelected.hit, null);
  assert.equal(notSelected.clickTarget?.id, "b");
  const selected = shapeToolTarget([a, b], "b", "rectangle", [0.5, 0.5], 0.01, 1);
  assert.deepEqual(selected.hit, { part: "handle", index: 2 });
  assert.equal(mayEditSelectedShape(selected, false, false), true);
  assert.equal(mayEditSelectedShape(selected, true, false), false);
  const overlapping = shapeToolTarget([a, b], "a", "rectangle", [0.4, 0.4], 0.01, 1);
  assert.equal(mayEditSelectedShape(overlapping, false, false), false);
  assert.equal(mayEditSelectedShape(overlapping, false, true), true);
});

test("a geometric no-op does not produce an Undo step", () => {
  const stroke = { id: "line", color: "#f00", width: 0.003, kind: "line" as const,
    points: [[0.2, 0.3], [0.8, 0.3]] as [number, number][] };
  assert.equal(inkChanged([stroke], [{ ...stroke, points: stroke.points.map(([x, y]): [number, number] => [x, y + 1e-12]) }]), false);
  assert.equal(inkChanged([stroke], [{ ...stroke, points: [[0.2, 0.3], [0.7, 0.3]] }]), true);
});

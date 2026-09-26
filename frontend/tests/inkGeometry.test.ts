import assert from "node:assert/strict";
import { test } from "node:test";
import { boundsOf, eraseInk, fitInk, selectInk, shapePoints, snapRotation, textPoints, transformInk, type InkStroke } from "../src/features/reader/inkGeometry.ts";

const line: InkStroke = { id: "line", width: 0.003, color: "#ff0000", points: [[0.2, 0.3], [0.8, 0.3]] };
const near = (a: number, b: number) => assert(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test("rotation snaps near quarter turns and leaves other angles free", () => {
  const rad = (degrees: number) => degrees * Math.PI / 180;
  for (const target of [-180, -90, 0, 90, 180, 270, 360]) {
    near(snapRotation(rad(target + 4), [line], 1.5), rad(target));
    near(snapRotation(rad(target - 4), [line], 1.5), rad(target));
    near(snapRotation(rad(target + 7), [line], 1.5), rad(target + 7));
  }
});

test("previously rotated text and shapes snap to the page axes", () => {
  const rad = (degrees: number) => degrees * Math.PI / 180;
  for (const ratio of [0.7, 1.5]) {
    for (const kind of ["text", "rectangle", "ellipse", "arrow", "line"] as const) {
      const points = kind === "text" ? textPoints("Test", [0.3, 0.3], .03, ratio)
        : shapePoints(kind, [0.3, 0.3], [0.6, kind === "line" || kind === "arrow" ? 0.3 : 0.5], ratio);
      const tilted = transformInk([{ ...line, kind, points }], [0.4, 0.4], 1, rad(23), [0, 0], ratio);
      near(snapRotation(rad(64), tilted, ratio), rad(67));
      near(snapRotation(rad(-20), tilted, ratio), rad(-23));
      near(snapRotation(rad(50), tilted, ratio), rad(50));
    }
  }
});

test("rectangle and lasso enclose complete strokes without collecting neighbours", () => {
  const other: InkStroke = { ...line, id: "other", points: [[0.1, 0.2], [0.9, 0.2]] };
  assert.deepEqual(selectInk([line, other], [[0.15, 0.25], [0.85, 0.4]], true), ["line"]);
  assert.deepEqual(selectInk([line, other], [[0.15, 0.25], [0.85, 0.25], [0.85, 0.4], [0.15, 0.4]], false), ["line"]);
});

test("rotation uses physical page proportions and is reversible", () => {
  const rotated = transformInk([line], [0.5, 0.3], 1, Math.PI / 2, [0, 0], 2)[0];
  near(rotated.points[0][0], 0.5); near(rotated.points[0][1], 0.15);
  near(rotated.points[1][1], 0.45);
  const restored = transformInk([rotated], [0.5, 0.3], 1, -Math.PI / 2, [0, 0], 2)[0];
  restored.points.forEach((p, i) => p.forEach((v, j) => near(v, line.points[i][j])));
  assert.deepEqual(line.points, [[0.2, 0.3], [0.8, 0.3]]);
});

test("moving at page edge preserves the shape instead of clamping its points", () => {
  const moved = fitInk(transformInk([line], [0, 0], 1, 0, [0.5, 0.2], 1.5), 1.5);
  near(moved[0].points[0][0], 0.4); near(moved[0].points[1][0], 1);
  near(boundsOf(moved)!.width, 0.6);
  const fullWidth: InkStroke = { ...line, points: [[0, 0.3], [1, 0.3]] };
  assert.deepEqual(fitInk([fullWidth], 1.5)[0].points, fullWidth.points);
});

test("resizing scales pen widths and keeps an oversized selection on the page", () => {
  const scaled = fitInk(transformInk([line], [0.2, 0.3], 4, 0, [0, 0], 1.5), 1.5);
  const bounds = boundsOf(scaled)!;
  assert(bounds.width <= 1 && bounds.x >= 0 && bounds.x + bounds.width <= 1);
  assert(scaled[0].width > line.width);
});

test("partial eraser cuts long sparse strokes at circle boundaries", () => {
  const parts = eraseInk([line], [0.5, 0.3], 0.05, 1.5, true, false);
  assert.equal(parts.length, 2);
  near(parts[0].points[parts[0].points.length - 1][0], 0.4485);
  near(parts[1].points[0][0], 0.5515);
  assert.notEqual(parts[0].id, parts[1].id);
  assert.deepEqual(eraseInk([line], [0.5, 0.3], 0.05, 1.5, false, false), []);
  assert.deepEqual(line.points, [[0.2, 0.3], [0.8, 0.3]]);
});

test("highlighter-only erasing preserves pen strokes and typed text", () => {
  const highlighter: InkStroke = { ...line, id: "highlight", kind: "highlighter" };
  const text: InkStroke = { ...line, id: "text", kind: "text", text: "Test", points: textPoints("Test", [0.4, 0.28], 0.03, 1.5) };
  assert.deepEqual(eraseInk([line, highlighter, text], [0.5, 0.3], 0.1, 1.5, false, true).map(s => s.id), ["line", "text"]);
});

test("eraser removes a whole rotated text box, including partial-erase mode", () => {
  const text: InkStroke = { ...line, id: "text", kind: "text", text: "Test", points: textPoints("Test", [0.4, 0.4], 0.05, 1.5) };
  const rotated = transformInk([text], [0.4, 0.4], 1, Math.PI / 3, [0, 0], 1.5)[0];
  const center = rotated.points.reduce((sum, p) => [sum[0] + p[0] / 4, sum[1] + p[1] / 4] as [number, number], [0, 0] as [number, number]);
  for (const partial of [true, false]) {
    assert.deepEqual(eraseInk([rotated], center, 0.01, 1.5, partial, false), []);
    assert.deepEqual(eraseInk([rotated], [0.1, 0.1], 0.01, 1.5, partial, false), [rotated]);
    assert.deepEqual(eraseInk([rotated], center, 0.01, 1.5, partial, true), [rotated]);
  }
});

test("shape generation and text boxes support grouped transforms", () => {
  const box: InkStroke = { ...line, kind: "rectangle", points: shapePoints("rectangle", [0.6, 0.6], [0.2, 0.2], 1.5) };
  assert.deepEqual(box.points[0], [0.2, 0.2]);
  assert.deepEqual(box.points[box.points.length - 1], box.points[0]);
  assert.equal(shapePoints("ellipse", [0.2, 0.2], [0.6, 0.6], 1.5).length, 65);
  const text: InkStroke = { ...line, id: "text", kind: "text", text: "日本語\nabc", points: textPoints("日本語\nabc", [0.3, 0.3], 0.03, 1.5) };
  const result = transformInk([box, text], [0.4, 0.4], 1.2, Math.PI / 3, [0, 0], 1.5);
  assert.equal(result[1].text, text.text);
  const [a, b, c, d] = result[1].points;
  near(c[0], b[0] + d[0] - a[0]); near(c[1], b[1] + d[1] - a[1]);
});

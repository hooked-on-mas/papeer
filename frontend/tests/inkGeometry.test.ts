import assert from "node:assert/strict";
import { test } from "node:test";
import { boundsOf, constrainedShapeEnd, ellipseCenter, eraseInk, fitInk, hitShape, reshapeShape, selectInk, shapeHandleCursor, shapePoints, snapRotation, textPoints, transformInk, type InkStroke } from "../src/features/reader/inkGeometry.ts";

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

const shapeOf = (kind: "line" | "arrow" | "rectangle" | "ellipse", a: [number, number], b: [number, number], ratio: number): InkStroke =>
  ({ ...line, id: kind, kind, points: shapePoints(kind, a, b, ratio) });

test("arrow heads stay aligned at the page edge and recover their size away from it", () => {
  for (const ratio of [0.7, 1.5]) {
    const original = shapeOf("arrow", [0.2, 0.02], [0.8, 0.02], ratio);
    const edge = reshapeShape(original, { part: "handle", index: 1 }, original.points[1], [0.1, 0.005], ratio);
    assert.deepEqual(edge.points[0], original.points[0]);
    near(edge.points[1][0], 0.1); near(edge.points[1][1], 0.005);
    assert(edge.points.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1));
    const [a, b, left, , right] = edge.points;
    const axis = [b[0] - a[0], (b[1] - a[1]) * ratio];
    const head = [b[0] - (left[0] + right[0]) / 2, (b[1] - (left[1] + right[1]) / 2) * ratio];
    near(axis[0] * head[1] - axis[1] * head[0], 0);
    assert(axis[0] * head[0] + axis[1] * head[1] > 0);
    near(Math.hypot(left[0] - b[0], (left[1] - b[1]) * ratio), Math.hypot(right[0] - b[0], (right[1] - b[1]) * ratio));
    const restored = reshapeShape(edge, { part: "handle", index: 1 }, b, [0.7, 0.4], ratio);
    near(Math.hypot(restored.points[2][0] - 0.7, (restored.points[2][1] - 0.4) * ratio), 0.025);
  }
});

test("shortening, saving and lengthening an enlarged arrow retains its preferred head size", () => {
  for (const ratio of [0.7, 1.5]) {
    const original = transformInk([shapeOf("arrow", [0.3, 0.3], [0.5, 0.3], ratio)], [0.3, 0.3], 2, 0, [0, 0], ratio)[0];
    const short = reshapeShape(original, { part: "handle", index: 1 }, original.points[1], [0.31, 0.3], ratio);
    near(Math.hypot(short.points[2][0] - short.points[1][0], (short.points[2][1] - short.points[1][1]) * ratio), 0.003);
    const saved: InkStroke = JSON.parse(JSON.stringify(short));
    const restored = reshapeShape(saved, { part: "handle", index: 1 }, saved.points[1], [0.7, 0.3], ratio);
    near(Math.hypot(restored.points[2][0] - 0.7, (restored.points[2][1] - 0.3) * ratio), 0.05);
  }
});

test("hitShape reserves edits for handles and treats the ellipse rim as its body", () => {
  for (const ratio of [0.7, 1.5]) {
    for (const kind of ["line", "arrow"] as const) {
      const s = shapeOf(kind, [0.2, 0.3], [0.8, 0.3], ratio);
      assert.deepEqual(hitShape(s, [0.2, 0.305], 0.01, ratio), { part: "handle", index: 0 });
      assert.deepEqual(hitShape(s, [0.8, 0.3], 0.01, ratio), { part: "handle", index: 1 });
      assert.deepEqual(hitShape(s, [0.5, 0.3], 0.01, ratio), { part: "body" });
      assert.equal(hitShape(s, [0.5, 0.5], 0.01, ratio), null);
    }
    const rect = shapeOf("rectangle", [0.2, 0.2], [0.6, 0.6], ratio);
    assert.deepEqual(hitShape(rect, [0.6, 0.6], 0.01, ratio), { part: "handle", index: 2 });
    assert.deepEqual(hitShape(rect, [0.4, 0.2], 0.01, ratio), { part: "body" });
    assert.deepEqual(hitShape(rect, [0.4, 0.4], 0.01, ratio), { part: "body" });
    assert.equal(hitShape(rect, [0.8, 0.8], 0.01, ratio), null);
    const ellipse = shapeOf("ellipse", [0.2, 0.2], [0.6, 0.6], ratio);
    assert.deepEqual(hitShape(ellipse, [0.6, 0.4], 0.01, ratio), { part: "handle", index: 0 });
    assert.deepEqual(hitShape(ellipse, [0.4, 0.2], 0.01, ratio), { part: "handle", index: 3 });
    assert.deepEqual(hitShape(ellipse, [0.4 + 0.2 * Math.SQRT1_2, 0.4 + 0.2 * Math.SQRT1_2], 0.01, ratio), { part: "body" });
    assert.deepEqual(hitShape(ellipse, [0.4, 0.4], 0.01, ratio), { part: "body" });
    assert.equal(hitShape(ellipse, [0.9, 0.9], 0.01, ratio), null);
  }
});

test("reshapeShape moves one end of a line or arrow and rebuilds the arrow head", () => {
  for (const ratio of [0.7, 1.5]) {
    const l = shapeOf("line", [0.2, 0.3], [0.8, 0.3], ratio);
    const moved = reshapeShape(l, { part: "handle", index: 1 }, [0.8, 0.3], [0.6, 0.5], ratio);
    assert.deepEqual(moved.points[0], [0.2, 0.3]); near(moved.points[1][0], 0.6); near(moved.points[1][1], 0.5);
    const a = shapeOf("arrow", [0.2, 0.3], [0.8, 0.3], ratio);
    const tip = reshapeShape(a, { part: "handle", index: 1 }, [0.8, 0.3], [0.5, 0.6], ratio);
    assert.equal(tip.points.length, 5);
    shapePoints("arrow", [0.2, 0.3], [0.5, 0.6], ratio).forEach(([x, y], i) => { near(tip.points[i][0], x); near(tip.points[i][1], y); });
  }
});

test("reshapeShape keeps a rotated rectangle's opposite corner and tilt", () => {
  for (const ratio of [0.7, 1.5]) {
    const base = shapeOf("rectangle", [0.3, 0.3], [0.6, 0.5], ratio);
    const tilted = transformInk([base], [0.45, 0.4], 1, 23 * Math.PI / 180, [0, 0], ratio)[0];
    const angle = (p: number[], q: number[]) => Math.atan2((q[1] - p[1]) * ratio, q[0] - p[0]);
    const result = reshapeShape(tilted, { part: "handle", index: 2 }, tilted.points[2], [tilted.points[2][0] + 0.05, tilted.points[2][1] + 0.03], ratio);
    assert.equal(result.points.length, 5);
    assert.deepEqual(result.points[4], result.points[0]);
    near(result.points[0][0], tilted.points[0][0]); near(result.points[0][1], tilted.points[0][1]);
    near(angle(result.points[0], result.points[1]), angle(tilted.points[0], tilted.points[1]));
    near(angle(result.points[1], result.points[2]), angle(tilted.points[1], tilted.points[2]));
    near(angle(result.points[3], result.points[2]), angle(tilted.points[0], tilted.points[1]));
  }
});

test("reshapeShape scales an ellipse about its centre without touching its width", () => {
  for (const ratio of [0.7, 1.5]) {
    const e = { ...shapeOf("ellipse", [0.3, 0.3], [0.5, 0.5], ratio), width: 0.006 };
    const [cx, cy] = [0.4, 0.4];
    const bigger = reshapeShape(e, { part: "rim" }, [0.5, 0.4], [0.7, 0.4], ratio);
    assert.equal(bigger.width, 0.006); assert.equal(bigger.points.length, 65);
    const box = boundsOf([bigger])!;
    near(box.x + box.width / 2, cx); near(box.y + box.height / 2, cy);
    near(box.width, 0.6);
    const tiny = reshapeShape(e, { part: "rim" }, [0.5, 0.4], [0.4, 0.4], ratio);
    near(boundsOf([tiny])!.width, 0.2 * 0.05);
  }
});

test("reshapeShape keeps the result on the page", () => {
  const s = shapeOf("line", [0.2, 0.3], [0.8, 0.3], 1);
  const moved = reshapeShape(s, { part: "handle", index: 1 }, [0.8, 0.3], [1.4, 0.3], 1);
  assert(moved.points.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1));
});

test("an ellipse handle stretches only its own axis and keeps the opposite end", () => {
  for (const ratio of [0.7, 1.5]) {
    const e = shapeOf("ellipse", [0.2, 0.3], [0.4, 0.5], ratio);
    const wide = reshapeShape(e, { part: "handle", index: 0 }, [0.4, 0.4], [0.6, 0.45], ratio);
    const box = boundsOf([wide])!;
    near(box.x, 0.2); near(box.width, 0.4); near(box.height, 0.2); near(box.y, 0.3);
    const tall = reshapeShape(e, { part: "handle", index: 3 }, [0.3, 0.3], [0.35, 0.1], ratio);
    const t = boundsOf([tall])!;
    near(t.y + t.height, 0.5); near(t.height, 0.4); near(t.width, 0.2); near(t.x, 0.2);
    assert.equal(wide.points.length, 65); assert.equal(wide.width, e.width);
  }
});

test("a tilted ellipse stretches along its own axes", () => {
  for (const ratio of [0.7, 1.5]) {
    const e = shapeOf("ellipse", [0.3, 0.3], [0.5, 0.4], ratio);
    const tilted = transformInk([e], [0.4, 0.35], 1, 30 * Math.PI / 180, [0, 0], ratio)[0];
    const [right, opposite] = [tilted.points[0], tilted.points[32]];
    const arm = (a: number[], b: number[]) => Math.hypot(b[0] - a[0], (b[1] - a[1]) * ratio);
    const angle = (a: number[], b: number[]) => Math.atan2((b[1] - a[1]) * ratio, b[0] - a[0]);
    const out: [number, number] = [right[0] + 0.1 * Math.cos(angle(opposite, right)), right[1] + 0.1 * Math.sin(angle(opposite, right)) / ratio];
    const result = reshapeShape(tilted, { part: "handle", index: 0 }, right, out, ratio);
    near(arm(result.points[32], result.points[0]), arm(opposite, right) + 0.1);
    near(angle(result.points[32], result.points[0]), angle(opposite, right));
    near(result.points[32][0], opposite[0]); near(result.points[32][1], opposite[1]);
    near(arm(result.points[48], result.points[16]), arm(tilted.points[48], tilted.points[16]));
  }
});

test("a click does not reshape narrow ellipses or scaled arrows", () => {
  const ellipse = shapeOf("ellipse", [0.3, 0.3], [0.304, 0.5], 1);
  assert.equal(reshapeShape(ellipse, { part: "handle", index: 0 }, ellipse.points[0], ellipse.points[0], 1), ellipse);
  const arrow = transformInk([shapeOf("arrow", [0.3, 0.3], [0.5, 0.3], 1)], [0.3, 0.3], 2, 0, [0, 0], 1)[0];
  assert.equal(reshapeShape(arrow, { part: "handle", index: 1 }, arrow.points[1], arrow.points[1], 1), arrow);
  const moved = reshapeShape(arrow, { part: "handle", index: 1 }, arrow.points[1], [0.75, 0.3], 1);
  near(Math.hypot(moved.points[1][0] - moved.points[2][0], moved.points[1][1] - moved.points[2][1]),
    Math.hypot(arrow.points[1][0] - arrow.points[2][0], arrow.points[1][1] - arrow.points[2][1]));
});

test("page edges stop deformation without moving the fixed point or changing stroke width", () => {
  const ellipse = { ...shapeOf("ellipse", [0.05, 0.4], [0.25, 0.6], 1), width: 0.006 };
  const grown = reshapeShape(ellipse, { part: "rim" }, [0.15, 0.6], [0.15, 0.8], 1);
  near(ellipseCenter(grown)[0], ellipseCenter(ellipse)[0]);
  near(ellipseCenter(grown)[1], ellipseCenter(ellipse)[1]);
  near(grown.width, ellipse.width);
  assert(grown.points.every(([x, y]) => x >= -1e-10 && x <= 1 + 1e-10 && y >= -1e-10 && y <= 1 + 1e-10));
  const rectangle = transformInk([shapeOf("rectangle", [0.2, 0.2], [0.6, 0.4], 1)], [0.4, 0.3], 1, Math.PI / 4, [0, 0], 1)[0];
  const resized = reshapeShape(rectangle, { part: "handle", index: 2 }, rectangle.points[2], [1, 0.1], 1);
  near(resized.points[0][0], rectangle.points[0][0]); near(resized.points[0][1], rectangle.points[0][1]);
  assert(resized.points.every(([x, y]) => x >= -1e-10 && x <= 1 + 1e-10 && y >= -1e-10 && y <= 1 + 1e-10));
});

test("Shift constrains new shapes and cursor follows rotated handle direction", () => {
  const lineEnd = constrainedShapeEnd("line", [0.2, 0.2], [0.39, 0.22], 1);
  near(lineEnd[1], 0.2);
  const squareEnd = constrainedShapeEnd("rectangle", [0.2, 0.2], [0.4, 0.3], 2);
  near(squareEnd[0] - 0.2, (squareEnd[1] - 0.2) * 2);
  const ellipse = shapeOf("ellipse", [0.3, 0.3], [0.5, 0.4], 1);
  const tilted = transformInk([ellipse], [0.4, 0.35], 1, Math.PI / 2, [0, 0], 1)[0];
  assert.equal(shapeHandleCursor(tilted, 0, 1), "ns-resize");
});

test("Shift keeps a rectangle or ellipse's proportions when reshaping a handle", () => {
  const rectangle = shapeOf("rectangle", [0.2, 0.2], [0.6, 0.4], 1);
  const box = reshapeShape(rectangle, { part: "handle", index: 2 }, [0.6, 0.4], [0.8, 0.4], 1, true);
  near(boundsOf([box])!.width / boundsOf([box])!.height, 2);
  near(box.points[0][0], rectangle.points[0][0]); near(box.points[0][1], rectangle.points[0][1]);
  const ellipse = shapeOf("ellipse", [0.2, 0.3], [0.6, 0.5], 1);
  const stretched = reshapeShape(ellipse, { part: "handle", index: 0 }, ellipse.points[0], [0.8, 0.4], 1, true);
  near(boundsOf([stretched])!.width / boundsOf([stretched])!.height, 2);
  near(stretched.points[32][0], ellipse.points[32][0]);
});

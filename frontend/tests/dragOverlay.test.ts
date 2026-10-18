import assert from "node:assert/strict";
import { test } from "node:test";
import { besideCursor, CARD_OFFSET } from "../src/features/library/dragOverlay.ts";

const rect = { left: 10, top: 200, width: 300, height: 40, right: 310, bottom: 240 };
const args = (activatorEvent: object | null, transform = { x: 5, y: 30, scaleX: 1, scaleY: 1 }) => ({
  activatorEvent: activatorEvent as Event | null, active: null, activeNodeRect: rect, draggingNodeRect: rect, containerNodeRect: null,
  over: null, overlayNodeRect: null, scrollableAncestors: [], scrollableAncestorRects: [], transform, windowRect: null,
});

test("the card of the dragged papers follows beside the pointer, not over the folder under it", () => {
  // Picked up 120px into the row, 15px down; moved by (5, 30) since.
  const moved = besideCursor(args({ clientX: 130, clientY: 215 }));
  // The card's corner: where the pointer is now, plus the offset.
  assert.equal(rect.left + moved.x, 130 + 5 + CARD_OFFSET.x);
  assert.equal(rect.top + moved.y, 215 + 30 + CARD_OFFSET.y);
});

test("dragged with the keyboard, the card stays over the row", () => {
  const transform = { x: 0, y: 40, scaleX: 1, scaleY: 1 };
  assert.deepEqual(besideCursor(args({ key: " " }, transform)), transform);
  assert.deepEqual(besideCursor(args(null, transform)), transform);
});

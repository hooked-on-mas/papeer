import type { Modifier } from "@dnd-kit/core";

/** Where the card of the papers being dragged sits from the pointer, in CSS pixels: below and to the right. */
export const CARD_OFFSET = { x: 16, y: 20 };

/**
 * Moves the card of the papers being dragged from over the row it was picked up from to just beside the
 * pointer, so that it never covers the name of the folder the pointer is over. Dragged with the keyboard
 * (no pointer), it stays over the row as before.
 */
export const besideCursor: Modifier = ({ activatorEvent, activeNodeRect, transform }) => {
  if (!activeNodeRect || !activatorEvent || !("clientX" in activatorEvent) || !("clientY" in activatorEvent)) return transform;
  const { clientX, clientY } = activatorEvent as { clientX: number; clientY: number };
  return {
    ...transform,
    x: transform.x + clientX - activeNodeRect.left + CARD_OFFSET.x,
    y: transform.y + clientY - activeNodeRect.top + CARD_OFFSET.y,
  };
};

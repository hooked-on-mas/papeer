import { useEffect, useRef, useState, type RefObject } from "react";
import { Check, Copy, X } from "lucide-react";

type Caret = { node: Text; offset: number };
type WordSegmenter = new (locale: undefined, options: { granularity: "word" }) => {
  segment(text: string): Iterable<{ index: number; segment: string; isWordLike?: boolean }>;
};

/** Hit the real PDF text even when the pen's transparent SVG is above it. */
function caretAt(root: HTMLElement, x: number, y: number): Caret | undefined {
  const spans = root.querySelectorAll<HTMLElement>(".textLayer span");
  for (const span of spans) {
    const node = span.firstChild;
    if (!(node instanceof Text) || !node.length) continue;
    const box = span.getBoundingClientRect();
    if (x < box.left - 3 || x > box.right + 3 || y < box.top - 3 || y > box.bottom + 3) continue;
    const range = document.createRange();
    let closest = { offset: 0, distance: Infinity };
    // PDF spans are individual text runs. Measure glyphs rather than estimating
    // by character count: Japanese/Latin text and proportional fonts can mix.
    for (let offset = 0; offset < node.length;) {
      const end = offset + (node.data.codePointAt(offset)! > 0xffff ? 2 : 1);
      range.setStart(node, offset); range.setEnd(node, end);
      const glyph = range.getBoundingClientRect();
      const distance = Math.hypot(x - (glyph.left + glyph.right) / 2, y - (glyph.top + glyph.bottom) / 2);
      if (distance < closest.distance) closest = { offset: x > (glyph.left + glyph.right) / 2 ? end : offset, distance };
      offset = end;
    }
    return { node, offset: closest.offset };
  }
}

function wordAt({ node, offset }: Caret): Range {
  const text = node.data;
  const Segmenter = (Intl as typeof Intl & { Segmenter?: WordSegmenter }).Segmenter;
  const segments = Segmenter ? new Segmenter(undefined, { granularity: "word" }).segment(text)
    : [...text.matchAll(/[\p{L}\p{N}_]+|[^\p{L}\p{N}_]/gu)].map(match => ({ index: match.index!, segment: match[0] }));
  const at = Math.min(offset, text.length - 1);
  const word = [...segments].find(segment => segment.index <= at && segment.index + segment.segment.length > at);
  const range = document.createRange();
  range.setStart(node, word?.index ?? at);
  range.setEnd(node, word ? word.index + word.segment.length : at + 1);
  return range;
}

/** Preserve native selection, with a long-press fallback and a visible copy action. */
export function PdfTextSelection({ container, enabled }: { container: RefObject<HTMLDivElement | null>; enabled: boolean }) {
  const [text, setText] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const touchCopied = useRef(false);
  const selectedText = useRef("");
  const copyEpoch = useRef(0);
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let press: { id: number; x: number; y: number; range?: Range } | undefined;
    let suppressClick = false;
    const pens = new Set<number>();
    const update = () => {
      const selection = getSelection();
      const value = selection?.rangeCount && root.contains(selection.getRangeAt(0).commonAncestorContainer) ? selection.toString() : "";
      // Focusing Copy/the manual fallback may collapse the native range. Preserve
      // that passage, but always accept a new nonempty selection (even while focused).
      if (!value && (!selection || selection.isCollapsed) && document.activeElement?.closest(".web-text-selection-tools")) return;
      if (value !== selectedText.current) {
        selectedText.current = value; copyEpoch.current++;
        setText(value); setCopyState("idle");
      }
    };
    const cancel = () => {
      clearTimeout(timer); timer = undefined; press = undefined;
      root.removeAttribute("data-touch-selecting");
    };
    const start = (event: TouchEvent) => {
      suppressClick = false; cancel();
      if (!enabled || pens.size || event.touches.length !== 1 || !(event.target instanceof Element)
          || !event.target.closest(".web-pdf-surface") || event.target.closest("button, input, textarea, select, a")) return;
      const touch = event.touches[0];
      press = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
      timer = setTimeout(() => {
        if (!press || !enabled) return;
        const selection = getSelection();
        if (!selection) return;
        const caret = caretAt(root, press.x, press.y);
        // Let iOS keep its native word and handles. A native word stays inside the pressed
        // text run; anything larger is iOS selecting the whole page, which is replaced.
        const native = !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : undefined;
        if (native && caret && native.startContainer === caret.node && native.endContainer === caret.node) return;
        if (!caret) {
          if (native && root.contains(native.commonAncestorContainer) && !(native.commonAncestorContainer instanceof Text)) selection.removeAllRanges();
          return;
        }
        press.range = wordAt(caret);
        selection.removeAllRanges(); selection.addRange(press.range.cloneRange());
        root.setAttribute("data-touch-selecting", "");
        update();
      }, 600);
    };
    const move = (event: TouchEvent) => {
      if (!press) return;
      if (event.touches.length !== 1 || event.touches[0].identifier !== press.id) { cancel(); return; }
      const touch = event.touches[0];
      if (!press.range) {
        if (Math.hypot(touch.clientX - press.x, touch.clientY - press.y) > 8) cancel();
        return;
      }
      event.preventDefault();
      const caret = caretAt(root, touch.clientX, touch.clientY);
      if (!caret) return;
      const range = press.range.cloneRange();
      const position = range.comparePoint(caret.node, caret.offset);
      if (position < 0) range.setStart(caret.node, caret.offset);
      if (position > 0) range.setEnd(caret.node, caret.offset);
      const selection = getSelection();
      selection?.removeAllRanges(); selection?.addRange(range); update();
    };
    const end = (event: TouchEvent) => {
      if (press?.range) { event.preventDefault(); suppressClick = true; }
      cancel();
    };
    const click = (event: MouseEvent) => {
      if (suppressClick && event.detail > 0) { suppressClick = false; event.preventDefault(); event.stopPropagation(); }
    };
    const newPress = (event: PointerEvent) => {
      suppressClick = false;
      if (event.pointerType === "pen") { pens.add(event.pointerId); cancel(); }
    };
    const penUp = (event: PointerEvent) => { pens.delete(event.pointerId); };
    const interrupt = () => { pens.clear(); cancel(); };
    const options = { passive: false, capture: true };
    root.addEventListener("touchstart", start, options);
    root.addEventListener("touchmove", move, options);
    root.addEventListener("touchend", end, options);
    root.addEventListener("touchcancel", cancel, options);
    root.addEventListener("click", click, true);
    root.addEventListener("pointerdown", newPress, true);
    document.addEventListener("selectionchange", update);
    window.addEventListener("pointerup", penUp, true);
    window.addEventListener("pointercancel", penUp, true);
    window.addEventListener("blur", interrupt);
    return () => {
      cancel();
      root.removeEventListener("touchstart", start, true);
      root.removeEventListener("touchmove", move, true);
      root.removeEventListener("touchend", end, true);
      root.removeEventListener("touchcancel", cancel, true);
      root.removeEventListener("click", click, true);
      root.removeEventListener("pointerdown", newPress, true);
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("pointerup", penUp, true);
      window.removeEventListener("pointercancel", penUp, true);
      window.removeEventListener("blur", interrupt);
    };
  }, [container, enabled]);

  const copy = async () => {
    const epoch = ++copyEpoch.current, value = selectedText.current;
    try {
      await navigator.clipboard.writeText(value);
      if (epoch === copyEpoch.current && value === selectedText.current) setCopyState("copied");
    } catch {
      if (epoch === copyEpoch.current && value === selectedText.current) setCopyState("error");
    }
  };
  if (!text.trim()) return null;
  return <div className="web-text-selection-tools" role="toolbar" aria-label="選択した文字の操作">
    <button aria-label="選択した文字をコピー"
      onPointerDown={event => { touchCopied.current = false; event.preventDefault(); }}
      onKeyDown={() => { touchCopied.current = false; }}
      onTouchEnd={event => {
        const touch = event.changedTouches[0], box = event.currentTarget.getBoundingClientRect();
        if (event.touches.length || !touch || touch.clientX < box.left || touch.clientX > box.right || touch.clientY < box.top || touch.clientY > box.bottom) return;
        touchCopied.current = true; void copy();
      }}
      onClick={() => {
        // WebKit can omit the compatibility click after preventDefault(pointerdown).
        // Copy during touchend's user activation, and ignore its optional later click.
        if (touchCopied.current) { touchCopied.current = false; return; }
        void copy();
      }}>{copyState === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copyState === "copied" ? "コピーしました" : "コピー"}</button>
    <button aria-label="文字選択を解除" onClick={() => {
      selectedText.current = ""; copyEpoch.current++; getSelection()?.removeAllRanges(); setText("");
    }}><X aria-hidden="true" /></button>
    {copyState === "error" && <label role="alert">コピーできませんでした。下の文字を選択してコピーしてください。
      <textarea readOnly aria-label="コピーする文字" value={text} onFocus={event => event.currentTarget.select()} /></label>}
  </div>;
}

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

type Mark = { left: number; top: number; width: number; height: number };

/** The range's text and highlight boxes (relative to `base`), keeping pdf.js line breaks. */
function describe(range: Range, base: DOMRect): { text: string; marks: Mark[] } {
  const scope = range.commonAncestorContainer;
  const nodes: Node[] = [];
  if (scope instanceof Text) nodes.push(scope);
  else {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (range.intersectsNode(node)) nodes.push(node);
  }
  let text = "";
  const marks: Mark[] = [];
  for (const node of nodes) {
    // Range.toString() drops the <br> between pdf.js text lines.
    if (node instanceof HTMLBRElement) { text += "\n"; continue; }
    if (!(node instanceof Text)) continue;
    const from = node === range.startContainer ? range.startOffset : 0, to = node === range.endContainer ? range.endOffset : node.length;
    if (to <= from) continue;
    text += node.data.slice(from, to);
    const part = document.createRange(); part.setStart(node, from); part.setEnd(node, to);
    for (const box of part.getClientRects()) {
      if (box.width && box.height) marks.push({ left: box.left - base.left, top: box.top - base.top, width: box.width, height: box.height });
    }
  }
  return { text, marks };
}

/**
 * Native selection for mouse and trackpad. Touch selection is drawn here instead: iOS does not
 * select pdf.js's transparent text, and its own long-press gesture cancels the page's touches.
 */
export function PdfTextSelection({ container, enabled }: { container: RefObject<HTMLDivElement | null>; enabled: boolean }) {
  const [text, setText] = useState("");
  const [marks, setMarks] = useState<Mark[]>([]);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const touchCopied = useRef(false);
  const selectedText = useRef("");
  const touchRange = useRef<Range | undefined>(undefined);
  const copyEpoch = useRef(0);
  const show = (value: string) => {
    if (value === selectedText.current) return;
    selectedText.current = value; copyEpoch.current++;
    setText(value); setCopyState("idle");
  };
  const clearTouch = () => { touchRange.current = undefined; setMarks([]); };
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
      // A touch selection has no native range; only a new native selection replaces it.
      if (!value && touchRange.current) return;
      if (value && touchRange.current) clearTouch();
      // Focusing Copy/the manual fallback may collapse the native range. Preserve
      // that passage, but always accept a new nonempty selection (even while focused).
      if (!value && (!selection || selection.isCollapsed) && document.activeElement?.closest(".web-text-selection-tools")) return;
      show(value);
    };
    const select = (range: Range) => {
      touchRange.current = range;
      const { text, marks } = describe(range, root.getBoundingClientRect());
      setMarks(marks); show(text);
      getSelection()?.removeAllRanges();
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
        const caret = caretAt(root, press.x, press.y);
        if (!caret) return;
        press.range = wordAt(caret);
        root.setAttribute("data-touch-selecting", "");
        select(press.range);
      }, 500);
    };
    const move = (event: TouchEvent) => {
      if (!press) return;
      if (event.touches.length !== 1 || event.touches[0].identifier !== press.id) { cancel(); return; }
      const touch = event.touches[0];
      if (!press.range) {
        if (Math.hypot(touch.clientX - press.x, touch.clientY - press.y) > 10) cancel();
        return;
      }
      event.preventDefault();
      const caret = caretAt(root, touch.clientX, touch.clientY);
      if (!caret) return;
      const range = press.range.cloneRange();
      const position = range.comparePoint(caret.node, caret.offset);
      if (position < 0) range.setStart(caret.node, caret.offset);
      if (position > 0) range.setEnd(caret.node, caret.offset);
      select(range);
    };
    const end = (event: TouchEvent) => {
      if (press?.range) { event.preventDefault(); suppressClick = true; }
      // A tap on the page dismisses a touch selection, as it does natively.
      else if (press && touchRange.current) { clearTouch(); show(""); }
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
  return <>{marks.map((mark, i) => <div key={i} className="web-touch-selection" aria-hidden="true" style={mark} />)}
  <div className="web-text-selection-tools" role="toolbar" aria-label="選択した文字の操作">
    <output className="sr-only" aria-label="選択中の文字">{text}</output>
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
      selectedText.current = ""; copyEpoch.current++; clearTouch(); getSelection()?.removeAllRanges(); setText("");
    }}><X aria-hidden="true" /></button>
    {copyState === "error" && <label role="alert">コピーできませんでした。下の文字を選択してコピーしてください。
      <textarea readOnly aria-label="コピーする文字" value={text} onFocus={event => event.currentTarget.select()} /></label>}
  </div></>;
}

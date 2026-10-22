import { useEffect, useRef, type ReactNode } from "react";

function fitMenu(details: HTMLDetailsElement) {
  const panel = details.querySelector<HTMLElement>(":scope > div")!;
  if (!details.open) { if (panel.hasAttribute("popover") && panel.matches(":popover-open")) panel.hidePopover(); return; }
  const frame = details.closest<HTMLElement>(".web-pdf-pane, .web-document-reader");
  const viewport = window.visualViewport;
  if (panel.hasAttribute("popover")) {
    if (!panel.matches(":popover-open")) panel.showPopover();
    const anchor = details.querySelector("summary")!.getBoundingClientRect();
    const top = (viewport?.offsetTop ?? 0) + 8, bottom = (viewport ? viewport.offsetTop + viewport.height : innerHeight) - 8;
    const below = Math.max(0, bottom - anchor.bottom), above = Math.max(0, anchor.top - top);
    const desired = Math.min(panel.scrollHeight + 2, (bottom - top) * .6);
    const upwards = below < desired && above > below;
    const height = Math.min(desired, upwards ? above : below);
    const left = (viewport?.offsetLeft ?? 0) + 8, right = (viewport ? viewport.offsetLeft + viewport.width : innerWidth) - 8;
    panel.style.maxHeight = `${height}px`;
    panel.style.top = `${upwards ? anchor.top - Math.min(panel.offsetHeight, height) : anchor.bottom}px`;
    panel.style.left = `${Math.max(left, Math.min((frame?.getBoundingClientRect().right ?? right) - panel.offsetWidth - 2, right - panel.offsetWidth))}px`;
    return;
  }
  const bottom = Math.min(frame?.getBoundingClientRect().bottom ?? innerHeight,
    viewport ? viewport.offsetTop + viewport.height : innerHeight);
  panel.style.maxHeight = `${Math.max(0, Math.floor(bottom - panel.getBoundingClientRect().top - 8))}px`;
}

/** Reader popovers stay inside the visible reader, including banners and keyboard resizing. */
export function ReaderMenu({ className, label, icon, children, closeOnAction = false, floating = false }: {
  className: string; label: string; icon: ReactNode; children: ReactNode; closeOnAction?: boolean; floating?: boolean;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const details = ref.current!;
    const summary = details.querySelector("summary")!;
    const frame = details.closest<HTMLElement>(".web-pdf-pane, .web-document-reader");
    const measure = () => fitMenu(details);
    const portalledMenu = (target: Element) => target.closest('[role="menu"], [role="dialog"], [data-radix-popper-content-wrapper]');
    const outside = (event: Event) => {
      const target = event.target;
      if (!details.open || !(target instanceof Element) || details.contains(target) || portalledMenu(target)) return;
      details.open = false;
      fitMenu(details);
      // Dismissing a settings popup on the PDF must not place a note or draw a dot.
      if (event.type === "pointerdown" && target.closest(".web-pdf-surface")) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (!details.open || event.key !== "Escape" || event.defaultPrevented
        || (event.target instanceof Element && portalledMenu(event.target))) return;
      details.open = false; fitMenu(details); summary.focus({ preventScroll: true });
      event.preventDefault(); event.stopPropagation();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(summary); if (frame) observer.observe(frame);
    details.addEventListener("toggle", measure);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    document.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("scroll", measure);
    return () => {
      observer.disconnect();
      details.removeEventListener("toggle", measure);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("scroll", measure);
    };
  }, []);
  return <details ref={ref} className={className}>
    <summary aria-label={label} title={label} onClick={event => {
      // Fit in the opening event, before its first paint; toggle is dispatched later.
      event.preventDefault();
      const details = ref.current!; details.open = !details.open; fitMenu(details);
    }}>{icon}</summary>
    <div popover={floating && "showPopover" in HTMLElement.prototype ? "manual" : undefined} onClick={event => {
      const button = (event.target as Element).closest("button");
      if (closeOnAction && button && !button.hasAttribute("aria-haspopup")) { ref.current!.open = false; fitMenu(ref.current!); }
    }}>{children}</div>
  </details>;
}

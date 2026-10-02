import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { LocateFixed, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { externalCitationSource, type Camera, type MapNode, type MapEdge, type Point } from "./mapGraph";
import { citationScope, citationCount, nodeRadius, frameMap, groupOutline, type MapGroup } from "./mapLayout";
import type { GroupDescription } from "./groupHooks";
import { groupLabelLayout } from "./groupLabelLayout";
import { viewportLayout } from "./viewportLayout";

export function MapNetwork({ nodes, edges, allNodes = nodes, allEdges = edges, groups, explanations, positions, origin, selected, hover, camera, setCamera, setPosition, setLayout, setMinimumHeight, select, setHover, reset }: {
  nodes: MapNode[]; edges: MapEdge[]; positions: Record<string, Point>; origin: string; selected: string | null;
  allNodes?: MapNode[]; allEdges?: MapEdge[];
  hover: string | null; camera: Camera; setCamera: (camera: Camera) => void; setPosition: (id: string, point: Point) => void;
  setLayout: (positions: Record<string, Point>, camera: Camera, elapsedMs: number) => void;
  setMinimumHeight: (height: number) => void;
  select: (id: string) => void; setHover: (id: string | null) => void; reset: () => Record<string, Point>;
  groups: MapGroup[];
  explanations: { descriptions: Record<string, GroupDescription>; enabled: boolean; running: boolean; error: string; retry: () => void };
}) {
  const svg = useRef<SVGSVGElement>(null);
  const footer = useRef<HTMLDivElement>(null);
  const marker = useId().replace(/:/g, "");
  const [size, setSize] = useState({ width: 0, height: 0 });
  const measuredSize = useRef({ width: 0, height: 0 });
  const gesture = useRef<{ id?: string; x: number; y: number; camera: Camera; point?: Point } | null>(null);
  const moved = useRef(false);
  const packedGeometry = useRef("");
  const active = hover ?? selected;
  const preview = nodes.find(n => n.id === hover);
  const scope = citationScope(nodes);
  const metadata = new Map(nodes.map(n => [n.id, n]));
  const membership = new Map(groups.flatMap(group => group.members.map(id => [id, group] as const)));
  const groupName = (group: MapGroup) => explanations.descriptions[group.id]?.name || group.label;
  const relationMetadata = new Map(allNodes.map(n => [n.id, n]));
  const rootReferences = new Set(allEdges.filter(e => e.kind === "citation" && e.source === origin).map(e => e.target));
  const groupRelation = (group: MapGroup) => {
    const members = new Set(group.members);
    const direct = group.members.filter(id => rootReferences.has(id)).length;
    const incoming = new Set(allEdges.filter(e => e.kind === "citation" && e.target === origin && members.has(e.source)).map(e => e.source)).size;
    const secondHop = new Set(allEdges.filter(e => e.kind === "citation" && rootReferences.has(e.source) && members.has(e.target)).map(e => e.target)).size;
    const shared = new Set(allEdges.filter(e => e.kind === "citation" && members.has(e.source) && rootReferences.has(e.target)).map(e => e.target));
    return { direct, incoming, secondHop, shared };
  };
  const radius = (id: string) => Math.max((id === origin ? 14 : 8) / camera.zoom, nodeRadius(metadata.get(id)!, scope) / Math.sqrt(Math.min(1, camera.zoom)));
  const baseOutlines = groups.map(group => ({ group, outline: groupOutline(group, positions, id => radius(id) + 12) })).filter(item => item.outline);
  const groupLabels = groupLabelLayout(baseOutlines.map(({ group, outline }) => ({ id: group.id,
    name: `${groups.indexOf(group) + 1} ${groupName(group)}`,
    hull: outline!.hull.map(p => ({ x: size.width / 2 + camera.x + p.x * camera.zoom, y: size.height / 2 + camera.y + p.y * camera.zoom })) })),
    nodes.filter(n => positions[n.id]).map(n => ({ x: size.width / 2 + camera.x + positions[n.id].x * camera.zoom,
      y: size.height / 2 + camera.y + positions[n.id].y * camera.zoom, radius: radius(n.id) * camera.zoom + 2 })), size);
  const outlines = baseOutlines.map(({ group }) => {
    const label = groupLabels.find(l => l.id === group.id)!;
    const extra = [{ x: label.left - 8, y: label.top - 8 }, { x: label.right + 8, y: label.top - 8 },
      { x: label.left - 8, y: label.bottom + 8 }, { x: label.right + 8, y: label.bottom + 8 }]
      .map(p => ({ x: (p.x - size.width / 2 - camera.x) / camera.zoom, y: (p.y - size.height / 2 - camera.y) / camera.zoom }));
    return { group, outline: groupOutline(group, positions, id => radius(id) + 12, extra) };
  });
  const regions = outlines.map(({ outline }) => ({ left: Math.min(...outline!.hull.map(p => p.x)), right: Math.max(...outline!.hull.map(p => p.x)),
    top: Math.min(...outline!.hull.map(p => p.y)), bottom: Math.max(...outline!.hull.map(p => p.y)) }));
  const overlappingGroups = regions.some((a, i) => regions.slice(i + 1).some(b => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top));
  const overlappingNodes = nodes.some((n, i) => nodes.slice(i + 1).some(other => positions[n.id] && positions[other.id]
    && Math.hypot(positions[n.id].x - positions[other.id].x, positions[n.id].y - positions[other.id].y) < radius(n.id) + radius(other.id) + 2 / camera.zoom));
  const unrelatedInside = regions.some((a, i) => nodes.some(n => !outlines[i].group.members.includes(n.id) && positions[n.id]
    && positions[n.id].x + radius(n.id) > a.left && positions[n.id].x - radius(n.id) < a.right
    && positions[n.id].y + radius(n.id) > a.top && positions[n.id].y - radius(n.id) < a.bottom));
  const outside = groupLabels.some(l => l.left < 8 || l.right > size.width - 8 || l.top < 8 || l.bottom > size.height - 8)
    || nodes.some(n => {
      const p = positions[n.id]; if (!p) return false;
      const x = size.width / 2 + camera.x + p.x * camera.zoom, y = size.height / 2 + camera.y + p.y * camera.zoom, r = radius(n.id) * camera.zoom;
      return x - r < 4 || x + r > size.width - 4 || y - r < 4 || y + r > size.height - 4;
    });
  const invalidGeometry = overlappingGroups || overlappingNodes || unrelatedInside || outside;
  const geometryKey = JSON.stringify([origin, size, nodes.map(n => [n.id, nodeRadius(n, scope)]).sort(), groups.map(g => [g.members, groupName(g)])]);
  useLayoutEffect(() => {
    if (!camera.fitted || camera.manual || !size.width || !size.height || !invalidGeometry || packedGeometry.current === geometryKey) return;
    packedGeometry.current = geometryKey;
    const start = performance.now();
    const packed = viewportLayout(nodes, groups, positions, origin, size.width, size.height,
      Object.fromEntries(groups.map(g => [g.id, groupName(g)])));
    setLayout(packed.positions, packed.camera, performance.now() - start);
  });
  const labelText = (n: MapNode) => {
    const author = n.first_author.trim().split(/\s+/).slice(-1)[0];
    const text = n.id !== origin && author ? `${author}${n.year ? ` · ${n.year}` : ""}` : n.title;
    return text.length > 24 ? text.slice(0, 23) + "…" : text;
  };
  const neighbors = new Set(edges.filter(e => e.source === active || e.target === active).flatMap(e => [e.source, e.target]));
  const labelOrder = [...nodes].sort((a, b) => Number(b.id === active) - Number(a.id === active)
    || Number(b.id === origin) - Number(a.id === origin) || Number(neighbors.has(b.id)) - Number(neighbors.has(a.id))
    || Number(b.roles.includes("related") && !b.roles.includes("references")) - Number(a.roles.includes("related") && !a.roles.includes("references"))
    || Number(groups.some(g => g.representative === b.title)) - Number(groups.some(g => g.representative === a.title))
    || b.prior_count - a.prior_count || b.score - a.score || a.id.localeCompare(b.id));
  const nodeLabels = new Map<string, { x: number; y: number; anchor: "middle" | "start" | "end" }>();
  const labelBounds: { left: number; right: number; top: number; bottom: number }[] = [...groupLabels];
  for (const n of labelOrder) {
    const p = positions[n.id];
    if (!p || n.id === origin || nodeLabels.size >= 12) continue;
    const width = [...labelText(n)].reduce((sum, letter) => sum + (letter.charCodeAt(0) < 256 ? 6.5 : 12), 0), r = radius(n.id) * camera.zoom;
    const options: { x: number; y: number; anchor: "middle" | "start" | "end" }[] = [
      { x: 0, y: r + 18, anchor: "middle" }, { x: 0, y: -r - 10, anchor: "middle" },
      { x: r + 10, y: 4, anchor: "start" }, { x: -r - 10, y: 4, anchor: "end" }];
    for (const option of options) {
      const x = size.width / 2 + camera.x + p.x * camera.zoom + option.x;
      const y = size.height / 2 + camera.y + p.y * camera.zoom + option.y;
      const left = x - (option.anchor === "middle" ? width / 2 : option.anchor === "end" ? width : 0);
      const box = { left, right: left + width, top: y - 13, bottom: y + 5 };
      if (box.left < 3 || box.right > size.width - 3 || box.top < 32 || box.bottom > size.height - 44) continue;
      if (labelBounds.some(b => box.left < b.right + 4 && box.right > b.left - 4 && box.top < b.bottom + 4 && box.bottom > b.top - 4)) continue;
      if (nodes.some(other => {
        const point = positions[other.id]; if (!point) return false;
        const cx = size.width / 2 + camera.x + point.x * camera.zoom, cy = size.height / 2 + camera.y + point.y * camera.zoom;
        const r = radius(other.id) * camera.zoom + 4;
        return Math.hypot(cx - Math.max(box.left, Math.min(box.right, cx)), cy - Math.max(box.top, Math.min(box.bottom, cy))) < r;
      })) continue;
      nodeLabels.set(n.id, option); labelBounds.push(box); break;
    }
  }
  useEffect(() => {
    if (!footer.current) return;
    const observer = new ResizeObserver(entries => setMinimumHeight(400 + Math.ceil(entries[0].contentRect.height)));
    observer.observe(footer.current);
    return () => observer.disconnect();
  }, [setMinimumHeight]);
  useEffect(() => {
    if (!svg.current) return;
    const observer = new ResizeObserver(entries => setSize({ width: entries[0].contentRect.width, height: entries[0].contentRect.height }));
    observer.observe(svg.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!size.width || !size.height || !nodes.length) return;
    const resized = measuredSize.current.width > 0 && (measuredSize.current.width !== size.width || measuredSize.current.height !== size.height);
    measuredSize.current = size;
    if (camera.manual && camera.fitted) return;
    // A viewport repair already fits the current screen; do not replace its camera with a stale resize fit.
    if (camera.fitted && invalidGeometry) return;
    if (camera.fitted && !resized) return;
    setCamera(frameMap(nodes, positions, size.width, size.height));
  }, [camera.fitted, camera.manual, size, nodes, positions, setCamera, invalidGeometry]);
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      setCamera({ ...camera, manual: true, zoom: Math.max(.01, Math.min(3, camera.zoom * (event.deltaY > 0 ? 1 / 1.1 : 1.1))) });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [camera, setCamera]);
  const fit = () => {
    packedGeometry.current = "";
    const fresh = reset();
    setCamera(frameMap(nodes, fresh, size.width, size.height));
  };
  const zoom = (factor: number) => setCamera({ ...camera, manual: true, zoom: Math.max(.01, Math.min(3, camera.zoom * factor)) });
  return <div className="flex-1 flex flex-col min-h-0" data-testid="map-network">
    <div className="flex-1 relative min-h-0">
    <svg ref={svg} className="w-full h-full touch-none select-none" viewBox={`0 0 ${size.width || 700} ${size.height || 500}`}
      aria-label="論文の関係図" data-camera={JSON.stringify(camera)} data-layout-ready={!!camera.fitted && (camera.manual || !invalidGeometry)}
      data-layout-issues={JSON.stringify({ overlappingGroups, overlappingNodes, unrelatedInside, outside })} tabIndex={0} role="group"
      onKeyDown={e => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "+" || e.key === "=") { e.preventDefault(); zoom(1.2); }
        if (e.key === "-") { e.preventDefault(); zoom(1 / 1.2); }
        if (e.key === "Home") { e.preventDefault(); fit(); }
        const delta = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] }[e.key];
        if (delta) { e.preventDefault(); setCamera({ ...camera, manual: true, x: camera.x + delta[0], y: camera.y + delta[1] }); }
      }}
      onPointerDown={e => {
        if (e.button !== 0) return;
        const id = (e.target as Element).closest("[data-node-id]")?.getAttribute("data-node-id") ?? undefined;
        gesture.current = { id, x: e.clientX, y: e.clientY, camera, point: id ? positions[id] : undefined };
        moved.current = false; e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={e => {
        const drag = gesture.current; if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) < 4) return;
        moved.current = true;
        if (drag.id && drag.point) setPosition(drag.id, { x: drag.point.x + dx / camera.zoom, y: drag.point.y + dy / camera.zoom });
        else setCamera({ ...drag.camera, manual: true, x: drag.camera.x + dx, y: drag.camera.y + dy });
      }}
      onPointerUp={e => {
        const id = gesture.current?.id;
        gesture.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        if (id && !moved.current) select(id);
      }} onPointerCancel={() => { gesture.current = null; }}>
      <defs><marker id={marker} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L7,3.5 L0,7 z" fill="currentColor" /></marker></defs>
      <g transform={`translate(${size.width / 2 + camera.x} ${size.height / 2 + camera.y}) scale(${camera.zoom})`}>
        {outlines.map(({ group, outline }) => <g key={group.id} data-map-group={group.id} pointerEvents="none" opacity={active && membership.get(active)?.id !== group.id ? .4 : 1}>
          <path d={outline!.path} fill={`color-mix(in oklab, ${group.color} 7%, transparent)`} stroke={`color-mix(in oklab, ${group.color} 40%, transparent)`} strokeWidth={1 / camera.zoom} />
        </g>)}
        {edges.map(e => {
          const a = positions[e.source], b = positions[e.target]; if (!a || !b) return null;
          const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1;
          const focused = e.source === active || e.target === active;
          const sameGroup = membership.has(e.source) && membership.get(e.source)?.id === membership.get(e.target)?.id;
          return <g key={`${e.kind}:${e.source}:${e.target}`} className={focused ? "text-primary" : "text-muted-foreground"} opacity={active && !focused ? .08 : focused ? 1 : e.source === origin || e.target === origin ? .18 : sameGroup ? .35 : .22}>
            <line data-kind={e.kind} data-source={e.source} data-target={e.target}
              x1={a.x + dx / length * radius(e.source)} y1={a.y + dy / length * radius(e.source)}
              x2={b.x - dx / length * (radius(e.target) + 5 / camera.zoom)} y2={b.y - dy / length * (radius(e.target) + 5 / camera.zoom)}
              stroke="currentColor" strokeWidth={(focused ? 2.2 : 1) / camera.zoom} strokeDasharray={e.kind === "citation" ? undefined : `${4 / camera.zoom} ${5 / camera.zoom}`}
              markerEnd={e.kind === "citation" ? `url(#${marker})` : undefined} />
          </g>;
        })}
        {nodes.map(n => {
          const p = positions[n.id]; if (!p) return null;
          const label = nodeLabels.get(n.id);
          const group = membership.get(n.id), count = citationCount(n, scope), color = group?.color ?? "var(--muted-foreground)";
          return <g key={n.id} data-node-id={n.id} data-group-id={group?.id} transform={`translate(${p.x} ${p.y})`} role="button" tabIndex={0}
            aria-label={`${n.title}${n.paper_id ? "、PDFあり" : ""}`} aria-pressed={n.id === selected}
            className="cursor-pointer outline-none focus:text-primary" opacity={active && n.id !== active && !neighbors.has(n.id) ? .45 : 1}
            onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(n.id)} onBlur={() => setHover(null)}
            onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(n.id); } }}>
            {n.id === selected && <circle r={radius(n.id) + 6 / camera.zoom} fill="none" stroke="var(--primary)" strokeWidth={2.5 / camera.zoom} />}
            {n.id === origin && <circle r={radius(n.id) + 3 / camera.zoom} fill="none" stroke="var(--primary)" strokeWidth={1 / camera.zoom} />}
            <circle data-node-circle data-citations={count ?? "unknown"} r={radius(n.id)} fill={n.id === origin ? "var(--primary)" : count === null ? "var(--background)" : `color-mix(in oklab, ${color} 24%, var(--background))`}
              stroke={n.id === active || n.id === origin ? "var(--primary)" : color} strokeWidth={(n.id === origin ? 2 : 1.6) / camera.zoom} />
            {n.id === origin && <text textAnchor="middle" y={3 / camera.zoom} fill="var(--primary-foreground)" fontSize={10 / camera.zoom}>起点</text>}
            {label && <text data-node-label x={label.x / camera.zoom} y={label.y / camera.zoom} textAnchor={label.anchor} fill="var(--foreground)" fontSize={12 / camera.zoom}
              stroke="var(--background)" strokeWidth={3 / camera.zoom} paintOrder="stroke">{labelText(n)}</text>}
            {n.paper_id && n.id !== origin && <g transform={`translate(${radius(n.id) * .8} ${radius(n.id) * .8}) scale(${1 / camera.zoom})`} aria-label="PDFあり" pointerEvents="none">
              <rect x="-5" y="-6" width="10" height="12" rx="1.5" fill="var(--background)" stroke="var(--primary)" strokeWidth=".8" />
              <path d="M-2.5,-3 H2.5 M-2.5,0 H2.5 M-2.5,3 H1" fill="none" stroke="var(--primary)" strokeWidth=".8" />
            </g>}
          </g>;
        })}
      </g>
      <g pointerEvents="none">
        {groupLabels.map(label => <g key={label.id} data-group-name={label.id}>
          <text data-group-label x={label.x} y={label.top + 14} textAnchor="middle" fontSize={12} fontWeight={500} fill="var(--foreground)" stroke="var(--background)" strokeWidth={2} paintOrder="stroke">
            {label.lines.map((line, i) => <tspan key={i} x={label.x} dy={i ? 15 : 0}>{line}</tspan>)}
          </text>
        </g>)}
      </g>
    </svg>
    </div>
    <div ref={footer} className="shrink-0">
    <div aria-label="論文の下見" className="border-t px-3 py-2 h-[3.5rem] shrink-0 text-xs flex items-center gap-3 min-w-0">
      <div className="flex-1 min-w-0 space-y-1">
      {preview ? <><p className="font-medium truncate">{preview.title}</p>
        <p className="truncate text-muted-foreground">{[preview.year, preview.first_author, rootReferences.has(preview.id) ? "直接引用" : "", `被引用 ${citationCount(preview, scope) ?? "未取得"}${citationCount(preview, scope) !== null ? "件" : ""}（${scope === "external" ? externalCitationSource(preview) : "ライブラリ内"}）`].filter(Boolean).join(" · ")}</p></>
        : <p className="text-muted-foreground">ノードにカーソルを合わせると文献を下見できます。クリックで詳細を開きます。</p>}
      </div>
      <div className="flex gap-1 shrink-0 bg-background rounded-lg border p-1">
        <Button variant="ghost" size="icon-sm" aria-label="縮小" onClick={() => zoom(1 / 1.2)}><Minus /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="拡大" onClick={() => zoom(1.2)}><Plus /></Button>
        <Button variant="ghost" size="sm" onClick={fit}><LocateFixed />全体を表示</Button>
      </div>
    </div>
    {groups.length > 0 && <div aria-label="グループの一覧" className="border-t px-3 py-2 flex flex-wrap gap-2 max-h-24 overflow-auto shrink-0">
      {groups.map((group, index) => <button key={group.id} className="inline-flex items-center gap-1.5 max-w-[48%] text-xs text-left rounded border px-2 py-1 hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
        title={groupName(group)} onClick={() => setCamera({ ...frameMap(nodes.filter(n => group.members.includes(n.id)), positions, size.width, size.height), manual: true })}>
        <span className="shrink-0 font-medium" style={{ color: group.color }}>{index + 1}</span><span className="truncate">{groupName(group)}</span><span className="shrink-0 text-muted-foreground">{group.members.length}論文</span>
      </button>)}
    </div>}
    <details className="border-t bg-background text-xs shrink-0" aria-label="論文のまとまり">
      <summary className="cursor-pointer px-2 py-1.5">つながりのまとまり · {groups.length ? `${groups.length}グループ` : "まだ確認できません"}</summary>
      <div className="p-3 space-y-3 max-h-[min(13rem,20vh)] overflow-auto"><p className="text-muted-foreground pb-1">図の名前と番号は引用のまとまりに対応します。下のグループ名を選ぶと、その周辺を拡大します。</p>
        {explanations.running && <p role="status">情報取得用のモデルで説明しています…</p>}
        {!explanations.enabled && groups.some(g => !explanations.descriptions[g.id]) && <p className="text-muted-foreground">設定の「論文情報の取得にAIを使う」をONにすると、情報取得用のモデルで共通点を説明します。</p>}
        {explanations.error && <p role="alert" className="text-destructive break-words">{explanations.error}</p>}
        {groups.map(group => { const explanation = explanations.descriptions[group.id], relation = groupRelation(group); return <div key={group.id} data-map-group-description={group.id}>
          <button className="w-full flex items-start gap-2 text-left rounded px-1 py-1.5 hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
            aria-label={`${groupName(group)}を拡大（${group.members.length}論文）`} title={group.representative}
            onClick={() => setCamera({ ...frameMap(nodes.filter(n => group.members.includes(n.id)), positions, size.width, size.height), manual: true })}>
            <span className="shrink-0 rounded border px-1 text-center" style={{ borderColor: group.color }}>{groups.indexOf(group) + 1}</span><span className="break-words">{groupName(group)} · {group.members.length}論文</span>
          </button>
          <p className="pl-5 text-muted-foreground break-words">起点との確認済み関係: 直接引用 {relation.direct}論文 · 起点を引用 {relation.incoming}論文 · 参考文献の先の引用 {relation.secondHop}論文 · 共通の参考文献 {relation.shared.size}件</p>
          {relation.shared.size > 0 && <details className="pl-5"><summary className="cursor-pointer text-muted-foreground">共通の参考文献を確認</summary>
            {[...relation.shared].map(id => <p key={id} className="break-words">{relationMetadata.get(id)?.title}</p>)}
          </details>}
          {explanation ? <div className="pl-5 space-y-1">
            <p className="leading-relaxed break-words">{explanation.description}</p>
            <details><summary className="cursor-pointer text-muted-foreground">説明の根拠 · AI生成{explanation.stale ? "（更新前）" : ""}</summary>
              <p className="text-muted-foreground break-words">情報取得用: {explanation.provider} / {explanation.model || "通常モデル"} · {(explanation.elapsed_ms / 1000).toFixed(1)}秒</p>
              {explanation.evidence.map(id => <p key={id} className="break-words">{metadata.get(id)?.title}</p>)}
            </details></div> : <p className="pl-5 text-muted-foreground break-words">代表的な論文: {group.representative}</p>}
        </div>; })}
        {explanations.enabled && groups.length > 0 && <Button variant="outline" size="sm" disabled={explanations.running} onClick={explanations.retry}>{explanations.error ? "説明を再試行" : "説明を更新"}</Button>}
      </div>
    </details>
    </div>
  </div>;
}

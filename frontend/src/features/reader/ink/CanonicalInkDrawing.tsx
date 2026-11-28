import type { InkObject } from '../../../runtime/edits/contracts.ts';
import { geometryPoints } from '../../../runtime/edits/annotationGeometry.ts';
import type { InkPageSize } from './canonicalInk.ts';

const asPicked = (color: string) => color;

/** Draw canonical point geometry directly in the overlay's width=1000 SVG coordinate space. */
export function CanonicalInkDrawing({ annotation, page, inkColor = asPicked }: {
  annotation: InkObject; page: InkPageSize; inkColor?: (color: string) => string;
}) {
  const g = annotation.geometry, t = annotation.transform, style = annotation.style;
  const scale = 1000 / page.widthPt, c = Math.cos(t.rotationRad), s = Math.sin(t.rotationRad);
  const transform = `matrix(${scale * c * t.scaleX} ${scale * s * t.scaleX} ${-scale * s * t.scaleY} ${scale * c * t.scaleY} ${scale * t.x} ${scale * t.y})`;
  const color = inkColor(style.color);
  return <g transform={transform} opacity={style.opacity}>
    {g.kind === 'text'
      ? g.text.split('\n').map((line, i) => <text key={i} x={0} y={g.fontSizePt * (.9 + i * 1.3)}
        fontFamily={g.fontFamily} fontSize={g.fontSizePt} fill={color} xmlSpace="preserve">{line}</text>)
      : <g fill="none" stroke={color} strokeWidth={style.widthPt} strokeLinecap="round" strokeLinejoin="round">
        {g.kind === 'rect' ? <rect width={g.widthPt} height={g.heightPt} />
          : g.kind === 'ellipse' ? <ellipse cx={g.widthPt / 2} cy={g.heightPt / 2} rx={g.widthPt / 2} ry={g.heightPt / 2} />
            : g.kind === 'path' && g.points.length === 1
              ? <circle cx={g.points[0].x} cy={g.points[0].y} r={style.widthPt / 2} fill={color} stroke="none" />
              : <polyline points={geometryPoints(g).map(p => `${p.x},${p.y}`).join(' ')} />}
      </g>}
  </g>;
}

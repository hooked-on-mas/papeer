import { useId } from 'react';
import type { Page, PaperSpec } from '../../runtime/edits/contracts';

const MM = 72 / 25.4;
const colors: Record<PaperSpec['color'], string> = { white: 'rgb(100% 100% 100%)', cream: 'rgb(100% 97% 88%)', dark: 'rgb(12% 14% 17%)' };
// Strictly exclude the end coordinate, as notebook.py's `while position < end` does.
const lastPosition = (start: number, end: number, step: number) => end > start ? start + (Math.ceil((end - start) / step) - 1) * step : null;

/** Physical point geometry matches notebook PDF paper without creating a PDF resource. */
export function CanonicalPaperBackground({ page }: { page: Pick<Page, 'widthPt' | 'heightPt' | 'background'> }) {
  const patternId = `paper-${useId()}`;
  if (page.background.kind !== 'paper') return null;
  const { template, color } = page.background.spec, width = page.widthPt, height = page.heightPt;
  const margin = 15 * MM, spacing = (template === 'grid10' ? 10 : template === 'ruled7' || template === 'cornell' ? 7 : template === 'ruled6' ? 6 : 5) * MM;
  const shade = color === 'dark' ? 'rgb(35% 39% 45%)' : 'rgb(75% 79% 83%)';
  const ruled = template.startsWith('ruled') || template === 'cornell';
  const bottom = height - (template === 'cornell' ? 35 * MM : margin);
  const grid = template.startsWith('grid'), dots = template === 'dot5';
  const firstY = ruled ? margin + spacing : margin;
  const lastY = ruled || grid || dots ? lastPosition(firstY, bottom, spacing) : null;
  const lastX = grid || dots ? lastPosition(margin, width - margin, spacing) : null;
  const lineWidth = Math.max(0, width - 2 * margin), lineHeight = Math.max(0, height - 2 * margin);
  return <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
    <rect width={width} height={height} fill={colors[color]} />
    <g stroke={shade} strokeWidth={.35} fill="none">
      {(ruled || grid) && lastY !== null && lineWidth > 0 && <>
        <defs><pattern id={`${patternId}-rows`} patternUnits="userSpaceOnUse" x={margin} y={firstY - spacing / 2} width={lineWidth} height={spacing}>
          <line x1={0} y1={spacing / 2} x2={lineWidth} y2={spacing / 2} stroke={shade} strokeWidth={.35} />
        </pattern></defs>
        <rect x={margin} y={firstY - .175} width={lineWidth} height={lastY - firstY + .35} stroke="none" fill={`url(#${patternId}-rows)`} />
      </>}
      {template === 'cornell' && <>
        <line x1={width * .28} y1={margin} x2={width * .28} y2={bottom} />
        <line x1={margin} y1={bottom} x2={width - margin} y2={bottom} />
      </>}
      {grid && lastX !== null && lineHeight > 0 && <>
        <defs><pattern id={`${patternId}-columns`} patternUnits="userSpaceOnUse" x={margin - spacing / 2} y={margin} width={spacing} height={lineHeight}>
          <line x1={spacing / 2} y1={0} x2={spacing / 2} y2={lineHeight} stroke={shade} strokeWidth={.35} />
        </pattern></defs>
        <rect x={margin - .175} y={margin} width={lastX - margin + .35} height={lineHeight} stroke="none" fill={`url(#${patternId}-columns)`} />
      </>}
      {dots && lastX !== null && lastY !== null && <>
        <defs><pattern id={`${patternId}-dots`} patternUnits="userSpaceOnUse" x={margin - spacing / 2} y={margin - spacing / 2} width={spacing} height={spacing}>
          <circle cx={spacing / 2} cy={spacing / 2} r={.45} stroke={shade} strokeWidth={.35} fill="none" />
        </pattern></defs>
        <rect x={margin - .625} y={margin - .625} width={lastX - margin + 1.25} height={lastY - margin + 1.25} stroke="none" fill={`url(#${patternId}-dots)`} />
      </>}
    </g>
  </svg>;
}

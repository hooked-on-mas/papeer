import { kindOf, textUnits, type InkStroke } from "./inkGeometry";

type InkColor = (color: string) => string;
const asPicked: InkColor = color => color;

export function InkDrawing({ stroke, ratio, inkColor = asPicked }: { stroke: InkStroke; ratio: number; inkColor?: InkColor }) {
  const height = 1000 * ratio;
  const color = inkColor(stroke.color);
  if (kindOf(stroke) === "text") {
    const [a, b, , d] = stroke.points;
    const lines = (stroke.text ?? "").split("\n"), units = Math.max(1, ...lines.map(textUnits));
    const ux = (b[0] - a[0]) * 1000, uy = (b[1] - a[1]) * height;
    const vx = (d[0] - a[0]) * 1000, vy = (d[1] - a[1]) * height;
    const size = Math.hypot(vx, vy) / (lines.length * 1.3), textWidth = units * size;
    const textHeight = lines.length * size * 1.3;
    if (!textWidth || !textHeight) return null;
    return <g transform={`matrix(${ux / textWidth} ${uy / textWidth} ${vx / textHeight} ${vy / textHeight} ${a[0] * 1000} ${a[1] * height})`}>
      {lines.map((line, i) => <text key={i} x={0} y={size * (0.9 + i * 1.3)} fontFamily="sans-serif" fontSize={size} fill={color}
        textLength={textUnits(line) * size || undefined} lengthAdjust="spacingAndGlyphs">{line}</text>)}
    </g>;
  }
  const opacity = kindOf(stroke) === "highlighter" ? 0.3 : 1;
  return stroke.points.length === 1
    ? <circle cx={stroke.points[0][0] * 1000} cy={stroke.points[0][1] * height} r={stroke.width * 500} fill={color} opacity={opacity} />
    : <polyline points={stroke.points.map(([x, y]) => `${x * 1000},${y * height}`).join(" ")} fill="none" stroke={color}
      strokeWidth={stroke.width * 1000} strokeLinecap="round" strokeLinejoin="round" opacity={opacity} />;
}


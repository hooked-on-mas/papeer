import { DEFAULT_PAPER, PAPER_SIZES, PAPER_TEMPLATES, type NotebookPaper } from "./notebooks";

const colors = { white: "#ffffff", cream: "#fff7e0", dark: "#1f242b" };

export function PaperPreview({ paper, className = "" }: { paper: NotebookPaper; className?: string }) {
  const spec = { ...DEFAULT_PAPER, ...paper };
  const landscape = spec.orientation === "landscape";
  const sizes = { A4: [210,297], B5: [182,257], A5: [148,210], Letter: [215.9,279.4], "16:9": [180,320] };
  const [short, long] = sizes[spec.size];
  const width = landscape ? long : short, height = (landscape ? short : long);
  const ruled = spec.template.startsWith("ruled") || spec.template === "cornell";
  const grid = spec.template.startsWith("grid"), dot = spec.template === "dot5";
  const spacing = spec.template === "grid10" ? 10 : (spec.template === "ruled7" || spec.template === "cornell") ? 7 : spec.template === "ruled6" ? 6 : 5;
  return <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${spec.size} ${spec.orientation === "portrait" ? "縦" : "横"} ${PAPER_TEMPLATES.find(([key]) => key === spec.template)?.[1] ?? ""}`} className={`border rounded shadow-sm ${className}`}>
    <defs><pattern id={`paper-${spec.template}-${spec.color}-${spec.orientation}`} width={spacing} height={spacing} patternUnits="userSpaceOnUse">
      {ruled && <path d={`M0 ${spacing}H${spacing}`} stroke="currentColor" strokeWidth=".4" />}
      {grid && <path d={`M0 ${spacing}H${spacing}V0`} fill="none" stroke="currentColor" strokeWidth=".4" />}
      {dot && <circle cx="1" cy="1" r=".45" fill="currentColor" />}
    </pattern></defs>
    <rect width={width} height={height} fill={colors[spec.color]} />
    <rect x="15" y="15" width={width-30} height={spec.template === "cornell" ? height-50 : height-30} fill={`url(#paper-${spec.template}-${spec.color}-${spec.orientation})`} color={spec.color === "dark" ? "#687381" : "#bdc9d3"} />
    {spec.template === "cornell" && <path d={`M${width*.28} 15V${height-35}M15 ${height-35}H${width-15}`} stroke="#9aa7b4" strokeWidth=".5" />}
  </svg>;
}

export function PaperSettings({ value, onChange }: { value: NotebookPaper; onChange: (value: NotebookPaper) => void }) {
  const paper = { ...DEFAULT_PAPER, ...value };
  return <div className="flex gap-5 items-start">
    <PaperPreview paper={paper} className="w-28 max-h-40 shrink-0" />
    <div className="grid grid-cols-2 gap-3 flex-1 text-sm">
      <label>サイズ<select aria-label="用紙サイズ" className="block border rounded p-1 w-full" value={paper.size} onChange={e => onChange({ ...paper, size: e.target.value as NotebookPaper["size"] })}>{PAPER_SIZES.map(size => <option key={size}>{size}</option>)}</select></label>
      <label>向き<select aria-label="用紙の向き" className="block border rounded p-1 w-full" value={paper.orientation} onChange={e => onChange({ ...paper, orientation: e.target.value as NotebookPaper["orientation"] })}><option value="portrait">縦</option><option value="landscape">横</option></select></label>
      <label className="col-span-2">罫線<select aria-label="罫線" className="block border rounded p-1 w-full" value={paper.template} onChange={e => onChange({ ...paper, template: e.target.value as NotebookPaper["template"] })}>{PAPER_TEMPLATES.map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label className="col-span-2">色<select aria-label="用紙色" className="block border rounded p-1 w-full" value={paper.color} onChange={e => onChange({ ...paper, color: e.target.value as NotebookPaper["color"] })}><option value="white">白</option><option value="cream">クリーム</option><option value="dark">ダーク</option></select></label>
    </div>
  </div>;
}

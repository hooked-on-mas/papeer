export function safePdfExternalUrl(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 8192) return null;
  try {
    const url = new URL(input);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function pdfLinkRect(viewport: { width: number; height: number; convertToViewportPoint(x: number, y: number): number[] }, value: unknown) {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite) || !(viewport.width > 0 && viewport.height > 0)) return null;
  const rect = [...viewport.convertToViewportPoint(value[0], value[1]), ...viewport.convertToViewportPoint(value[2], value[3])], [a, b, c, d] = rect;
  if (!rect.every(Number.isFinite)) return null;
  const x = Math.max(0, Math.min(1, Math.min(a, c) / viewport.width)), y = Math.max(0, Math.min(1, Math.min(b, d) / viewport.height));
  const right = Math.max(0, Math.min(1, Math.max(a, c) / viewport.width)), bottom = Math.max(0, Math.min(1, Math.max(b, d) / viewport.height));
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

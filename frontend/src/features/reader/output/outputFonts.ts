import type { Page } from '../../../runtime/edits/contracts.ts';

export type OutputFont = { family: string; bytes: Uint8Array };
function base64(bytes: Uint8Array) {
  let value = ''; for (let offset = 0; offset < bytes.length; offset += 8192) value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(value);
}
export function captureFontStyles(pages: readonly Page[], fonts: readonly OutputFont[]): { pages: Page[]; css: string } {
  const names = new Map(fonts.map((font, index) => [font.family, `PapeerCapture${index}`]));
  const copied = structuredClone(pages) as Page[];
  for (const page of copied) for (const annotation of page.annotations) if (annotation.kind === 'ink' && annotation.geometry.kind === 'text') {
    const family = names.get(annotation.geometry.fontFamily); if (!family) throw new Error(`output-font-unavailable:${annotation.geometry.fontFamily}`);
    annotation.geometry.fontFamily = family;
  }
  return { pages: copied, css: fonts.map(font => {
    const trueType = font.bytes[0] === 0 && font.bytes[1] === 1;
    return `@font-face{font-family:${names.get(font.family)};src:url(data:font/${trueType ? 'ttf' : 'otf'};base64,${base64(font.bytes)}) format('${trueType ? 'truetype' : 'opentype'}')}`;
  }).join('\n') };
}

type NodeEvidence = {
  node: Node;
  parent: Node | null;
  children: readonly Node[];
  text: string | null;
};

type RenderEvidence = {
  page: HTMLElement;
  layer: HTMLElement;
  nodes: readonly NodeEvidence[];
};

/** Facts belong to one drawing. They cannot authorize fonts, raster or capture. */
export type PdfTextLayerCompletion<Page, Text> = {
  page: Page | null;
  text: Text | null;
  rendered: RenderEvidence | null;
  notified: boolean;
  invalid: boolean;
};

export function createPdfTextLayerCompletion<Page, Text>(): PdfTextLayerCompletion<Page, Text> {
  return { page: null, text: null, rendered: null, notified: false, invalid: false };
}

export function invalidatePdfTextLayerCompletion<Page, Text>(facts: PdfTextLayerCompletion<Page, Text>) {
  facts.invalid = true;
  facts.rendered = null;
  facts.page = null;
  facts.text = null;
}

/** Called only by the actual text-render success callback, never page/text load. */
export function recordPdfTextLayerRendered<Page, Text>(facts: PdfTextLayerCompletion<Page, Text>, page: HTMLElement | null) {
  if (facts.invalid || facts.notified || !page?.isConnected) return;
  const layer = page.querySelector<HTMLElement>('.textLayer');
  if (!layer?.isConnected || layer.parentNode !== page) return;
  const nodes: NodeEvidence[] = [];
  const visit = (node: Node) => {
    const children = Array.from(node.childNodes);
    nodes.push({ node, parent: node.parentNode, children, text: node.textContent });
    children.forEach(visit);
  };
  visit(layer);
  facts.rendered = { page, layer, nodes };
}

/** Validate actual completion evidence even after its first notification. */
export function currentPdfTextLayerCompletion<Page, Text>(facts: PdfTextLayerCompletion<Page, Text>, page: HTMLElement | null,
  isCurrent: () => boolean): { page: Page; text: Text; layer: HTMLElement } | null {
  if (facts.invalid || !facts.page || !facts.text || !isCurrent()) return null;
  const rendered = facts.rendered;
  if (!rendered || rendered.page !== page || !page?.isConnected || !rendered.layer.isConnected
    || page.querySelector('.textLayer') !== rendered.layer || rendered.layer.parentNode !== page) return null;
  for (const evidence of rendered.nodes) {
    if (evidence.node.parentNode !== evidence.parent || evidence.node.textContent !== evidence.text
      || evidence.node.childNodes.length !== evidence.children.length
      || evidence.children.some((child, index) => evidence.node.childNodes[index] !== child)) return null;
  }
  return { page: facts.page, text: facts.text, layer: rendered.layer };
}

/** Font settlement may refit this witness, but cannot record or notify a render. */
export function refitCompletedPdfTextLayer<Page, Text>(facts: PdfTextLayerCompletion<Page, Text>, page: HTMLElement | null,
  isCurrent: () => boolean, refit: (page: Page, text: Text, layer: HTMLElement) => void): boolean {
  if (!facts.notified) return false;
  const current = currentPdfTextLayerCompletion(facts, page, isCurrent);
  if (!current) return false;
  refit(current.page, current.text, current.layer);
  return currentPdfTextLayerCompletion(facts, page, isCurrent) !== null;
}

/** Join three independent callbacks without inventing a render completion. */
export function completePdfTextLayer<Page, Text>(facts: PdfTextLayerCompletion<Page, Text>, page: HTMLElement | null,
  isCurrent: () => boolean, complete: (page: Page, text: Text, layer: HTMLElement) => void): boolean {
  if (facts.notified) return false;
  const current = currentPdfTextLayerCompletion(facts, page, isCurrent);
  if (!current) return false;
  // Claim before calling the hook: publication can synchronously trigger work.
  facts.notified = true;
  complete(current.page, current.text, current.layer);
  return true;
}

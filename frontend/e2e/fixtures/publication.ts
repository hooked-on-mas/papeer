import mermaid from "mermaid";
import katex from "katex";

async function run() {
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", layout: "dagre" });
  const normal = await mermaid.render("normal-diagram", "flowchart LR\n  A[Original] --> B[Translation]");
  document.getElementById("diagram")!.innerHTML = normal.svg;
  const math = katex.renderToString("\\frac{a}{b}+x^2", { throwOnError: true });
  let elkError = "";
  try {
    await mermaid.render("elk-diagram", "---\nconfig:\n  layout: elk\n---\nflowchart LR\n  A --> B");
  } catch (error) { elkError = String(error); }
  return { svg: normal.svg, math, elkError };
}

Object.assign(window, { publicationResult: await run() });

// Stands in for react-pdf, which needs a browser DOM as soon as it loads, in tests/renderSmoke.
import { createElement } from "react";

export const pdfjs = { GlobalWorkerOptions: {} };
export const Document = ({ children }) => createElement("div", { "data-stub": "document" }, children);
export const Page = () => createElement("div", { "data-stub": "page" });

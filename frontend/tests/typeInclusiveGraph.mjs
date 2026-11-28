import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { localDependency } from './boundaryVerifier.mjs';

/** Import closure that also follows type-only imports/exports. `moduleGraph` (boundaryVerifier.mjs) is the runtime graph and skips them;
 * this graph answers a different question: "does any module reachable from the entry mention this file, even only as a type?".
 * Only static `import`/`export ... from` and literal `import('...')` are followed (same literal-only limit as `moduleGraph`). */
export function typeInclusiveFiles(root, src) {
  const files = new Set(), pending = [root];
  while (pending.length) {
    const file = pending.pop(); if (files.has(file)) continue;
    files.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = node => {
      let name;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) name = node.moduleSpecifier.text;
      else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) name = node.arguments[0].text;
      const target = name && localDependency(file, name, src);
      if (target) pending.push(target);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return files;
}

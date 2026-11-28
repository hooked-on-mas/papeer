import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const sourceFile = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const runtimeImport = node => !node.importClause || (!node.importClause.isTypeOnly &&
  (!!node.importClause.name || !node.importClause.namedBindings || ts.isNamespaceImport(node.importClause.namedBindings) ||
    node.importClause.namedBindings.elements.length === 0 || node.importClause.namedBindings.elements.some(item => !item.isTypeOnly)));
const runtimeExport = node => !node.isTypeOnly && (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.exportClause.elements.length === 0 || node.exportClause.elements.some(item => !item.isTypeOnly));

/** Keep external imports in the analysis even though only local modules have graph edges. */
export function moduleReferences(source) {
  const result = [];
  const add = node => result.push({ name: node && ts.isStringLiteralLike(node) ? node.text : undefined, node });
  const visit = node => {
    // A literal module worker URL is an execution edge, unlike ordinary URL assets.
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Worker') {
      const url = node.arguments?.[0];
      if (url && ts.isNewExpression(url) && ts.isIdentifier(url.expression) && url.expression.text === 'URL'
        && url.arguments?.length === 2 && ts.isStringLiteralLike(url.arguments[0])
        && /\.(?:ts|tsx|js)$/.test(url.arguments[0].text)
        && ts.isPropertyAccessExpression(url.arguments[1]) && url.arguments[1].name.text === 'url'
        && ts.isMetaProperty(url.arguments[1].expression) && url.arguments[1].expression.keywordToken === ts.SyntaxKind.ImportKeyword
        && url.arguments[1].expression.name.text === 'meta') add(url.arguments[0]);
    }
    if (ts.isImportDeclaration(node) && runtimeImport(node)) add(node.moduleSpecifier);
    if (ts.isExportDeclaration(node) && runtimeExport(node) && node.moduleSpecifier) add(node.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source); return result;
}

export function localDependency(file, name, src) {
  if (!name) return undefined;
  const base = name.startsWith('@/') ? path.join(src, name.slice(2)) : name.startsWith('.') ? path.resolve(path.dirname(file), name) : undefined;
  return base && [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]
    .find(value => existsSync(value) && /\.(?:ts|tsx|js)$/.test(value));
}

export function moduleGraph(root, src) {
  const files = new Set(), pending = [root], edges = [];
  while (pending.length) {
    const file = pending.pop(); if (files.has(file)) continue;
    files.add(file);
    for (const { name } of moduleReferences(sourceFile(file, readFileSync(file, 'utf8')))) {
      const target = localDependency(file, name, src);
      if (target) { edges.push([file, target]); pending.push(target); }
    }
  }
  return { files, edges };
}

const uiPackages = new Set(['react', 'react-dom', 'lucide-react', 'codemirror', 'zustand', '@codemirror/state', '@codemirror/view',
  '@codemirror/lang-markdown', '@codemirror/search', '@base-ui/react', 'class-variance-authority', 'cn', 'react-resizable-panels']);
const packageName = name => name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
const hostGlobals = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'localStorage', 'sessionStorage', 'indexedDB', 'caches',
  'Worker', 'SharedWorker', 'BroadcastChannel', 'importScripts', 'require', 'process', 'Deno', 'Bun', 'eval', 'Function']);
const domGlobals = new Set(['Element', 'HTMLElement', 'Node', 'Document', 'Image', 'Audio', 'DOMParser', 'ResizeObserver', 'MutationObserver',
  'IntersectionObserver', 'getComputedStyle', 'getSelection', 'requestAnimationFrame', 'cancelAnimationFrame']);
const ambientRoots = new Set(['window', 'document', 'navigator', 'globalThis', 'self', 'global']);
const forbiddenMembers = new Set([...hostGlobals, 'cookie', 'cookieStore', 'sendBeacon', 'serviceWorker', 'storage', 'clipboard', 'location', '__TAURI_INTERNALS__']);
const uiRootMembers = {
  window: new Set(['addEventListener', 'removeEventListener', 'dispatchEvent', 'getSelection', 'getComputedStyle', 'matchMedia',
    'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'innerWidth', 'innerHeight',
    'devicePixelRatio', 'visualViewport', 'scrollX', 'scrollY', 'scrollTo', 'document', 'navigator']),
  document: new Set(['addEventListener', 'removeEventListener', 'dispatchEvent', 'createElement', 'createTextNode', 'createRange',
    'createTreeWalker', 'getElementById', 'querySelector', 'querySelectorAll', 'getSelection', 'elementFromPoint', 'elementsFromPoint', 'activeElement',
    'body', 'documentElement', 'hidden', 'visibilityState', 'fonts']),
  navigator: new Set(['userAgent', 'platform', 'maxTouchPoints', 'language', 'languages']),
};
const standardGlobals = new Set(['crypto', 'structuredClone', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask']);

/** AST and lexical symbols avoid matching comments, schema strings, property names,
 * or an injected port/parameter named document/fetch. Types create no runtime edge. */
export function boundaryViolations(text, { file = 'fixture.ts', layer = 'domain', allowedUiPackages = [], allowedPackages = [] } = {}) {
  file = path.resolve(file).replaceAll('\\', '/');
  const source = sourceFile(file, text);
  const options = { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest };
  const host = { ...ts.createCompilerHost(options), getSourceFile: name => name === file ? source : undefined, writeFile() {} };
  const checker = ts.createProgram([file], options, host).getTypeChecker();
  const errors = [];
  const report = (node, message) => { const point = source.getLineAndCharacterOfPosition(node?.getStart(source) ?? 0); errors.push(`${file}:${point.line + 1}:${point.character + 1} ${message}`); };
  for (const { name, node } of moduleReferences(source)) {
    if (!name) report(node, 'computed module loading is forbidden');
    else if (!name.startsWith('.') && !name.startsWith('@/') && !allowedPackages.includes(name) && (layer !== 'ui' || (!uiPackages.has(packageName(name)) && !allowedUiPackages.includes(packageName(name))) || name.startsWith('zustand/'))) report(node, `forbidden runtime package: ${name}`);
    else if (layer !== 'ui' && /\.(css|svg|png)$/.test(name)) report(node, `UI asset in domain: ${name}`);
  }
  const local = node => {
    const symbol = ts.isShorthandPropertyAssignment(node.parent) ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
    return symbol?.declarations?.some(declaration => declaration.getSourceFile() === source &&
      !(ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient));
  };
  const isName = node => {
    const parent = node.parent;
    return (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node);
  };
  const visit = node => {
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) return;
    if (ts.isIdentifier(node) && (hostGlobals.has(node.text) || ambientRoots.has(node.text) || domGlobals.has(node.text)) && !isName(node) && !local(node)) {
      const name = node.text;
      if (hostGlobals.has(name)) report(node, `host global requires an injected port: ${name}`);
      if (layer !== 'ui' && domGlobals.has(name)) report(node, `DOM global in domain: ${name}`);
      if (ambientRoots.has(name)) {
        const members = []; let expression = node;
        while (true) {
          const parent = expression.parent;
          if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent)) { expression = parent; continue; }
          if (ts.isPropertyAccessExpression(parent) && parent.expression === expression) { members.push(parent.name.text); expression = parent; continue; }
          if (ts.isElementAccessExpression(parent) && parent.expression === expression) { members.push(ts.isStringLiteralLike(parent.argumentExpression) ? parent.argumentExpression.text : undefined); expression = parent; continue; }
          break;
        }
        let root = name === 'self' ? 'window' : name;
        if (layer === 'worker' && name === 'self' && members.length === 1 && ['onmessage', 'postMessage'].includes(members[0])) {
          // Only the dedicated worker envelope may use these two worker operations.
        } else if (root === 'globalThis' && standardGlobals.has(members[0])) {
          if (members.some(member => forbiddenMembers.has(member))) report(node, 'host member requires an injected port');
        } else {
          if (root === 'globalThis' && ['window', 'document', 'navigator'].includes(members[0])) root = members.shift();
          if (layer !== 'ui' || !uiRootMembers[root]?.has(members[0]) || members.some(member => member === undefined || forbiddenMembers.has(member))) {
            report(node, `forbidden ${layer} global access: ${name}`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source); return errors;
}

export function graphBoundaryViolations(root, src, { layer = 'domain', allowedUiPackages = [], allowedPackagesByModule = {}, forbiddenPaths = /^(api|store|web|adapters|migrations)\// } = {}) {
  const errors = [];
  for (const file of moduleGraph(root, src).files) {
    const relative = path.relative(src, file).replaceAll('\\', '/');
    if (forbiddenPaths.test(relative)) errors.push(`${root} → forbidden module ${relative}`);
    errors.push(...boundaryViolations(readFileSync(file, 'utf8'), { file, layer, allowedUiPackages, allowedPackages: allowedPackagesByModule[relative] ?? [] }));
    for (const { name } of moduleReferences(sourceFile(file, readFileSync(file, 'utf8')))) {
      if (name && (name.startsWith('.') || name.startsWith('@/')) && !/\.(css|svg|png)$/.test(name) && !localDependency(file, name, src)) errors.push(`${file}: unresolved local module ${name}`);
    }
  }
  return errors;
}

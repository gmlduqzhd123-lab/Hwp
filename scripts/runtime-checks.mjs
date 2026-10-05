// Inspect executable/resource contexts rather than informational namespace or license URLs.
import ts from 'typescript';

export const credentialPattern = /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/;

function decodeHtml(value) {
  return value.replace(/&(?:#(x[0-9a-f]+|[0-9]+)|([a-z]+));/gi, (entity, numeric, named) => {
    if (numeric) {
      const code = numeric[0].toLowerCase() === 'x' ? Number.parseInt(numeric.slice(1), 16) : Number(numeric);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', colon: ':', sol: '/', bsol: '\\', tab: '\t', newline: '\n' }[named.toLowerCase()] ?? entity;
  });
}

function attributes(text) {
  const values = new Map();
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of text.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    if (values.has(name)) throw new Error('Duplicate HTML attribute.');
    values.set(name, decodeHtml(match[2] ?? match[3] ?? match[4]));
  }
  return values;
}

function localResource(value, allowImageData = false) {
  const normalized = value.trim().replace(/[\u0000-\u0020\u007f]/g, '').replace(/\\/g, '/');
  if (allowImageData && /^data:image\/(?:svg\+xml|png|jpeg|gif|webp)[;,]/i.test(normalized)) return true;
  return !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(normalized);
}

function requireLocal(value, path, allowImageData = false) {
  if (!localResource(value, allowImageData)) throw new Error(`Remote or unsupported runtime resource: ${path}`);
}

export function inspectResources(text, extension, path) {
  if (extension === '.html') {
    const markup = text.replace(/<!--[\s\S]*?-->/g, '');
    for (const tag of markup.matchAll(/<([a-z][\w:-]*)\b([^>]*)>/gi)) {
      const name = tag[1].toLowerCase();
      const attrs = attributes(tag[2]);
      if (name === 'base' || name === 'iframe' || name === 'object' || name === 'embed') {
        throw new Error(`Unsupported active HTML element: ${path}`);
      }
      for (const [key, value] of attrs) {
        if (/^on/i.test(key) || key === 'srcdoc') throw new Error(`Inline execution attribute: ${path}`);
        if (key === 'style') inspectResources(value, '.css', path);
        if (key === 'src' || (key === 'href' && ['link', 'image', 'use'].includes(name)) || key === 'xlink:href') {
          requireLocal(value, path, name === 'img' || (name === 'link' && attrs.get('rel') === 'icon'));
        }
        if (key === 'srcset') {
          for (const candidate of value.split(',')) requireLocal(candidate.trim().split(/\s+/)[0], path);
        }
      }
      if (name === 'script' && !attrs.has('src')) throw new Error(`Inline script in app entry: ${path}`);
      if (name === 'meta' && attrs.get('http-equiv')?.toLowerCase() === 'refresh') throw new Error(`HTML refresh: ${path}`);
    }
    for (const style of markup.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) inspectResources(style[1], '.css', path);
  } else if (extension === '.css') {
    const css = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\\([0-9a-f]{1,6})\s?|\\([^\r\n])/gi,
      (_, hex, character) => hex ? String.fromCodePoint(Number.parseInt(hex, 16) || 0xfffd) : character);
    for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)|@import\s+["']([^"']+)["']/gi)) {
      requireLocal(match[1] ?? match[2] ?? match[3] ?? match[4], path, true);
    }
  } else if (/\.(?:[cm]?tsx?|jsx?)$/.test(extension)) {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true,
      /\.[jt]sx$/.test(extension) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const resourceCalls = new Set(['fetch', 'importScripts', 'Worker', 'SharedWorker', 'WebSocket', 'EventSource', 'URL']);
    function inspectLiteral(node) {
      if (node && (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node))) {
        requireLocal(ts.isTemplateExpression(node) ? node.head.text : node.text, path);
      }
    }
    function visit(node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) inspectLiteral(node.moduleSpecifier);
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const expression = node.expression;
        if (expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(expression) && resourceCalls.has(expression.text))
          || (ts.isPropertyAccessExpression(expression) && resourceCalls.has(expression.name.text))) {
          for (const argument of node.arguments ?? []) inspectLiteral(argument);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}

export function requireProductionPolicy(html) {
  const expected = new Map([
    ['default-src', ["'none'"]], ['script-src', ["'self'"]], ['style-src', ["'self'"]],
    ['img-src', ["'self'", 'blob:', 'data:']], ['font-src', ["'self'"]], ['worker-src', ["'self'", 'blob:']], ['manifest-src', ["'self'"]],
    ['connect-src', ["'none'"]], ['object-src', ["'none'"]], ['base-uri', ["'none'"]], ['form-action', ["'none'"]],
  ]);
  const policies = [];
  const markup = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const match of markup.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = attributes(match[1]);
    if (attrs.get('http-equiv')?.toLowerCase() === 'content-security-policy') {
      policies.push({ content: attrs.get('content') ?? '', index: match.index });
    }
  }
  if (policies.length !== 1 || (/<script\b/i.test(markup) && policies[0].index > markup.search(/<script\b/i))) {
    throw new Error('Missing production policy before scripts.');
  }
  const actual = new Map();
  for (const directive of policies[0].content.split(';').filter((value) => value.trim())) {
    const [name, ...values] = directive.trim().split(/\s+/);
    if (actual.has(name)) throw new Error('Duplicate production policy directive.');
    actual.set(name, values);
  }
  if (actual.size !== expected.size || [...expected].some(([name, values]) => {
    const tokens = actual.get(name);
    return !tokens || tokens.length !== values.length || values.some((value) => !tokens.includes(value));
  })) throw new Error('Unexpected production execution or resource policy.');
}

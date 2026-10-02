import { invalidPackage } from './errors';

/** ZIP paths and package references are local names, never web URLs. */
export function assertSafePath(path: string, allowDirectory = true): string {
  if (!path || path.startsWith('/') || /[\\\u0000-\u001f\u007f:%?#]/u.test(path)) invalidPackage();
  const isDirectory = path.endsWith('/');
  if (isDirectory && !allowDirectory) invalidPackage();
  const parts = (isDirectory ? path.slice(0, -1) : path).split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/u.test(part))) invalidPackage();
  return path;
}

export function normalizedPathKey(path: string): string {
  // A directory marker cannot distinguish a file from a directory at the same path.
  return path.replace(/\/$/u, '').normalize('NFC').toLowerCase();
}

export function isXmlPath(path: string): boolean {
  return /\.(?:xml|hpf|opf|rdf)$/iu.test(path);
}

/** Confirmed ZIP-root and package-relative rules; existing targets decide without guessing. */
export function resolvePackageReference(packagePath: string, href: string, paths: ReadonlySet<string>): string {
  assertSafePath(packagePath, false);
  assertSafePath(href, false);
  const slash = packagePath.lastIndexOf('/');
  const relative = assertSafePath(`${slash < 0 ? '' : packagePath.slice(0, slash + 1)}${href}`, false);
  const candidates = new Set([href, relative].filter((path) => paths.has(path)));
  const resolved = [...candidates][0];
  if (candidates.size !== 1 || !resolved) invalidPackage();
  return resolved;
}

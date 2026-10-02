import type { XmlDocument, XmlElement } from '../xml/validate';
import { invalidPackage } from './errors';
import { assertSafePath, resolvePackageReference } from './paths';

export const PACKAGE_NAMESPACES = Object.freeze({
  container: 'urn:oasis:names:tc:opendocument:xmlns:container',
  opf: 'http://www.idpf.org/2007/opf',
  version: 'http://www.hancom.co.kr/hwpml/2011/version',
  head: 'http://www.hancom.co.kr/hwpml/2011/head',
  section: 'http://www.hancom.co.kr/hwpml/2011/section',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
});

export function isOpfNamespace(uri: string): boolean {
  return uri === PACKAGE_NAMESPACES.opf || uri === 'http://www.idpf.org/2007/opf/';
}

const AUXILIARY_ROOTFILE_TYPES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'Preview/PrvText.txt': ['text/plain', 'text/xml'],
  'Preview/PrvImage.png': ['image/png'],
  'META-INF/container.rdf': ['application/rdf+xml'],
});

export interface XmlSummary {
  root: XmlElement;
  /** Only the small package identity documents need their complete element list retained. */
  identityDocument?: XmlDocument;
}

function rootIs(summary: XmlSummary | undefined, local: string, uri: string): summary is XmlSummary {
  return summary?.root.local === local && summary.root.uri === uri;
}

function directChildren(parent: XmlElement, elements: readonly XmlElement[]): XmlElement[] {
  const result: XmlElement[] = [];
  let previousEnd = parent.start;
  for (const element of elements) {
    if (element.start > parent.start && element.end <= parent.end && element.start >= previousEnd) {
      result.push(element);
      previousEnd = element.end;
    }
  }
  return result;
}

function oneChild(parent: XmlElement, elements: readonly XmlElement[], local: string, uri: string): XmlElement {
  const matches = directChildren(parent, elements).filter((element) => element.local === local && element.uri === uri);
  const match = matches[0];
  if (matches.length !== 1 || !match) invalidPackage();
  return match;
}

export function inspectPackageIdentity(paths: ReadonlySet<string>, documents: ReadonlyMap<string, XmlSummary>): { headerPath: string; sectionPaths: string[]; formatVersion: string } {
  const version = documents.get('version.xml');
  if (!rootIs(version, 'HCFVersion', PACKAGE_NAMESPACES.version)) invalidPackage();
  // Hancom's public model also writes the historical spelling "tagetApplication".
  const applications = [version.root.attributes.targetApplication, version.root.attributes.tagetApplication].filter((value) => value !== undefined);
  if (applications.some((value) => value !== 'WORDPROCESSOR')) invalidPackage();
  const build = version.root.attributes.buildNumber ?? version.root.attributes.build;
  if (version.root.attributes.buildNumber && version.root.attributes.build && version.root.attributes.buildNumber !== version.root.attributes.build) invalidPackage();
  const versionParts = [...['major', 'minor', 'micro'].map((name) => version.root.attributes[name]), build];
  if (versionParts.some((part) => !part || !/^\d{1,4}$/u.test(part)) || !/^\d{1,4}\.\d{1,4}$/u.test(version.root.attributes.xmlVersion ?? '')) invalidPackage();

  const container = documents.get('META-INF/container.xml');
  if (!rootIs(container, 'container', PACKAGE_NAMESPACES.container) || !container.identityDocument) invalidPackage();
  const containerElements = container.identityDocument.elements;
  if (containerElements.some((element) => element.attributes['xml:base'] !== undefined)) invalidPackage();
  const rootfiles = oneChild(container.root, containerElements, 'rootfiles', PACKAGE_NAMESPACES.container);
  let packagePath: string | undefined;
  let packageDocument: XmlSummary | undefined;
  const declaredRootPaths = new Set<string>();
  for (const rootfile of directChildren(rootfiles, containerElements)) {
    if (rootfile.local !== 'rootfile' || rootfile.uri !== PACKAGE_NAMESPACES.container) invalidPackage();
    const path = assertSafePath(rootfile.attributes['full-path'] ?? '', false);
    if (!paths.has(path) || declaredRootPaths.has(path)) invalidPackage();
    declaredRootPaths.add(path);
    const mediaType = rootfile.attributes['media-type']?.toLowerCase();
    const summary = documents.get(path);
    if (summary?.root.local === 'package' && isOpfNamespace(summary.root.uri)) {
      if (packagePath !== undefined || (mediaType !== undefined && mediaType !== 'application/hwpml-package+xml')) invalidPackage();
      packagePath = path;
      packageDocument = summary;
    } else {
      if (!mediaType || !Object.hasOwn(AUXILIARY_ROOTFILE_TYPES, path) || !AUXILIARY_ROOTFILE_TYPES[path]?.includes(mediaType)) invalidPackage();
      if (path === 'META-INF/container.rdf' && !rootIs(summary, 'RDF', PACKAGE_NAMESPACES.rdf)) invalidPackage();
    }
  }
  if (!packagePath || !packageDocument?.identityDocument) invalidPackage();
  const packageElements = packageDocument.identityDocument.elements;
  if (packageElements.some((element) => element.attributes['xml:base'] !== undefined)) invalidPackage();
  const opfNamespace = packageDocument.root.uri;
  if (packageElements.some((element) => isOpfNamespace(element.uri) && element.uri !== opfNamespace)) invalidPackage();
  const manifest = oneChild(packageDocument.root, packageElements, 'manifest', opfNamespace);
  const spine = oneChild(packageDocument.root, packageElements, 'spine', opfNamespace);
  const items = directChildren(manifest, packageElements).filter((element) => element.local === 'item' && element.uri === opfNamespace);
  const itemsById = new Map<string, string>();
  const manifestPaths = new Set<string>();
  const declaredSections = new Set<string>();
  let header: XmlSummary | undefined;
  let headerPath: string | undefined;
  for (const item of items) {
    const id = item.attributes.id;
    if (!id || itemsById.has(id)) invalidPackage();
    const path = resolvePackageReference(packagePath, item.attributes.href ?? '', paths);
    if (!paths.has(path) || manifestPaths.has(path)) invalidPackage();
    itemsById.set(id, path);
    manifestPaths.add(path);
    const summary = documents.get(path);
    const isHeader = rootIs(summary, 'head', PACKAGE_NAMESPACES.head);
    const isSection = rootIs(summary, 'sec', PACKAGE_NAMESPACES.section);
    if ((isHeader || isSection) && item.attributes['media-type'] !== undefined
      && !/^(?:application|text)\/(?:xml|[a-z0-9!#$&^_.+-]+\+xml)$/iu.test(item.attributes['media-type'])) invalidPackage();
    if (isHeader) {
      if (header) invalidPackage();
      header = summary;
      headerPath = path;
    }
    if (isSection) declaredSections.add(path);
  }
  if (!header || !headerPath) invalidPackage();
  const sectionPaths: string[] = [];
  const seenSpinePaths = new Set<string>();
  const seenSections = new Set<string>();
  for (const itemref of directChildren(spine, packageElements)) {
    if (itemref.local !== 'itemref' || itemref.uri !== opfNamespace) invalidPackage();
    const path = itemsById.get(itemref.attributes.idref ?? '');
    if (!path || seenSpinePaths.has(path)) invalidPackage();
    seenSpinePaths.add(path);
    const summary = documents.get(path);
    if (summary === header) continue;
    if (!rootIs(summary, 'sec', PACKAGE_NAMESPACES.section)) invalidPackage();
    seenSections.add(path);
    sectionPaths.push(path);
  }
  if (!sectionPaths.length || seenSections.size !== declaredSections.size) invalidPackage();
  const headerVersion = header.root.attributes.version;
  const sectionCount = header.root.attributes.secCnt;
  if (headerVersion !== undefined && headerVersion !== version.root.attributes.xmlVersion) invalidPackage();
  if (sectionCount !== undefined && (!/^\d{1,10}$/u.test(sectionCount) || Number(sectionCount) !== sectionPaths.length)) invalidPackage();
  return { headerPath, sectionPaths, formatVersion: versionParts.join('.') };
}

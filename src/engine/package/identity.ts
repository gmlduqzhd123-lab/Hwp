import type { XmlDocument, XmlElement } from '../xml/validate';
import { invalidPackage } from './errors';
import { assertSafePath, resolvePackageReference } from './paths';

export const PACKAGE_NAMESPACES = Object.freeze({
  container: 'urn:oasis:names:tc:opendocument:xmlns:container',
  opf: 'http://www.idpf.org/2007/opf',
  version: 'http://www.hancom.co.kr/hwpml/2011/version',
  head: 'http://www.hancom.co.kr/hwpml/2011/head',
  section: 'http://www.hancom.co.kr/hwpml/2011/section',
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

export function inspectPackageIdentity(paths: ReadonlySet<string>, documents: ReadonlyMap<string, XmlSummary>): { sectionPaths: string[]; formatVersion: string } {
  const version = documents.get('version.xml');
  if (!rootIs(version, 'HCFVersion', PACKAGE_NAMESPACES.version)) invalidPackage();
  if (version.root.attributes.targetApplication !== undefined && version.root.attributes.targetApplication !== 'WORDPROCESSOR') invalidPackage();
  const build = version.root.attributes.buildNumber ?? version.root.attributes.build;
  if (version.root.attributes.buildNumber && version.root.attributes.build && version.root.attributes.buildNumber !== version.root.attributes.build) invalidPackage();
  const versionParts = [...['major', 'minor', 'micro'].map((name) => version.root.attributes[name]), build];
  if (versionParts.some((part) => !part || !/^\d{1,4}$/u.test(part)) || !/^\d{1,4}\.\d{1,4}$/u.test(version.root.attributes.xmlVersion ?? '')) invalidPackage();

  const container = documents.get('META-INF/container.xml');
  if (!rootIs(container, 'container', PACKAGE_NAMESPACES.container) || !container.identityDocument) invalidPackage();
  const containerElements = container.identityDocument.elements;
  if (containerElements.some((element) => element.attributes['xml:base'] !== undefined)) invalidPackage();
  const rootfiles = oneChild(container.root, containerElements, 'rootfiles', PACKAGE_NAMESPACES.container);
  const rootfile = oneChild(rootfiles, containerElements, 'rootfile', PACKAGE_NAMESPACES.container);
  if (rootfile.attributes['media-type'] !== undefined && rootfile.attributes['media-type'].toLowerCase() !== 'application/hwpml-package+xml') invalidPackage();
  const packagePath = assertSafePath(rootfile.attributes['full-path'] ?? '', false);
  if (!paths.has(packagePath)) invalidPackage();
  const packageDocument = documents.get(packagePath);
  if (!rootIs(packageDocument, 'package', PACKAGE_NAMESPACES.opf) || !packageDocument.identityDocument) invalidPackage();
  const packageElements = packageDocument.identityDocument.elements;
  if (packageElements.some((element) => element.attributes['xml:base'] !== undefined)) invalidPackage();
  const manifest = oneChild(packageDocument.root, packageElements, 'manifest', PACKAGE_NAMESPACES.opf);
  const spine = oneChild(packageDocument.root, packageElements, 'spine', PACKAGE_NAMESPACES.opf);
  const items = directChildren(manifest, packageElements).filter((element) => element.local === 'item' && element.uri === PACKAGE_NAMESPACES.opf);
  const itemsById = new Map<string, string>();
  const manifestPaths = new Set<string>();
  const declaredSections = new Set<string>();
  let header: XmlSummary | undefined;
  for (const item of items) {
    const id = item.attributes.id;
    if (!id || itemsById.has(id)) invalidPackage();
    const path = resolvePackageReference(packagePath, item.attributes.href ?? '');
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
    }
    if (isSection) declaredSections.add(path);
  }
  if (!header) invalidPackage();
  const sectionPaths: string[] = [];
  const seenSections = new Set<string>();
  for (const itemref of directChildren(spine, packageElements)) {
    if (itemref.local !== 'itemref' || itemref.uri !== PACKAGE_NAMESPACES.opf) invalidPackage();
    const path = itemsById.get(itemref.attributes.idref ?? '');
    if (!path || seenSections.has(path) || !rootIs(documents.get(path), 'sec', PACKAGE_NAMESPACES.section)) invalidPackage();
    seenSections.add(path);
    sectionPaths.push(path);
  }
  if (!sectionPaths.length || seenSections.size !== declaredSections.size) invalidPackage();
  const headerVersion = header.root.attributes.version;
  const sectionCount = header.root.attributes.secCnt;
  if (headerVersion !== undefined && headerVersion !== version.root.attributes.xmlVersion) invalidPackage();
  if (sectionCount !== undefined && (!/^\d{1,10}$/u.test(sectionCount) || Number(sectionCount) !== sectionPaths.length)) invalidPackage();
  return { sectionPaths, formatVersion: versionParts.join('.') };
}

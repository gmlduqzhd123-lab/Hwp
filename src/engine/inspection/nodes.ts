import type { InspectionNode, InspectionReason, SourceSpan } from '../../domain/document';
import type { XmlIndex, XmlIndexedElement, XmlIndexNode } from '../xml/index';

export const INSPECTION_NAMESPACES = Object.freeze({
  section: 'http://www.hancom.co.kr/hwpml/2011/section',
  paragraph: 'http://www.hancom.co.kr/hwpml/2011/paragraph',
  head: 'http://www.hancom.co.kr/hwpml/2011/head',
  core: 'http://www.hancom.co.kr/hwpml/2011/core',
});

export function uniqueReasons(reasons: readonly InspectionReason[]): InspectionReason[] {
  return [...new Set(reasons)];
}

export function isElement(element: XmlIndexedElement, uri: string, local: string): boolean {
  return element.uri === uri && element.local === local;
}

export function ancestor(element: XmlIndexedElement, predicate: (candidate: XmlIndexedElement) => boolean): XmlIndexedElement | null {
  for (let candidate = element.parent; candidate; candidate = candidate.parent) {
    if (predicate(candidate)) return candidate;
  }
  return null;
}

/** XML ids can repeat. Keys instead follow bounded parser element order. */
export function createNodeCatalog(entryPath: string, index: XmlIndex) {
  const orders = new Map(index.elements.map((element, order) => [element, order]));
  const namespaceOrders = new Map<string, number>();
  for (const element of index.elements) if (!namespaceOrders.has(element.uri)) namespaceOrders.set(element.uri, namespaceOrders.size);
  const siblingOrders = new Map<XmlIndexedElement, number>();
  siblingOrders.set(index.root, 0);
  for (const element of index.elements) {
    const namespaces = new Map<string, Map<string, number>>();
    for (const child of element.children) {
      if (child.kind !== 'element') continue;
      // Reuse the parser's namespace string rather than concatenating a long
      // shared URI into a fresh key for every child.
      let counts = namespaces.get(child.uri);
      if (!counts) { counts = new Map(); namespaces.set(child.uri, counts); }
      const order = counts.get(child.local) ?? 0;
      siblingOrders.set(child, order);
      counts.set(child.local, order + 1);
    }
  }
  function sourceSpan(node: XmlIndexNode): SourceSpan {
    return { entryPath, ...node.sourceSpan };
  }
  function namespaceLabel(uri: string): string {
    return Object.entries(INSPECTION_NAMESPACES).find(([, known]) => known === uri)?.[0] ?? `foreign-${namespaceOrders.get(uri) ?? -1}`;
  }
  function identity(element: XmlIndexedElement): InspectionNode {
    const segments: string[] = [];
    const ordinalPath: number[] = [];
    for (let candidate: XmlIndexedElement | null = element; candidate; candidate = candidate.parent) {
      // Unknown names can be enormous while sharing one namespace binding. Do
      // not multiply their raw source strings into every descendant's path.
      const local = candidate.local.length <= 32 ? candidate.local : `element-${orders.get(candidate)}`;
      segments.push(`${namespaceLabel(candidate.uri)}:${local}[${siblingOrders.get(candidate) ?? 0}]`);
      ordinalPath.push(orders.get(candidate) ?? -1);
    }
    const descriptivePath = `/${segments.reverse().join('/')}`;
    return {
      nodeId: `${entryPath}#element-${orders.get(element) ?? -1}`,
      sourceId: element.attributes.id ?? null,
      structurePath: descriptivePath.length <= 512 ? descriptivePath : `/element-path/${ordinalPath.reverse().join('/')}`,
      sourceSpan: sourceSpan(element),
      supportLevel: 'INSPECT_ONLY',
      correctionCandidate: false,
      reasons: [],
    };
  }
  return { identity, sourceSpan, namespaceLabel };
}

export type NodeCatalog = ReturnType<typeof createNodeCatalog>;

import { unzipSync, zipSync } from 'fflate';

export interface HancomPackageOptions {
  opfNamespace?: string;
  rootReferences?: boolean;
  headerInSpine?: boolean;
  auxiliaryRootfiles?: boolean;
  xmlVersion?: '1.5' | '1.31';
  inertMetadata?: boolean;
}

/**
 * Development-only: adapt a tiny trusted synthetic fixture to documented Hancom
 * package conventions. Never call this unbounded test helper with user documents.
 * These bytes remain synthetic, and do not claim Hancom opening/rendering validation.
 */
export function makeHancomPackage(input: Uint8Array, options: HancomPackageOptions = {}): Uint8Array {
  const entries = unzipSync(input);
  const encode = (source: string) => new TextEncoder().encode(source);
  const read = (path: string): string => {
    const bytes = entries[path];
    if (!bytes) throw new Error('Trusted synthetic package component is missing.');
    return new TextDecoder().decode(bytes);
  };
  const namespace = options.opfNamespace ?? 'http://www.idpf.org/2007/opf/';
  let packageXml = read('Contents/content.hpf').replace('http://www.idpf.org/2007/opf', namespace);
  if (options.rootReferences !== false) packageXml = packageXml.replace(/\bhref="([^"/]+)"/gu, 'href="Contents/$1"');
  const prefix = /<([^\s:]+):spine>/u.exec(packageXml)?.[1];
  if (!prefix) throw new Error('Trusted synthetic spine is missing.');
  if (options.headerInSpine !== false) packageXml = packageXml.replace(`<${prefix}:spine>`, `<${prefix}:spine><${prefix}:itemref idref="header" linear="yes"/>`);
  if (options.inertMetadata !== false) {
    packageXml = packageXml.replace(`<${prefix}:metadata>`, `<${prefix}:metadata><${prefix}:meta name="synthetic-source" content="https://example.invalid/synthetic-metadata"/>`)
      .replace(`<${prefix}:package `, `<${prefix}:package xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${namespace} https://example.invalid/package.xsd" `);
  }
  entries['Contents/content.hpf'] = encode(packageXml);
  const xmlVersion = options.xmlVersion ?? '1.5';
  entries['version.xml'] = encode(read('version.xml').replace('micro="0"', 'micro="1"').replace('xmlVersion="1.5"', `xmlVersion="${xmlVersion}"`));
  entries['Contents/header.xml'] = encode(read('Contents/header.xml').replace('version="1.5"', `version="${xmlVersion}"`));
  if (options.auxiliaryRootfiles !== false) {
    entries['Preview/PrvText.txt'] = encode('공개 합성 미리보기');
    const about = options.inertMetadata === false ? '' : 'https://example.invalid/synthetic-document';
    entries['META-INF/container.rdf'] = encode(`<?xml version="1.0" encoding="UTF-8"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="${about}"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2011/package#Document"/></rdf:Description></rdf:RDF>`);
    entries['META-INF/container.xml'] = encode(read('META-INF/container.xml').replace('</rootfiles>', '<rootfile full-path="Preview/PrvText.txt" media-type="text/xml"/><rootfile full-path="META-INF/container.rdf" media-type="application/rdf+xml"/></rootfiles>'));
  }
  return zipSync(entries, { level: 0 });
}

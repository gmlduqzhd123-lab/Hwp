import { Uint8ArrayReader, ZipReader } from '@zip.js/zip.js/lib/zip-core-native.js';
import { EngineError } from '../domain/errors';
import { RESOURCE_LIMITS, type ResourceLimits } from '../domain/limits';
import type { PreflightReport } from '../domain/preflight';
import { INSPECTION_MAX_ENTRY_PATH_LENGTH, type DocumentInspection } from '../domain/document';
import { inspectDocument } from './inspection';
import { invalidPackage, resourceLimit, unsupportedFile } from './package/errors';
import { inspectPackageIdentity, isOpfNamespace, PACKAGE_NAMESPACES, type XmlSummary } from './package/identity';
import { isXmlPath } from './package/paths';
import { scanZipMetadata, validateLimits } from './package/metadata';
import { validateXml, type XmlDocument } from './xml/validate';
import { indexXml, type XmlIndex } from './xml/index';

const HWP_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const MIMETYPE = new TextEncoder().encode('application/hwp+zip');

function inspectFileType(bytes: Uint8Array, fileName: string): void {
  if (HWP_MAGIC.every((byte, index) => bytes[index] === byte) || String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-' || !/\.hwpx$/iu.test(fileName)) unsupportedFile();
}

/** Every entry is CRC-checked sequentially; binary resources never become retained buffers. */
async function readPackage(input: Uint8Array, fileName: string, inputLimits: Readonly<ResourceLimits>, visitXml?: (path: string, bytes: Uint8Array, document: XmlDocument) => void): Promise<{ report: PreflightReport; headerPath: string }> {
  const limits = Object.freeze({ ...inputLimits });
  validateLimits(limits);
  if (input.byteLength > limits.maxInputBytes) resourceLimit();
  // Own the bounded bytes before the first async operation, even for direct callers.
  const bytes = new Uint8Array(input);
  inspectFileType(bytes, fileName);
  const metadata = scanZipMetadata(bytes, limits);
  const mimetype = metadata.entries[0];
  if (!mimetype || mimetype.name !== 'mimetype' || mimetype.localOffset !== 0 || mimetype.method !== 0 || mimetype.uncompressedSize !== MIMETYPE.length) invalidPackage();
  if (!MIMETYPE.every((byte, index) => bytes[mimetype.dataOffset + index] === byte)) invalidPackage();
  const paths = new Set(metadata.entries.filter((entry) => !entry.directory).map((entry) => entry.name));
  const documents = new Map<string, XmlSummary>();
  let actualTotal = 0;
  let xmlCount = 0;
  let xmlElements = 0;
  let streamFailure: EngineError | undefined;
  // Native JS entrypoint embeds its fallback codec and never fetches WASM or creates another Worker.
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false, useCompressionStream: false, checkSignature: true, checkCrc32: true, strictness: 'strict' });
  try {
    const entries = await reader.getEntries();
    if (entries.length !== metadata.entries.length || reader.directoryOffset !== metadata.centralOffset) invalidPackage();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const expected = metadata.entries[index];
      if (!entry || !expected) invalidPackage();
      if (entry.filename !== expected.name || entry.directory !== expected.directory || entry.compressedSize !== expected.compressedSize || entry.uncompressedSize !== expected.uncompressedSize || entry.offset !== expected.localOffset || entry.compressionMethod !== expected.method || entry.rawBitFlag !== expected.flags || entry.signature !== expected.crc32 || entry.encrypted || entry.symlink) invalidPackage();
      if (entry.directory) continue;
      const isXml = isXmlPath(entry.filename);
      const chunks: Uint8Array[] = [];
      let entryBytes = 0;
      const writer = new WritableStream<Uint8Array>({
        write(chunk) {
          try {
            entryBytes += chunk.byteLength;
            actualTotal += chunk.byteLength;
            if (actualTotal > limits.maxUncompressedBytes || (isXml && entryBytes > limits.maxXmlBytes)) resourceLimit();
            if (entryBytes > expected.uncompressedSize) invalidPackage();
            if (isXml) chunks.push(chunk.slice());
          } catch (error) {
            // Some codec versions replace sink errors during cancellation; preserve our safe reason.
            if (error instanceof EngineError) streamFailure = error;
            throw error;
          }
        },
      });
      await entry.getData(writer, { useWebWorkers: false, useCompressionStream: false, checkSignature: true, checkCrc32: true });
      if (entryBytes !== expected.uncompressedSize) invalidPackage();
      if (isXml) {
        const xmlBytes = new Uint8Array(entryBytes);
        let offset = 0;
        for (const chunk of chunks) { xmlBytes.set(chunk, offset); offset += chunk.length; }
        const document = validateXml(xmlBytes, limits);
        xmlElements += document.elements.length;
        // Bound package-wide metadata work as well as each XML parser invocation.
        if (xmlElements > limits.maxXmlElements) resourceLimit();
        const root = document.elements[0];
        if (!root) invalidPackage();
        const needsIdentityElements = root.uri === PACKAGE_NAMESPACES.container || isOpfNamespace(root.uri);
        documents.set(entry.filename, { root, ...(needsIdentityElements ? { identityDocument: document } : {}) });
        visitXml?.(entry.filename, xmlBytes, document);
        xmlCount += 1;
      }
    }
    if (actualTotal !== metadata.uncompressedBytes) invalidPackage();
    const identity = inspectPackageIdentity(paths, documents);
    return {
      headerPath: identity.headerPath,
      report: { entryCount: entries.length, uncompressedBytes: actualTotal, xmlCount, sectionPaths: identity.sectionPaths, formatVersion: identity.formatVersion, supportLevel: 'INSPECT_ONLY' },
    };
  } catch (error) {
    if (streamFailure) throw streamFailure;
    if (error instanceof EngineError) throw error;
    return invalidPackage();
  } finally {
    await reader.close();
  }
}

/** Package-only callers retain the existing bounded report API. */
export async function preflight(input: Uint8Array, fileName: string, inputLimits: Readonly<ResourceLimits> = RESOURCE_LIMITS): Promise<PreflightReport> {
  return (await readPackage(input, fileName, inputLimits)).report;
}

/** Read structure only after every ZIP entry and the package identity pass. */
export async function inspectHwpx(input: Uint8Array, fileName: string, inputLimits: Readonly<ResourceLimits> = RESOURCE_LIMITS): Promise<{ report: PreflightReport; inspection: DocumentInspection }> {
  const limits = Object.freeze({ ...inputLimits });
  const indexes = new Map<string, XmlIndex>();
  let retainedNodes = 0;
  let retainedTextLength = 0;
  const { report, headerPath } = await readPackage(input, fileName, limits, (path, bytes, document) => {
    const root = document.elements[0];
    if (!root || !((root.uri === PACKAGE_NAMESPACES.head && root.local === 'head') || (root.uri === PACKAGE_NAMESPACES.section && root.local === 'sec'))) return;
    if (path.length > INSPECTION_MAX_ENTRY_PATH_LENGTH) resourceLimit();
    const index = indexXml(bytes, limits);
    retainedNodes += index.elements.length;
    for (const element of index.elements) {
      for (const child of element.children) {
        if (child.kind === 'element') continue;
        retainedNodes += 1;
        retainedTextLength += child.text.length;
      }
    }
    // Bound retained reading data across all entries, including extra roots.
    if (retainedNodes > limits.maxXmlElements || retainedTextLength > limits.maxXmlTextLength) resourceLimit();
    indexes.set(path, index);
  });
  const header = indexes.get(headerPath);
  if (!header) invalidPackage();
  const sections = report.sectionPaths.map((path) => {
    const index = indexes.get(path);
    if (!index) invalidPackage();
    return { path, index };
  });
  return { report, inspection: inspectDocument({ header: { path: headerPath, index: header }, sections }, limits) };
}

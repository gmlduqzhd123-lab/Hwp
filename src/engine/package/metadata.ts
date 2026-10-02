import { RESOURCE_LIMITS, type ResourceLimits } from '../../domain/limits';
import { assertSafePath, isXmlPath, normalizedPathKey } from './paths';
import { encryptedPackage, invalidPackage, resourceLimit, unsupportedFile } from './errors';

export interface ZipEntryMetadata {
  name: string;
  directory: boolean;
  flags: number;
  method: 0 | 8;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  dataOffset: number;
  endOffset: number;
}

export interface ZipMetadata {
  entries: ZipEntryMetadata[];
  uncompressedBytes: number;
  centralOffset: number;
}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const DESCRIPTOR = 0x08074b50;
const UTF8 = 0x0800;

export function validateLimits(limits: Readonly<ResourceLimits>): void {
  for (const key of Object.keys(RESOURCE_LIMITS) as (keyof ResourceLimits)[]) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value <= 0) resourceLimit();
  }
}

/** Scan bounded central and local metadata before any decompressor sees the input. */
export function scanZipMetadata(bytes: Uint8Array, limits: Readonly<ResourceLimits> = RESOURCE_LIMITS): ZipMetadata {
  validateLimits(limits);
  if (bytes.byteLength > limits.maxInputBytes) resourceLimit();
  if (bytes.byteLength < 22) invalidPackage();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const inside = (offset: number, length: number, end = bytes.length): void => {
    if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > end) invalidPackage();
  };
  const u16 = (offset: number): number => { inside(offset, 2); return view.getUint16(offset, true); };
  const u32 = (offset: number): number => { inside(offset, 4); return view.getUint32(offset, true); };
  let endOffset = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
    if (u32(at) === END && at + 22 + u16(at + 20) === bytes.length) { endOffset = at; break; }
  }
  if (endOffset < 0) invalidPackage();
  const count = u16(endOffset + 10);
  const centralSize = u32(endOffset + 12);
  const centralOffset = u32(endOffset + 16);
  if (u16(endOffset + 4) !== 0 || u16(endOffset + 6) !== 0 || u16(endOffset + 8) !== count) invalidPackage();
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) invalidPackage();
  if (count > limits.maxEntries) resourceLimit();
  if (!count || centralOffset + centralSize !== endOffset) invalidPackage();
  inside(centralOffset, centralSize, endOffset);
  const entries: ZipEntryMetadata[] = [];
  const seenPaths = new Set<string>();
  let declaredTotal = 0;
  let cursor = centralOffset;
  const decodeName = (offset: number, length: number, flags: number): string => {
    if (!length) invalidPackage();
    const nameBytes = bytes.subarray(offset, offset + length);
    if (!(flags & UTF8) && nameBytes.some((byte) => byte > 0x7f)) invalidPackage();
    // A filename BOM is part of the name, not an encoding marker to discard.
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(nameBytes); } catch { return invalidPackage(); }
  };
  const checkExtra = (offset: number, length: number): void => {
    const extraEnd = offset + length;
    while (offset < extraEnd) {
      inside(offset, 4, extraEnd);
      const kind = u16(offset);
      const size = u16(offset + 2);
      offset += 4;
      inside(offset, size, extraEnd);
      // ZIP64 and Unicode alternate names require rules that this first release has not validated.
      if (kind === 0x0001 || kind === 0x7075) invalidPackage();
      if (kind === 0x9901) encryptedPackage();
      offset += size;
    }
  };
  for (let index = 0; index < count; index += 1) {
    inside(cursor, 46, endOffset);
    if (u32(cursor) !== CENTRAL) invalidPackage();
    const version = u16(cursor + 6);
    const flags = u16(cursor + 8);
    const method = u16(cursor + 10);
    if (flags & 0x2041) encryptedPackage();
    if (version > 20 || flags & ~0x080e || (method !== 0 && method !== 8) || (method === 0 && flags & 6)) invalidPackage();
    const crc32 = u32(cursor + 16);
    const compressedSize = u32(cursor + 20);
    const uncompressedSize = u32(cursor + 24);
    const nameLength = u16(cursor + 28);
    const extraLength = u16(cursor + 30);
    const commentLength = u16(cursor + 32);
    const localOffset = u32(cursor + 42);
    if (u16(cursor + 34) !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) invalidPackage();
    inside(cursor + 46, nameLength + extraLength + commentLength, endOffset);
    const name = assertSafePath(decodeName(cursor + 46, nameLength, flags));
    // HWPX scripts and plainly executable resources are outside the safe-input
    // scope. This does not claim to identify or sanitize every disguised payload.
    if (/(?:^|\/)scripts(?:\/|$)/iu.test(name)
      || /\.(?:exe|com|dll|scr|cpl|msi|bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|hta|jar)$/iu.test(name)) unsupportedFile();
    const key = normalizedPathKey(name);
    if (seenPaths.has(key)) invalidPackage();
    seenPaths.add(key);
    checkExtra(cursor + 46 + nameLength, extraLength);
    declaredTotal += uncompressedSize;
    if (declaredTotal > limits.maxUncompressedBytes) resourceLimit();
    if (isXmlPath(name) && uncompressedSize > limits.maxXmlBytes) resourceLimit();
    const directory = name.endsWith('/');
    // Directory markers are never decompressed, so only canonical empty STORED
    // markers can pass. A method-8 marker with zero input is not a valid stream.
    if ((method === 0 && compressedSize !== uncompressedSize) || (directory && (method !== 0 || compressedSize || uncompressedSize || crc32))) invalidPackage();
    // Match all relevant local fields rather than trusting the central record alone.
    inside(localOffset, 30, centralOffset);
    if (u32(localOffset) !== LOCAL || u16(localOffset + 4) !== version || u16(localOffset + 6) !== flags || u16(localOffset + 8) !== method) invalidPackage();
    const localNameLength = u16(localOffset + 26);
    const localExtraLength = u16(localOffset + 28);
    inside(localOffset + 30, localNameLength + localExtraLength, centralOffset);
    if (decodeName(localOffset + 30, localNameLength, flags) !== name) invalidPackage();
    checkExtra(localOffset + 30 + localNameLength, localExtraLength);
    const localCrc = u32(localOffset + 14);
    const localCompressed = u32(localOffset + 18);
    const localUncompressed = u32(localOffset + 22);
    if (flags & 8) {
      if ((localCrc !== 0 && localCrc !== crc32) || (localCompressed !== 0 && localCompressed !== compressedSize) || (localUncompressed !== 0 && localUncompressed !== uncompressedSize)) invalidPackage();
    } else if (localCrc !== crc32 || localCompressed !== compressedSize || localUncompressed !== uncompressedSize) invalidPackage();
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    inside(dataOffset, compressedSize, centralOffset);
    let entryEnd = dataOffset + compressedSize;
    if (flags & 8) {
      const candidates = [entryEnd];
      if (entryEnd + 4 <= centralOffset && u32(entryEnd) === DESCRIPTOR) candidates.push(entryEnd + 4);
      const matching = candidates.filter((offset) => offset + 12 <= centralOffset
        && u32(offset) === crc32 && u32(offset + 4) === compressedSize && u32(offset + 8) === uncompressedSize);
      const descriptorOffset = matching[0];
      // CRC can equal the optional signature. Match every field, and reject ambiguity.
      if (matching.length !== 1 || descriptorOffset === undefined) invalidPackage();
      entryEnd = descriptorOffset + 12;
    }
    entries.push({ name, directory, flags, method, crc32, compressedSize, uncompressedSize, localOffset, dataOffset, endOffset: entryEnd });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== endOffset) invalidPackage();
  const byPath = entries.map((entry) => ({ key: normalizedPathKey(entry.name), directory: entry.directory }))
    .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  let previousFile: string | undefined;
  for (const entry of byPath) {
    // Lexical order makes descendants contiguous. Avoid repeatedly hashing every
    // parent prefix, which is quadratic for a maximum-length deeply nested name.
    if (previousFile !== undefined && entry.key.startsWith(`${previousFile}/`)) invalidPackage();
    if (!entry.directory) previousFile = entry.key;
  }
  const ordered = [...entries].sort((left, right) => left.localOffset - right.localOffset);
  let previousEnd = 0;
  for (const entry of ordered) {
    if (entry.localOffset !== previousEnd) invalidPackage();
    previousEnd = entry.endOffset;
  }
  if (previousEnd !== centralOffset) invalidPackage();
  return { entries, uncompressedBytes: declaredTotal, centralOffset };
}

// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { TextReader, TextWriter, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from '@zip.js/zip.js/lib/zip-core-native.js';
import { unzipSync } from 'fflate';
import { SaxesParser } from 'saxes';

const encoder = new TextEncoder();
const options = { useWebWorkers: false, useCompressionStream: false };

async function archive(entries: [string, string][]) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    ...options, extendedTimestamp: false, dataDescriptor: false, zip64: false,
  });
  for (const [name, text] of entries) {
    await writer.add(name, new TextReader(text), { level: 0, lastModDate: new Date(2024, 0, 1) });
  }
  return writer.close();
}

function replaceZipName(bytes: Uint8Array, from: string, to: string) {
  const original = encoder.encode(from);
  const replacement = encoder.encode(to);
  if (original.length !== replacement.length) throw new Error('Probe names must have equal byte lengths');
  const changed = bytes.slice();
  let matches = 0;
  for (let offset = 0; offset <= changed.length - original.length; offset++) {
    if (original.every((value, index) => changed[offset + index] === value)) {
      changed.set(replacement, offset);
      matches++;
      offset += original.length - 1;
    }
  }
  // One local header and one central-directory header.
  expect(matches).toBe(2);
  return changed;
}

describe('ZIP candidate capability probes (T-01)', () => {
  it('roundtrips DEFLATE with the bundled JavaScript codec and no resource fetch', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('probe network forbidden'));
    const text = '압축된 공개 합성 텍스트 '.repeat(1000);
    const writer = new ZipWriter(new Uint8ArrayWriter(), options);
    try {
      await writer.add('compressed.txt', new TextReader(text), { level: 6 });
      const bytes = await writer.close();
      const reader = new ZipReader(new Uint8ArrayReader(bytes), options);
      try {
        const [entry] = await reader.getEntries();
        if (!entry || entry.directory) throw new Error('Unexpected directory in probe');
        expect(entry.compressionMethod).toBe(8);
        expect(entry.compressedSize).toBeLessThan(entry.uncompressedSize);
        expect(await entry.getData(new TextWriter(), { checkSignature: true })).toBe(text);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        await reader.close();
      }
    } finally {
      fetch.mockRestore();
    }
  });

  it('writes mimetype as the first STORED local and central-directory entry', async () => {
    const bytes = await archive([['mimetype', 'application/hwp+zip'], ['Contents/a.xml', '<a/>']]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(8, true)).toBe(0);
    expect(view.getUint16(26, true)).toBe(8);
    expect(new TextDecoder().decode(bytes.subarray(30, 38))).toBe('mimetype');
    const reader = new ZipReader(new Uint8ArrayReader(bytes), options);
    try {
      const entries = await reader.getEntries();
      expect(entries.map((entry) => entry.filename)).toEqual(['mimetype', 'Contents/a.xml']);
      const mimetype = entries[0]!;
      if (mimetype.directory) throw new Error('Unexpected directory in probe');
      expect(mimetype.compressionMethod).toBe(0);
      expect(await mimetype.getData(new TextWriter(), { checkSignature: true })).toBe('application/hwp+zip');
    } finally {
      await reader.close();
    }
  });

  it('zip.js validates CRC while fflate unzipSync accepts a modified stored payload', async () => {
    const bytes = await archive([['payload.txt', 'ORIGINAL']]);
    const changed = bytes.slice();
    const view = new DataView(changed.buffer, changed.byteOffset, changed.byteLength);
    const payloadOffset = 30 + view.getUint16(26, true) + view.getUint16(28, true);
    changed[payloadOffset] = changed[payloadOffset]! ^ 1;
    const reader = new ZipReader(new Uint8ArrayReader(changed), options);
    try {
      const [entry] = await reader.getEntries();
      if (!entry || entry.directory) throw new Error('Unexpected directory in probe');
      await expect(entry.getData(new Uint8ArrayWriter(), { checkSignature: true })).rejects.toThrow();
    } finally {
      await reader.close();
    }
    expect(new TextDecoder().decode(unzipSync(changed)['payload.txt'])).not.toBe('ORIGINAL');
  });

  it('exposes duplicate paths for a guard; fflate unzipSync collapses them to one object key', async () => {
    const bytes = replaceZipName(await archive([['a.xml', '<first/>'], ['b.xml', '<second/>']]), 'b.xml', 'a.xml');
    const reader = new ZipReader(new Uint8ArrayReader(bytes), options);
    try {
      const entries = await reader.getEntries();
      expect(entries.map((entry) => entry.filename)).toEqual(['a.xml', 'a.xml']);
      expect(entries.map((entry) => entry.uncompressedSize)).toEqual([8, 9]);
    } finally {
      await reader.close();
    }
    const flattened = unzipSync(bytes);
    expect(Object.keys(flattened)).toEqual(['a.xml']);
    expect(new TextDecoder().decode(flattened['a.xml'])).toBe('<second/>');
  });

  it('streams output through a caller-controlled byte budget and propagates sink failure', async () => {
    const reader = new ZipReader(new Uint8ArrayReader(await archive([['large.xml', 'a'.repeat(160_000)]])), options);
    let observed = 0;
    let limitHit = false;
    const limit = 16_384;
    try {
      const [entry] = await reader.getEntries();
      if (!entry || entry.directory) throw new Error('Unexpected directory in probe');
      expect(entry.uncompressedSize).toBe(160_000);
      const sink = new WritableStream<Uint8Array>({
        write(chunk) {
          if (observed + chunk.byteLength > limit) {
            limitHit = true;
            throw new Error('probe output budget exceeded');
          }
          observed += chunk.byteLength;
        },
      });
      // zip.js may surface its stream-close error instead of the sink's message.
      // The independent flag proves that rejection followed the actual budget.
      await expect(entry.getData(sink, { checkSignature: true })).rejects.toThrow();
      expect(limitHit).toBe(true);
      expect(observed).toBeLessThanOrEqual(limit);
    } finally {
      await reader.close();
    }
  });
});

describe('saxes namespace and source-position probes (T-01)', () => {
  it('resolves namespace URI independent of prefix and exposes UTF-16 source positions', () => {
    const source = '<root xmlns:x="urn:probe">한글😀<x:t a="1"> A &amp; B </x:t></root>';
    const parser = new SaxesParser({ xmlns: true, position: true });
    const tags: { uri: string; local: string; position: number }[] = [];
    const text: string[] = [];
    parser.on('opentag', (tag) => tags.push({ uri: tag.uri, local: tag.local, position: parser.position }));
    parser.on('text', (value) => text.push(value));
    parser.write(source).close();
    expect(tags[1]).toEqual({ uri: 'urn:probe', local: 't', position: source.indexOf('> A') + 1 });
    expect(text.join('')).toBe('한글😀 A & B ');
    const openEnd = tags[1]!.position;
    // UTF-16 positions require an explicit mapping before creating byte patches.
    expect(encoder.encode(source.slice(0, openEnd)).length).toBeGreaterThan(openEnd);
  });

  it('provides a DOCTYPE event for a caller rejection policy and rejects unknown entities', () => {
    const parser = new SaxesParser({ xmlns: true });
    parser.on('doctype', () => { throw new Error('probe DTD forbidden'); });
    expect(() => parser.write('<!DOCTYPE root SYSTEM "https://example.invalid/external.dtd"><root/>').close()).toThrow('probe DTD forbidden');
    const unknownEntity = new SaxesParser({ xmlns: true });
    expect(() => unknownEntity.write('<root>&external;</root>').close()).toThrow();
  });

  it('rejects malformed XML and reports namespace attributes without serializing source', () => {
    const parser = new SaxesParser({ xmlns: true });
    const seen: { uri: string; local: string; value: string }[] = [];
    parser.on('attribute', (attribute) => seen.push(attribute));
    parser.write('<x:p xmlns:x="urn:p" xmlns:y="urn:attribute" y:id="7"/>').close();
    expect(seen).toContainEqual(expect.objectContaining({ uri: 'urn:attribute', local: 'id', value: '7' }));
    expect(() => new SaxesParser({ xmlns: true }).write('<a><b></a>').close()).toThrow();
  });
});

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { preflight } from '../../src/engine/preflight';
import { createDocumentSession } from '../../src/engine/session';

const fixtures = [
  '01-plain-text.hwpx',
  '02-alternate-prefixes.hwpx',
  '03-spine-order.hwpx',
  '04-simple-table.hwpx',
  '05-unsupported-tables.hwpx',
] as const;

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(`../fixtures/${name}`, import.meta.url)));
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('T-02 / AC-16 unchanged HWPX round trips', () => {
  it.each(fixtures)('%s preserves every input byte and the independently computed hash', async (name) => {
    const input = await fixture(name);
    const original = input.slice();
    const session = await createDocumentSession(input, name);

    expect(session.report.supportLevel).toBe('INSPECT_ONLY');
    expect(session.report.entryCount).toBeGreaterThan(0);
    expect(session.report.xmlCount).toBeGreaterThan(0);
    expect(session.report.sectionPaths.length).toBeGreaterThan(0);
    expect(session.originalSha256).toBe(sha256(original));
    expect(session.getOriginalBytes()).toEqual(original);
    expect(session.exportUnchanged()).toEqual(original);
    expect(input).toEqual(original);

    const output = session.exportUnchanged();
    const reopened = await createDocumentSession(output, name);
    expect(reopened.exportUnchanged()).toEqual(original);
    expect(reopened.originalSha256).toBe(session.originalSha256);
    expect(reopened.report).toEqual(session.report);
    expect(await preflight(output, name)).toEqual(session.report);
  });

  it.each(fixtures)('%s keeps the original when caller, getter, worker, and export copies change', async (name) => {
    const input = await fixture(name);
    const original = input.slice();
    const session = await createDocumentSession(input, name);
    const originalCopy = session.getOriginalBytes();
    const workerCopy = session.getWorkerBytes();
    const exportCopy = session.exportUnchanged();

    expect(originalCopy).not.toBe(input);
    expect(workerCopy.buffer).not.toBe(originalCopy.buffer);
    expect(exportCopy.buffer).not.toBe(originalCopy.buffer);
    input.fill(0);
    originalCopy.fill(1);
    workerCopy.fill(2);
    exportCopy.fill(3);

    expect(session.getOriginalBytes()).toEqual(original);
    expect(session.getWorkerBytes()).toEqual(original);
    expect(session.exportUnchanged()).toEqual(original);
    expect(session.originalSha256).toBe(sha256(original));
  });

  it('keeps input bytes available after the actual Worker buffer transfer operation', async () => {
    const input = await fixture(fixtures[0]);
    const original = input.slice();
    const session = await createDocumentSession(input, fixtures[0]);
    const workerBytes = session.getWorkerBytes();
    const transferred = structuredClone(workerBytes, { transfer: [workerBytes.buffer] });

    expect(workerBytes.byteLength).toBe(0);
    expect(transferred).toEqual(original);
    transferred.fill(0);
    expect(input).toEqual(original);
    expect(session.getOriginalBytes()).toEqual(original);
    expect(session.exportUnchanged()).toEqual(original);
    expect(session.originalSha256).toBe(sha256(original));
  });

  it('takes ownership before awaiting asynchronous validation', async () => {
    const input = await fixture(fixtures[0]);
    const original = input.slice();
    const creating = createDocumentSession(input, fixtures[0]);
    input.fill(0);
    const session = await creating;
    expect(session.exportUnchanged()).toEqual(original);
    expect(session.originalSha256).toBe(sha256(original));
  });

  it('returns an independent report including its section order array', async () => {
    const input = await fixture(fixtures[2]);
    const session = await createDocumentSession(input, fixtures[2]);
    const originalReport = session.report;
    const changedReport = session.report;
    changedReport.entryCount = 0;
    changedReport.sectionPaths.splice(0, changedReport.sectionPaths.length);
    expect(session.report).toEqual(originalReport);
    expect(session.report.sectionPaths).not.toBe(originalReport.sectionPaths);
    expect(session.exportUnchanged()).toEqual(input);
  });

  it('reads OPF spine order rather than archive or section filename order', async () => {
    const bytes = await fixture('03-spine-order.hwpx');
    const report = await preflight(bytes, '03-spine-order.hwpx');
    expect(report.sectionPaths).toEqual([
      'Contents/section2.xml',
      'Contents/section0.xml',
      'Contents/section1.xml',
    ]);
  });

  it('honors the Uint8Array view instead of reading unrelated backing-buffer bytes', async () => {
    const bytes = await fixture(fixtures[0]);
    const backing = new Uint8Array(bytes.length + 32).fill(0x7f);
    backing.set(bytes, 16);
    const view = backing.subarray(16, 16 + bytes.length);
    const session = await createDocumentSession(view, fixtures[0]);
    expect(session.exportUnchanged()).toEqual(bytes);
    expect(session.originalSha256).toBe(sha256(bytes));
    expect(backing.subarray(0, 16)).toEqual(new Uint8Array(16).fill(0x7f));
  });
});

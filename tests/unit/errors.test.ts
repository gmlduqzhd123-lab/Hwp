import { describe, expect, it } from 'vitest';
import {
  EngineError, ERROR_MESSAGES, getErrorMessage, isErrorCode, isXmlUnsupportedReason,
  safeError, XML_UNSUPPORTED_MESSAGES, type XmlUnsupportedReason,
} from '../../src/domain/errors';

const privateDiagnostic = 'PRIVATE_DOCUMENT_TEXT PRIVATE_FILENAME.hwpx https://example.invalid/PRIVATE_PATH '
  + 'cd4c396ac7fd3cb0712beb95137889f2ad69b5b4701dd660e5660c6d3956d77b';
const xmlReasons: XmlUnsupportedReason[] = [
  'ENCODING', 'XML_VERSION', 'DTD', 'PROCESSING_INSTRUCTION',
  'NAMESPACE', 'ACTIVE_CONTENT', 'EXTERNAL_REFERENCE', 'EVENT_ATTRIBUTE',
];

describe('safe document diagnostics', () => {
  it.each(xmlReasons)('retains known %s classification while discarding raw diagnostic content', (reason) => {
    const error = new EngineError('XML_UNSUPPORTED', privateDiagnostic, reason);
    expect(error.xmlReason).toBe(reason);
    const result = safeError(error);
    expect(result).toEqual({ code: 'XML_UNSUPPORTED', message: XML_UNSUPPORTED_MESSAGES[reason], xmlReason: reason });
    expect(JSON.stringify(result)).not.toContain(privateDiagnostic);
    expect(result.message).not.toContain('PRIVATE_');
    expect(result.message).not.toContain('https:');
    expect(result.message).not.toContain('cd4c396');
  });

  it('keeps legacy engine error codes while replacing their arbitrary message text', () => {
    expect(safeError(new EngineError('FILE_INVALID_PACKAGE', privateDiagnostic))).toEqual({
      code: 'FILE_INVALID_PACKAGE', message: ERROR_MESSAGES.FILE_INVALID_PACKAGE,
    });
  });

  it('does not treat an XML reason as relevant to another error code', () => {
    const error = new EngineError('FILE_ENCRYPTED', privateDiagnostic, 'DTD');
    expect(error.xmlReason).toBeUndefined();
    expect(safeError(error)).toEqual({ code: 'FILE_ENCRYPTED', message: ERROR_MESSAGES.FILE_ENCRYPTED });
    expect(getErrorMessage('FILE_ENCRYPTED', 'DTD')).toBe(ERROR_MESSAGES.FILE_ENCRYPTED);
  });

  it('sanitizes parser errors and objects claiming to be engine diagnostics', () => {
    for (const error of [new Error(privateDiagnostic), { code: 'XML_UNSUPPORTED', message: privateDiagnostic, xmlReason: 'DTD' }, privateDiagnostic]) {
      expect(safeError(error)).toEqual({ code: 'FILE_INVALID_PACKAGE', message: ERROR_MESSAGES.FILE_INVALID_PACKAGE });
    }
  });

  it('ignores a reason altered at runtime to contain document data', () => {
    const error = new EngineError('XML_UNSUPPORTED', privateDiagnostic, 'DTD');
    Reflect.set(error, 'xmlReason', privateDiagnostic);
    expect(safeError(error)).toEqual({ code: 'XML_UNSUPPORTED', message: ERROR_MESSAGES.XML_UNSUPPORTED });
  });

  it.each(['PRIVATE_FILENAME.hwpx', '__proto__', 'constructor', 'toString', '', null, {}, 5])(
    'rejects unknown diagnostic identifiers (%#)', (value) => {
      expect(isErrorCode(value)).toBe(false);
      expect(isXmlUnsupportedReason(value)).toBe(false);
      expect(getErrorMessage('XML_UNSUPPORTED', value)).toBe(ERROR_MESSAGES.XML_UNSUPPORTED);
    },
  );
});

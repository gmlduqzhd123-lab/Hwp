export type ErrorCode =
  | 'FILE_UNSUPPORTED' | 'FILE_INVALID_PACKAGE' | 'FILE_ENCRYPTED'
  | 'RESOURCE_LIMIT' | 'XML_UNSUPPORTED' | 'WORKER_FAILED';

export type XmlUnsupportedReason =
  | 'ENCODING' | 'XML_VERSION' | 'DTD' | 'PROCESSING_INSTRUCTION'
  | 'NAMESPACE' | 'ACTIVE_CONTENT' | 'EXTERNAL_REFERENCE' | 'EVENT_ATTRIBUTE';

export const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = Object.freeze({
  FILE_UNSUPPORTED: '현재 지원 범위의 HWPX 파일만 검사할 수 있습니다. HWP·PDF 변환과 실행 가능 개체는 지원하지 않습니다.',
  FILE_INVALID_PACKAGE: 'HWPX 파일 구조를 확인하지 못했습니다. 손상되었거나 지원하지 않는 패키지입니다.',
  FILE_ENCRYPTED: '암호화된 파일은 검사할 수 없습니다. 암호를 해제한 HWPX를 선택해 주세요.',
  RESOURCE_LIMIT: '파일 또는 내부 데이터가 검사 한도를 넘었습니다. 더 작은 HWPX를 선택해 주세요.',
  XML_UNSUPPORTED: '안전하게 해석할 수 없는 XML 구조입니다. 이 파일의 검사를 중단했습니다.',
  WORKER_FAILED: '검사 기능을 준비하지 못했습니다. 준비를 다시 시도해 주세요.',
});

export const XML_UNSUPPORTED_MESSAGES: Readonly<Record<XmlUnsupportedReason, string>> = Object.freeze({
  ENCODING: 'XML 문자 인코딩을 읽을 수 없습니다. 한글에서 HWPX로 다시 저장한 파일을 선택해 주세요.',
  XML_VERSION: '이 파일의 XML 버전은 지원하지 않습니다. 한글에서 HWPX로 다시 저장한 파일을 선택해 주세요.',
  DTD: 'DTD 선언이 들어 있어 검사를 중단했습니다. DTD는 외부 데이터나 엔터티를 정의할 수 있어 지원하지 않습니다.',
  PROCESSING_INSTRUCTION: '지원하지 않는 XML 처리 지시문이 있어 이 파일을 열지 못했습니다.',
  NAMESPACE: 'XML 이름공간 선언을 확인할 수 없어 검사를 중단했습니다.',
  ACTIVE_CONTENT: '스크립트나 실행 가능한 개체가 들어 있어 검사를 중단했습니다. 이 기능이 없는 HWPX 파일을 선택해 주세요.',
  EXTERNAL_REFERENCE: '문서 밖의 자원을 참조하는 속성이 있어 검사를 중단했습니다. 외부 연결을 사용하지 않는 HWPX 파일을 선택해 주세요.',
  EVENT_ATTRIBUTE: '동작을 실행하는 이벤트 속성이 들어 있어 검사를 중단했습니다.',
});

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_MESSAGES, value);
}

export function isXmlUnsupportedReason(value: unknown): value is XmlUnsupportedReason {
  return typeof value === 'string' && Object.hasOwn(XML_UNSUPPORTED_MESSAGES, value);
}

/** Diagnostics are selected from app-owned text, never from document/parser text. */
export function getErrorMessage(code: ErrorCode, xmlReason?: unknown): string {
  if (code === 'XML_UNSUPPORTED' && isXmlUnsupportedReason(xmlReason)) return XML_UNSUPPORTED_MESSAGES[xmlReason];
  return ERROR_MESSAGES[code];
}

export interface SafeError {
  code: ErrorCode;
  message: string;
  xmlReason?: XmlUnsupportedReason;
}

export class EngineError extends Error {
  readonly code: ErrorCode;
  readonly xmlReason?: XmlUnsupportedReason;
  constructor(code: ErrorCode, message: string, xmlReason?: XmlUnsupportedReason) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    if (code === 'XML_UNSUPPORTED' && isXmlUnsupportedReason(xmlReason)) this.xmlReason = xmlReason;
  }
}

export function safeError(error: unknown): SafeError {
  if (error instanceof EngineError && isErrorCode(error.code)) {
    const xmlReason = error.code === 'XML_UNSUPPORTED' && isXmlUnsupportedReason(error.xmlReason)
      ? error.xmlReason : undefined;
    return {
      code: error.code,
      message: getErrorMessage(error.code, xmlReason),
      ...(xmlReason === undefined ? {} : { xmlReason }),
    };
  }
  return { code: 'FILE_INVALID_PACKAGE', message: ERROR_MESSAGES.FILE_INVALID_PACKAGE };
}

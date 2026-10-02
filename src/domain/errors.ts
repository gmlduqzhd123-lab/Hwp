export type ErrorCode =
  | 'FILE_UNSUPPORTED' | 'FILE_INVALID_PACKAGE' | 'FILE_ENCRYPTED'
  | 'RESOURCE_LIMIT' | 'XML_UNSUPPORTED' | 'WORKER_FAILED';

export class EngineError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

export function safeError(error: unknown): { code: ErrorCode; message: string } {
  if (error instanceof EngineError) return { code: error.code, message: error.message };
  return { code: 'FILE_INVALID_PACKAGE', message: '파일 구조를 확인하지 못했습니다. 원본은 변경되지 않았습니다.' };
}

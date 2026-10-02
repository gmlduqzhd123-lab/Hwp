import { EngineError } from '../../domain/errors';

export function invalidPackage(): never {
  throw new EngineError('FILE_INVALID_PACKAGE', '올바른 HWPX 패키지가 아니거나 파일이 손상되었습니다. 원본은 변경되지 않았습니다.');
}

export function encryptedPackage(): never {
  throw new EngineError('FILE_ENCRYPTED', '암호화된 파일은 검사할 수 없습니다. 암호를 해제한 HWPX 파일을 선택해 주세요.');
}

export function resourceLimit(): never {
  throw new EngineError('RESOURCE_LIMIT', '파일이 안전한 처리 한도를 초과했습니다. 더 작은 HWPX 파일을 선택해 주세요.');
}

export function unsupportedFile(): never {
  throw new EngineError('FILE_UNSUPPORTED', 'HWP·PDF와 다른 파일 형식은 지원하지 않습니다. HWPX 파일을 선택해 주세요. 확장자 변경은 변환이 아닙니다.');
}

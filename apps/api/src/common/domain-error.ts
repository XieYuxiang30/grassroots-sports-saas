import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 领域错误码：前端据 `code` 做本地化文案，不要把中文提示硬编码在 UI 里。
 */
export type DomainErrorCode =
  | 'MATCH_NOT_FOUND'
  | 'MATCH_ARCHIVED'
  | 'SEASON_NOT_FOUND'
  | 'PLAYER_NOT_FOUND'
  | 'PLAYER_DUPLICATE_JERSEY'
  | 'INVALID_PASSCODE'
  | 'INVALID_EVENT'
  | 'NO_UNDOABLE_EVENT'
  | 'SHARE_CODE_NOT_FOUND'
  | 'SHARE_CODE_CONFLICT'
  | 'TOO_MANY_EVENTS'
  | 'STORE_NOT_READY';

export class DomainError extends HttpException {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string, status: HttpStatus = HttpStatus.BAD_REQUEST) {
    super({ statusCode: status, code, message, error: code }, status);
    this.code = code;
  }

  static notFound(code: DomainErrorCode, message: string): DomainError {
    return new DomainError(code, message, HttpStatus.NOT_FOUND);
  }

  static forbidden(code: DomainErrorCode, message: string): DomainError {
    return new DomainError(code, message, HttpStatus.FORBIDDEN);
  }

  static conflict(code: DomainErrorCode, message: string): DomainError {
    return new DomainError(code, message, HttpStatus.CONFLICT);
  }
}

/** 全局异常过滤器输出体，与前端约定的 ApiErrorBody 对齐。 */
export interface ApiErrorPayload {
  statusCode: number;
  code: DomainErrorCode | 'INTERNAL_ERROR';
  message: string;
  error: string;
}

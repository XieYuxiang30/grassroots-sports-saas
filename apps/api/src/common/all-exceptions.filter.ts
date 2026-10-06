import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import type { ApiErrorPayload } from './domain-error';
import { DomainError } from './domain-error';

/**
 * 统一错误响应格式。
 *
 * 前端（计分端 PWA / 观众端 H5 / 小程序）只需要处理一种错误结构：
 * `{ statusCode, code, message, error }`，其中 `code` 是机器可读的领域错误码。
 * 现场排查时，日志里也能直接看到 code，不用去猜字符串。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<{ method?: string; url?: string }>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let payload: ApiErrorPayload = {
      statusCode: status,
      code: 'INTERNAL_ERROR',
      message: '服务器内部错误，请联系管理员',
      error: 'INTERNAL_ERROR',
    };

    if (exception instanceof DomainError) {
      status = exception.getStatus();
      const body = exception.getResponse() as { code?: string; message?: string };
      payload = {
        statusCode: status,
        code: (body.code ?? 'INVALID_EVENT') as ApiErrorPayload['code'],
        message: body.message ?? exception.message,
        error: body.code ?? 'DOMAIN_ERROR',
      };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      const message =
        typeof body === 'string'
          ? body
          : ((body as { message?: string | string[] }).message ?? exception.message);
      payload = {
        statusCode: status,
        code: status === HttpStatus.NOT_FOUND ? 'MATCH_NOT_FOUND' : 'INVALID_EVENT',
        message: Array.isArray(message) ? message.join('；') : message,
        error: 'HTTP_ERROR',
      };
    }

    if (status >= 500) {
      this.logger.error(
        `${request?.method ?? '?'} ${request?.url ?? '?'} → ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json(payload);
  }
}

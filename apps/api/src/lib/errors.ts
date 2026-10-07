import {inspect} from 'node:util';

import {
  AppError,
  ERROR_CATALOG,
  type ErrorCode,
  type ErrorResponseBody,
  shouldNotify,
} from '@gift-inspector/shared';
import type {FastifyBaseLogger, FastifyReply, FastifyRequest} from 'fastify';

import type {Notifier} from './notifier';

/** Fastify 自身が投げるエラーのうち、カタログのコードに対応付けるもの */
const FASTIFY_ERROR_CODES: Record<string, ErrorCode> = {
  FST_ERR_CTP_BODY_TOO_LARGE: 'UPLOAD_TOO_LARGE',
  FST_REQ_FILE_TOO_LARGE: 'UPLOAD_TOO_LARGE',
  FST_FILES_LIMIT: 'UPLOAD_TOO_LARGE',
  FST_PARTS_LIMIT: 'UPLOAD_TOO_LARGE',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'VALIDATION_FAILED',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'VALIDATION_FAILED',
  FST_ERR_CTP_INVALID_JSON_BODY: 'VALIDATION_FAILED',
  FST_INVALID_MULTIPART_CONTENT_TYPE: 'VALIDATION_FAILED',
  FST_ERR_VALIDATION: 'VALIDATION_FAILED',
};

/**
 * あらゆる throw をカタログのコードに写像する。写像できないものは SYS_UNEXPECTED。
 * ここを通らずにエラー応答を返す経路を作らないこと。
 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error) {
    const fastifyCode = (err as {code?: unknown}).code;
    if (typeof fastifyCode === 'string' && fastifyCode in FASTIFY_ERROR_CODES) {
      return new AppError(FASTIFY_ERROR_CODES[fastifyCode] as ErrorCode, {
        detail: err.message,
        cause: err,
      });
    }
    if ('validation' in err) {
      return new AppError('VALIDATION_FAILED', {detail: err.message, cause: err});
    }
  }
  return new AppError('SYS_UNEXPECTED', {
    detail: err instanceof Error ? err.message : String(err),
    cause: err,
  });
}

/** ログに出す例外の情報（ヘッダー・APIキー・画像本体などは出さない） */
export function serializeErrorForLog(err: AppError) {
  const cause = err.cause;
  return {
    errorCode: err.code,
    category: err.category,
    detail: err.detail,
    cause:
      cause instanceof Error
        ? {
            name: cause.name,
            message: cause.message,
            // 想定外のエラーだけスタックを残す（原因の特定に必要）
            stack: err.code === 'SYS_UNEXPECTED' ? cause.stack : undefined,
          }
        : cause === undefined
          ? undefined
          : inspect(cause, {depth: 2, breakLength: Infinity}),
  };
}

/** エラーをログに出し、必要なら通知する。応答を返さない経路（バッチ処理など）でも使う */
export function reportError(
  logger: FastifyBaseLogger,
  notifier: Notifier,
  err: AppError,
  context: {requestId?: string | null; inspectionId?: string | null; where?: string} = {}
): void {
  const payload = {...serializeErrorForLog(err), ...context};
  if (shouldNotify(err.code)) {
    logger.error(payload, ERROR_CATALOG[err.code].userMessage);
    notifier.notify({
      key: err.code,
      title: `${err.code}（${err.category}）`,
      fields: {
        where: context.where,
        requestId: context.requestId,
        inspectionId: context.inspectionId,
        detail: err.detail,
        cause: err.cause instanceof Error ? err.cause.message : undefined,
      },
    });
  } else {
    logger.warn(payload, ERROR_CATALOG[err.code].userMessage);
  }
}

export function buildErrorBody(
  err: AppError,
  requestId: string | null,
  inspectionId: string | null
): ErrorResponseBody {
  const def = ERROR_CATALOG[err.code];
  return {
    error: {
      code: err.code,
      category: def.category,
      message: def.userMessage,
      requestId,
      inspectionId,
    },
  };
}

/** エラー応答を返す唯一の関数 */
export function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  notifier: Notifier,
  err: AppError,
  inspectionId: string | null = null
): FastifyReply {
  reportError(request.log, notifier, err, {
    requestId: request.id,
    inspectionId,
    where: `${request.method} ${request.routeOptions.url ?? request.url}`,
  });
  const status = ERROR_CATALOG[err.code].httpStatus ?? 500;
  return reply.code(status).type('application/json').send(buildErrorBody(err, request.id, inspectionId));
}

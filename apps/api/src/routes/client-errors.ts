import {AppError, ERROR_CATALOG, isErrorCode} from '@gift-inspector/shared';
import type {FastifyPluginAsync} from 'fastify';
import {z} from 'zod';

import type {AppDeps} from '../app';

const bodySchema = z.object({
  code: z.string().max(64),
  message: z.string().max(2_000).optional(),
  stack: z.string().max(8_000).optional(),
  inspectionId: z.uuid().nullable().optional(),
  requestId: z.string().max(64).nullable().optional(),
  url: z.string().max(500).optional(),
  userAgent: z.string().max(500).optional(),
});

/**
 * POST /api/client-errors
 * web で起きたエラーを受け取り、API のログに出す。SYSTEM・CONFIG・未知のコードは通知する。
 * web 側は送信に失敗しても画面表示に影響させない。
 */
export const clientErrorRoutes: FastifyPluginAsync<AppDeps> = async (app, {notifier}) => {
  app.post('/api/client-errors', async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError('VALIDATION_FAILED', {detail: parsed.error.message});
    }
    const body = parsed.data;
    const category = isErrorCode(body.code) ? ERROR_CATALOG[body.code].category : 'UNKNOWN';
    const important = category === 'UNKNOWN' || category === 'SYSTEM' || category === 'CONFIG';

    const payload = {
      source: 'web',
      clientErrorCode: body.code,
      category,
      clientMessage: body.message,
      clientStack: body.stack,
      inspectionId: body.inspectionId ?? null,
      clientRequestId: body.requestId ?? null,
      url: body.url,
      userAgent: body.userAgent,
    };
    if (important) {
      request.log.error(payload, 'クライアントでエラーが発生しました');
      notifier.notify({
        key: `client:${body.code}`,
        title: `クライアントエラー ${body.code}（${category}）`,
        fields: {
          message: body.message,
          inspectionId: body.inspectionId,
          requestId: body.requestId,
          url: body.url,
          userAgent: body.userAgent,
        },
      });
    } else {
      request.log.warn(payload, 'クライアントでエラーが発生しました');
    }
    return reply.code(204).send();
  });
};

import multipart from '@fastify/multipart';
import {AppError, INSPECTION_FIELDS} from '@gift-inspector/shared';
import type {FastifyPluginAsync} from 'fastify';

import type {AppDeps} from '../app';
import {runInspection, validateInspectionId} from '../inspection/run';
import {sendError, toAppError} from '../lib/errors';

/**
 * POST /api/inspections（multipart: inspection_id, order_code, image）
 * 判定が行われたら 200 で InspectionResult、行われなければエラー応答（inspectionId つき）。
 */
export const inspectionRoutes: FastifyPluginAsync<AppDeps> = async (app, deps) => {
  await app.register(multipart, {
    throwFileSizeLimit: true,
    limits: {
      fileSize: deps.config.IMAGE_MAX_BYTES,
      files: 1,
      fields: 4,
      fieldSize: 256,
      parts: 6,
    },
  });

  app.post('/api/inspections', async (request, reply) => {
    let inspectionId: string | null = null;
    try {
      if (!request.isMultipart()) {
        throw new AppError('VALIDATION_FAILED', {detail: 'multipart/form-data ではない'});
      }
      const fields: Record<string, string> = {};
      let image: Buffer | null = null;
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== INSPECTION_FIELDS.image) {
            throw new AppError('VALIDATION_FAILED', {
              detail: `想定外のファイル項目: ${part.fieldname}`,
            });
          }
          image = await part.toBuffer();
        } else {
          fields[part.fieldname] = String(part.value);
          // エラー応答にも検品IDを載せられるよう、受け取った時点で控える
          if (part.fieldname === INSPECTION_FIELDS.inspectionId) {
            inspectionId = validateInspectionId(fields[part.fieldname]);
          }
        }
      }
      inspectionId = validateInspectionId(fields[INSPECTION_FIELDS.inspectionId]);
      const orderCode = fields[INSPECTION_FIELDS.orderCode];
      if (!orderCode) throw new AppError('VALIDATION_FAILED', {detail: 'order_code がない'});
      if (!image || image.length === 0)
        throw new AppError('VALIDATION_FAILED', {detail: 'image がない'});

      request.log.info({inspectionId, orderCode, imageBytes: image.length}, '検品を受け付けました');
      const result = await runInspection(
        {
          inspectionId,
          orderCode,
          image,
          requestId: request.id,
          userAgent: request.headers['user-agent'] ?? null,
        },
        {
          config: deps.config,
          db: deps.db,
          provider: deps.provider,
          logger: request.log,
          notifier: deps.notifier,
        }
      );
      request.log.info(
        {inspectionId, overall: result.overall, replayed: result.replayed},
        '検品が完了しました'
      );
      return result;
    } catch (err: unknown) {
      return sendError(request, reply, deps.notifier, toAppError(err), inspectionId);
    }
  });
};

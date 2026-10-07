import multipart from '@fastify/multipart';
import {
  AppError,
  INSPECTION_FIELDS,
  MANUAL_ORDER_CODE,
  MIZUHIKI_TYPES,
  type MizuhikiType,
} from '@gift-inspector/shared';
import type {FastifyPluginAsync} from 'fastify';

import type {AppDeps} from '../app';
import {runInspection, validateInspectionId} from '../inspection/run';
import type {Expected} from '../judge/judge';
import {sendError, toAppError} from '../lib/errors';

/**
 * POST /api/inspections（multipart: inspection_id, order_code, image）
 * order_code が MANUAL のときは開発用の手入力モード（DEV_MODE_ENABLED=true のときだけ。正解の6項目を追加で受け取る）
 * 判定が行われたら 200 で InspectionResult、行われなければエラー応答（inspectionId つき）。
 */
export const inspectionRoutes: FastifyPluginAsync<AppDeps> = async (app, deps) => {
  await app.register(multipart, {
    throwFileSizeLimit: true,
    limits: {
      fileSize: deps.config.IMAGE_MAX_BYTES,
      files: 1,
      // 手入力モードでは正解の6項目が加わる。カード文面（最大 1000 文字）が入る大きさにする
      fields: 10,
      fieldSize: 4096,
      parts: 12,
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

      // 開発モードが無効なら、手入力の中身を見る前に断る
      if (orderCode === MANUAL_ORDER_CODE && !deps.config.DEV_MODE_ENABLED) {
        throw new AppError('DEV_MODE_DISABLED', {detail: '手入力モードの依頼を受けた'});
      }
      const manualExpected = orderCode === MANUAL_ORDER_CODE ? parseManualExpected(fields) : null;

      request.log.info(
        {
          inspectionId,
          orderCode,
          mode: manualExpected ? 'manual' : 'order',
          imageBytes: image.length,
        },
        '検品を受け付けました'
      );
      const result = await runInspection(
        {
          inspectionId,
          orderCode,
          manualExpected,
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

const MAX_LENGTH = {omotegaki: 64, atena: 128, cardText: 1000} as const;

function text(fields: Record<string, string>, name: string, max: number): string | null {
  const v = fields[name];
  if (v === undefined || v.trim() === '') return null;
  if ([...v].length > max) throw new AppError('VALIDATION_FAILED', {detail: `${name} が長すぎる`});
  return v;
}

function bool(fields: Record<string, string>, name: string): boolean {
  const v = fields[name];
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new AppError('VALIDATION_FAILED', {detail: `${name} は true / false`});
}

/**
 * 開発用の手入力モードの正解を読む。形式だけを検査し、内容の妥当性（必須項目が空でないか）は
 * runInspection の assertValidExpected が通常と同じ規則で検査する。
 */
function parseManualExpected(fields: Record<string, string>): Expected {
  const f = INSPECTION_FIELDS;
  const noshiType = fields[f.expectedNoshiType] || null;
  if (noshiType !== null && !(MIZUHIKI_TYPES as readonly string[]).includes(noshiType)) {
    throw new AppError('VALIDATION_FAILED', {detail: `${f.expectedNoshiType} が不正`});
  }
  return {
    omotegaki: text(fields, f.expectedOmotegaki, MAX_LENGTH.omotegaki),
    atena: text(fields, f.expectedAtena, MAX_LENGTH.atena),
    cardText: text(fields, f.expectedCardText, MAX_LENGTH.cardText),
    noshiType: noshiType as MizuhikiType | null,
    noshiRequired: bool(fields, f.noshiRequired),
    cardRequired: bool(fields, f.cardRequired),
  };
}

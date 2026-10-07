/**
 * 検品の実行（docs/error-handling.md 3.3・3.4）。
 *   1. 入力検証（オーダー・正解データ・画像）
 *   2. 冪等性の確認（同じ inspection_id）
 *   3. 画像を保存 → PENDING 行を INSERT
 *   4. AI 読取（ガード付き）→ 突合
 *   5. 行を UPDATE して確定。確定できなければ結果を返さない（PERSIST_FAILED）
 * 判定が行われなかった場合は AppError を投げる（ルートがエラー応答にする）。
 */
import {
  AppError,
  type ErrorCode,
  type InspectionItem,
  type InspectionResult,
  isErrorCode,
  ITEM_LABELS,
  MANUAL_ORDER_CODE,
  ORDER_CODE_PATTERN,
  TIMEOUTS_MS,
} from '@gift-inspector/shared';
import type {FastifyBaseLogger} from 'fastify';

import {type AttemptRecord, type GuardDeps, guardedRead} from '../ai/guard';
import {PROMPT_VERSION, SCHEMA_VERSION} from '../ai/prompt';
import type {AiProvider} from '../ai/types';
import type {Config} from '../config';
import {
  completeInspection,
  failInspection,
  findInspection,
  insertPending,
  type StoredInspection,
} from '../db/inspections';
import {findOrderWithId} from '../db/orders';
import type {Db} from '../db/pool';
import {assertValidExpected, type Expected, judge, type Judgement} from '../judge/judge';
import type {Notifier} from '../lib/notifier';
import {inspectImage, saveImage, sha256} from '../storage/images';

/** クライアントは crypto.randomUUID()（v4）で発行する */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface InspectInput {
  inspectionId: string;
  orderCode: string;
  /**
   * 開発用の手入力モード（orderCode = MANUAL_ORDER_CODE）の正解。DEV_MODE_ENABLED=true のときだけ受け付ける。
   * 判定は通常と同じ関数・規則で行い、AI には渡さない
   */
  manualExpected?: Expected | null;
  image: Buffer;
  requestId: string;
  userAgent: string | null;
}

export interface InspectDeps {
  config: Config;
  db: Db;
  provider: AiProvider;
  logger: FastifyBaseLogger;
  /** 総合 ERROR の検品を通知する（docs/error-handling.md 0章-4・5.2） */
  notifier: Notifier;
  now?: () => number;
  guardDeps?: GuardDeps;
}

/** judge_detail に保存し、再送時に応答を再構成するための情報 */
interface StoredDetail {
  result: Omit<InspectionResult, 'replayed' | 'completedAt'>;
}

export function validateInspectionId(value: string | undefined): string {
  if (!value || !UUID_PATTERN.test(value)) {
    throw new AppError('VALIDATION_FAILED', {detail: 'inspection_id が UUID ではない'});
  }
  return value.toLowerCase();
}

export async function runInspection(
  input: InspectInput,
  deps: InspectDeps
): Promise<InspectionResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const deadline = startedAt + TIMEOUTS_MS.inspectionTotal;
  const {inspectionId} = input;
  const imageHash = sha256(input.image);

  const manual = input.manualExpected ?? null;
  // 開発モードが無効なら、手入力の依頼は何もせずに断る（再送の確認より先）
  if (manual && !deps.config.DEV_MODE_ENABLED) {
    throw new AppError('DEV_MODE_DISABLED', {detail: '手入力モードの依頼を受けた'});
  }
  const target: ReplayTarget = manual
    ? {mode: 'manual', orderCode: MANUAL_ORDER_CODE, expected: manual}
    : {mode: 'order', orderCode: input.orderCode};

  // --- 2. 冪等性（同じ ID の再送）。保存済みの結果を返すのは、同じ画像・同じ判定対象のときだけ
  const existing = await findInspection(deps.db, inspectionId);
  if (existing) return replay(existing, target, imageHash);

  // --- 1. 入力検証
  let orderId: number | null = null;
  let expected: Expected;
  if (manual) {
    expected = manual;
  } else {
    if (!ORDER_CODE_PATTERN.test(input.orderCode)) {
      throw new AppError('ORDER_NOT_FOUND', {detail: 'コードの形式が不正'});
    }
    const found = await findOrderWithId(deps.db, input.orderCode);
    if (!found) throw new AppError('ORDER_NOT_FOUND', {detail: input.orderCode});
    const {order} = found;
    orderId = found.id;
    expected = {
      omotegaki: order.omotegaki,
      atena: order.atena,
      cardText: order.cardText,
      noshiType: order.noshiType,
      noshiRequired: order.noshiRequired,
      cardRequired: order.cardRequired,
    };
  }
  // AI を呼ぶ前に正解データを検査する（不備なら CONFIG_INVALID_EXPECTED）
  assertValidExpected(expected);

  if (input.image.length > deps.config.IMAGE_MAX_BYTES) {
    throw new AppError('UPLOAD_TOO_LARGE', {detail: `${input.image.length}B`});
  }
  const image = inspectImage(input.image);

  // --- 3. 保存と PENDING 行
  const saved = await saveImage(
    deps.config.IMAGE_DIR,
    inspectionId,
    input.image,
    image,
    new Date(startedAt)
  );
  const inserted = await insertPending(deps.db, {
    inspectionId,
    requestId: input.requestId,
    orderId,
    mode: target.mode,
    expected,
    image: {path: saved.relativePath, sha256: saved.sha256, bytes: saved.bytes, ...image},
    ai: {
      provider: deps.provider.name,
      model: deps.provider.model,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
    },
    appVersion: deps.config.APP_VERSION,
    clientUa: input.userAgent,
  });
  if (!inserted) {
    // 並行した再送が先に INSERT した
    const other = await findInspection(deps.db, inspectionId);
    if (other) return replay(other, target, imageHash);
    throw new AppError('INSPECTION_IN_PROGRESS');
  }

  // --- 4. AI 読取と突合。ここから先は、何が起きても行を閉じる
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('inspection timeout')),
    Math.max(0, deadline - now())
  );
  let attempts: AttemptRecord[] = [];
  try {
    const read = await guardedRead(
      deps.provider,
      {image: input.image, mimeType: image.mime, inspectionId},
      {deadline, signal: controller.signal, deps: deps.guardDeps}
    );
    attempts = read.attempts;
    const judgement = judge(expected, read, {
      refMismatchBlocksOk: deps.config.REF_MISMATCH_BLOCKS_OK,
    });
    const result = toResult(
      inspectionId,
      target,
      judgement,
      read.status === 'ok' ? read.data : null,
      expected
    );
    const adopted = attempts[attempts.length - 1];

    // --- 5. 確定
    let persisted = false;
    try {
      persisted = await completeInspection(deps.db, inspectionId, {
        judgement,
        attempts,
        rawResponse: adopted?.raw ?? null,
        read: {
          noshiPresent: result?.reference.noshiPresent ?? null,
          cardPresent: result?.reference.cardPresent ?? null,
          noshiType: result?.reference.mizuhikiRead ?? null,
        },
        tokensIn: sum(attempts.map(a => a.tokensIn)),
        tokensOut: sum(attempts.map(a => a.tokensOut)),
        durationMs: now() - startedAt,
        errorDetail: judgement.overall === 'ERROR' ? (lastDetail(attempts) ?? null) : null,
        detail: result ? ({result} satisfies StoredDetail) : null,
      });
    } catch (err: unknown) {
      throw new AppError('PERSIST_FAILED', {detail: errorMessage(err), cause: err});
    }
    if (!persisted) {
      throw new AppError('PERSIST_FAILED', {
        detail: 'PENDING 行を更新できなかった（既に閉じられている）',
      });
    }

    if (judgement.overall === 'ERROR' || !result) {
      // 判定が行われなかった検品は、分類（再試行で直るものも含む）に関係なく通知する
      deps.notifier.notify({
        key: `inspection:ERROR:${judgement.errorCode ?? 'SYS_UNEXPECTED'}`,
        title: `検品が ERROR で終わりました（${judgement.errorCode ?? 'SYS_UNEXPECTED'}）`,
        fields: {
          inspectionId,
          orderCode: input.orderCode,
          attempts: attempts.length,
          detail: lastDetail(attempts),
        },
      });
      throw new AppError(judgement.errorCode ?? 'SYS_UNEXPECTED', {detail: lastDetail(attempts)});
    }
    return {...result, completedAt: new Date(now()).toISOString(), replayed: false};
  } catch (err: unknown) {
    const appErr =
      err instanceof AppError
        ? err
        : new AppError('SYS_UNEXPECTED', {detail: errorMessage(err), cause: err});
    // 判定結果で確定済み（ERROR 判定）でなければ、行を ERROR で閉じる。閉じられなくてもエラーは表に出す
    if (appErr.code === 'PERSIST_FAILED' || !(await isClosed(deps.db, inspectionId))) {
      await closeQuietly(
        deps,
        inspectionId,
        appErr.code,
        appErr.detail ?? null,
        attempts,
        now() - startedAt
      );
    }
    throw appErr;
  } finally {
    clearTimeout(timer);
  }
}

function sum(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null);
  return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function lastDetail(attempts: AttemptRecord[]): string | undefined {
  return attempts[attempts.length - 1]?.detail ?? undefined;
}

async function isClosed(db: Db, inspectionId: string): Promise<boolean> {
  try {
    return (await findInspection(db, inspectionId))?.status === 'DONE';
  } catch {
    return false;
  }
}

/** 行を ERROR で閉じる。失敗してもログに出すだけ（元のエラーを優先して表に出す。放置行は掃除で閉じる） */
async function closeQuietly(
  deps: InspectDeps,
  inspectionId: string,
  code: ErrorCode,
  detail: string | null,
  attempts: AttemptRecord[],
  durationMs: number
): Promise<void> {
  try {
    const closed = await failInspection(deps.db, inspectionId, code, detail, attempts, durationMs);
    if (!closed)
      deps.logger.warn(
        {inspectionId, errorCode: code},
        '検品行を ERROR で閉じられませんでした（行がないか既に完了）'
      );
  } catch (err: unknown) {
    deps.logger.error(
      {inspectionId, errorCode: code, err: errorMessage(err)},
      '検品行を ERROR で閉じられませんでした。5分後に SYS_ABANDONED として閉じられます'
    );
  }
}

function toResult(
  inspectionId: string,
  target: ReplayTarget,
  j: Judgement,
  read: {noshi_present: boolean; card_present: boolean; mizuhiki_type: string} | null,
  expected: Expected
): Omit<InspectionResult, 'replayed' | 'completedAt'> | null {
  if (j.overall === 'ERROR' || j.items === null) return null;
  const items: InspectionItem[] = j.items.map(i => ({
    key: i.key,
    label: ITEM_LABELS[i.key],
    result: i.result,
    reason: i.reason,
    expected: i.expected,
    read: i.read,
  }));
  return {
    inspectionId,
    orderCode: target.orderCode,
    mode: target.mode,
    overall: j.overall,
    ngReason: j.ngReason,
    unreadableReason: j.unreadableReason,
    items,
    refWarnings: j.refWarnings,
    reference: {
      noshiPresent: read?.noshi_present ?? null,
      cardPresent: read?.card_present ?? null,
      mizuhikiRead: read?.mizuhiki_type ?? null,
      mizuhikiExpected: expected.noshiType,
    },
  };
}

/** 判定の対象（オーダー、または手入力の正解） */
type ReplayTarget =
  | {mode: 'order'; orderCode: string}
  | {mode: 'manual'; orderCode: typeof MANUAL_ORDER_CODE; expected: Expected};

function sameTarget(stored: StoredInspection, target: ReplayTarget): boolean {
  if (stored.mode !== target.mode) return false;
  if (target.mode === 'order') return stored.orderCode === target.orderCode;
  const a = stored.expected;
  const b = target.expected;
  return (
    a.omotegaki === b.omotegaki &&
    a.atena === b.atena &&
    a.cardText === b.cardText &&
    a.noshiType === b.noshiType &&
    a.noshiRequired === b.noshiRequired &&
    a.cardRequired === b.cardRequired
  );
}

/**
 * 同じ inspection_id の再送。保存済みの結果を返す（AI は呼ばない）。
 * 別の画像・別の判定対象（オーダー・手入力の正解）で同じ ID が使われた場合は、
 * 判定していない画像に結果を返さないよう拒否する。
 */
function replay(
  stored: StoredInspection,
  target: ReplayTarget,
  imageHash: string
): InspectionResult {
  if (
    !sameTarget(stored, target) ||
    (stored.imageSha256 !== null && stored.imageSha256 !== imageHash)
  ) {
    throw new AppError('VALIDATION_FAILED', {
      detail: '同じ inspection_id で別の画像または判定対象（オーダー・手入力の正解）が送られた',
    });
  }
  if (stored.status === 'PENDING') throw new AppError('INSPECTION_IN_PROGRESS');
  if (stored.overall === 'ERROR' || stored.overall === null) {
    const code: ErrorCode = isErrorCode(stored.errorCode) ? stored.errorCode : 'SYS_UNEXPECTED';
    throw new AppError(code, {detail: `再送（保存済みのエラー: ${stored.errorCode ?? 'なし'}）`});
  }
  const detail = stored.judgeDetail as StoredDetail | null;
  if (!detail?.result || detail.result.overall !== stored.overall) {
    throw new AppError('SYS_UNEXPECTED', {detail: '保存済みの判定結果を復元できない'});
  }
  return {
    ...detail.result,
    completedAt: (stored.completedAt ?? stored.createdAt).toISOString(),
    replayed: true,
  };
}

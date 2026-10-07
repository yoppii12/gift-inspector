/**
 * inspections テーブルの読み書き（docs/error-handling.md 3.4、db/migrations/001_init.sql）。
 */
import type {ErrorCode} from '@gift-inspector/shared';
import type {ResultSetHeader, RowDataPacket} from 'mysql2/promise';

import type {AttemptRecord} from '../ai/guard';
import type {Judgement} from '../judge/judge';
import {type Db, withDb} from './pool';

export interface PendingInspection {
  inspectionId: string;
  requestId: string;
  orderId: number;
  expected: {
    omotegaki: string | null;
    atena: string | null;
    cardText: string | null;
    noshiType: string | null;
    noshiRequired: boolean;
    cardRequired: boolean;
  };
  image: {
    path: string;
    sha256: string;
    bytes: number;
    mime: string;
    width: number | null;
    height: number | null;
  };
  ai: {provider: string; model: string; promptVersion: string; schemaVersion: number};
  appVersion: string;
  clientUa: string | null;
}

export type StoredStatus = 'PENDING' | 'DONE';

export interface StoredInspection {
  id: number;
  inspectionId: string;
  status: StoredStatus;
  overall: 'OK' | 'NG' | 'UNREADABLE' | 'ERROR' | null;
  errorCode: string | null;
  orderCode: string | null;
  /** 再送時に同じ画像かどうかを確かめるため */
  imageSha256: string | null;
  createdAt: Date;
  completedAt: Date | null;
  /** 完了時に保存した、応答の再構成に必要な情報 */
  judgeDetail: unknown;
}

interface StoredRow extends RowDataPacket {
  id: number;
  inspection_id: string;
  status: StoredStatus;
  overall: StoredInspection['overall'];
  error_code: string | null;
  order_code: string | null;
  image_sha256: string | null;
  created_at: Date;
  completed_at: Date | null;
  judge_detail: unknown;
}

export async function findInspection(
  db: Db,
  inspectionId: string
): Promise<StoredInspection | null> {
  return withDb(async () => {
    const [rows] = await db.query<StoredRow[]>(
      `SELECT i.id, i.inspection_id, i.status, i.overall, i.error_code, o.order_code, i.image_sha256,
              i.created_at, i.completed_at, i.judge_detail
         FROM inspections i LEFT JOIN demo_orders o ON o.id = i.order_id
        WHERE i.inspection_id = ?`,
      [inspectionId]
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      inspectionId: r.inspection_id,
      status: r.status,
      overall: r.overall,
      errorCode: r.error_code,
      orderCode: r.order_code,
      imageSha256: r.image_sha256,
      createdAt: r.created_at,
      completedAt: r.completed_at,
      judgeDetail: r.judge_detail,
    };
  });
}

/** PENDING 行を作る。同じ inspection_id が既にあれば false（並行した再送） */
export async function insertPending(db: Db, p: PendingInspection): Promise<boolean> {
  return withDb(async () => {
    try {
      await db.query(
        `INSERT INTO inspections
          (inspection_id, request_id, order_id, mode, status,
           expected_omotegaki, expected_atena, expected_card_text, expected_noshi_type,
           expected_noshi_required, expected_card_required,
           image_path, image_sha256, image_bytes, image_mime, image_width, image_height,
           ai_provider, ai_model, prompt_version, schema_version, app_version, client_ua)
         VALUES (?, ?, ?, 'order', 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          p.inspectionId,
          p.requestId,
          p.orderId,
          p.expected.omotegaki,
          p.expected.atena,
          p.expected.cardText,
          p.expected.noshiType,
          p.expected.noshiRequired ? 1 : 0,
          p.expected.cardRequired ? 1 : 0,
          p.image.path,
          p.image.sha256,
          p.image.bytes,
          p.image.mime,
          p.image.width,
          p.image.height,
          p.ai.provider,
          p.ai.model,
          p.ai.promptVersion,
          p.ai.schemaVersion,
          p.appVersion,
          p.clientUa?.slice(0, 500) ?? null,
        ]
      );
      return true;
    } catch (err: unknown) {
      if ((err as {code?: unknown}).code === 'ER_DUP_ENTRY') return false;
      throw err;
    }
  });
}

export interface Completion {
  judgement: Judgement;
  attempts: AttemptRecord[];
  /** 採用した試行の生の応答 */
  rawResponse: unknown;
  read: {
    noshiPresent: boolean | null;
    cardPresent: boolean | null;
    noshiType: string | null;
  };
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number;
  /** 判定が ERROR のときの詳細（最後の試行の内容など） */
  errorDetail: string | null;
  /** 応答の再構成用（judge_detail に保存） */
  detail: unknown;
}

function itemColumn(j: Judgement, key: 'omotegaki' | 'atena' | 'card_text') {
  const item = j.items?.find(i => i.key === key);
  return {result: item?.result ?? null, reason: item?.reason ?? null, read: item?.read ?? null};
}

/**
 * PENDING 行を完了させる。更新できなかった（行がない・既に完了）場合は false。
 * 呼び出し側は false や例外のとき、判定結果を返さずに PERSIST_FAILED にする。
 */
export async function completeInspection(
  db: Db,
  inspectionId: string,
  c: Completion
): Promise<boolean> {
  const j = c.judgement;
  const om = itemColumn(j, 'omotegaki');
  const at = itemColumn(j, 'atena');
  const ca = itemColumn(j, 'card_text');
  return withDb(async () => {
    const [res] = await db.query<ResultSetHeader>(
      `UPDATE inspections SET
          status = 'DONE', overall = ?, error_code = ?, error_detail = ?, unreadable_reason = ?,
          ai_attempt_count = ?, ai_attempts = CAST(? AS JSON), ai_raw_response = CAST(? AS JSON),
          tokens_in = ?, tokens_out = ?,
          read_omotegaki = ?, read_atena = ?, read_card_text = ?, read_noshi_type = ?,
          noshi_present = ?, card_present = ?,
          result_omotegaki = ?, result_atena = ?, result_card = ?,
          reason_omotegaki = ?, reason_atena = ?, reason_card = ?,
          ref_warnings = CAST(? AS JSON), judge_detail = CAST(? AS JSON),
          completed_at = CURRENT_TIMESTAMP(3), duration_ms = ?
        WHERE inspection_id = ? AND status = 'PENDING'`,
      [
        j.overall,
        j.errorCode,
        c.errorDetail?.slice(0, 1000) ?? null,
        j.unreadableReason,
        c.attempts.length,
        JSON.stringify(c.attempts),
        JSON.stringify(c.rawResponse ?? null),
        c.tokensIn,
        c.tokensOut,
        om.read?.slice(0, 255) ?? null,
        at.read?.slice(0, 255) ?? null,
        ca.read?.slice(0, 2000) ?? null,
        c.read.noshiType,
        c.read.noshiPresent === null ? null : c.read.noshiPresent ? 1 : 0,
        c.read.cardPresent === null ? null : c.read.cardPresent ? 1 : 0,
        om.result,
        at.result,
        ca.result,
        om.reason,
        at.reason,
        ca.reason,
        JSON.stringify(j.refWarnings),
        JSON.stringify(c.detail),
        c.durationMs,
        inspectionId,
      ]
    );
    return res.affectedRows === 1;
  });
}

/** 判定に入る前後のエラーで、PENDING 行を ERROR として閉じる */
export async function failInspection(
  db: Db,
  inspectionId: string,
  code: ErrorCode,
  detail: string | null,
  attempts: AttemptRecord[],
  durationMs: number
): Promise<boolean> {
  return withDb(async () => {
    const [res] = await db.query<ResultSetHeader>(
      `UPDATE inspections SET
          status = 'DONE', overall = 'ERROR', error_code = ?, error_detail = ?,
          ai_attempt_count = ?, ai_attempts = CAST(? AS JSON),
          completed_at = CURRENT_TIMESTAMP(3), duration_ms = ?
        WHERE inspection_id = ? AND status = 'PENDING'`,
      [
        code,
        detail?.slice(0, 1000) ?? null,
        attempts.length,
        JSON.stringify(attempts),
        durationMs,
        inspectionId,
      ]
    );
    return res.affectedRows === 1;
  });
}

/** 放置された PENDING 行を SYS_ABANDONED で閉じ、その inspection_id を返す */
export async function closeAbandoned(db: Db, olderThanMs: number): Promise<string[]> {
  return withDb(async () => {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT inspection_id FROM inspections
        WHERE status = 'PENDING' AND created_at < (CURRENT_TIMESTAMP(3) - INTERVAL ? MICROSECOND)`,
      [olderThanMs * 1000]
    );
    const ids = rows.map(r => String(r.inspection_id));
    if (ids.length === 0) return [];
    await db.query(
      `UPDATE inspections SET status = 'DONE', overall = 'ERROR', error_code = 'SYS_ABANDONED',
              error_detail = '処理が途中で止まった（プロセスの停止など）', completed_at = CURRENT_TIMESTAMP(3)
        WHERE status = 'PENDING' AND inspection_id IN (?)`,
      [ids]
    );
    return ids;
  });
}

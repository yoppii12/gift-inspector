import {AppError} from '@gift-inspector/shared';
import mysql from 'mysql2/promise';

import type {Config} from '../config';

export type Db = mysql.Pool;

export function createPool(config: Config): Db {
  return mysql.createPool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_NAME,
    // 1GB VPS 前提。同時検品は数件なので小さく保つ
    connectionLimit: 5,
    connectTimeout: 5_000,
    waitForConnections: true,
    queueLimit: 20,
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: false,
    enableKeepAlive: true,
  });
}

/**
 * DB 操作を実行し、接続系の失敗を DB_UNAVAILABLE に写像する。
 * それ以外（SQL の誤りなど）は呼び出し側の toAppError で SYS_UNEXPECTED になる。
 */
export async function withDb<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    if (isConnectionError(err)) {
      throw new AppError('DB_UNAVAILABLE', {detail: (err as Error).message, cause: err});
    }
    throw err;
  }
}

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'PROTOCOL_CONNECTION_LOST',
  'ER_CON_COUNT_ERROR',
  'ER_ACCESS_DENIED_ERROR',
  'ER_BAD_DB_ERROR',
  'POOL_CLOSED',
  'POOL_ENQUEUELIMIT',
]);

export function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as {code?: unknown}).code;
  return typeof code === 'string' && CONNECTION_ERROR_CODES.has(code);
}

/**
 * 放置された PENDING 行の掃除（docs/error-handling.md 3.4）。
 * プロセスが判定の途中で落ちた検品を SYS_ABANDONED として閉じ、通知する（気づけない中断を残さない）。
 */
import {AppError, TIMEOUTS_MS} from '@gift-inspector/shared';
import type {FastifyBaseLogger} from 'fastify';

import {closeAbandoned} from '../db/inspections';
import type {Db} from '../db/pool';
import {reportError, toAppError} from '../lib/errors';
import type {Notifier} from '../lib/notifier';

const SWEEP_INTERVAL_MS = 5 * 60_000;

export async function sweepAbandoned(
  db: Db,
  notifier: Notifier,
  logger: FastifyBaseLogger
): Promise<string[]> {
  try {
    const ids = await closeAbandoned(db, TIMEOUTS_MS.pendingAbandoned);
    if (ids.length > 0) {
      reportError(
        logger,
        notifier,
        new AppError('SYS_ABANDONED', {detail: `${ids.length}件: ${ids.join(', ')}`}),
        {
          where: 'sweepAbandoned',
        }
      );
    }
    return ids;
  } catch (err: unknown) {
    // 掃除自体の失敗（DB 停止など）も表に出す。次の周期で再試行される
    reportError(logger, notifier, toAppError(err), {where: 'sweepAbandoned'});
    return [];
  }
}

/** 起動時に1回、その後5分ごとに掃除する。戻り値で停止できる */
export function startSweeper(db: Db, notifier: Notifier, logger: FastifyBaseLogger): () => void {
  const run = () => void sweepAbandoned(db, notifier, logger);
  run();
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

import {constants} from 'node:fs';
import {access, mkdir, statfs} from 'node:fs/promises';

import type {FastifyPluginAsync} from 'fastify';

import {type Config, describeConfig, providerKeyName} from '../config';
import type {AppDeps} from '../app';

const MIN_FREE_BYTES = 500 * 1024 * 1024;
const DB_PING_TIMEOUT_MS = 3_000;

interface Check {
  ok: boolean;
  detail?: string;
}

/**
 * GET /api/health
 * 失敗した確認項目を返す（503）。cron の healthcheck.sh が5分ごとに叩いて通知する。
 * 秘匿情報は返さない。
 */
export const healthRoutes: FastifyPluginAsync<AppDeps> = async (app, {db, config}) => {
  app.get('/api/health', async (_request, reply) => {
    const checks: Record<string, Check> = {};

    try {
      const conn = await db.getConnection();
      try {
        await conn.query({sql: 'SELECT 1', timeout: DB_PING_TIMEOUT_MS});
        checks.db = {ok: true};
      } finally {
        conn.release();
      }
    } catch (err: unknown) {
      checks.db = {ok: false, detail: err instanceof Error ? err.message : String(err)};
    }

    try {
      await mkdir(config.IMAGE_DIR, {recursive: true});
      await access(config.IMAGE_DIR, constants.W_OK);
      const fs = await statfs(config.IMAGE_DIR);
      const free = fs.bavail * fs.bsize;
      checks.storage =
        free >= MIN_FREE_BYTES
          ? {ok: true, detail: `free ${Math.floor(free / 1024 / 1024)}MB`}
          : {ok: false, detail: `空き容量不足: ${Math.floor(free / 1024 / 1024)}MB`};
    } catch (err: unknown) {
      checks.storage = {ok: false, detail: err instanceof Error ? err.message : String(err)};
    }

    const aiConfigured =
      config.AI_PROVIDER === 'mock' || (config.AI_MODEL !== '' && hasProviderKey(config));
    checks.ai = aiConfigured
      ? {ok: true, detail: `${config.AI_PROVIDER}${config.AI_MODEL ? `/${config.AI_MODEL}` : ''}`}
      : {ok: false, detail: 'AIの設定が不足しています'};

    const ok = Object.values(checks).every(c => c.ok);
    if (!ok) app.log.warn({checks}, 'ヘルスチェックで失敗した項目があります');
    return reply.code(ok ? 200 : 503).send({
      status: ok ? 'OK' : 'NG',
      checks,
      app: describeConfig(config),
      memory: {rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024)},
    });
  });
};

function hasProviderKey(config: Config): boolean {
  const name = providerKeyName(config.AI_PROVIDER);
  return name !== null && config[name] !== '';
}

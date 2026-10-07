import {AppError} from '@gift-inspector/shared';
import pino from 'pino';

import {buildApp, LOGGER_OPTIONS} from './app';
import {ConfigError, describeConfig, loadConfig} from './config';
import {createPool} from './db/pool';
import {reportError} from './lib/errors';
import {createNotifier} from './lib/notifier';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err: unknown) {
    // logger を作る前なので JSON 1行で標準エラーに出す（journald に残る）
    const issues = err instanceof ConfigError ? err.issues : [String(err)];
    console.error(JSON.stringify({level: 60, msg: '環境変数が不正なため起動できません', issues}));
    process.exit(1);
  }

  const logger = pino({
    ...LOGGER_OPTIONS,
    level: config.NODE_ENV === 'production' ? 'info' : 'debug',
    base: {appVersion: config.APP_VERSION},
  });
  const notifier = createNotifier({
    webhookUrl: config.SLACK_WEBHOOK_URL,
    appVersion: config.APP_VERSION,
    logger,
  });
  const db = createPool(config);
  const deps = {config, db, notifier};
  const app = buildApp(deps, {loggerInstance: logger});

  // 握りつぶされた Promise・想定外の例外を見逃さない。記録・通知したうえで終了し、systemd に再起動させる
  const fatal = (kind: string) => (err: unknown) => {
    const appErr = new AppError('SYS_UNEXPECTED', {detail: kind, cause: err});
    reportError(app.log, deps.notifier, appErr, {where: kind});
    app.log.fatal({kind}, 'プロセスを終了します');
    setTimeout(() => process.exit(1), 1_000).unref();
  };
  process.on('unhandledRejection', fatal('unhandledRejection'));
  process.on('uncaughtException', fatal('uncaughtException'));

  const shutdown = (signal: string) => {
    app.log.info({signal}, '停止します');
    app
      .close()
      .then(() => db.end())
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        app.log.error(
          {err: err instanceof Error ? err.message : String(err)},
          '停止処理に失敗しました'
        );
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await app.listen({host: config.API_HOST, port: config.API_PORT});
  app.log.info({config: describeConfig(config)}, '起動しました');
}

main().catch((err: unknown) => {
  console.error(
    JSON.stringify({
      level: 60,
      msg: '起動に失敗しました',
      err:
        err instanceof Error
          ? {name: err.name, message: err.message, stack: err.stack}
          : String(err),
    })
  );
  process.exit(1);
});

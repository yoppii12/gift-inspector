import {randomUUID} from 'node:crypto';

import {AppError, TIMEOUTS_MS} from '@gift-inspector/shared';
import Fastify, {type FastifyBaseLogger, type FastifyInstance} from 'fastify';

import type {Config} from './config';
import type {Db} from './db/pool';
import {sendError, toAppError} from './lib/errors';
import type {Notifier} from './lib/notifier';
import {clientErrorRoutes} from './routes/client-errors';
import {healthRoutes} from './routes/health';
import {ordersRoutes} from './routes/orders';

export interface AppDeps {
  config: Config;
  db: Db;
  notifier: Notifier;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export const LOGGER_OPTIONS = {
  redact: ['req.headers.authorization', 'req.headers.cookie'],
};

export function buildApp(
  deps: AppDeps,
  options: {loggerInstance?: FastifyBaseLogger; logger?: boolean} = {}
): FastifyInstance {
  const app = Fastify({
    ...(options.loggerInstance
      ? {loggerInstance: options.loggerInstance}
      : {logger: options.logger ?? LOGGER_OPTIONS}),
    // OpenResty の $request_id を引き継ぎ、nginx と API のログを突き合わせられるようにする
    requestIdHeader: 'x-request-id',
    genReqId: req => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
        ? incoming
        : randomUUID();
    },
    requestTimeout: TIMEOUTS_MS.serverRequest,
    bodyLimit: 64 * 1024,
    trustProxy: '127.0.0.1',
  });

  app.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });

  // すべての例外はここでカタログのコードに写像され、ログ・通知・応答が行われる
  app.setErrorHandler((err, request, reply) => {
    return sendError(request, reply, deps.notifier, toAppError(err));
  });

  app.setNotFoundHandler((request, reply) => {
    return sendError(
      request,
      reply,
      deps.notifier,
      new AppError('VALIDATION_FAILED', {
        detail: `存在しない経路: ${request.method} ${request.url}`,
      })
    );
  });

  void app.register(healthRoutes, deps);
  void app.register(clientErrorRoutes, deps);
  void app.register(ordersRoutes, deps);

  return app;
}

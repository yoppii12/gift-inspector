import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {AppError, ERROR_CATALOG, type ErrorResponseBody} from '@gift-inspector/shared';
import {describe, expect, it, vi} from 'vitest';

import {buildApp} from '../src/app';
import {loadConfig} from '../src/config';
import type {Db} from '../src/db/pool';
import {toAppError} from '../src/lib/errors';
import type {NotifyEvent} from '../src/lib/notifier';

function connError(code: string): Error {
  return Object.assign(new Error(`connect ${code}`), {code});
}

function setup(dbImpl: Partial<Db> = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    DB_USER: 'u',
    DB_NAME: 'n',
    IMAGE_DIR: mkdtempSync(join(tmpdir(), 'gi-img-')),
  });
  const events: NotifyEvent[] = [];
  const notifier = {notify: vi.fn((e: NotifyEvent) => void events.push(e))};
  const db = {
    query: vi.fn(() => Promise.reject(connError('ECONNREFUSED'))),
    getConnection: vi.fn(() => Promise.reject(connError('ECONNREFUSED'))),
    ...dbImpl,
  } as unknown as Db;
  const app = buildApp({config, db, notifier}, {logger: false});
  return {app, events, notifier};
}

function errorBody(payload: string): ErrorResponseBody['error'] {
  return (JSON.parse(payload) as ErrorResponseBody).error;
}

describe('エラー応答の共通形式', () => {
  it('存在しない経路は VALIDATION_FAILED（JSON）になり、通知される', async () => {
    const {app, events} = setup();
    const res = await app.inject({method: 'GET', url: '/api/nope'});
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const err = errorBody(res.payload);
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.message).toBe(ERROR_CATALOG.VALIDATION_FAILED.userMessage);
    expect(err.requestId).toBeTruthy();
    expect(res.headers['x-request-id']).toBe(err.requestId);
    expect(events.map(e => e.key)).toEqual(['VALIDATION_FAILED']);
  });

  it('DB 接続断は DB_UNAVAILABLE（503）になり、通知される', async () => {
    const {app, events} = setup();
    const res = await app.inject({method: 'GET', url: '/api/orders'});
    expect(res.statusCode).toBe(503);
    expect(errorBody(res.payload).code).toBe('DB_UNAVAILABLE');
    expect(events.map(e => e.key)).toEqual(['DB_UNAVAILABLE']);
  });

  it('想定外の例外は SYS_UNEXPECTED（500）になり、内部のメッセージは利用者に返さない', async () => {
    const {app, events} = setup({
      query: vi.fn(() => Promise.reject(new Error('You have an error in your SQL syntax'))),
    });
    const res = await app.inject({method: 'GET', url: '/api/orders'});
    expect(res.statusCode).toBe(500);
    const err = errorBody(res.payload);
    expect(err.code).toBe('SYS_UNEXPECTED');
    expect(res.payload).not.toContain('SQL syntax');
    expect(events[0]?.fields.cause).toContain('SQL syntax');
  });

  it('形式の不正なオーダーコードは ORDER_NOT_FOUND（404）で、通知しない', async () => {
    const {app, events} = setup();
    const res = await app.inject({method: 'GET', url: '/api/orders/DROP%20TABLE'});
    expect(res.statusCode).toBe(404);
    expect(errorBody(res.payload).code).toBe('ORDER_NOT_FOUND');
    expect(events).toHaveLength(0);
  });

  it('リクエストIDは OpenResty から渡された値を引き継ぐ', async () => {
    const {app} = setup();
    const res = await app.inject({
      method: 'GET',
      url: '/api/nope',
      headers: {'x-request-id': 'abcdef0123456789abcdef0123456789'},
    });
    expect(errorBody(res.payload).requestId).toBe('abcdef0123456789abcdef0123456789');
  });

  it('JSON 本文の上限を超えると UPLOAD_TOO_LARGE（413）', async () => {
    const {app} = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/client-errors',
      headers: {'content-type': 'application/json'},
      payload: JSON.stringify({code: 'X', message: 'a'.repeat(100_000)}),
    });
    expect(res.statusCode).toBe(413);
    expect(errorBody(res.payload).code).toBe('UPLOAD_TOO_LARGE');
  });
});

describe('toAppError', () => {
  it('AppError はそのまま返す', () => {
    const e = new AppError('AI_TIMEOUT');
    expect(toAppError(e)).toBe(e);
  });

  it.each([null, undefined, 'string', 42, {foo: 1}])(
    'Error 以外（%s）も SYS_UNEXPECTED にする',
    v => {
      expect(toAppError(v).code).toBe('SYS_UNEXPECTED');
    }
  );
});

describe('ヘルスチェック', () => {
  it('DB に接続できなければ 503 で、失敗した項目を返す', async () => {
    const {app} = setup();
    const res = await app.inject({method: 'GET', url: '/api/health'});
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.payload) as {status: string; checks: Record<string, {ok: boolean}>};
    expect(body.status).toBe('NG');
    expect(body.checks.db?.ok).toBe(false);
    expect(body.checks.storage?.ok).toBe(true);
    // 秘匿情報を返さない
    expect(res.payload).not.toMatch(/password|api_key|webhook/i);
  });

  it('すべて正常なら 200', async () => {
    const conn = {query: vi.fn(() => Promise.resolve([[{1: 1}], []])), release: vi.fn()};
    const {app} = setup({
      getConnection: vi.fn(() => Promise.resolve(conn)),
    } as unknown as Partial<Db>);
    const res = await app.inject({method: 'GET', url: '/api/health'});
    expect(res.statusCode).toBe(200);
    expect(conn.release).toHaveBeenCalled();
  });
});

describe('クライアントエラー報告', () => {
  it('SYSTEM 分類と未知のコードは通知し、USER_ACTION は通知しない', async () => {
    const {app, events} = setup();
    for (const code of ['RESPONSE_INVALID', 'SOMETHING_NEW', 'CAMERA_PERMISSION_DENIED']) {
      const res = await app.inject({method: 'POST', url: '/api/client-errors', payload: {code}});
      expect(res.statusCode).toBe(204);
    }
    expect(events.map(e => e.key)).toEqual(['client:RESPONSE_INVALID', 'client:SOMETHING_NEW']);
  });
});

describe('設定の検証', () => {
  it('production で mock は起動できない', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DB_USER: 'u',
        DB_NAME: 'n',
        IMAGE_DIR: '/tmp',
        AI_PROVIDER: 'mock',
      })
    ).toThrow(/AI_PROVIDER/);
  });

  it('AI プロバイダを指定したらモデル名とキーが必須', () => {
    expect(() =>
      loadConfig({DB_USER: 'u', DB_NAME: 'n', IMAGE_DIR: '/tmp', AI_PROVIDER: 'anthropic'})
    ).toThrow(/AI_MODEL.*AI_API_KEY|AI_API_KEY.*AI_MODEL/);
  });

  it('エラーメッセージに値そのものを含めない', () => {
    try {
      loadConfig({
        DB_USER: 'u',
        DB_NAME: 'n',
        IMAGE_DIR: '/tmp',
        SLACK_WEBHOOK_URL: 'secret-not-a-url',
      });
      expect.unreachable();
    } catch (err: unknown) {
      expect(String(err)).not.toContain('secret-not-a-url');
    }
  });
});

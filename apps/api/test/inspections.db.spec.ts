/**
 * 検品 API の結合テスト（実際の MySQL 8.0 を使う）。`npm run test:db -w @gift-inspector/api` で実行する。
 * 通常の `npm test` では TEST_DB_HOST がないため実行されない（その旨を表示する）。
 */
import {randomUUID} from 'node:crypto';
import {chmodSync} from 'node:fs';

import type {ErrorResponseBody, InspectionResult} from '@gift-inspector/shared';
import mysql from 'mysql2/promise';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';

import {MOCK_READING, MockProvider, type MockStep} from '../src/ai/providers/mock';
import {ProviderError} from '../src/ai/types';
import {buildApp} from '../src/app';
import {loadConfig} from '../src/config';
import type {Db} from '../src/db/pool';
import {sweepAbandoned} from '../src/inspection/sweeper';
import {fakeHeic, fakeJpeg, inspectionForm, tempDir} from './helpers';

const enabled = Boolean(process.env.TEST_DB_HOST);
if (!enabled) {
  console.error(
    '[inspections.db.spec] TEST_DB_HOST がないため、DB の結合テストを実行しません（npm run test:db で実行）'
  );
}

const valid: MockStep = {type: 'tool_use', input: MOCK_READING};

describe.skipIf(!enabled)('POST /api/inspections（MySQL）', () => {
  let pool: mysql.Pool;
  const notify = vi.fn();

  beforeAll(() => {
    pool = mysql.createPool({
      host: process.env.TEST_DB_HOST,
      port: Number(process.env.TEST_DB_PORT),
      user: process.env.TEST_DB_USER,
      password: process.env.TEST_DB_PASSWORD,
      database: process.env.TEST_DB_NAME,
      timezone: 'Z',
      connectionLimit: 5,
    });
  });
  afterAll(async () => {
    await pool.end();
  });

  function setup(steps: MockStep[] = [valid], opts: {db?: Db; imageDir?: string} = {}) {
    const config = loadConfig({
      NODE_ENV: 'test',
      DB_USER: 'u',
      DB_NAME: 'n',
      IMAGE_DIR: opts.imageDir ?? tempDir(),
      APP_VERSION: 'test',
    });
    const provider = new MockProvider(steps, 0);
    const app = buildApp(
      {config, db: opts.db ?? pool, notifier: {notify}, provider},
      {logger: false}
    );
    return {app, provider, config};
  }

  async function post(
    app: ReturnType<typeof setup>['app'],
    id: string,
    order: string,
    image = fakeJpeg()
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/inspections',
      ...inspectionForm(id, order, image),
    });
  }

  async function row(id: string) {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM inspections WHERE inspection_id = ?',
      [id]
    );
    return rows[0];
  }

  it('登録どおりに読めれば 200 / OK で、DONE として記録される', async () => {
    const {app} = setup();
    const id = randomUUID();
    const res = await post(app, id, 'GIFT-DEMO-001');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as InspectionResult;
    expect(body).toMatchObject({inspectionId: id, overall: 'OK', replayed: false});
    expect(body.items.map(i => [i.key, i.result])).toEqual([
      ['omotegaki', 'OK'],
      ['atena', 'OK'],
      ['card_text', 'OK'],
    ]);
    const r = await row(id);
    expect(r).toMatchObject({
      status: 'DONE',
      overall: 'OK',
      error_code: null,
      ai_attempt_count: 1,
      prompt_version: 'read-v1',
    });
    expect(r?.image_sha256).toHaveLength(64);
  });

  it('デモの意図的 NG（表書き）は 200 / NG で、正解と読取値が並ぶ', async () => {
    const {app} = setup();
    const res = await post(app, randomUUID(), 'GIFT-DEMO-003');
    const body = JSON.parse(res.payload) as InspectionResult;
    expect(body.overall).toBe('NG');
    expect(body.items.find(i => i.key === 'omotegaki')).toMatchObject({
      result: 'NG',
      expected: '御礼',
      read: '御祝',
    });
  });

  it('同じ inspection_id の再送は保存済みの結果を返し、AI は1回しか呼ばない', async () => {
    const {app, provider} = setup();
    const id = randomUUID();
    const first = JSON.parse((await post(app, id, 'GIFT-DEMO-001')).payload) as InspectionResult;
    const second = JSON.parse((await post(app, id, 'GIFT-DEMO-001')).payload) as InspectionResult;
    expect(provider.requests).toHaveLength(1);
    expect(second).toMatchObject({overall: first.overall, replayed: true});
  });

  it('同じ inspection_id の同時送信でも、AI は1回しか呼ばない', async () => {
    const {app, provider} = setup();
    const id = randomUUID();
    const results = await Promise.all([
      post(app, id, 'GIFT-DEMO-001'),
      post(app, id, 'GIFT-DEMO-001'),
    ]);
    expect(provider.requests).toHaveLength(1);
    // 片方は判定して 200 / OK。もう片方は保存済みの結果（200 / replayed）か、処理中（409）
    const outcomes = results.map(r => {
      const body = JSON.parse(r.payload) as Partial<InspectionResult> & Partial<ErrorResponseBody>;
      return r.statusCode === 200
        ? `200:${body.overall}:${String(body.replayed)}`
        : `${r.statusCode}:${body.error?.code}`;
    });
    expect(outcomes).toContain('200:OK:false');
    const other = outcomes.find(o => o !== '200:OK:false') ?? outcomes[1];
    expect(['200:OK:true', '409:INSPECTION_IN_PROGRESS', '200:OK:false']).toContain(other);
    expect(outcomes.filter(o => o === '200:OK:false')).toHaveLength(1);
  });

  it.each([
    ['別の画像', 'GIFT-DEMO-001', fakeJpeg(200)],
    ['別のオーダー', 'GIFT-DEMO-003', fakeJpeg()],
  ])(
    '同じ inspection_id で%sを送っても、保存済みの結果は返さない（VALIDATION_FAILED）',
    async (_l, order, image) => {
      const {app, provider} = setup();
      const id = randomUUID();
      expect((await post(app, id, 'GIFT-DEMO-001')).statusCode).toBe(200);
      const res = await post(app, id, order, image);
      expect(res.statusCode).toBe(400);
      expect((JSON.parse(res.payload) as ErrorResponseBody).error).toMatchObject({
        code: 'VALIDATION_FAILED',
        inspectionId: id,
      });
      expect(res.payload).not.toContain('"overall"');
      expect(provider.requests).toHaveLength(1);
      expect(await row(id)).toMatchObject({overall: 'OK', order_id: 1});
    }
  );

  it('判定が ERROR になった検品は、再試行で直る種類（AI_TIMEOUT）でも通知され、詳細が記録される', async () => {
    const {app} = setup([{type: 'error', error: new ProviderError('timeout', 'mock timeout')}]);
    const id = randomUUID();
    notify.mockClear();
    const res = await post(app, id, 'GIFT-DEMO-001');
    expect(res.statusCode).toBe(504);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({key: 'inspection:ERROR:AI_TIMEOUT'})
    );
    expect(await row(id)).toMatchObject({
      overall: 'ERROR',
      error_code: 'AI_TIMEOUT',
      error_detail: 'mock timeout',
    });
  });

  it('AI の設定不備は AI_AUTH（502）で、ERROR として記録され、OK を返さない', async () => {
    const {app, provider} = setup([
      {type: 'error', error: new ProviderError('http', '401', {status: 401})},
    ]);
    const id = randomUUID();
    const res = await post(app, id, 'GIFT-DEMO-001');
    expect(res.statusCode).toBe(502);
    expect((JSON.parse(res.payload) as ErrorResponseBody).error).toMatchObject({
      code: 'AI_AUTH',
      inspectionId: id,
    });
    expect(res.payload).not.toContain('"overall"');
    expect(provider.requests).toHaveLength(1);
    expect(await row(id)).toMatchObject({
      status: 'DONE',
      overall: 'ERROR',
      error_code: 'AI_AUTH',
      ai_attempt_count: 1,
    });
  });

  it('AI の応答が2回とも不適合なら 200 / UNREADABLE で、試行2回分が記録される', async () => {
    const {app} = setup([{type: 'tool_use', input: {...MOCK_READING, extra: 1}}]);
    const id = randomUUID();
    const body = JSON.parse((await post(app, id, 'GIFT-DEMO-001')).payload) as InspectionResult;
    expect(body).toMatchObject({overall: 'UNREADABLE', unreadableReason: 'AI_SCHEMA_INVALID'});
    const r = await row(id);
    expect(r).toMatchObject({
      overall: 'UNREADABLE',
      ai_attempt_count: 2,
      unreadable_reason: 'AI_SCHEMA_INVALID',
    });
    expect(r?.ai_attempts).toHaveLength(2);
  });

  it('存在しないオーダーは ORDER_NOT_FOUND（404）で、行を作らない', async () => {
    const {app, provider} = setup();
    const id = randomUUID();
    const res = await post(app, id, 'GIFT-DEMO-999');
    expect(res.statusCode).toBe(404);
    expect(provider.requests).toHaveLength(0);
    expect(await row(id)).toBeUndefined();
  });

  it.each([
    ['HEIC', fakeHeic(), 415, 'IMAGE_UNSUPPORTED_TYPE'],
    ['途中で切れた JPEG', fakeJpeg().subarray(0, 50), 400, 'IMAGE_INVALID'],
  ])('%s は %i / %s で、AI を呼ばず行も作らない', async (_l, image, status, code) => {
    const {app, provider} = setup();
    const id = randomUUID();
    const res = await post(app, id, 'GIFT-DEMO-001', image);
    expect(res.statusCode).toBe(status);
    expect((JSON.parse(res.payload) as ErrorResponseBody).error.code).toBe(code);
    expect(provider.requests).toHaveLength(0);
    expect(await row(id)).toBeUndefined();
  });

  it('画像を保存できなければ STORAGE_WRITE_FAILED（500）で、AI を呼ばない', async () => {
    const dir = tempDir();
    chmodSync(dir, 0o500); // 書き込み不可
    const {app, provider} = setup([valid], {imageDir: dir});
    const id = randomUUID();
    const res = await post(app, id, 'GIFT-DEMO-001');
    chmodSync(dir, 0o700);
    expect(res.statusCode).toBe(500);
    expect((JSON.parse(res.payload) as ErrorResponseBody).error.code).toBe('STORAGE_WRITE_FAILED');
    expect(provider.requests).toHaveLength(0);
    expect(await row(id)).toBeUndefined();
  });

  it('判定後の記録（UPDATE）に失敗したら、判定結果を返さず PERSIST_FAILED（500）', async () => {
    // 完了の UPDATE だけ失敗させる
    const flaky = {
      query: (sql: string, params?: unknown[]) => {
        if (sql.includes("status = 'DONE', overall = ?")) {
          return Promise.reject(
            Object.assign(new Error('Lock wait timeout exceeded'), {code: 'ER_LOCK_WAIT_TIMEOUT'})
          );
        }
        return pool.query(sql, params);
      },
    } as unknown as Db;
    const {app} = setup([valid], {db: flaky});
    const id = randomUUID();
    const res = await post(app, id, 'GIFT-DEMO-001');
    expect(res.statusCode).toBe(500);
    expect((JSON.parse(res.payload) as ErrorResponseBody).error.code).toBe('PERSIST_FAILED');
    expect(res.payload).not.toContain('"overall"');
    // 行は ERROR で閉じられている（完了扱いの OK は残らない）
    expect(await row(id)).toMatchObject({
      status: 'DONE',
      overall: 'ERROR',
      error_code: 'PERSIST_FAILED',
    });
  });

  it('PENDING のまま放置された行は SYS_ABANDONED で閉じられ、通知される', async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO inspections (inspection_id, order_id, mode, expected_noshi_required, expected_card_required, created_at)
       VALUES (?, 1, 'order', 1, 1, CURRENT_TIMESTAMP(3) - INTERVAL 10 MINUTE)`,
      [id]
    );
    const fresh = randomUUID();
    await pool.query(
      `INSERT INTO inspections (inspection_id, order_id, mode, expected_noshi_required, expected_card_required)
       VALUES (?, 1, 'order', 1, 1)`,
      [fresh]
    );
    notify.mockClear();
    const closed = await sweepAbandoned(pool, {notify}, {error: vi.fn(), warn: vi.fn()} as never);
    expect(closed).toContain(id);
    expect(closed).not.toContain(fresh);
    expect(await row(id)).toMatchObject({
      status: 'DONE',
      overall: 'ERROR',
      error_code: 'SYS_ABANDONED',
    });
    expect(await row(fresh)).toMatchObject({status: 'PENDING'});
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({key: 'SYS_ABANDONED'}));
    await pool.query('DELETE FROM inspections WHERE inspection_id = ?', [fresh]);
  });

  it('処理中（PENDING）の ID を再送すると INSPECTION_IN_PROGRESS（409）', async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO inspections (inspection_id, order_id, mode, expected_noshi_required, expected_card_required)
       VALUES (?, 1, 'order', 1, 1)`,
      [id]
    );
    const {app, provider} = setup();
    const res = await post(app, id, 'GIFT-DEMO-001');
    expect(res.statusCode).toBe(409);
    expect(provider.requests).toHaveLength(0);
    await pool.query('DELETE FROM inspections WHERE inspection_id = ?', [id]);
  });

  it('どの検品でも、完了した行は必ず総合結果を持ち、ERROR は必ずエラーコードを持つ', async () => {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM inspections
        WHERE (status = 'DONE' AND overall IS NULL) OR (overall = 'ERROR' AND error_code IS NULL)`
    );
    expect(rows[0]?.n).toBe(0);
  });
});

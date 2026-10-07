/**
 * 検品 API のうち、DB を使わずに確かめられること（画像検査・入力検証・DB 停止）。
 * DB を使う流れは inspections.db.spec.ts（npm run test:db）。
 */
import {randomUUID} from 'node:crypto';

import {type ErrorResponseBody} from '@gift-inspector/shared';
import {describe, expect, it, vi} from 'vitest';

import {MOCK_READING, MockProvider} from '../src/ai/providers/mock';
import {buildApp} from '../src/app';
import {loadConfig} from '../src/config';
import type {Db} from '../src/db/pool';
import {inspectImage} from '../src/storage/images';
import {fakeHeic, fakeJpeg, inspectionForm, multipart, tempDir} from './helpers';

describe('画像の検査', () => {
  it('JPEG を受け付け、寸法を読む', () => {
    expect(inspectImage(fakeJpeg())).toEqual({
      mime: 'image/jpeg',
      ext: 'jpg',
      width: 1600,
      height: 1200,
    });
  });

  it('途中で切れた JPEG は IMAGE_INVALID', () => {
    const cut = fakeJpeg().subarray(0, 60);
    expect(() => inspectImage(cut)).toThrow('IMAGE_INVALID');
  });

  it('HEIC は IMAGE_UNSUPPORTED_TYPE', () => {
    expect(() => inspectImage(fakeHeic())).toThrow('IMAGE_UNSUPPORTED_TYPE');
  });

  it.each([
    ['GIF', Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(40)])],
    ['PDF', Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(40)])],
    ['テキスト', Buffer.from('this is not an image at all, really')],
  ])('%s は IMAGE_UNSUPPORTED_TYPE', (_label, buf) => {
    expect(() => inspectImage(buf)).toThrow('IMAGE_UNSUPPORTED_TYPE');
  });

  it('小さすぎるデータは IMAGE_INVALID', () => {
    expect(() => inspectImage(Buffer.from([0xff, 0xd8, 0xff]))).toThrow('IMAGE_INVALID');
  });
});

function connError(code: string): Error {
  return Object.assign(new Error(`connect ${code}`), {code});
}

function setup(maxBytes = 5 * 1024 * 1024) {
  const config = loadConfig({
    NODE_ENV: 'test',
    DB_USER: 'u',
    DB_NAME: 'n',
    IMAGE_DIR: tempDir(),
    IMAGE_MAX_BYTES: String(maxBytes),
  });
  const db = {query: vi.fn(() => Promise.reject(connError('ECONNREFUSED')))} as unknown as Db;
  const provider = new MockProvider([{type: 'tool_use', input: MOCK_READING}], 0);
  const notify = vi.fn();
  const app = buildApp({config, db, notifier: {notify}, provider}, {logger: false});
  return {app, provider, notify};
}

function error(payload: string): ErrorResponseBody['error'] {
  return (JSON.parse(payload) as ErrorResponseBody).error;
}

describe('POST /api/inspections（DB なし）', () => {
  it('multipart でなければ VALIDATION_FAILED', async () => {
    const {app} = setup();
    const res = await app.inject({method: 'POST', url: '/api/inspections', payload: {a: 1}});
    expect(res.statusCode).toBe(400);
    expect(error(res.payload).code).toBe('VALIDATION_FAILED');
  });

  it('inspection_id が UUID でなければ VALIDATION_FAILED', async () => {
    const {app} = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/inspections',
      ...inspectionForm('abc', 'GIFT-DEMO-001', fakeJpeg()),
    });
    expect(error(res.payload).code).toBe('VALIDATION_FAILED');
  });

  it('画像がなければ VALIDATION_FAILED（検品IDは応答に載る）', async () => {
    const {app} = setup();
    const id = randomUUID();
    const res = await app.inject({
      method: 'POST',
      url: '/api/inspections',
      ...multipart([
        {name: 'inspection_id', value: id},
        {name: 'order_code', value: 'GIFT-DEMO-001'},
      ]),
    });
    expect(error(res.payload)).toMatchObject({code: 'VALIDATION_FAILED', inspectionId: id});
  });

  it('上限を超える画像は UPLOAD_TOO_LARGE（413）で、AI を呼ばない', async () => {
    const {app, provider} = setup(1024);
    const id = randomUUID();
    const res = await app.inject({
      method: 'POST',
      url: '/api/inspections',
      ...inspectionForm(id, 'GIFT-DEMO-001', fakeJpeg(4096)),
    });
    expect(res.statusCode).toBe(413);
    expect(error(res.payload)).toMatchObject({code: 'UPLOAD_TOO_LARGE', inspectionId: id});
    expect(provider.requests).toHaveLength(0);
  });

  it('DB に接続できなければ DB_UNAVAILABLE（503）で、OK を返さず、通知する', async () => {
    const {app, provider, notify} = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/inspections',
      ...inspectionForm(randomUUID(), 'GIFT-DEMO-001', fakeJpeg()),
    });
    expect(res.statusCode).toBe(503);
    expect(error(res.payload).code).toBe('DB_UNAVAILABLE');
    expect(res.payload).not.toContain('"overall"');
    expect(provider.requests).toHaveLength(0);
    expect(notify).toHaveBeenCalled();
  });
});

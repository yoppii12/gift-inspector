import type {InspectionResult} from '@gift-inspector/shared';
import {describe, expect, it, vi} from 'vitest';

import {ClientError} from '../src/services/api';
import {getOrder, newInspectionId, postInspection} from '../src/services/inspection';

const ID = '11111111-1111-4111-8111-111111111111';

function result(overrides: Partial<InspectionResult> = {}): InspectionResult {
  return {
    inspectionId: ID,
    orderCode: 'GIFT-DEMO-001',
    overall: 'OK',
    ngReason: null,
    unreadableReason: null,
    items: [],
    refWarnings: [],
    reference: {
      noshiPresent: true,
      cardPresent: true,
      mizuhikiRead: '蝶結び',
      mizuhikiExpected: '蝶結び',
    },
    completedAt: '2026-10-07T00:00:00.000Z',
    replayed: false,
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  });
}

describe('postInspection', () => {
  it('inspection_id → order_code → image の順で送る', async () => {
    let sent: FormData | null = null;
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
      sent = init.body as FormData;
      return Promise.resolve(json(result()));
    }) as unknown as typeof fetch;
    await postInspection(ID, 'GIFT-DEMO-001', new Blob(['x'], {type: 'image/jpeg'}), {fetchImpl});
    expect([...(sent as unknown as FormData).keys()]).toEqual([
      'inspection_id',
      'order_code',
      'image',
    ]);
  });

  it('応答の検品 ID が送信と違えば RESPONSE_INVALID（別の検品の結果を表示しない）', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(json(result({inspectionId: '22222222-2222-4222-8222-222222222222'})))
    ) as unknown as typeof fetch;
    await expect(
      postInspection(ID, 'GIFT-DEMO-001', new Blob(['x']), {fetchImpl})
    ).rejects.toMatchObject({
      code: 'RESPONSE_INVALID',
      inspectionId: ID,
    });
  });

  it('応答のオーダーが送信と違えば RESPONSE_INVALID', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(json(result({orderCode: 'GIFT-DEMO-003'})))
    ) as unknown as typeof fetch;
    await expect(
      postInspection(ID, 'GIFT-DEMO-001', new Blob(['x']), {fetchImpl})
    ).rejects.toMatchObject({
      code: 'RESPONSE_INVALID',
    });
  });

  it('エラー応答（ERROR の検品）は ClientError で、検品 ID を持つ', async () => {
    const body = {
      error: {
        code: 'AI_TIMEOUT',
        category: 'RETRYABLE',
        message: 'x',
        requestId: 'r',
        inspectionId: ID,
      },
    };
    const fetchImpl = vi.fn(() => Promise.resolve(json(body, 504))) as unknown as typeof fetch;
    const err = await postInspection(ID, 'GIFT-DEMO-001', new Blob(['x']), {fetchImpl}).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ClientError);
    expect(err).toMatchObject({code: 'AI_TIMEOUT', inspectionId: ID});
  });
});

describe('getOrder', () => {
  it('形式の違う QR はサーバーに問い合わせずに QR_INVALID_FORMAT', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(getOrder('https://example.com/')).rejects.toMatchObject({
      code: 'QR_INVALID_FORMAT',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('newInspectionId', () => {
  it('UUID v4 を毎回新しく発行する', () => {
    const a = newInspectionId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newInspectionId()).not.toBe(a);
  });
});

import type {InspectionResult} from '@gift-inspector/shared';
import {describe, expect, it, vi} from 'vitest';

import {ClientError} from '../src/services/api';
import {
  findResultProblem,
  getOrder,
  isDevModeRequested,
  newInspectionId,
  postInspection,
} from '../src/services/inspection';

const ID = '11111111-1111-4111-8111-111111111111';

function result(overrides: Partial<InspectionResult> = {}): InspectionResult {
  return {
    inspectionId: ID,
    orderCode: 'GIFT-DEMO-001',
    mode: 'order',
    overall: 'OK',
    ngReason: null,
    unreadableReason: null,
    items: [
      {
        key: 'omotegaki',
        label: '表書き',
        result: 'OK',
        reason: 'MATCH',
        expected: '御祝',
        read: '御祝',
      },
      {
        key: 'atena',
        label: '宛名',
        result: 'OK',
        reason: 'MATCH',
        expected: '佐藤 花子',
        read: '佐藤 花子',
      },
      {
        key: 'card_text',
        label: 'メッセージカード',
        result: 'SKIP',
        reason: 'NOT_REQUIRED',
        expected: null,
        read: null,
      },
    ],
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

describe('findResultProblem（OK でないものを OK と表示しない）', () => {
  const okResult = () => result();
  const withItems = (
    overall: InspectionResult['overall'],
    results: string[],
    extra: Partial<InspectionResult> = {}
  ) =>
    result({
      overall,
      items: results.map((r, i) => ({
        key: (['omotegaki', 'atena', 'card_text'] as const)[i] ?? 'omotegaki',
        label: 'x',
        result: r as InspectionResult['items'][number]['result'],
        reason: 'MATCH',
        expected: 'a',
        read: 'a',
      })),
      ...extra,
    });

  it('整合した結果は問題なし', () => {
    expect(findResultProblem(okResult())).toBeNull();
    expect(findResultProblem(withItems('NG', ['OK', 'NG', 'SKIP']))).toBeNull();
    expect(findResultProblem(withItems('UNREADABLE', ['OK', 'UNREADABLE', 'SKIP']))).toBeNull();
    expect(
      findResultProblem(withItems('NG', ['OK', 'OK', 'SKIP'], {ngReason: 'REF_MISMATCH'}))
    ).toBeNull();
  });

  it.each([
    ['OK なのに NG の項目', withItems('OK', ['OK', 'NG', 'SKIP'])],
    ['OK なのに判定不能の項目', withItems('OK', ['UNREADABLE', 'OK', 'OK'])],
    ['OK なのに全項目 SKIP', withItems('OK', ['SKIP', 'SKIP', 'SKIP'])],
    ['NG なのに NG の項目がない', withItems('NG', ['OK', 'OK', 'OK'])],
    ['判定不能なのに NG の項目', withItems('UNREADABLE', ['NG', 'UNREADABLE', 'OK'])],
    ['総合が ERROR', withItems('ERROR' as never, ['OK'])],
    ['項目がない', result({items: []})],
    ['項目の結果が不正', withItems('OK', ['YES'])],
  ])('%s は問題として検出する', (_l, r) => {
    expect(findResultProblem(r)).not.toBeNull();
  });

  it('矛盾した応答は postInspection が RESPONSE_INVALID にする', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(json(withItems('OK', ['OK', 'NG', 'SKIP'])))
    ) as unknown as typeof fetch;
    await expect(
      postInspection(ID, 'GIFT-DEMO-001', new Blob(['x']), {fetchImpl})
    ).rejects.toMatchObject({
      code: 'RESPONSE_INVALID',
      inspectionId: ID,
    });
  });
});

describe('開発用の手入力モード', () => {
  const manual = {
    orderCode: 'MANUAL',
    omotegaki: '御祝',
    atena: '佐藤 花子',
    cardText: null,
    noshiType: '蝶結び' as const,
    noshiRequired: true,
    cardRequired: false,
  };

  it('正解の項目を image より前に入れて送る', async () => {
    let sent: FormData | null = null;
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
      sent = init.body as FormData;
      return Promise.resolve(json(result({orderCode: 'MANUAL', mode: 'manual'})));
    }) as unknown as typeof fetch;
    await postInspection(ID, 'MANUAL', new Blob(['x']), {fetchImpl, manual});
    const form = sent as unknown as FormData;
    expect([...form.keys()]).toEqual([
      'inspection_id',
      'order_code',
      'expected_omotegaki',
      'expected_atena',
      'expected_card_text',
      'expected_noshi_type',
      'noshi_required',
      'card_required',
      'image',
    ]);
    expect(form.get('noshi_required')).toBe('true');
    expect(form.get('card_required')).toBe('false');
  });

  it('手入力で送ったのに通常モードの応答が返れば RESPONSE_INVALID', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(json(result({orderCode: 'MANUAL', mode: 'order'})))
    ) as unknown as typeof fetch;
    await expect(
      postInspection(ID, 'MANUAL', new Blob(['x']), {fetchImpl, manual})
    ).rejects.toMatchObject({
      code: 'RESPONSE_INVALID',
    });
  });

  it('?dev=1 のときだけ入口を出す', () => {
    expect(isDevModeRequested('?dev=1')).toBe(true);
    expect(isDevModeRequested('')).toBe(false);
    expect(isDevModeRequested('?dev=0')).toBe(false);
    expect(isDevModeRequested('?check=1')).toBe(false);
  });
});

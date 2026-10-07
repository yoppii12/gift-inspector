import {describe, expect, it, vi} from 'vitest';

import {ClientError, request} from '../src/services/api';

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json', ...headers},
  });
}

function html(status: number) {
  return new Response('<html><body>502 Bad Gateway</body></html>', {
    status,
    headers: {'content-type': 'text/html'},
  });
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err: unknown) {
    expect(err).toBeInstanceOf(ClientError);
    return (err as ClientError).code;
  }
  throw new Error('例外が出なかった');
}

const fetchReturning = (res: Response) =>
  vi.fn(() => Promise.resolve(res)) as unknown as typeof fetch;

describe('request(): 成功', () => {
  it('2xx の JSON を返す', async () => {
    const res = await request<{a: number}>('/x', {fetchImpl: fetchReturning(json({a: 1}))});
    expect(res.a).toBe(1);
  });

  it('204 は undefined', async () => {
    const res = await request('/x', {fetchImpl: fetchReturning(new Response(null, {status: 204}))});
    expect(res).toBeUndefined();
  });
});

describe('request(): 失敗は必ずエラーコードになる', () => {
  it('API のエラー応答はそのコードと ID を引き継ぐ', async () => {
    const body = {
      error: {
        code: 'DB_UNAVAILABLE',
        category: 'SYSTEM',
        message: 'x',
        requestId: 'req-1',
        inspectionId: null,
      },
    };
    try {
      await request('/x', {fetchImpl: fetchReturning(json(body, 503))});
      expect.unreachable();
    } catch (err: unknown) {
      const e = err as ClientError;
      expect(e.code).toBe('DB_UNAVAILABLE');
      expect(e.requestId).toBe('req-1');
      expect(e.httpStatus).toBe(503);
    }
  });

  it.each([
    [401, 'AUTH_REQUIRED'],
    [413, 'UPLOAD_TOO_LARGE'],
    [429, 'RATE_LIMITED'],
    [502, 'UPSTREAM_UNAVAILABLE'],
    [503, 'UPSTREAM_UNAVAILABLE'],
    [504, 'UPSTREAM_TIMEOUT'],
    [500, 'RESPONSE_INVALID'],
    [418, 'RESPONSE_INVALID'],
  ])('HTML の %i 応答（OpenResty が直接返したもの）は %s', async (status, code) => {
    expect(await codeOf(request('/x', {fetchImpl: fetchReturning(html(status))}))).toBe(code);
  });

  it('未知のエラーコードを含む JSON はステータスから写像する', async () => {
    const body = {error: {code: 'SOMETHING_NEW'}};
    expect(await codeOf(request('/x', {fetchImpl: fetchReturning(json(body, 502))}))).toBe(
      'UPSTREAM_UNAVAILABLE'
    );
  });

  it('2xx でも JSON でなければ RESPONSE_INVALID（成功扱いにしない）', async () => {
    const res = new Response('<html>captive portal</html>', {
      status: 200,
      headers: {'content-type': 'text/html'},
    });
    expect(await codeOf(request('/x', {fetchImpl: fetchReturning(res)}))).toBe('RESPONSE_INVALID');
  });

  it('2xx で壊れた JSON は RESPONSE_INVALID', async () => {
    const res = new Response('{"a":', {status: 200, headers: {'content-type': 'application/json'}});
    expect(await codeOf(request('/x', {fetchImpl: fetchReturning(res)}))).toBe('RESPONSE_INVALID');
  });

  it('通信できなければ NETWORK_OFFLINE', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(new TypeError('Failed to fetch'))
    ) as unknown as typeof fetch;
    expect(await codeOf(request('/x', {fetchImpl}))).toBe('NETWORK_OFFLINE');
  });

  it('時間切れは REQUEST_TIMEOUT', async () => {
    const fetchImpl = vi.fn(
      (_: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          );
        })
    ) as unknown as typeof fetch;
    expect(await codeOf(request('/x', {fetchImpl, timeoutMs: 10}))).toBe('REQUEST_TIMEOUT');
  });

  it('呼び出し側が中断したら REQUEST_ABORTED（検品IDを保持する）', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          );
        })
    ) as unknown as typeof fetch;
    const p = request('/x', {fetchImpl, signal: controller.signal, inspectionId: 'insp-1'});
    controller.abort();
    try {
      await p;
      expect.unreachable();
    } catch (err: unknown) {
      expect((err as ClientError).code).toBe('REQUEST_ABORTED');
      expect((err as ClientError).inspectionId).toBe('insp-1');
    }
  });
});

describe('request(): acceptStatuses', () => {
  it('指定したステータスの非エラー JSON は返す（ヘルスチェックの 503）', async () => {
    const res = await request<{status: string}>('/x', {
      fetchImpl: fetchReturning(json({status: 'NG'}, 503)),
      acceptStatuses: [503],
    });
    expect(res.status).toBe('NG');
  });

  it('指定したステータスでもエラー形式なら例外にする（OpenResty の 503 など）', async () => {
    const body = {
      error: {
        code: 'UPSTREAM_UNAVAILABLE',
        category: 'SYSTEM',
        message: 'x',
        requestId: null,
        inspectionId: null,
      },
    };
    expect(
      await codeOf(
        request('/x', {fetchImpl: fetchReturning(json(body, 503)), acceptStatuses: [503]})
      )
    ).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('指定したステータスでも HTML なら例外にする', async () => {
    expect(
      await codeOf(request('/x', {fetchImpl: fetchReturning(html(503)), acceptStatuses: [503]}))
    ).toBe('UPSTREAM_UNAVAILABLE');
  });
});

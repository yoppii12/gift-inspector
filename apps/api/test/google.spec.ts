/**
 * Gemini プロバイダ。応答・エラーの変換と、guard（3.1 の分類）と組み合わせた結果を確かめる。
 */
import {TIMEOUTS_MS} from '@gift-inspector/shared';
import {describe, expect, it, vi} from 'vitest';

import {type GuardDeps, guardedRead} from '../src/ai/guard';
import {GoogleProvider, UNPARSEABLE} from '../src/ai/providers/google';
import {MOCK_READING} from '../src/ai/providers/mock';
import {ProviderError, type ReadRequest} from '../src/ai/types';

const KEY = 'AIzaTEST-SECRET-KEY-should-never-leak';

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json', ...headers},
  });
}

function ok(text: string, finishReason = 'STOP', extra: Record<string, unknown> = {}) {
  return json({
    candidates: [{content: {parts: [{text}]}, finishReason}],
    usageMetadata: {promptTokenCount: 1311, candidatesTokenCount: 61, thoughtsTokenCount: 600},
    responseId: 'resp-1',
    ...extra,
  });
}

function apiError(status: number, statusText: string, details: unknown[] = []) {
  return json(
    {error: {code: status, status: statusText, message: `mock ${status}`, details}},
    status
  );
}

function request(signal = new AbortController().signal): ReadRequest {
  return {
    image: Buffer.from('jpeg-bytes'),
    mimeType: 'image/jpeg',
    inspectionId: 'insp-1',
    timeoutMs: 30_000,
    signal,
  };
}

function provider(fetchImpl: typeof fetch) {
  return new GoogleProvider({apiKey: KEY, model: 'gemini-3.5-flash', fetchImpl});
}

const fetchReturning = (...responses: (Response | Error)[]) => {
  const fn = vi.fn(() => {
    const r = responses.length > 1 ? responses.shift() : responses[0];
    return r instanceof Error ? Promise.reject(r) : Promise.resolve((r as Response).clone());
  });
  return fn as unknown as typeof fetch & typeof fn;
};

describe('依頼の内容', () => {
  it('画像・読取指示・温度0・JSON スキーマを送り、キーは URL ではなくヘッダーで渡す', async () => {
    const fetchImpl = fetchReturning(ok(JSON.stringify(MOCK_READING)));
    await provider(fetchImpl).read(request());
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent'
    );
    expect(url).not.toContain(KEY);
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY);
    const body = JSON.parse(init.body as string) as {
      generationConfig: {
        temperature: number;
        responseMimeType: string;
        responseJsonSchema: Record<string, unknown>;
      };
      contents: {parts: Record<string, unknown>[]}[];
    };
    expect(body.generationConfig.temperature).toBe(0);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseJsonSchema).not.toHaveProperty('$schema');
    expect(body.generationConfig.responseJsonSchema).toMatchObject({additionalProperties: false});
    expect(body.contents[0]?.parts[0]).toMatchObject({inline_data: {mime_type: 'image/jpeg'}});
  });

  it('正解情報（登録内容）を送らない', async () => {
    const fetchImpl = fetchReturning(ok(JSON.stringify(MOCK_READING)));
    await provider(fetchImpl).read(request());
    const sent = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string;
    for (const v of ['御祝', '佐藤', 'ご出産', '御礼', '鈴木']) expect(sent).not.toContain(v);
  });
});

describe('応答の変換', () => {
  it('STOP で JSON が返れば tool_use として渡し、トークン数（思考を含む）を記録する', async () => {
    const res = await provider(fetchReturning(ok(JSON.stringify(MOCK_READING)))).read(request());
    expect(res).toMatchObject({
      stopReason: 'tool_use',
      toolInput: MOCK_READING,
      requestId: 'resp-1',
      tokensIn: 1311,
      tokensOut: 661,
    });
  });

  it('思考の部分（thought）は読取結果に含めない', async () => {
    const body = json({
      candidates: [
        {
          content: {
            parts: [{text: '考え中…', thought: true}, {text: JSON.stringify(MOCK_READING)}],
          },
          finishReason: 'STOP',
        },
      ],
    });
    expect((await provider(fetchReturning(body)).read(request())).toolInput).toEqual(MOCK_READING);
  });

  it.each([
    ['MAX_TOKENS', 'max_tokens'],
    ['SAFETY', 'refusal'],
    ['RECITATION', 'refusal'],
    ['PROHIBITED_CONTENT', 'refusal'],
    ['OTHER', 'other'],
  ])('finishReason=%s は %s', async (finish, stop) => {
    const res = await provider(fetchReturning(ok('{"omotegaki":', finish))).read(request());
    expect(res.stopReason).toBe(stop);
  });

  it('JSON として読めない応答は UNPARSEABLE（strict スキーマで不適合になる）', async () => {
    const res = await provider(fetchReturning(ok('御祝です'))).read(request());
    expect(res.toolInput).toBe(UNPARSEABLE);
  });

  it('入力が安全フィルタで止められ、候補がなければ refusal', async () => {
    const res = await provider(
      fetchReturning(json({promptFeedback: {blockReason: 'SAFETY'}}))
    ).read(request());
    expect(res).toMatchObject({stopReason: 'refusal', toolInput: null});
  });

  it('STOP なのに本文が空なら no_output（tool_use 扱いにしない）', async () => {
    const res = await provider(fetchReturning(ok(''))).read(request());
    expect(res).toMatchObject({stopReason: 'no_output', toolInput: null});
  });
});

describe('失敗の変換', () => {
  it.each([400, 401, 403, 404, 429, 500, 503])(
    'HTTP %i は ProviderError(http, status) で、キーを含まない',
    async status => {
      const err = await provider(fetchReturning(apiError(status, 'X')))
        .read(request())
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({kind: 'http', status});
      expect(String((err as Error).message)).not.toContain(KEY);
    }
  );

  it('429 の RetryInfo（retryDelay）を待ち時間として渡す', async () => {
    const details = [{'@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '13s'}];
    const err = (await provider(fetchReturning(apiError(429, 'RESOURCE_EXHAUSTED', details)))
      .read(request())
      .catch((e: unknown) => e)) as ProviderError;
    expect(err.retryAfterMs).toBe(13_000);
  });

  it('通信できなければ network', async () => {
    const err = await provider(fetchReturning(new TypeError('fetch failed')))
      .read(request())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({kind: 'network'});
  });

  it('中断（タイムアウト）されたら timeout', async () => {
    const c = new AbortController();
    c.abort(new DOMException('timeout', 'TimeoutError'));
    const err = await provider(fetchReturning(new DOMException('aborted', 'AbortError')))
      .read(request(c.signal))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({kind: 'timeout'});
  });

  it('エラー本文が JSON でなくても、ステータスで ProviderError になる', async () => {
    const html = new Response('<html>502</html>', {
      status: 502,
      headers: {'content-type': 'text/html'},
    });
    const err = await provider(fetchReturning(html))
      .read(request())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({kind: 'http', status: 502});
  });

  it('キーやモデルが空なら作れない（起動時に失敗させる）', () => {
    expect(() => new GoogleProvider({apiKey: '', model: 'm'})).toThrow('GEMINI_API_KEY');
    expect(() => new GoogleProvider({apiKey: 'k', model: ''})).toThrow('AI_MODEL');
  });
});

describe('guard と組み合わせた結果（3.1）', () => {
  function clock(): GuardDeps & {sleeps: number[]} {
    let t = 1_000_000;
    const sleeps: number[] = [];
    return {
      sleeps,
      now: () => t,
      sleep: ms => {
        sleeps.push(ms);
        t += ms;
        return Promise.resolve();
      },
    };
  }

  async function run(...responses: (Response | Error)[]) {
    const deps = clock();
    const fetchImpl = fetchReturning(...responses);
    const result = await guardedRead(
      provider(fetchImpl),
      {image: Buffer.from('x'), mimeType: 'image/jpeg', inspectionId: 'insp-1'},
      {
        deadline: deps.now() + TIMEOUTS_MS.inspectionTotal,
        signal: new AbortController().signal,
        deps,
      }
    );
    return {result, calls: fetchImpl.mock.calls.length, sleeps: deps.sleeps};
  }

  it('適合する JSON なら ok', async () => {
    expect((await run(ok(JSON.stringify(MOCK_READING)))).result.status).toBe('ok');
  });

  it('503 が2回なら ERROR（AI_UNAVAILABLE）、2回呼ぶ', async () => {
    const r = await run(apiError(503, 'UNAVAILABLE'));
    expect(r.result).toMatchObject({status: 'error', code: 'AI_UNAVAILABLE'});
    expect(r.calls).toBe(2);
  });

  it('429 → 成功なら ok（retryDelay は上限 5 秒まで）', async () => {
    const details = [{'@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '13s'}];
    const r = await run(
      apiError(429, 'RESOURCE_EXHAUSTED', details),
      ok(JSON.stringify(MOCK_READING))
    );
    expect(r.result.status).toBe('ok');
    expect(r.sleeps).toEqual([TIMEOUTS_MS.aiRetryAfterMax]);
  });

  it('403（キー不正）は再試行せず ERROR（AI_AUTH）', async () => {
    const r = await run(apiError(403, 'PERMISSION_DENIED'), ok(JSON.stringify(MOCK_READING)));
    expect(r.result).toMatchObject({status: 'error', code: 'AI_AUTH'});
    expect(r.calls).toBe(1);
  });

  it.each([
    ['読めない JSON', ok('御祝です'), 'AI_SCHEMA_INVALID'],
    ['余計なキー', ok(JSON.stringify({...MOCK_READING, confidence: 0.9})), 'AI_SCHEMA_INVALID'],
    ['打ち切り', ok('{"omotegaki":"御', 'MAX_TOKENS'), 'AI_SCHEMA_TRUNCATED'],
    ['安全フィルタ', ok('', 'SAFETY'), 'AI_SCHEMA_REFUSAL'],
    ['本文なし', ok(''), 'AI_SCHEMA_NO_TOOL_USE'],
  ])('%s が2回続けば UNREADABLE（%s）', async (_l, res, reason) => {
    const r = await run(res);
    expect(r.result).toMatchObject({status: 'unreadable', reason});
    expect(r.calls).toBe(2);
  });
});

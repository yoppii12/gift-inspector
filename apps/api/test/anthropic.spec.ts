/**
 * Claude プロバイダ。実際の SDK に模擬の fetch を渡し、依頼の内容・応答と失敗の変換・guard と組み合わせた結果を確かめる。
 */
import Anthropic from '@anthropic-ai/sdk';
import {TIMEOUTS_MS} from '@gift-inspector/shared';
import {describe, expect, it, vi} from 'vitest';

import {type GuardDeps, guardedRead} from '../src/ai/guard';
import {AnthropicProvider, UNPARSEABLE} from '../src/ai/providers/anthropic';
import {MOCK_READING} from '../src/ai/providers/mock';
import {ProviderError, type ReadRequest} from '../src/ai/types';

const KEY = 'sk-ant-TEST-SECRET-should-never-leak';

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json', 'request-id': 'req_test', ...headers},
  });
}

function message(
  text: string | null,
  stopReason = 'end_turn',
  extra: Record<string, unknown> = {}
) {
  return json({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [
      {type: 'thinking', thinking: '', signature: 'x'},
      ...(text === null ? [] : [{type: 'text', text}]),
    ],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {input_tokens: 1500, output_tokens: 300},
    ...extra,
  });
}

function apiError(status: number, type: string, headers: Record<string, string> = {}) {
  return json({type: 'error', error: {type, message: `mock ${status}`}}, status, headers);
}

function mockFetch(...responses: (Response | Error)[]) {
  const fn = vi.fn((_url: string, _init: RequestInit) => {
    const r = responses.length > 1 ? responses.shift() : responses[0];
    return r instanceof Error ? Promise.reject(r) : Promise.resolve((r as Response).clone());
  });
  return fn;
}

function provider(fetchImpl: ReturnType<typeof mockFetch>, effort: 'low' | null = null) {
  const client = new Anthropic({
    apiKey: KEY,
    maxRetries: 0,
    fetch: fetchImpl as unknown as typeof fetch,
  });
  return new AnthropicProvider({apiKey: KEY, model: 'claude-opus-5-5', effort, client});
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

function sentBody(fetchImpl: ReturnType<typeof mockFetch>) {
  const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown> & {
    output_config: {format: {type: string; schema: Record<string, unknown>}; effort?: string};
    messages: {content: {type: string}[]}[];
  };
}

describe('依頼の内容', () => {
  it('画像・読取指示・JSON スキーマを送り、temperature は送らない', async () => {
    const f = mockFetch(message(JSON.stringify(MOCK_READING)));
    await provider(f).read(request());
    const body = sentBody(f);
    expect(body).not.toHaveProperty('temperature');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.output_config.format.schema).not.toHaveProperty('$schema');
    expect(body.output_config.format.schema).toMatchObject({additionalProperties: false});
    expect(body.output_config).not.toHaveProperty('effort');
    expect(body.messages[0]?.content.map(c => c.type)).toEqual(['image', 'text']);
    expect(body).toMatchObject({model: 'claude-opus-5-5', fallbacks: 'default'});
  });

  it('読み直し（fallbacks）の beta ヘッダーを付ける', async () => {
    const f = mockFetch(message(JSON.stringify(MOCK_READING)));
    await provider(f).read(request());
    const headers = new Headers((f.mock.calls[0]?.[1] as RequestInit).headers);
    expect(headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
  });

  it('effort を指定したときだけ送る', async () => {
    const f = mockFetch(message(JSON.stringify(MOCK_READING)));
    await provider(f, 'low').read(request());
    expect(sentBody(f).output_config.effort).toBe('low');
  });

  it('正解情報（登録内容）を送らない', async () => {
    const f = mockFetch(message(JSON.stringify(MOCK_READING)));
    await provider(f).read(request());
    const sent = JSON.stringify(sentBody(f));
    for (const v of ['御祝', '佐藤', 'ご出産', '御礼', '鈴木']) expect(sent).not.toContain(v);
  });
});

describe('応答の変換', () => {
  it('end_turn で JSON が返れば tool_use として渡す（thinking ブロックは無視）', async () => {
    const res = await provider(mockFetch(message(JSON.stringify(MOCK_READING)))).read(request());
    expect(res).toMatchObject({
      stopReason: 'tool_use',
      toolInput: MOCK_READING,
      tokensIn: 1500,
      tokensOut: 300,
    });
  });

  it('JSON として読めなければ UNPARSEABLE', async () => {
    const res = await provider(mockFetch(message('御祝です'))).read(request());
    expect(res.toolInput).toBe(UNPARSEABLE);
  });

  it.each([
    ['max_tokens', '{"omotegaki":"御', 'max_tokens'],
    ['refusal', null, 'refusal'],
    ['pause_turn', null, 'claude:pause_turn'],
  ])('stop_reason=%s は %s', async (stop, text, expected) => {
    const res = await provider(mockFetch(message(text, stop))).read(request());
    expect(res.stopReason).toBe(expected);
  });

  it('end_turn なのに本文がなければ no_output', async () => {
    const res = await provider(mockFetch(message(null))).read(request());
    expect(res).toMatchObject({stopReason: 'no_output', toolInput: null});
  });

  it('読み直しがなければ、応答したモデルは依頼したモデル', async () => {
    const res = await provider(mockFetch(message(JSON.stringify(MOCK_READING)))).read(request());
    expect(res.servedModel).toBe('claude-opus-5-5');
    expect(res.requestId).toBe('req_test');
  });

  it('別のモデルが読み直した場合（usage.iterations の fallback_message）、そのモデルを servedModel に残す', async () => {
    const iter = (type: string, model: string) => ({
      type,
      model,
      input_tokens: 1,
      output_tokens: 1,
      cache_creation: null,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    const body = message(JSON.stringify(MOCK_READING), 'end_turn', {
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        iterations: [
          iter('message', 'claude-opus-5-5'),
          iter('fallback_message', 'claude-opus-4-8'),
        ],
      },
    });
    const res = await provider(mockFetch(body)).read(request());
    expect(res.servedModel).toBe('claude-opus-4-8');
  });

  it('fallback ブロックより前の（拒否したモデルの）途中の出力は使わない', async () => {
    const body = json({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [
        {type: 'text', text: '{"noshi_pr'},
        {
          type: 'fallback',
          from: {model: 'claude-opus-5-5'},
          to: {model: 'claude-opus-4-8'},
          trigger: {type: 'refusal'},
        },
        {type: 'text', text: JSON.stringify(MOCK_READING)},
      ],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {input_tokens: 1, output_tokens: 1},
    });
    const res = await provider(mockFetch(body)).read(request());
    expect(res.toolInput).toEqual(MOCK_READING);
  });

  it('text ブロックが複数なら連結して読む', async () => {
    const half = JSON.stringify(MOCK_READING);
    const body = json({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [
        {type: 'text', text: half.slice(0, 15)},
        {type: 'text', text: half.slice(15)},
      ],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {input_tokens: 1, output_tokens: 1},
    });
    expect((await provider(mockFetch(body)).read(request())).toolInput).toEqual(MOCK_READING);
  });

  it.each([null, 'stop_sequence', 'tool_use'])(
    'stop_reason=%s は tool_use 扱いにしない',
    async stop => {
      const res = await provider(
        mockFetch(message(JSON.stringify(MOCK_READING), stop as string))
      ).read(request());
      expect(res.stopReason).not.toBe('tool_use');
    }
  );
});

describe('失敗の変換', () => {
  it.each([
    [400, 'invalid_request_error'],
    [401, 'authentication_error'],
    [403, 'permission_error'],
    [429, 'rate_limit_error'],
    [500, 'api_error'],
    [529, 'overloaded_error'],
  ])('HTTP %i は ProviderError(http, status) で、キーを含まない', async (status, type) => {
    const err = await provider(mockFetch(apiError(status, type)))
      .read(request())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({kind: 'http', status, requestId: 'req_test'});
    expect(String((err as Error).message)).not.toContain(KEY);
  });

  it('SDK 自身のタイムアウト（中断されていない signal）は「1試行の制限時間」の timeout', async () => {
    const err = await provider(mockFetch(new DOMException('timed out', 'AbortError')))
      .read(request())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({kind: 'timeout'});
    expect((err as Error).message).toContain('1試行');
  });

  it('retry-after ヘッダーを待ち時間として渡す', async () => {
    const err = (await provider(mockFetch(apiError(429, 'rate_limit_error', {'retry-after': '3'})))
      .read(request())
      .catch((e: unknown) => e)) as ProviderError;
    expect(err.retryAfterMs).toBe(3_000);
  });

  it('通信できなければ network', async () => {
    const err = await provider(mockFetch(new TypeError('fetch failed')))
      .read(request())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({kind: 'network'});
  });

  it('中断（タイムアウト）されたら timeout', async () => {
    const c = new AbortController();
    c.abort(new DOMException('timeout', 'TimeoutError'));
    const err = await provider(mockFetch(new DOMException('aborted', 'AbortError')))
      .read(request(c.signal))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({kind: 'timeout'});
  });

  it('1試行のタイムアウトと、検品全体の中断を文言で区別する（どちらも timeout）', async () => {
    const attempt = new AbortController();
    attempt.abort(new DOMException('t', 'TimeoutError'));
    const outer = new AbortController();
    outer.abort(new Error('inspection timeout'));
    const abortErr = new DOMException('aborted', 'AbortError');
    const a = (await provider(mockFetch(abortErr))
      .read(request(attempt.signal))
      .catch((e: unknown) => e)) as ProviderError;
    const b = (await provider(mockFetch(abortErr))
      .read(request(outer.signal))
      .catch((e: unknown) => e)) as ProviderError;
    expect([a.kind, b.kind]).toEqual(['timeout', 'timeout']);
    expect(a.message).toContain('1試行');
    expect(b.message).toContain('検品全体の中断');
  });

  it('想定外の例外（SDK 以外）はそのまま投げ、guard が SYS_UNEXPECTED にする', async () => {
    const client = {
      beta: {messages: {create: () => Promise.reject(new RangeError('boom'))}},
    } as unknown as Anthropic;
    const p = new AnthropicProvider({apiKey: KEY, model: 'm', client});
    const err = await p.read(request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RangeError);
  });

  it('キーやモデルが空なら作れない（起動時に失敗させる）', () => {
    expect(() => new AnthropicProvider({apiKey: '', model: 'm'})).toThrow('ANTHROPIC_API_KEY');
    expect(() => new AnthropicProvider({apiKey: 'k', model: ''})).toThrow('AI_MODEL');
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
    const f = mockFetch(...responses);
    const result = await guardedRead(
      provider(f),
      {image: Buffer.from('x'), mimeType: 'image/jpeg', inspectionId: 'insp-1'},
      {
        deadline: deps.now() + TIMEOUTS_MS.inspectionTotal,
        signal: new AbortController().signal,
        deps,
      }
    );
    return {result, calls: f.mock.calls.length};
  }

  it('適合する JSON なら ok', async () => {
    expect((await run(message(JSON.stringify(MOCK_READING)))).result.status).toBe('ok');
  });

  it.each([
    [408, 'request_timeout', 'AI_TIMEOUT'],
    [409, 'conflict', 'AI_UNAVAILABLE'],
  ])('%i は一時障害（%s）として2回試す', async (status, type, code) => {
    const r = await run(apiError(status, type));
    expect(r.result).toMatchObject({status: 'error', code});
    expect(r.calls).toBe(2);
  });

  it('529 が2回なら ERROR（AI_OVERLOADED）、2回呼ぶ（SDK は再試行しない）', async () => {
    const r = await run(apiError(529, 'overloaded_error'));
    expect(r.result).toMatchObject({status: 'error', code: 'AI_OVERLOADED'});
    expect(r.calls).toBe(2);
  });

  it('401 は再試行せず ERROR（AI_AUTH）', async () => {
    const r = await run(
      apiError(401, 'authentication_error'),
      message(JSON.stringify(MOCK_READING))
    );
    expect(r.result).toMatchObject({status: 'error', code: 'AI_AUTH'});
    expect(r.calls).toBe(1);
  });

  it.each([
    ['読めない JSON', message('御祝です'), 'AI_SCHEMA_INVALID'],
    [
      '余計なキー',
      message(JSON.stringify({...MOCK_READING, confidence: 0.9})),
      'AI_SCHEMA_INVALID',
    ],
    ['打ち切り', message('{"omotegaki":"御', 'max_tokens'), 'AI_SCHEMA_TRUNCATED'],
    ['拒否', message(null, 'refusal'), 'AI_SCHEMA_REFUSAL'],
    ['本文なし', message(null), 'AI_SCHEMA_NO_TOOL_USE'],
  ])('%s が2回続けば UNREADABLE（%s）', async (_l, res, reason) => {
    const r = await run(res);
    expect(r.result).toMatchObject({status: 'unreadable', reason});
    expect(r.calls).toBe(2);
  });
});

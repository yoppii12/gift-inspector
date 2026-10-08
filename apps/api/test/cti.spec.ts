/**
 * CTI-Cloud（社内の Gemma）プロバイダ。依頼の内容、応答・エラーの変換、guard と組み合わせた結果、
 * Structure 定義（docs/cti-cloud/read_gift_items.yaml）と prompt.ts・スキーマのずれを確かめる。
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

import {TIMEOUTS_MS} from '@gift-inspector/shared';
import {describe, expect, it, vi} from 'vitest';

import {type GuardDeps, guardedRead} from '../src/ai/guard';
import {parse as parseYaml} from 'yaml';

import {SYSTEM_PROMPT, TOOL_INPUT_SCHEMA} from '../src/ai/prompt';
import {CTI_PROMPT_VERSION, CTI_SYSTEM_PROMPT, CtiProvider} from '../src/ai/providers/cti';
import {UNPARSEABLE} from '../src/ai/providers/google';
import {MOCK_READING} from '../src/ai/providers/mock';
import {ProviderError, type ReadRequest} from '../src/ai/types';

const KEY = 'eyJTEST.SECRET-KEY.should-never-leak';
const BASE = 'https://api.laplust.com/v0/apps/1013';

function text(body: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, {
    status,
    headers: {'content-type': 'text/plain; charset=UTF-8', ...headers},
  });
}

const ok = (value: unknown = MOCK_READING) => text(JSON.stringify(value));

/** openresty が返すエラーページ */
const htmlError = (status: number, title: string) =>
  text(`<html><head><title>${status} ${title}</title></head><body>${title}</body></html>`, status, {
    'content-type': 'text/html',
  });

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
  return new CtiProvider({apiKey: KEY, baseUrl: `${BASE}/`, model: 'gemma', fetchImpl});
}

const fetchReturning = (...responses: (Response | Error)[]) => {
  const fn = vi.fn(() => {
    const r = responses.length > 1 ? responses.shift() : responses[0];
    return r instanceof Error ? Promise.reject(r) : Promise.resolve((r as Response).clone());
  });
  return fn as unknown as typeof fetch & typeof fn;
};

describe('依頼の内容', () => {
  it('画像だけを multipart の image で送り、キーは Bearer で渡す', async () => {
    const fetchImpl = fetchReturning(ok());
    await provider(fetchImpl).read(request());
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/read_gift_items`);
    expect(url).not.toContain(KEY);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    const form = init.body as FormData;
    expect([...form.keys()]).toEqual(['image']);
    const image = form.get('image') as File;
    expect(image.type).toBe('image/jpeg');
    expect(image.name).toBe('image.jpg');
    expect(Buffer.from(await image.arrayBuffer()).toString()).toBe('jpeg-bytes');
  });

  it('正解情報（登録内容）を送らない（送るのは画像だけ）', async () => {
    const fetchImpl = fetchReturning(ok());
    await provider(fetchImpl).read(request());
    const form = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
    expect([...form.keys()]).toEqual(['image']);
  });

  it('判定記録には CTI-Cloud 側の Structure の版を残す', () => {
    expect(provider(fetchReturning(ok())).promptVersion).toBe(CTI_PROMPT_VERSION);
  });
});

describe('応答の変換', () => {
  it('JSON（オブジェクト）が返れば tool_use として渡す。トークン数は返らないので null', async () => {
    const res = await provider(fetchReturning(ok())).read(request());
    expect(res).toMatchObject({
      stopReason: 'tool_use',
      toolInput: MOCK_READING,
      tokensIn: null,
      tokensOut: null,
    });
  });

  it('JSON が文字列で包まれていても読む', async () => {
    const res = await provider(
      fetchReturning(text(JSON.stringify(JSON.stringify(MOCK_READING))))
    ).read(request());
    expect(res.toolInput).toEqual(MOCK_READING);
  });

  it('x-request-id があれば記録する', async () => {
    const res = await provider(
      fetchReturning(text(JSON.stringify(MOCK_READING), 200, {'x-request-id': 'req-9'}))
    ).read(request());
    expect(res.requestId).toBe('req-9');
  });

  it('JSON として読めない応答は UNPARSEABLE（strict スキーマで不適合になる）', async () => {
    const res = await provider(fetchReturning(text('御祝です'))).read(request());
    expect(res).toMatchObject({stopReason: 'tool_use', toolInput: UNPARSEABLE});
  });

  it('本文が空なら no_output（tool_use 扱いにしない）', async () => {
    const res = await provider(fetchReturning(text('  '))).read(request());
    expect(res).toMatchObject({stopReason: 'no_output', toolInput: null});
  });
});

describe('失敗の変換', () => {
  it.each([400, 401, 403, 404, 429, 500, 502, 503])(
    'HTTP %i は ProviderError(http, status) で、キーを含まず、HTML のタグを除く',
    async status => {
      const err = await provider(fetchReturning(htmlError(status, 'Error')))
        .read(request())
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({kind: 'http', status});
      expect(String((err as Error).message)).not.toContain(KEY);
      expect(String((err as Error).message)).not.toContain('<');
    }
  );

  it('Retry-After ヘッダー（秒）を待ち時間として渡す', async () => {
    const err = (await provider(fetchReturning(text('busy', 429, {'retry-after': '4'})))
      .read(request())
      .catch((e: unknown) => e)) as ProviderError;
    expect(err.retryAfterMs).toBe(4_000);
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

  it('Retry-After が空なら待ち時間を渡さない（0 にしない）', async () => {
    const err = (await provider(fetchReturning(text('busy', 429, {'retry-after': ' '})))
      .read(request())
      .catch((e: unknown) => e)) as ProviderError;
    expect(err.retryAfterMs).toBeNull();
  });

  it('200 で HTML が返ればサーバー側の障害（network。判定不能にしない）', async () => {
    for (const res of [
      text('<html><body>maintenance</body></html>', 200, {'content-type': 'text/html'}),
      text('  <!doctype html><p>x</p>'),
    ]) {
      const err = await provider(fetchReturning(res))
        .read(request())
        .catch((e: unknown) => e);
      expect(err).toMatchObject({kind: 'network', status: null});
    }
  });

  it('本文を読む途中で失敗したら network、中断なら timeout', async () => {
    const broken = () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () => Promise.reject(new TypeError('terminated')),
        clone() {
          return this;
        },
      }) as unknown as Response;
    const err = await provider(fetchReturning(broken()))
      .read(request())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({kind: 'network'});
    expect(String((err as Error).message)).toContain('HTTP 200');

    const c = new AbortController();
    c.abort(new DOMException('timeout', 'TimeoutError'));
    const aborted = await provider(fetchReturning(broken()))
      .read(request(c.signal))
      .catch((e: unknown) => e);
    expect(aborted).toMatchObject({kind: 'timeout'});
  });

  it('キー・URL・モデルが空なら作れない（起動時に失敗させる）', () => {
    expect(() => new CtiProvider({apiKey: '', baseUrl: BASE, model: 'm'})).toThrow('CTI_API_KEY');
    expect(() => new CtiProvider({apiKey: 'k', baseUrl: '', model: 'm'})).toThrow('CTI_BASE_URL');
    expect(() => new CtiProvider({apiKey: 'k', baseUrl: BASE, model: ''})).toThrow('AI_MODEL');
  });
});

describe('guard と組み合わせた結果（3.1）', () => {
  async function run(...responses: (Response | Error)[]) {
    const deps: GuardDeps = {now: () => 1_000_000, sleep: () => Promise.resolve()};
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
    return {result, calls: fetchImpl.mock.calls.length};
  }

  it('適合する JSON なら ok', async () => {
    expect((await run(ok())).result.status).toBe('ok');
  });

  it('500 が2回なら ERROR（AI_UNAVAILABLE）、2回呼ぶ', async () => {
    const r = await run(htmlError(500, 'Internal Server Error'));
    expect(r.result).toMatchObject({status: 'error', code: 'AI_UNAVAILABLE'});
    expect(r.calls).toBe(2);
  });

  it('401（キー不正）は再試行せず ERROR（AI_AUTH）', async () => {
    const r = await run(htmlError(401, 'Authorization Required'), ok());
    expect(r.result).toMatchObject({status: 'error', code: 'AI_AUTH'});
    expect(r.calls).toBe(1);
  });

  it.each([
    ['読めない JSON', text('御祝です')],
    ['余計なキー', ok({...MOCK_READING, confidence: 0.9})],
    ['項目の欠け', ok({noshi_present: true})],
  ])('%s が2回続けば UNREADABLE（AI_SCHEMA_INVALID）', async (_l, res) => {
    const r = await run(res);
    expect(r.result).toMatchObject({status: 'unreadable', reason: 'AI_SCHEMA_INVALID'});
    expect(r.calls).toBe(2);
  });

  it.each([
    ['null', 'AI_SCHEMA_NO_TOOL_USE'],
    ['[]', 'AI_SCHEMA_INVALID'],
    ['"御祝"', 'AI_SCHEMA_INVALID'],
    [JSON.stringify(JSON.stringify(JSON.stringify(MOCK_READING))), 'AI_SCHEMA_INVALID'],
  ])('オブジェクトでない JSON（%s）が2回続けば UNREADABLE（%s）', async (body, reason) => {
    const r = await run(text(body));
    expect(r.result).toMatchObject({status: 'unreadable', reason});
    expect(r.calls).toBe(2);
  });

  it('200 で HTML が2回続けば ERROR（AI_UNAVAILABLE）。判定不能にしない', async () => {
    const r = await run(text('<html>maintenance</html>', 200, {'content-type': 'text/html'}));
    expect(r.result).toMatchObject({status: 'error', code: 'AI_UNAVAILABLE'});
    expect(r.calls).toBe(2);
  });

  it('応答の raw・エラーの記録にキーが含まれない', async () => {
    const a = await run(ok());
    const b = await run(htmlError(401, 'Authorization Required'));
    expect(JSON.stringify([a.result, b.result])).not.toContain(KEY);
  });
});

describe('Structure 定義（docs/cti-cloud/read_gift_items.yaml）', () => {
  interface Script {
    get?: {key: string};
    'core.multimodal_generation'?: {
      input: {image: string; system: string};
      output: {text: {format: {type: string; schema: Record<string, unknown>}}};
    };
    [step: string]: unknown;
  }
  const structure = parseYaml(
    readFileSync(
      fileURLToPath(new URL('../../../docs/cti-cloud/read_gift_items.yaml', import.meta.url)),
      'utf8'
    )
  ) as {paths: Record<string, {post: {script: Script[]}}>};
  const script = structure.paths['/read_gift_items']?.post.script ?? [];
  const generation = script.find(step => step['core.multimodal_generation'])?.[
    'core.multimodal_generation'
  ];

  /** 説明文を除き、null 許容の書き方（anyOf と type の配列）をそろえる */
  function normalize(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(normalize);
    if (node === null || typeof node !== 'object') return node;
    const {description: _d, $schema: _s, ...rest} = node as Record<string, unknown>;
    const anyOf = rest.anyOf as {type?: unknown}[] | undefined;
    if (anyOf?.every(a => Object.keys(a).length === 1 && typeof a.type === 'string')) {
      const {anyOf: _a, ...others} = rest;
      return normalize({...others, type: anyOf.map(a => a.type)});
    }
    return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, normalize(v)]));
  }

  it('読取指示は CTI_SYSTEM_PROMPT（prompt.ts の指示・項目の説明）と完全に一致する', () => {
    expect(generation?.input.system).toBe(CTI_SYSTEM_PROMPT);
    expect(CTI_SYSTEM_PROMPT).toContain(SYSTEM_PROMPT);
  });

  it('スキーマはアプリの読取スキーマと同じ（項目・型・null の可否・選択肢・必須・余計な項目の拒否）', () => {
    expect(generation?.output.text.format.type).toBe('json_object');
    expect(normalize(generation?.output.text.format.schema)).toEqual(normalize(TOOL_INPUT_SCHEMA));
  });

  it('受け取るのは画像だけで、画像を保存しない', () => {
    expect(script.filter(step => step.get).map(step => step.get?.key)).toEqual(['image']);
    expect(generation?.input.image).toBe('$image');
    expect(script.some(step => 'app.file.put' in step)).toBe(false);
  });
});

/**
 * CTI-Cloud（社内の Gemma）プロバイダ。依頼の内容、応答・エラーの変換、guard と組み合わせた結果、
 * Structure 定義（docs/cti-cloud/read_gift_items.yaml）と prompt.ts・スキーマのずれを確かめる。
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

import {TIMEOUTS_MS} from '@gift-inspector/shared';
import {describe, expect, it, vi} from 'vitest';

import {type GuardDeps, guardedRead} from '../src/ai/guard';
import {SYSTEM_PROMPT, TOOL_INPUT_SCHEMA, USER_PROMPT} from '../src/ai/prompt';
import {CTI_PROMPT_VERSION, CtiProvider} from '../src/ai/providers/cti';
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

  it('応答の raw・エラーの記録にキーが含まれない', async () => {
    const a = await run(ok());
    const b = await run(htmlError(401, 'Authorization Required'));
    expect(JSON.stringify([a.result, b.result])).not.toContain(KEY);
  });
});

describe('Structure 定義（docs/cti-cloud/read_gift_items.yaml）', () => {
  const yaml = readFileSync(
    fileURLToPath(new URL('../../../docs/cti-cloud/read_gift_items.yaml', import.meta.url)),
    'utf8'
  );
  const schema = TOOL_INPUT_SCHEMA as {
    properties: Record<string, {type?: string | string[]; enum?: string[]}>;
    required: string[];
  };

  it('読取指示は prompt.ts と同じ（SYSTEM_PROMPT の各行と、読み取る項目の説明をすべて含む）', () => {
    const lines = [
      ...SYSTEM_PROMPT.split('\n'),
      ...USER_PROMPT.split('\n').filter(l => l.startsWith('- ')),
    ];
    for (const line of lines.map(l => l.trim()).filter(Boolean)) {
      expect(yaml, line).toContain(line);
    }
  });

  it('スキーマの項目・必須・選択肢・null の可否がアプリのスキーマと同じ', () => {
    for (const [key, prop] of Object.entries(schema.properties)) {
      const block = new RegExp(`\\n {22}${key}:\\n((?: {24}.*\\n)+)`).exec(yaml)?.[1];
      expect(block, key).toBeDefined();
      const nullable = Array.isArray(prop.type) && prop.type.includes('null');
      expect(block?.includes('type: "null"'), `${key} の null`).toBe(nullable);
      for (const v of prop.enum ?? []) expect(block, `${key} の ${v}`).toContain(`- ${v}`);
      expect(yaml).toMatch(new RegExp(`required:[\\s\\S]*- ${key}\\n`));
    }
    expect(yaml).toContain('additionalProperties: false');
  });

  it('受け取るのは画像だけで、画像を保存しない', () => {
    expect(yaml.match(/- get:/g)).toHaveLength(1);
    expect(yaml).toContain('key: image');
    expect(yaml).not.toMatch(/^\s*- app\.file\.put:/m);
  });
});

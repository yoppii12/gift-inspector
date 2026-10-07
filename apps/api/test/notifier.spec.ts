import type {FastifyBaseLogger} from 'fastify';
import {describe, expect, it, vi} from 'vitest';

import {createNotifier} from '../src/lib/notifier';

function makeLogger() {
  return {error: vi.fn()} as unknown as FastifyBaseLogger & {error: ReturnType<typeof vi.fn>};
}

describe('Slack 通知', () => {
  it('Webhook 未設定なら送らない', () => {
    const fetchImpl = vi.fn();
    const n = createNotifier({webhookUrl: '', appVersion: 'v', logger: makeLogger(), fetchImpl});
    n.notify({key: 'A', title: 't', fields: {}});
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('同じキーは5分に1回にまとめ、まとめた件数を次の通知に付ける', async () => {
    let t = 0;
    const bodies: string[] = [];
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
      bodies.push(init.body as string);
      return Promise.resolve(new Response(null, {status: 200}));
    });
    const n = createNotifier({
      webhookUrl: 'https://hooks.example/x',
      appVersion: 'v1',
      logger: makeLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => t,
    });
    n.notify({key: 'DB_UNAVAILABLE', title: 'db', fields: {}});
    t = 60_000;
    n.notify({key: 'DB_UNAVAILABLE', title: 'db', fields: {}});
    n.notify({key: 'DB_UNAVAILABLE', title: 'db', fields: {}});
    n.notify({key: 'AI_AUTH', title: 'ai', fields: {}}); // 別キーはまとめない
    t = 6 * 60_000;
    n.notify({key: 'DB_UNAVAILABLE', title: 'db', fields: {}});
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    expect(bodies[2]).toContain('2件');
  });

  it('送信に失敗したらログに出す（例外は外に漏らさない）', async () => {
    const logger = makeLogger();
    const n = createNotifier({
      webhookUrl: 'https://hooks.example/x',
      appVersion: 'v',
      logger,
      fetchImpl: () => Promise.reject(new Error('network down')),
    });
    expect(() => n.notify({key: 'A', title: 't', fields: {}})).not.toThrow();
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());
    expect(JSON.stringify(logger.error.mock.calls[0])).toContain('network down');
  });
});

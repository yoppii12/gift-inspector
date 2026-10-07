/**
 * AI 読取の計測（案C: プロバイダ・モデルの比較）。本番と同じ guard・判定関数で、同じ画像を N 回読ませる。
 * API キーを手元に持ち出さないよう、VPS 上で api.env を読み込んで実行する（docs/ops.md「AI の計測」）。
 *
 *   node bench.js --provider google --model gemini-3.5-flash --runs 5 \
 *     GIFT-DEMO-001=/path/to/001.jpg GIFT-DEMO-003=/path/to/003.jpg
 *
 * 出力: 1試行ごとの行（JSON Lines）と、画像ごとの集計（応答時間 p50/p95・一致率・判定の内訳）。
 */
import {readFileSync} from 'node:fs';
import {parseArgs} from 'node:util';

import {TIMEOUTS_MS} from '@gift-inspector/shared';

import {guardedRead} from '../src/ai/guard';
import {GoogleProvider} from '../src/ai/providers/google';
import type {AiProvider} from '../src/ai/types';
import {type Expected, judge} from '../src/judge/judge';
import {inspectImage} from '../src/storage/images';

const {values, positionals} = parseArgs({
  allowPositionals: true,
  options: {
    provider: {type: 'string', default: 'google'},
    model: {type: 'string'},
    runs: {type: 'string', default: '5'},
    'interval-ms': {type: 'string', default: '3000'},
    // 配置場所によって相対パスが変わるため必須にする（VPS: /srv/gift-inspector/db/seeds/demo_orders.json）
    orders: {type: 'string'},
  },
});

function fail(message: string): never {
  console.error(`[bench] ${message}`);
  process.exit(1);
}

function createProvider(): AiProvider {
  const model = values.model ?? fail('--model が必要です');
  if (values.provider === 'google') {
    return new GoogleProvider({
      apiKey: process.env.GEMINI_API_KEY ?? fail('GEMINI_API_KEY がありません'),
      model,
    });
  }
  return fail(`未対応のプロバイダ: ${values.provider}`);
}

interface DemoOrder {
  orderCode: string;
  registered: Expected;
}

const orders = (
  JSON.parse(readFileSync(values.orders ?? fail('--orders が必要です'), 'utf8')) as {
    orders: DemoOrder[];
  }
).orders;
const provider = createProvider();
const runs = Number(values.runs);
const interval = Number(values['interval-ms']);
if (!Number.isInteger(runs) || runs < 1) fail(`--runs が不正です: ${values.runs}`);
if (!Number.isFinite(interval) || interval < 0)
  fail(`--interval-ms が不正です: ${values['interval-ms']}`);
if (positionals.length === 0) fail('ORDER=画像パス を1つ以上指定してください');

const out = (line: string) => process.stdout.write(`${line}\n`);

const percentile = (xs: number[], p: number) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

for (const arg of positionals) {
  // パスに = が含まれても壊れないよう、最初の = で分ける
  const eq = arg.indexOf('=');
  const orderCode = eq > 0 ? arg.slice(0, eq) : undefined;
  const path = eq > 0 ? arg.slice(eq + 1) : undefined;
  const order =
    orders.find(o => o.orderCode === orderCode) ?? fail(`オーダーがありません: ${orderCode}`);
  const image = readFileSync(path ?? fail(`画像パスがありません: ${arg}`));
  const {mime} = inspectImage(image);

  const totals: number[] = [];
  /** 1試行ごとの応答時間（AI 1試行のタイムアウト値を決めるのに使う） */
  const attemptMs: number[] = [];
  const overalls: Record<string, number> = {};
  const readings = new Set<string>();

  for (let i = 1; i <= runs; i++) {
    if (i > 1) await new Promise(r => setTimeout(r, interval));
    const started = Date.now();
    const read = await guardedRead(
      provider,
      {image, mimeType: mime, inspectionId: `bench-${orderCode}-${i}`},
      {deadline: started + TIMEOUTS_MS.inspectionTotal, signal: new AbortController().signal}
    );
    const totalMs = Date.now() - started;
    const j = judge(order.registered, read, {refMismatchBlocksOk: false});
    const key = j.overall === 'ERROR' ? `ERROR:${j.errorCode}` : j.overall;
    overalls[key] = (overalls[key] ?? 0) + 1;
    if (read.status === 'ok') {
      totals.push(totalMs);
      readings.add(JSON.stringify(read.data));
    }
    for (const a of read.attempts) {
      if (a.class === 'ok' || a.class === 'schema') attemptMs.push(a.latencyMs);
    }
    out(
      JSON.stringify({
        orderCode,
        run: i,
        provider: provider.name,
        model: provider.model,
        overall: j.overall,
        errorCode: j.errorCode,
        totalMs,
        attempts: read.attempts.map(a => ({
          class: a.class,
          code: a.code,
          ms: a.latencyMs,
          http: a.httpStatus,
        })),
        tokensIn: read.attempts.at(-1)?.tokensIn ?? null,
        tokensOut: read.attempts.at(-1)?.tokensOut ?? null,
        items: j.items?.map(it => `${it.key}:${it.result}`),
        refWarnings: j.refWarnings,
        reading: read.status === 'ok' ? read.data : null,
      })
    );
  }

  out(
    `[集計] ${orderCode} ${provider.name}/${provider.model} 判定=${JSON.stringify(overalls)} ` +
      `成功時の応答 p50=${percentile(totals, 50) ?? '-'}ms p95=${percentile(totals, 95) ?? '-'}ms ` +
      `1試行（応答あり） p50=${percentile(attemptMs, 50) ?? '-'}ms p95=${percentile(attemptMs, 95) ?? '-'}ms ` +
      `読取結果の種類=${readings.size}（1 なら毎回同じ）`
  );
}

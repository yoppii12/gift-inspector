import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

import {MIZUHIKI_TYPES, ORDER_CODE_PATTERN} from '@gift-inspector/shared';
import {z} from 'zod';

export const DATA_PATH = fileURLToPath(new URL('../../../db/seeds/demo_orders.json', import.meta.url));

const text = z.string().refine(s => s.trim().length > 0, '空文字は不可');

const contentSchema = {
  omotegaki: text.nullable(),
  atena: text.nullable(),
  cardText: text.nullable(),
  noshiType: z.enum(MIZUHIKI_TYPES).nullable(),
};

const orderSchema = z.strictObject({
  orderCode: z.string().regex(ORDER_CODE_PATTERN),
  registered: z.strictObject({
    ...contentSchema,
    noshiRequired: z.boolean(),
    cardRequired: z.boolean(),
  }),
  printed: z.strictObject(contentSchema),
  expected: z.enum(['OK', 'NG']),
  note: text,
});

const fileSchema = z.object({
  orders: z.array(orderSchema).min(1),
});

export type DemoOrder = z.infer<typeof orderSchema>;

/**
 * 元データを読み込み、矛盾があれば例外にする（DB の CHECK 制約と同じ条件 + 想定結果の整合）。
 * ここで止めることで「正解データの不備に気づかないままデモに臨む」ことを防ぐ。
 */
export function loadDemoOrders(path = DATA_PATH): DemoOrder[] {
  const parsed = fileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const problems = parsed.orders.flatMap(validateOrder);
  const codes = parsed.orders.map(o => o.orderCode);
  if (new Set(codes).size !== codes.length) problems.push('orderCode が重複しています');
  if (problems.length > 0) {
    throw new Error(`demo_orders.json に矛盾があります:\n- ${problems.join('\n- ')}`);
  }
  return parsed.orders;
}

export function validateOrder(order: DemoOrder): string[] {
  const p: string[] = [];
  const r = order.registered;
  const at = (msg: string) => p.push(`${order.orderCode}: ${msg}`);

  if (r.noshiRequired) {
    if (!r.omotegaki || !r.atena || !r.noshiType) at('のし必須なのに表書き・宛名・水引のいずれかが空');
  } else if (r.omotegaki || r.atena || r.noshiType) {
    at('のし不要なのに表書き・宛名・水引が入っている');
  }
  if (r.cardRequired !== (r.cardText !== null)) at('カード必須とカード文面の有無が一致しない');
  if (!r.noshiRequired && !r.cardRequired) at('のしもカードも不要');

  // 想定結果と「登録 vs 印刷」の差分が一致しているか（主判定の項目のみ）
  const diffs = [
    r.noshiRequired && order.printed.omotegaki !== r.omotegaki,
    r.noshiRequired && order.printed.atena !== r.atena,
    r.cardRequired && order.printed.cardText !== r.cardText,
  ].filter(Boolean).length;
  if (order.expected === 'OK' && diffs > 0) at('想定OKなのに印刷内容が登録と異なる');
  if (order.expected === 'NG' && diffs === 0) at('想定NGなのに印刷内容が登録と同じ');
  return p;
}

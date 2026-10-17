import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

import {
  BAG_TYPES,
  MIZUHIKI_TYPES,
  NOSHI_SIZES,
  OMOTEGAKI_BLANK,
  ORDER_CODE_PATTERN,
} from '@gift-inspector/shared';
import {z} from 'zod';

import {CARD_TEXT_MAX} from './noshi';

export const DATA_PATH = fileURLToPath(
  new URL('../../../db/seeds/demo_orders.json', import.meta.url)
);

const text = z.string().refine(s => s.trim().length > 0, '空文字は不可');

const contentSchema = {
  omotegaki: text.nullable(),
  atena: text.nullable(),
  cardText: text.nullable(),
  noshiType: z.enum(MIZUHIKI_TYPES).nullable(),
};

const orderSchema = z.strictObject({
  orderCode: z.string().regex(ORDER_CODE_PATTERN),
  /**
   * pseudo = 擬似のし・カードを印刷して使う（printed を PDF にする）。
   * real = 受領した実物を使う（printed は実物の内容。PDF は作らない。setup に並べる物を書く）
   */
  kind: z.enum(['pseudo', 'real']).default('pseudo'),
  /** 撮影時に作業台に並べる物（real では必須） */
  setup: text.optional(),
  registered: z.strictObject({
    ...contentSchema,
    noshiRequired: z.boolean(),
    cardRequired: z.boolean(),
    // 参考判定（#53・#55）。省略・null は対象外
    noshiSize: z.enum(NOSHI_SIZES).nullable().default(null),
    bagType: z.enum(BAG_TYPES).nullable().default(null),
    carrierBag: z.boolean().nullable().default(null),
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

  // DB の CHECK 制約（ck_noshi、002 以降）と同じ: のしありなら表書き・水引は必須、名入れは null（名入れなし）可
  if (r.noshiRequired) {
    if (!r.omotegaki || !r.noshiType) at('のし必須なのに表書き・水引のいずれかが空');
  } else if (r.omotegaki || r.atena || r.noshiType || r.noshiSize) {
    at('のし不要なのに表書き・名入れ・水引・大きさが入っている');
  }
  if (order.kind === 'real' && !order.setup) at('実物のオーダーに、並べる物（setup）がない');
  if (r.cardRequired !== (r.cardText !== null)) at('カード必須とカード文面の有無が一致しない');
  if (!r.noshiRequired && !r.cardRequired) at('のしもカードも不要');

  // 現物側の整合: のしがある（水引がある）ときだけ表書き・名入れを入れられる（表書きなし＝無地、名入れなし可）
  const pr = order.printed;
  if (pr.noshiType === null && (pr.omotegaki !== null || pr.atena !== null)) {
    at('現物ののしに水引がないのに、表書き・名入れが入っている');
  }
  if (order.kind === 'pseudo' && pr.noshiType !== null && pr.omotegaki === null) {
    at('擬似のしに表書きがない（無地は実物で確認する）');
  }
  // 現物の「無地」は表書きなし（null）で書く。文字「無地」が印字されていれば判定では不一致になる
  if (pr.omotegaki === OMOTEGAKI_BLANK)
    at('現物の表書きに「無地」と書いている（無地は null で表す）');
  if (pr.cardText !== null && [...pr.cardText].length > CARD_TEXT_MAX) {
    at(`現物のカード文面が長すぎる（${CARD_TEXT_MAX} 文字まで）`);
  }

  // 想定結果と「登録 vs 現物」の差分が一致しているか（主判定の項目のみ）
  const printedOmotegaki = pr.omotegaki ?? (pr.noshiType !== null ? OMOTEGAKI_BLANK : null);
  const diffs = [
    r.noshiRequired && printedOmotegaki !== r.omotegaki,
    // 名入れなし（null）は判定の対象外
    r.noshiRequired && r.atena !== null && pr.atena !== r.atena,
    r.cardRequired && pr.cardText !== r.cardText,
  ].filter(Boolean).length;
  if (order.expected === 'OK' && diffs > 0) at('想定OKなのに印刷内容が登録と異なる');
  if (order.expected === 'NG' && diffs === 0) at('想定NGなのに印刷内容が登録と同じ');
  return p;
}

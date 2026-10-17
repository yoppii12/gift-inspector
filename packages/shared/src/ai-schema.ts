import {z} from 'zod';

import {MIZUHIKI_TYPES} from './status';

/**
 * AIの読取結果のスキーマ。照合はコード側で行い、AIには正解情報を渡さない。
 * 余計なキーは拒否する（strict）。変更したら AI_READ_SCHEMA_VERSION を上げる。
 */
export const AI_READ_SCHEMA_VERSION = 3;

export const aiReadSchema = z.strictObject({
  noshi_present: z.boolean(),
  mizuhiki_type: z.enum([...MIZUHIKI_TYPES, '不明']),
  omotegaki: z.string().nullable(),
  /** のし紙が写っていて、表書きの位置に何も印字されていない（v2。表書き「無地」の判定に使う） */
  omotegaki_blank: z.boolean(),
  atena: z.string().nullable(),
  card_present: z.boolean(),
  card_text: z.string().nullable(),
  // v3（#53）: 写っている資材。参考判定にだけ使う
  paper_flat_bag_present: z.boolean(),
  drawstring_bag_present: z.boolean(),
  seal_present: z.boolean(),
  manual_present: z.boolean(),
  carrier_bag_present: z.boolean(),
});

export type AiReadResult = z.infer<typeof aiReadSchema>;

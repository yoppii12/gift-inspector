import {z} from 'zod';

import {MIZUHIKI_TYPES} from './status';

/**
 * AIの読取結果のスキーマ。照合はコード側で行い、AIには正解情報を渡さない。
 * 余計なキーは拒否する（strict）。変更したら AI_READ_SCHEMA_VERSION を上げる。
 */
export const AI_READ_SCHEMA_VERSION = 1;

export const aiReadSchema = z.strictObject({
  noshi_present: z.boolean(),
  mizuhiki_type: z.enum([...MIZUHIKI_TYPES, '不明']),
  omotegaki: z.string().nullable(),
  atena: z.string().nullable(),
  card_present: z.boolean(),
  card_text: z.string().nullable(),
});

export type AiReadResult = z.infer<typeof aiReadSchema>;

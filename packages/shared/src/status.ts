/**
 * 判定ステータスの定義。合成規則の実装は apps/api/src/judge/judge.ts の1か所のみ。
 * 詳細は docs/error-handling.md 2章。
 */

/** 主判定の項目 */
export const ITEM_KEYS = ['omotegaki', 'atena', 'card_text'] as const;
export type ItemKey = (typeof ITEM_KEYS)[number];

export const ITEM_LABELS: Record<ItemKey, string> = {
  omotegaki: '表書き',
  atena: '宛名',
  card_text: 'メッセージカード',
};

export const ITEM_RESULTS = ['OK', 'NG', 'UNREADABLE', 'SKIP'] as const;
export type ItemResult = (typeof ITEM_RESULTS)[number];

export const ITEM_REASONS = [
  'MATCH',
  'MISMATCH',
  'NOT_PRESENT',
  'TEXT_UNREADABLE',
  'NOT_REQUIRED',
] as const;
export type ItemReason = (typeof ITEM_REASONS)[number];

export const OVERALL_RESULTS = ['OK', 'NG', 'UNREADABLE', 'ERROR'] as const;
export type Overall = (typeof OVERALL_RESULTS)[number];

/** UNREADABLE の理由（エラーではなく判定の理由） */
export const UNREADABLE_REASONS = [
  'AI_SCHEMA_NO_TOOL_USE',
  'AI_SCHEMA_INVALID',
  'AI_SCHEMA_TRUNCATED',
  'AI_SCHEMA_REFUSAL',
  'TEXT_UNREADABLE',
] as const;
export type UnreadableReason = (typeof UNREADABLE_REASONS)[number];

/** 参考判定の警告 */
export const REF_WARNINGS = [
  'NOSHI_MISSING',
  'NOSHI_UNEXPECTED',
  'CARD_MISSING',
  'CARD_UNEXPECTED',
  'MIZUHIKI_MISMATCH',
  'MIZUHIKI_UNKNOWN',
] as const;
export type RefWarning = (typeof REF_WARNINGS)[number];

export const MIZUHIKI_TYPES = ['蝶結び', '結び切り'] as const;
export type MizuhikiType = (typeof MIZUHIKI_TYPES)[number];

/** デモ用オーダーのQRコード値の形式。読取値はこの形式で事前検証する */
export const ORDER_CODE_PATTERN = /^GIFT-DEMO-[0-9]{3}$/;

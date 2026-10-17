/**
 * 判定ステータスの定義。合成規則の実装は apps/api/src/judge/judge.ts の1か所のみ。
 * 詳細は docs/error-handling.md 2章。
 */

/** 主判定の項目 */
export const ITEM_KEYS = ['omotegaki', 'atena', 'card_text'] as const;
export type ItemKey = (typeof ITEM_KEYS)[number];

export const ITEM_LABELS: Record<ItemKey, string> = {
  omotegaki: '表書き',
  atena: '名入れ',
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
  // #53: ラッピング資材・手提げ袋（オーダーで指定があるときだけ）
  'BAG_MISSING',
  'BAG_MISMATCH',
  'BAG_UNEXPECTED',
  'SEAL_MISSING',
  'MANUAL_MISSING',
  'CARRIER_BAG_MISSING',
  'CARRIER_BAG_UNEXPECTED',
  // #55: のし紙の長短（縦横比の計測。オーダーで指定があるときだけ）
  'NOSHI_SIZE_MISMATCH',
  'NOSHI_SIZE_UNKNOWN',
] as const;
export type RefWarning = (typeof REF_WARNINGS)[number];

/** 水引の種類（お客様の呼び方。PoC の初期は「花結び」を「蝶結び」と呼んでいた。#51） */
export const MIZUHIKI_TYPES = ['花結び', '結び切り'] as const;
export type MizuhikiType = (typeof MIZUHIKI_TYPES)[number];

/**
 * ラッピングの袋（#53）。紙平袋はシール貼り、布巾着袋は取扱説明書の同梱が必須。
 * オーダーで未設定（null）のときは参考判定の対象外
 */
export const BAG_TYPES = ['紙平袋', '布巾着袋', 'なし'] as const;
export type BagType = (typeof BAG_TYPES)[number];

/** のし紙の大きさ（#55）。高さは共通で長さが違う。縦横比で見分ける */
export const NOSHI_SIZES = ['長い', '短い'] as const;
export type NoshiSize = (typeof NOSHI_SIZES)[number];

/** 参考判定の項目（判定結果の一覧の順） */
export const REFERENCE_KEYS = [
  'noshi',
  'noshi_size',
  'mizuhiki',
  'card',
  'bag',
  'seal',
  'manual',
  'carrier_bag',
] as const;
export type ReferenceKey = (typeof REFERENCE_KEYS)[number];

export const REFERENCE_LABELS: Record<ReferenceKey, string> = {
  noshi: 'のし',
  noshi_size: 'のし紙の大きさ',
  mizuhiki: '水引',
  card: 'メッセージカード',
  bag: 'ラッピングの袋',
  seal: 'シール',
  manual: '取扱説明書',
  carrier_bag: '紙手提げ袋（黒）',
};

/** 表書きの正解がこの値のときは「表書きを印字しない」ことが正解（#51） */
export const OMOTEGAKI_BLANK = '無地';

/** デモ用オーダーのQRコード値の形式。読取値はこの形式で事前検証する */
export const ORDER_CODE_PATTERN = /^GIFT-DEMO-[0-9]{3}$/;

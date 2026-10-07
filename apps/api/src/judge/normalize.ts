/**
 * 突合用の文字列正規化（docs/error-handling.md 2.1、CLAUDE.md 7章）。
 * 正規化は「同じとみなしてよいことが確実なもの」だけを吸収する。迷うものは吸収しない（= NG に倒す）。
 */

/**
 * 異体字の一方向正規化表（左を右に寄せる）。両辺に同じ変換をかけてから比較する。
 * 追加するときは、人名・表書きで同一視して問題ないことを確認し、test/normalize.spec.ts にペアを足すこと。
 */
export const VARIANT_TABLE: Readonly<Record<string, string>> = {
  髙: '高',
  﨑: '崎',
  嵜: '崎',
  邊: '辺',
  邉: '辺',
  濵: '浜',
  濱: '浜',
  澤: '沢',
  齋: '斎',
  齊: '斉',
  櫻: '桜',
  廣: '広',
  國: '国',
  嶋: '島',
};

const VARIANT_PATTERN = new RegExp(`[${Object.keys(VARIANT_TABLE).join('')}]`, 'gu');

/** 文字・数字を1つも含まない（空白・記号のみ）とき、読めていないものとして扱う */
const HAS_CONTENT = /[\p{L}\p{N}]/u;

/**
 * 正規化する。NFKC（全角英数→半角、全角空白→半角 など）→ 空白をすべて除去 → 異体字表。
 * 文字・数字を含まない場合は null（= 読めていない／正解が空）を返す。
 */
export function normalizeText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .replace(VARIANT_PATTERN, ch => VARIANT_TABLE[ch] ?? ch);
  return HAS_CONTENT.test(normalized) ? normalized : null;
}

/**
 * 判定（docs/error-handling.md 2章）。OK を返す分岐はこのファイルにしかない。
 * 判定のデフォルトは非 OK。条件を満たしたことを明示的に確認できたときだけ OK にする。
 */
import {
  AppError,
  type AiReadResult,
  type ErrorCode,
  ITEM_KEYS,
  type ItemKey,
  type ItemReason,
  type ItemResult,
  type MizuhikiType,
  OMOTEGAKI_BLANK,
  type Overall,
  type RefWarning,
  type UnreadableReason,
} from '@gift-inspector/shared';

import {normalizeText} from './normalize';

/** 判定時点の正解（オーダーの登録内容、または開発用の手入力） */
export interface Expected {
  /** のしありなら必須。「無地」は表書きを印字しないことが正解 */
  omotegaki: string | null;
  /** のしありで null なら名入れなし（名入れは対象外）。空白だけの文字列は設定の不備 */
  atena: string | null;
  cardText: string | null;
  noshiType: MizuhikiType | null;
  noshiRequired: boolean;
  cardRequired: boolean;
}

/** AI 読取の結果（ai/guard.ts の出力を判定用に絞ったもの） */
export type ReadOutcome =
  | {status: 'ok'; data: AiReadResult}
  | {status: 'unreadable'; reason: UnreadableReason}
  | {status: 'error'; code: ErrorCode};

export interface ItemJudgement {
  key: ItemKey;
  result: ItemResult;
  reason: ItemReason;
  expected: string | null;
  read: string | null;
  normalizedExpected: string | null;
  normalizedRead: string | null;
  /** AI が「表書きの位置に何も印字されていない」と答えた（表書きの項目のみ） */
  blank: boolean;
}

export interface Judgement {
  overall: Overall;
  /** overall=ERROR のとき必ず入る */
  errorCode: ErrorCode | null;
  /** overall=UNREADABLE のとき必ず入る */
  unreadableReason: UnreadableReason | null;
  /** overall=NG のうち、参考判定の警告だけが理由のとき 'REF_MISMATCH' */
  ngReason: 'ITEM' | 'REF_MISMATCH' | null;
  /** ERROR のときは null（項目の結果を表示しない） */
  items: ItemJudgement[] | null;
  refWarnings: RefWarning[];
}

export interface JudgeOptions {
  /** true なら参考判定の警告があるとき総合 NG にする（D7、既定 false） */
  refMismatchBlocksOk: boolean;
}

const ITEM_FIELDS: Record<ItemKey, {expected: keyof Expected; read: keyof AiReadResult}> = {
  omotegaki: {expected: 'omotegaki', read: 'omotegaki'},
  atena: {expected: 'atena', read: 'atena'},
  card_text: {expected: 'cardText', read: 'card_text'},
};

function isRequired(key: ItemKey, expected: Expected): boolean {
  if (key === 'card_text') return expected.cardRequired;
  // 名入れなし（null）は対象外。空白だけの文字列は対象のまま残し、assertValidExpected で設定の不備にする
  if (key === 'atena') return expected.noshiRequired && expected.atena !== null;
  return expected.noshiRequired;
}

/** 表書きの正解が「無地」（表書きを印字しないことが正解） */
function expectsBlank(key: ItemKey, normalizedExpected: string | null): boolean {
  return key === 'omotegaki' && normalizedExpected === OMOTEGAKI_BLANK;
}

function isPresent(key: ItemKey, read: AiReadResult): boolean {
  return key === 'card_text' ? read.card_present : read.noshi_present;
}

/**
 * 正解データの妥当性を検査する。AI を呼ぶ前に必ず通す（2.1 の手順 2）。
 * 不正なら CONFIG_INVALID_EXPECTED を投げる。
 */
export function assertValidExpected(expected: Expected): void {
  const problems: string[] = [];
  for (const key of ITEM_KEYS) {
    if (!isRequired(key, expected)) continue;
    const value = expected[ITEM_FIELDS[key].expected] as string | null;
    if (normalizeText(value) === null) problems.push(`${key} が空`);
  }
  if (expected.noshiRequired && expected.noshiType === null) problems.push('水引種別が空');
  if (!expected.noshiRequired && !expected.cardRequired) problems.push('判定する項目がない');
  if (problems.length > 0) {
    throw new AppError('CONFIG_INVALID_EXPECTED', {detail: problems.join(', ')});
  }
}

/** 項目ごとの判定（2.1 の表を上から順に評価） */
export function judgeItem(key: ItemKey, expected: Expected, read: AiReadResult): ItemJudgement {
  const expectedRaw = expected[ITEM_FIELDS[key].expected] as string | null;
  const readRaw = read[ITEM_FIELDS[key].read] as string | null;
  const normalizedExpected = normalizeText(expectedRaw);
  const normalizedRead = normalizeText(readRaw);
  const blank = key === 'omotegaki' && read.omotegaki_blank;
  const base = {
    key,
    expected: expectedRaw,
    read: readRaw,
    normalizedExpected,
    normalizedRead,
    blank,
  };

  if (!isRequired(key, expected)) return {...base, result: 'SKIP', reason: 'NOT_REQUIRED'};
  // 2: assertValidExpected で弾いているはずだが、ここでも OK に倒さない
  if (normalizedExpected === null) {
    throw new AppError('CONFIG_INVALID_EXPECTED', {detail: `${key} の正解が空`});
  }
  if (!isPresent(key, read)) return {...base, result: 'NG', reason: 'NOT_PRESENT'};
  let matched: boolean;
  if (expectsBlank(key, normalizedExpected)) {
    // 無地: 文字が読めたら印字されている（不一致）。記号・空白だけでも何か返したなら、印字なしとは言えない。
    // 「印字なし」と答え、読取値を何も返していない（null）ときだけ一致とする
    if (normalizedRead !== null) return {...base, result: 'NG', reason: 'MISMATCH'};
    if (readRaw !== null || !blank) {
      return {...base, result: 'UNREADABLE', reason: 'TEXT_UNREADABLE'};
    }
    matched = true;
  } else {
    // 無地でない正解に「印字なし」と答えた: 印字漏れの疑い。読み取れずではなく不一致にする
    if (blank && readRaw === null) return {...base, result: 'NG', reason: 'MISMATCH'};
    // 「印字なし」と答えたのに何か読んでいる（応答が矛盾）: どちらを信じても OK にしない
    if (blank) return {...base, result: 'UNREADABLE', reason: 'TEXT_UNREADABLE'};
    if (normalizedRead === null) return {...base, result: 'UNREADABLE', reason: 'TEXT_UNREADABLE'};
    matched = normalizedRead === normalizedExpected;
  }
  // 項目の OK はここだけ
  if (matched) return {...base, result: 'OK', reason: 'MATCH'};
  return {...base, result: 'NG', reason: 'MISMATCH'};
}

/** 参考判定の警告（2.3） */
export function refWarnings(expected: Expected, read: AiReadResult): RefWarning[] {
  const w: RefWarning[] = [];
  if (expected.noshiRequired && !read.noshi_present) w.push('NOSHI_MISSING');
  if (!expected.noshiRequired && read.noshi_present) w.push('NOSHI_UNEXPECTED');
  if (expected.cardRequired && !read.card_present) w.push('CARD_MISSING');
  if (!expected.cardRequired && read.card_present) w.push('CARD_UNEXPECTED');
  if (expected.noshiRequired && read.noshi_present) {
    if (read.mizuhiki_type === '不明') w.push('MIZUHIKI_UNKNOWN');
    else if (read.mizuhiki_type !== expected.noshiType) w.push('MIZUHIKI_MISMATCH');
  }
  return w;
}

/**
 * 項目の結果から総合結果を合成する（2.2 の 3〜7）。
 * 64通りの組合せはテストで表として固定している。
 */
export function combineItems(
  results: readonly ItemResult[],
  hasRefWarning: boolean,
  options: JudgeOptions
): Pick<Judgement, 'overall' | 'errorCode' | 'unreadableReason' | 'ngReason'> {
  const judged = results.filter(r => r !== 'SKIP');
  // 3: 判定する項目がないのは設定の不備。警告より優先する
  if (judged.length === 0) {
    return {
      overall: 'ERROR',
      errorCode: 'CONFIG_INVALID_EXPECTED',
      unreadableReason: null,
      ngReason: null,
    };
  }
  if (judged.includes('NG')) {
    return {overall: 'NG', errorCode: null, unreadableReason: null, ngReason: 'ITEM'};
  }
  if (judged.includes('UNREADABLE')) {
    return {
      overall: 'UNREADABLE',
      errorCode: null,
      unreadableReason: 'TEXT_UNREADABLE',
      ngReason: null,
    };
  }
  if (options.refMismatchBlocksOk && hasRefWarning) {
    return {overall: 'NG', errorCode: null, unreadableReason: null, ngReason: 'REF_MISMATCH'};
  }
  // 7: ここに来るのは SKIP 以外がすべて OK のときだけ。念のため明示的に確かめてから OK を返す
  if (judged.every(r => r === 'OK')) {
    return {overall: 'OK', errorCode: null, unreadableReason: null, ngReason: null};
  }
  return {
    overall: 'ERROR',
    errorCode: 'SYS_UNEXPECTED',
    unreadableReason: null,
    ngReason: null,
  };
}

function errorJudgement(code: ErrorCode): Judgement {
  return {
    overall: 'ERROR',
    errorCode: code,
    unreadableReason: null,
    ngReason: null,
    items: null,
    refWarnings: [],
  };
}

/** 総合判定（2.2 の 1〜7）。例外を投げず、必ず Judgement を返す */
export function judge(expected: Expected, outcome: ReadOutcome, options: JudgeOptions): Judgement {
  try {
    assertValidExpected(expected);
  } catch (err: unknown) {
    if (err instanceof AppError) return errorJudgement(err.code);
    throw err;
  }

  // 1: 判定前・判定中のエラー
  if (outcome.status === 'error') return errorJudgement(outcome.code);

  // 2: AI 応答が2回ともスキーマ不適合。必須の項目はすべて UNREADABLE
  if (outcome.status === 'unreadable') {
    return {
      overall: 'UNREADABLE',
      errorCode: null,
      unreadableReason: outcome.reason,
      ngReason: null,
      items: ITEM_KEYS.map(key => {
        const expectedRaw = expected[ITEM_FIELDS[key].expected] as string | null;
        const required = isRequired(key, expected);
        return {
          key,
          result: required ? 'UNREADABLE' : 'SKIP',
          reason: required ? 'TEXT_UNREADABLE' : 'NOT_REQUIRED',
          expected: expectedRaw,
          read: null,
          normalizedExpected: normalizeText(expectedRaw),
          normalizedRead: null,
          blank: false,
        };
      }),
      refWarnings: [],
    };
  }

  const items = ITEM_KEYS.map(key => judgeItem(key, expected, outcome.data));
  const warnings = refWarnings(expected, outcome.data);
  return {
    ...combineItems(
      items.map(i => i.result),
      warnings.length > 0,
      options
    ),
    items,
    refWarnings: warnings,
  };
}

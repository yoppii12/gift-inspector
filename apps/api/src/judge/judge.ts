/**
 * 判定（docs/error-handling.md 2章）。OK を返す分岐はこのファイルにしかない。
 * 判定のデフォルトは非 OK。条件を満たしたことを明示的に確認できたときだけ OK にする。
 */
import {
  AppError,
  type AiReadResult,
  type BagType,
  type ErrorCode,
  ITEM_KEYS,
  type ItemKey,
  type ItemReason,
  type ItemResult,
  type MizuhikiType,
  type NoshiSize,
  OMOTEGAKI_BLANK,
  type Overall,
  REFERENCE_LABELS,
  type ReferenceItem,
  type ReferenceKey,
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
  /** のし紙の大きさ（参考判定）。null は対象外 */
  noshiSize: NoshiSize | null;
  /** ラッピングの袋（参考判定）。null は対象外 */
  bagType: BagType | null;
  /** 紙手提げ袋（参考判定）。null は対象外 */
  carrierBag: boolean | null;
}

/** AI 以外で計測した値（参考判定にだけ使う） */
export interface Measurements {
  /** のし紙の縦横比の計測（measure/noshi-size.ts）。計測しなかった・失敗したときは null */
  noshiSize: {size: NoshiSize | null; ratio: number | null; reason: string} | null;
}

export const NO_MEASUREMENTS: Measurements = {noshiSize: null};

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
export function refWarnings(
  expected: Expected,
  read: AiReadResult,
  measurements: Measurements = NO_MEASUREMENTS
): RefWarning[] {
  const w: RefWarning[] = [];
  if (expected.noshiRequired && !read.noshi_present) w.push('NOSHI_MISSING');
  if (!expected.noshiRequired && read.noshi_present) w.push('NOSHI_UNEXPECTED');
  if (expected.cardRequired && !read.card_present) w.push('CARD_MISSING');
  if (!expected.cardRequired && read.card_present) w.push('CARD_UNEXPECTED');
  if (expected.noshiRequired && read.noshi_present) {
    if (read.mizuhiki_type === '不明') w.push('MIZUHIKI_UNKNOWN');
    else if (read.mizuhiki_type !== expected.noshiType) w.push('MIZUHIKI_MISMATCH');
  }
  // のし紙の長短（オーダーで指定があり、のし紙が写っているときだけ。#55）
  if (expected.noshiRequired && expected.noshiSize !== null && read.noshi_present) {
    const measured = measurements.noshiSize?.size ?? null;
    if (measured === null) w.push('NOSHI_SIZE_UNKNOWN');
    else if (measured !== expected.noshiSize) w.push('NOSHI_SIZE_MISMATCH');
  }
  // ラッピング資材・手提げ袋（オーダーで指定があるときだけ。#53）
  if (expected.bagType !== null) {
    const seen = seenBag(read);
    if (expected.bagType === 'なし') {
      if (seen !== 'なし') w.push('BAG_UNEXPECTED');
    } else if (seen === 'なし') {
      w.push('BAG_MISSING');
    } else if (seen !== expected.bagType) {
      w.push('BAG_MISMATCH');
    }
    if (expected.bagType === '紙平袋' && !read.seal_present) w.push('SEAL_MISSING');
    if (expected.bagType === '布巾着袋' && !read.manual_present) w.push('MANUAL_MISSING');
  }
  if (expected.carrierBag === true && !read.carrier_bag_present) w.push('CARRIER_BAG_MISSING');
  if (expected.carrierBag === false && read.carrier_bag_present) {
    w.push('CARRIER_BAG_UNEXPECTED');
  }
  return w;
}

/** 写っていた袋（両方写っていれば両方を並べる。どの登録とも一致しない） */
function seenBag(read: AiReadResult): string {
  if (read.paper_flat_bag_present && read.drawstring_bag_present) return '紙平袋・布巾着袋';
  if (read.paper_flat_bag_present) return '紙平袋';
  if (read.drawstring_bag_present) return '布巾着袋';
  return 'なし';
}

const yesNo = (v: boolean) => (v ? 'あり' : 'なし');

const NOSHI_SIZE_REASON_LABELS: Record<string, string> = {
  BORDERLINE: '長い・短いの境目に近い',
  NOT_FOUND: 'のし紙の輪郭が見つからない',
  MULTIPLE: 'のし紙らしい紙が複数ある',
  UNSUPPORTED_FORMAT: 'JPEG 以外の画像',
  ERROR: '計測に失敗',
};

function noshiSizeDetail(m: Measurements['noshiSize']): string | undefined {
  if (m === null) return undefined;
  const ratio = m.ratio === null ? null : `縦横比 ${m.ratio.toFixed(2)}`;
  const reason = m.size === null ? (NOSHI_SIZE_REASON_LABELS[m.reason] ?? m.reason) : null;
  return [ratio, reason].filter(Boolean).join('・') || undefined;
}

/**
 * 参考判定の一覧（表示用。判定には使わない）。オーダーで対象になっている項目だけを返す。
 * AI が読み取れなかったとき（read = null）は、読み取り結果を null・状態を UNKNOWN にする。
 */
export function referenceItems(
  expected: Expected,
  read: AiReadResult | null,
  measurements: Measurements = NO_MEASUREMENTS
): ReferenceItem[] {
  const items: ReferenceItem[] = [];
  const add = (
    key: ReferenceKey,
    expectedLabel: string,
    readLabel: string | null,
    unknown = false,
    detail?: string
  ) =>
    items.push({
      key,
      label: REFERENCE_LABELS[key],
      expected: expectedLabel,
      read: read === null ? null : readLabel,
      status:
        read === null || unknown ? 'UNKNOWN' : readLabel === expectedLabel ? 'MATCH' : 'MISMATCH',
      ...(detail === undefined ? {} : {detail}),
    });

  add('noshi', yesNo(expected.noshiRequired), read && yesNo(read.noshi_present));
  if (expected.noshiRequired && expected.noshiSize !== null) {
    const m = measurements.noshiSize;
    add(
      'noshi_size',
      expected.noshiSize,
      read && (read.noshi_present ? (m?.size ?? null) : null),
      !read?.noshi_present || !m?.size,
      noshiSizeDetail(m)
    );
  }
  if (expected.noshiRequired && expected.noshiType !== null) {
    // のしが写っていない・判別できないときは水引の一致を判断しない
    add(
      'mizuhiki',
      expected.noshiType,
      read && (read.noshi_present ? read.mizuhiki_type : null),
      !read?.noshi_present || read.mizuhiki_type === '不明'
    );
  }
  add('card', yesNo(expected.cardRequired), read && yesNo(read.card_present));
  if (expected.bagType !== null) {
    add('bag', expected.bagType, read && seenBag(read));
    if (expected.bagType === '紙平袋') add('seal', 'あり', read && yesNo(read.seal_present));
    if (expected.bagType === '布巾着袋') add('manual', 'あり', read && yesNo(read.manual_present));
  }
  if (expected.carrierBag !== null) {
    add('carrier_bag', yesNo(expected.carrierBag), read && yesNo(read.carrier_bag_present));
  }
  return items;
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
export function judge(
  expected: Expected,
  outcome: ReadOutcome,
  options: JudgeOptions,
  measurements: Measurements = NO_MEASUREMENTS
): Judgement {
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
  const warnings = refWarnings(expected, outcome.data, measurements);
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

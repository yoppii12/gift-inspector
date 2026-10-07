/**
 * AI 読取のガードレール（docs/error-handling.md 3章）。
 * - 失敗を (a) スキーマ系 (b) 一時障害 (c) 設定不備 に分類する
 * - 1検品あたり最大2回。(a) は即再試行、(b) は待ってから再試行、(c) は再試行しない
 * - 2回とも (a) なら UNREADABLE、それ以外の失敗は ERROR。OK の判定はここでは行わない
 */
import {
  AI_MAX_ATTEMPTS,
  type AiReadResult,
  aiReadSchema,
  type ErrorCode,
  TIMEOUTS_MS,
  type UnreadableReason,
} from '@gift-inspector/shared';

import type {ReadOutcome} from '../judge/judge';
import {type AiProvider, ProviderError, type ReadRequest} from './types';

export type AttemptClass = 'ok' | 'schema' | 'transient' | 'config' | 'unexpected';

/** 試行ごとの記録（inspections.ai_attempts に保存する） */
export interface AttemptRecord {
  n: number;
  startedAt: string;
  latencyMs: number;
  class: AttemptClass;
  /** schema → UnreadableReason、transient/config/unexpected → ErrorCode */
  code: UnreadableReason | ErrorCode | null;
  detail: string | null;
  stopReason: string | null;
  httpStatus: number | null;
  requestId: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  raw: unknown;
}

export type GuardedRead = ReadOutcome & {attempts: AttemptRecord[]};

export interface GuardDeps {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const realGuardDeps: GuardDeps = {
  now: Date.now,
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        },
        {once: true}
      );
    }),
};

type Classified =
  | {class: 'ok'; data: AiReadResult}
  | {class: 'schema'; code: UnreadableReason; detail: string}
  | {
      class: 'transient' | 'config' | 'unexpected';
      code: ErrorCode;
      detail: string;
      retryAfterMs: number | null;
    };

/** 応答を検証・分類する。tool_use で返り、strict スキーマに適合したものだけが ok */
export function classifyResponse(stopReason: string, toolInput: unknown): Classified {
  if (stopReason === 'max_tokens') {
    return {class: 'schema', code: 'AI_SCHEMA_TRUNCATED', detail: '出力が途中で打ち切られた'};
  }
  if (stopReason === 'refusal') {
    return {class: 'schema', code: 'AI_SCHEMA_REFUSAL', detail: '応答が拒否された'};
  }
  if (stopReason !== 'tool_use' || toolInput === null || toolInput === undefined) {
    return {class: 'schema', code: 'AI_SCHEMA_NO_TOOL_USE', detail: `stop_reason=${stopReason}`};
  }
  const parsed = aiReadSchema.safeParse(toolInput);
  if (!parsed.success) {
    return {
      class: 'schema',
      code: 'AI_SCHEMA_INVALID',
      detail: parsed.error.issues
        .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; '),
    };
  }
  return {class: 'ok', data: parsed.data};
}

/** 通信の失敗を分類する */
export function classifyError(err: unknown): Classified {
  if (err instanceof ProviderError) {
    const base = {detail: err.message, retryAfterMs: err.retryAfterMs};
    if (err.kind === 'timeout') return {...base, class: 'transient', code: 'AI_TIMEOUT'};
    if (err.kind === 'network') return {...base, class: 'transient', code: 'AI_UNAVAILABLE'};
    const s = err.status ?? 0;
    if (s === 408) return {...base, class: 'transient', code: 'AI_TIMEOUT'};
    if (s === 429) return {...base, class: 'transient', code: 'AI_RATE_LIMITED'};
    if (s === 529) return {...base, class: 'transient', code: 'AI_OVERLOADED'};
    if (s >= 500) return {...base, class: 'transient', code: 'AI_UNAVAILABLE'};
    if (s === 401 || s === 403) return {...base, class: 'config', code: 'AI_AUTH'};
    return {...base, class: 'config', code: 'AI_BAD_REQUEST'};
  }
  // プロバイダ実装の不具合など。原因が分からないので再試行せず表に出す
  return {
    class: 'unexpected',
    code: 'SYS_UNEXPECTED',
    detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    retryAfterMs: null,
  };
}

/**
 * AI で画像を読み取る。例外を投げず、必ず GuardedRead を返す。
 * @param deadline 検品全体の締め切り（エポックミリ秒）。2回目を呼ぶ前に残り時間を確認する
 */
export async function guardedRead(
  provider: AiProvider,
  request: Omit<ReadRequest, 'timeoutMs' | 'signal'>,
  options: {deadline: number; signal: AbortSignal; deps?: GuardDeps}
): Promise<GuardedRead> {
  const deps = options.deps ?? realGuardDeps;
  const attempts: AttemptRecord[] = [];
  let last: Classified | null = null;

  for (let n = 1; n <= AI_MAX_ATTEMPTS; n++) {
    if (n > 1) {
      // last は1回目の結果。ok と config / unexpected はここに来ない
      const wait =
        last?.class === 'transient'
          ? Math.min(last.retryAfterMs ?? TIMEOUTS_MS.aiRetryBackoff, TIMEOUTS_MS.aiRetryAfterMax)
          : 0;
      if (options.deadline - deps.now() - wait < TIMEOUTS_MS.aiAttempt) {
        return {status: 'error', code: 'INSPECTION_TIMEOUT', attempts};
      }
      if (wait > 0) {
        try {
          await deps.sleep(wait, options.signal);
        } catch {
          return {status: 'error', code: 'INSPECTION_TIMEOUT', attempts};
        }
      }
    }

    const startedAt = deps.now();
    const attemptSignal = AbortSignal.any([
      options.signal,
      AbortSignal.timeout(TIMEOUTS_MS.aiAttempt),
    ]);
    const record: AttemptRecord = {
      n,
      startedAt: new Date(startedAt).toISOString(),
      latencyMs: 0,
      class: 'unexpected',
      code: null,
      detail: null,
      stopReason: null,
      httpStatus: null,
      requestId: null,
      tokensIn: null,
      tokensOut: null,
      raw: null,
    };

    try {
      const res = await provider.read({
        ...request,
        timeoutMs: TIMEOUTS_MS.aiAttempt,
        signal: attemptSignal,
      });
      last = classifyResponse(res.stopReason, res.toolInput);
      Object.assign(record, {
        stopReason: res.stopReason,
        requestId: res.requestId,
        tokensIn: res.tokensIn,
        tokensOut: res.tokensOut,
        raw: res.raw,
      });
    } catch (err: unknown) {
      last = classifyError(err);
      if (err instanceof ProviderError) {
        Object.assign(record, {httpStatus: err.status, requestId: err.requestId});
      }
    }
    record.latencyMs = deps.now() - startedAt;
    record.class = last.class;
    record.code = last.class === 'ok' ? null : last.code;
    record.detail = last.class === 'ok' ? null : last.detail;
    attempts.push(record);

    if (last.class === 'ok') return {status: 'ok', data: last.data, attempts};
    // (c) 設定不備と原因不明は再試行しない
    if (last.class === 'config' || last.class === 'unexpected') {
      return {status: 'error', code: last.code, attempts};
    }
  }

  // ここに来るのは2回とも失敗し、最後が (a) か (b) のとき。2回目の分類で確定する
  if (last?.class === 'schema') return {status: 'unreadable', reason: last.code, attempts};
  if (last?.class === 'transient') return {status: 'error', code: last.code, attempts};
  return {status: 'error', code: 'SYS_UNEXPECTED', attempts};
}

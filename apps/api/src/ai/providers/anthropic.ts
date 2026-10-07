/**
 * Anthropic（Claude API）プロバイダ。Messages API を構造化出力（JSON スキーマ）で呼ぶ。
 * 依頼に含めるのは画像と読取指示だけ（正解情報は渡さない）。
 * - 現行モデルは temperature を受け付けない（400）ため指定しない。再現性は計測で確かめる（案C）
 * - SDK の自動リトライは無効（maxRetries: 0）。リトライは guard だけが行う
 * - 安全フィルタで拒否された場合は、サーバー側で推奨モデルに読み直させる（fallbacks: "default"）。
 *   実際に読んだモデルは servedModel として試行の記録に残す
 */
import Anthropic from '@anthropic-ai/sdk';

import {JSON_INSTRUCTION, SYSTEM_PROMPT, TOOL_INPUT_SCHEMA, USER_PROMPT} from '../prompt';
import {
  abortError,
  type AiProvider,
  ProviderError,
  type ProviderResponse,
  type ReadRequest,
} from '../types';

const MAX_TOKENS = 16_000;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** JSON として読めなかった応答。strict スキーマで必ず不適合（AI_SCHEMA_INVALID）になる */
export const UNPARSEABLE = Object.freeze({__unparseable: true});

const {$schema: _ignored, ...RESPONSE_SCHEMA} = TOOL_INPUT_SCHEMA as Record<string, unknown>;

export type Effort = 'low' | 'medium' | 'high';

type Message = Anthropic.Beta.BetaMessage;

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: Effort | null;

  constructor(options: {
    apiKey: string;
    model: string;
    effort?: Effort | null;
    client?: Anthropic;
  }) {
    if (!options.apiKey && !options.client) throw new Error('ANTHROPIC_API_KEY が空です');
    if (!options.model) throw new Error('AI_MODEL が空です');
    this.model = options.model;
    this.effort = options.effort ?? null;
    this.client = options.client ?? new Anthropic({apiKey: options.apiKey, maxRetries: 0});
  }

  async read(request: ReadRequest): Promise<ProviderResponse> {
    let message: Message;
    try {
      message = await this.client.beta.messages.create(
        {
          model: this.model,
          max_tokens: MAX_TOKENS,
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
          system: `${SYSTEM_PROMPT}\n${JSON_INSTRUCTION}`,
          output_config: {
            format: {type: 'json_schema', schema: RESPONSE_SCHEMA},
            ...(this.effort ? {effort: this.effort} : {}),
          },
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: request.mimeType,
                    data: request.image.toString('base64'),
                  },
                },
                {type: 'text', text: USER_PROMPT},
              ],
            },
          ],
        },
        {signal: request.signal, timeout: request.timeoutMs, maxRetries: 0}
      );
    } catch (err: unknown) {
      throw toProviderError(err, request.signal);
    }
    return toResponse(message);
  }
}

/**
 * SDK の例外を ProviderError に写像する（具体的なクラスから順に判定する）。
 * SDK 以外の想定外の例外はそのまま返し、guard が SYS_UNEXPECTED として扱う。
 */
export function toProviderError(err: unknown, signal: AbortSignal): unknown {
  // SDK 自身のタイムアウト（1試行の制限時間）
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderError('timeout', 'Claude の応答が1試行の制限時間を超えた', {cause: err});
  }
  // HTTP の応答を受け取れていれば、その後に中断されてもステータスを記録する
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
    return new ProviderError('http', `Claude HTTP ${err.status}: ${err.message.slice(0, 300)}`, {
      status: err.status,
      retryAfterMs: retryAfter(err.headers as Headers | undefined),
      requestId: err.requestID ?? null,
      cause: err,
    });
  }
  if (signal.aborted || err instanceof Anthropic.APIUserAbortError)
    return abortError('Claude', signal, err);
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError('network', `Claude に接続できない: ${err.message}`, {cause: err});
  }
  return err;
}

function retryAfter(headers: Headers | undefined): number | null {
  const v = headers?.get('retry-after');
  const n = v === null || v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : null;
}

/**
 * 実際に応答したモデル。別モデルが読み直したかどうかは usage.iterations の fallback_message で判断する
 * （SDK の仕様。fallback ブロックやトップレベルの model では判断しない）。
 */
function servedModel(message: Message): string {
  const iterations = message.usage?.iterations ?? [];
  const fallback = iterations.filter(i => i.type === 'fallback_message').at(-1);
  return fallback && 'model' in fallback ? String(fallback.model) : message.model;
}

/** guard は 'tool_use' を「構造化出力が最後まで返った」として扱う */
export function toResponse(message: Message): ProviderResponse {
  const usage = message.usage;
  const base = {
    raw: message,
    requestId:
      (message as Message & {_request_id?: string | null})._request_id ?? message.id ?? null,
    tokensIn: usage?.input_tokens ?? null,
    tokensOut: usage?.output_tokens ?? null,
    servedModel: servedModel(message),
  };
  // fallbacks で読み直した場合、拒否したモデルの途中の出力が fallback ブロックの前に残りうる。
  // 最後に応答したモデルの出力（最後の fallback ブロックより後ろ）だけを使う
  const lastFallback = message.content.findLastIndex(b => b.type === 'fallback');
  const text = message.content
    .slice(lastFallback + 1)
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map(b => b.text)
    .join('');

  switch (message.stop_reason) {
    case 'end_turn': {
      if (!text) return {...base, stopReason: 'no_output', toolInput: null};
      try {
        return {...base, stopReason: 'tool_use', toolInput: JSON.parse(text) as unknown};
      } catch {
        return {...base, stopReason: 'tool_use', toolInput: UNPARSEABLE};
      }
    }
    case 'max_tokens':
      return {...base, stopReason: 'max_tokens', toolInput: text ? UNPARSEABLE : null};
    case 'refusal':
      return {...base, stopReason: 'refusal', toolInput: null};
    default:
      // stop_sequence / tool_use / pause_turn など、構造化出力として完結していないもの
      // guard の 'tool_use'（構造化出力の完了）と取り違えないよう、接頭辞を付けて記録する
      return {
        ...base,
        stopReason: `claude:${String(message.stop_reason ?? 'unknown')}`,
        toolInput: null,
      };
  }
}

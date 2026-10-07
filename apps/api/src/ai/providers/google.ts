/**
 * Google（Gemini API）プロバイダ。generateContent を構造化出力（JSON スキーマ）・温度 0 で呼ぶ。
 * 依頼に含めるのは画像と読取指示だけ（正解情報は渡さない）。
 * ここではリトライしない。失敗は ProviderError に、終了理由は guard の分類に合う stopReason に変換する。
 */
import {JSON_INSTRUCTION, SYSTEM_PROMPT, TOOL_INPUT_SCHEMA, USER_PROMPT} from '../prompt';
import {type AiProvider, ProviderError, type ProviderResponse, type ReadRequest} from '../types';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
/** 思考トークンを含めて打ち切られない程度に大きく取る（出力そのものは100トークン前後） */
const MAX_OUTPUT_TOKENS = 8192;

/** guard は 'tool_use' を「構造化出力が最後まで返った」として扱う */
const STOP_REASONS: Record<string, string> = {
  STOP: 'tool_use',
  MAX_TOKENS: 'max_tokens',
  SAFETY: 'refusal',
  RECITATION: 'refusal',
  BLOCKLIST: 'refusal',
  PROHIBITED_CONTENT: 'refusal',
  SPII: 'refusal',
  IMAGE_SAFETY: 'refusal',
};

/** JSON として読めなかった応答。strict スキーマで必ず不適合（AI_SCHEMA_INVALID）になる */
export const UNPARSEABLE = Object.freeze({__unparseable: true});

const {$schema: _ignored, ...RESPONSE_SCHEMA} = TOOL_INPUT_SCHEMA as Record<string, unknown>;

interface GeminiPart {
  text?: string;
  thought?: boolean;
}
interface GeminiResponse {
  candidates?: {content?: {parts?: GeminiPart[]}; finishReason?: string}[];
  promptFeedback?: {blockReason?: string};
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  responseId?: string;
  modelVersion?: string;
}
interface GeminiError {
  error?: {
    code?: number;
    status?: string;
    message?: string;
    details?: {'@type'?: string; retryDelay?: string}[];
  };
}

export class GoogleProvider implements AiProvider {
  readonly name = 'google';
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: {
    apiKey: string;
    model: string;
    fetchImpl?: typeof fetch;
    baseUrl?: string;
  }) {
    if (!options.apiKey) throw new Error('GEMINI_API_KEY が空です');
    if (!options.model) throw new Error('AI_MODEL が空です');
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? BASE_URL;
  }

  async read(request: ReadRequest): Promise<ProviderResponse> {
    const body = {
      systemInstruction: {parts: [{text: `${SYSTEM_PROMPT}\n${JSON_INSTRUCTION}`}]},
      contents: [
        {
          role: 'user',
          parts: [
            {inline_data: {mime_type: request.mimeType, data: request.image.toString('base64')}},
            {text: USER_PROMPT},
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        responseMimeType: 'application/json',
        responseJsonSchema: RESPONSE_SCHEMA,
      },
    };

    let res: Response;
    try {
      // キーはヘッダーで渡す（URL に入れるとアクセスログやエラーメッセージに残りうる）
      res = await this.fetchImpl(
        `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`,
        {
          method: 'POST',
          headers: {'content-type': 'application/json', 'x-goog-api-key': this.apiKey},
          body: JSON.stringify(body),
          signal: request.signal,
        }
      );
    } catch (err: unknown) {
      if (request.signal.aborted) {
        throw new ProviderError('timeout', 'Gemini の応答がタイムアウトした', {cause: err});
      }
      throw new ProviderError('network', `Gemini に接続できない: ${errorText(err)}`, {cause: err});
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (err: unknown) {
      if (request.signal.aborted) {
        throw new ProviderError('timeout', 'Gemini の応答の受信中にタイムアウトした', {cause: err});
      }
      if (!res.ok) throw httpError(res, {});
      throw new ProviderError('http', `Gemini の応答を JSON として読めない（HTTP ${res.status}）`, {
        status: 502,
        cause: err,
      });
    }

    if (!res.ok) throw httpError(res, json as GeminiError);
    return toResponse(json as GeminiResponse);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function httpError(res: Response, body: GeminiError): ProviderError {
  const e = body.error ?? {};
  const message =
    `Gemini HTTP ${res.status} ${e.status ?? ''}: ${(e.message ?? '').slice(0, 300)}`.trim();
  return new ProviderError('http', message, {status: res.status, retryAfterMs: retryAfter(res, e)});
}

/** RetryInfo.retryDelay（"13s" など）か Retry-After ヘッダー（秒） */
function retryAfter(res: Response, e: NonNullable<GeminiError['error']>): number | null {
  const delay = e.details?.find(d => d['@type']?.endsWith('RetryInfo'))?.retryDelay;
  const fromBody = delay ? /^(\d+(?:\.\d+)?)s$/.exec(delay)?.[1] : undefined;
  const seconds = fromBody ?? res.headers.get('retry-after') ?? undefined;
  const n = seconds === undefined ? NaN : Number(seconds);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : null;
}

export function toResponse(body: GeminiResponse): ProviderResponse {
  const usage = body.usageMetadata ?? {};
  const base = {
    raw: body,
    requestId: body.responseId ?? null,
    tokensIn: usage.promptTokenCount ?? null,
    tokensOut:
      usage.candidatesTokenCount === undefined && usage.thoughtsTokenCount === undefined
        ? null
        : (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
  };

  const candidate = body.candidates?.[0];
  if (!candidate) {
    // 入力そのものが安全フィルタで止められた場合は候補が返らない
    const stopReason = body.promptFeedback?.blockReason ? 'refusal' : 'no_candidates';
    return {...base, stopReason, toolInput: null};
  }

  const finish = candidate.finishReason ?? 'UNKNOWN';
  const stopReason = STOP_REASONS[finish] ?? finish.toLowerCase();
  const text = (candidate.content?.parts ?? [])
    .filter(p => !p.thought && typeof p.text === 'string')
    .map(p => p.text)
    .join('');

  if (stopReason !== 'tool_use') return {...base, stopReason, toolInput: text ? UNPARSEABLE : null};
  if (!text) return {...base, stopReason: 'no_output', toolInput: null};
  try {
    return {...base, stopReason, toolInput: JSON.parse(text) as unknown};
  } catch {
    return {...base, stopReason, toolInput: UNPARSEABLE};
  }
}

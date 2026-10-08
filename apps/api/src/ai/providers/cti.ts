/**
 * CTI-Cloud（社内の Gemma）プロバイダ。App の read_gift_items に画像だけを multipart で送る。
 * 読取指示・JSON スキーマ・温度（既定 0）は CTI-Cloud 側の Structure（docs/cti-cloud/read_gift_items.yaml）にあり、
 * こちらからは送らない。正解情報も送らない（読取と照合の分離）。
 * ここではリトライしない。失敗は ProviderError に、応答は guard の分類に合う stopReason に変換する。
 */
import {
  abortError,
  type AiProvider,
  ProviderError,
  type ProviderResponse,
  type ReadRequest,
} from '../types';
import {UNPARSEABLE} from './google';

/**
 * CTI-Cloud 側の Structure の版。docs/cti-cloud/read_gift_items.yaml の読取指示・スキーマを変えたら上げる
 * （判定記録の prompt_version に残し、結果の差を追えるようにする）
 */
export const CTI_PROMPT_VERSION = 'cti-read-v1';

const ENDPOINT = 'read_gift_items';

const EXTENSIONS: Record<ReadRequest['mimeType'], string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export class CtiProvider implements AiProvider {
  readonly name = 'cti';
  readonly model: string;
  readonly promptVersion = CTI_PROMPT_VERSION;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: {apiKey: string; baseUrl: string; model: string; fetchImpl?: typeof fetch}) {
    if (!options.apiKey) throw new Error('CTI_API_KEY が空です');
    if (!options.baseUrl) throw new Error('CTI_BASE_URL が空です');
    if (!options.model) throw new Error('AI_MODEL が空です');
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async read(request: ReadRequest): Promise<ProviderResponse> {
    const form = new FormData();
    form.append(
      'image',
      new Blob([new Uint8Array(request.image)], {type: request.mimeType}),
      `image.${EXTENSIONS[request.mimeType]}`
    );

    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/${ENDPOINT}`, {
        method: 'POST',
        headers: {authorization: `Bearer ${this.apiKey}`},
        body: form,
        signal: request.signal,
      });
    } catch (err: unknown) {
      if (request.signal.aborted) throw abortError('CTI-Cloud', request.signal, err);
      throw new ProviderError('network', `CTI-Cloud に接続できない: ${errorText(err)}`, {
        cause: err,
      });
    }
    try {
      text = await res.text();
    } catch (err: unknown) {
      if (request.signal.aborted) throw abortError('CTI-Cloud', request.signal, err);
      // 本文の途中で切れた。一時障害として扱い、実際のステータスは文言に残す
      throw new ProviderError(
        'network',
        `CTI-Cloud の応答を最後まで読めない（HTTP ${res.status}）`,
        {cause: err}
      );
    }

    if (!res.ok) throw httpError(res, text);
    return toResponse(text, res.headers.get('x-request-id'));
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** エラー本文は openresty の HTML のこともあるので、タグを除いて短く残す */
function httpError(res: Response, text: string): ProviderError {
  const summary = text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  const seconds = Number(res.headers.get('retry-after') ?? NaN);
  return new ProviderError('http', `CTI-Cloud HTTP ${res.status}: ${summary}`, {
    status: res.status,
    retryAfterMs: Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null,
  });
}

/**
 * 本文（JSON）を読取結果として渡す。JSON 文字列がさらに文字列で包まれていても読む。
 * 読めなければ UNPARSEABLE（strict スキーマで必ず不適合になり、guard が1回だけ再試行する）。
 * トークン数は返らないので記録しない。
 */
export function toResponse(text: string, requestId: string | null): ProviderResponse {
  const base = {raw: {text}, requestId, tokensIn: null, tokensOut: null, servedModel: null};
  if (!text.trim()) return {...base, stopReason: 'no_output', toolInput: null};
  try {
    let value: unknown = JSON.parse(text);
    if (typeof value === 'string') value = JSON.parse(value);
    return {...base, stopReason: 'tool_use', toolInput: value};
  } catch {
    return {...base, stopReason: 'tool_use', toolInput: UNPARSEABLE};
  }
}

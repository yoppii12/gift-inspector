/**
 * AI プロバイダの抽象（モデル切替のための境界）。
 * プロバイダは「画像を渡して応答を返す」ことだけを行い、リトライ・検証・分類は ai/guard.ts が行う。
 * 入力に正解情報（オーダーの登録内容）を含める手段をあえて用意していない（読取と照合の分離）。
 */

export interface ReadRequest {
  image: Buffer;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  /** ログ・ベンダー側の突き合わせ用。プロンプトには含めない */
  inspectionId: string;
  timeoutMs: number;
  signal: AbortSignal;
}

/** プロバイダが返す応答（未検証） */
export interface ProviderResponse {
  /** 'tool_use' 以外（'end_turn' 'max_tokens' 'refusal' など）はスキーマ系の失敗として扱われる */
  stopReason: string;
  /** 構造化出力（tool use の入力）。返らなければ null */
  toolInput: unknown;
  /** 記録用の生の応答 */
  raw: unknown;
  requestId: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
}

export type ProviderErrorKind = 'timeout' | 'network' | 'http';

/** プロバイダの通信失敗。HTTP エラーは status を必ず持つ */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly requestId: string | null;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    options: {
      status?: number;
      retryAfterMs?: number | null;
      requestId?: string | null;
      cause?: unknown;
    } = {}
  ) {
    super(message, {cause: options.cause});
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.requestId = options.requestId ?? null;
  }
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  /** 成功時は応答、通信失敗は ProviderError を投げる。SDK の自動リトライは無効にしておくこと */
  read(request: ReadRequest): Promise<ProviderResponse>;
}

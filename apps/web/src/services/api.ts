import {
  ERROR_CATALOG,
  type ErrorCode,
  type ErrorResponseBody,
  isErrorCode,
  TIMEOUTS_MS,
} from '@gift-inspector/shared';

/**
 * 画面で扱うエラー。通信・応答のあらゆる失敗はこれに変換される（docs/error-handling.md 4章）。
 * 画面側は code を見て ErrorPanel に渡すだけでよい。
 */
export class ClientError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number | null;
  readonly requestId: string | null;
  readonly inspectionId: string | null;
  /** 開発者向けの詳細（ライブラリのエラー種別・元のメッセージなど）。画面では折りたたんで表示する */
  readonly detail: string | null;

  constructor(
    code: ErrorCode,
    options: {
      httpStatus?: number | null;
      requestId?: string | null;
      inspectionId?: string | null;
      detail?: string;
      cause?: unknown;
    } = {}
  ) {
    super(options.detail ? `${code}: ${options.detail}` : code, {cause: options.cause});
    this.name = 'ClientError';
    this.code = code;
    this.httpStatus = options.httpStatus ?? null;
    this.requestId = options.requestId ?? null;
    this.inspectionId = options.inspectionId ?? null;
    this.detail =
      options.detail ?? (options.cause instanceof Error ? `${options.cause.name}: ${options.cause.message}` : null);
  }
}

/** JSON でない応答（OpenResty が直接返したもの等）をステータスから写像する */
export function codeFromStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
      return 'AUTH_REQUIRED';
    case 413:
      return 'UPLOAD_TOO_LARGE';
    case 429:
      return 'RATE_LIMITED';
    case 502:
    case 503:
      return 'UPSTREAM_UNAVAILABLE';
    case 504:
      return 'UPSTREAM_TIMEOUT';
    default:
      return 'RESPONSE_INVALID';
  }
}

function isErrorBody(value: unknown): value is ErrorResponseBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const err = value.error;
  return typeof err === 'object' && err !== null && isErrorCode((err as {code?: unknown}).code);
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: BodyInit;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** 画面を離れたときなどに呼び出し側から中断する */
  signal?: AbortSignal;
  inspectionId?: string | null;
  /** エラー形式でない JSON 本文を返す非 2xx ステータス（ヘルスチェックの 503 など） */
  acceptStatuses?: number[];
  fetchImpl?: typeof fetch;
}

/**
 * API 呼び出しの唯一の入口。成功時は JSON を返し、失敗時は必ず ClientError を投げる。
 * 「エラーなのに成功として扱う」「エラーの種類が分からない」経路を作らないため、
 * 2xx でも JSON として読めなければ RESPONSE_INVALID にする。
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const inspectionId = options.inspectionId ?? null;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? TIMEOUTS_MS.clientRequest);
  const signals = [timeout.signal, ...(options.signal ? [options.signal] : [])];

  let res: Response;
  try {
    res = await fetchImpl(path, {
      method: options.method ?? 'GET',
      body: options.body,
      headers: {accept: 'application/json', ...options.headers},
      signal: AbortSignal.any(signals),
      credentials: 'same-origin',
    });
  } catch (err: unknown) {
    clearTimeout(timer);
    if (options.signal?.aborted) {
      throw new ClientError('REQUEST_ABORTED', {inspectionId, cause: err});
    }
    if (timeout.signal.aborted) {
      throw new ClientError('REQUEST_TIMEOUT', {inspectionId, cause: err});
    }
    // fetch の TypeError（オフライン・DNS・接続断）
    throw new ClientError('NETWORK_OFFLINE', {inspectionId, cause: err});
  }
  clearTimeout(timer);

  const requestId = res.headers.get('x-request-id');
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  let body: unknown = undefined;
  if (isJson && res.status !== 204) {
    try {
      body = await res.json();
    } catch (err: unknown) {
      throw new ClientError(res.ok ? 'RESPONSE_INVALID' : codeFromStatus(res.status), {
        httpStatus: res.status,
        requestId,
        inspectionId,
        detail: 'JSON を読めません',
        cause: err,
      });
    }
  }

  const accepted = options.acceptStatuses?.includes(res.status) ?? false;
  if (!res.ok && !(accepted && body !== undefined && !isErrorBody(body))) {
    if (isErrorBody(body)) {
      throw new ClientError(body.error.code, {
        httpStatus: res.status,
        requestId: body.error.requestId ?? requestId,
        inspectionId: body.error.inspectionId ?? inspectionId,
      });
    }
    throw new ClientError(codeFromStatus(res.status), {httpStatus: res.status, requestId, inspectionId});
  }

  if (res.status === 204) return undefined as T;
  if (!isJson || body === undefined) {
    throw new ClientError('RESPONSE_INVALID', {
      httpStatus: res.status,
      requestId,
      inspectionId,
      detail: 'JSON 以外の応答',
    });
  }
  return body as T;
}

/** 例外を ClientError に正規化する（画面の catch で使う） */
export function toClientError(err: unknown): ClientError {
  if (err instanceof ClientError) return err;
  return new ClientError('SYS_UNEXPECTED', {
    detail: err instanceof Error ? err.message : String(err),
    cause: err,
  });
}

export function shouldReport(err: ClientError): boolean {
  const {category} = ERROR_CATALOG[err.code];
  return category === 'SYSTEM' || category === 'CONFIG';
}

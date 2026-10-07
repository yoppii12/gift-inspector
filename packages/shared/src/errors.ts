/**
 * エラーカタログ（唯一の定義）。
 * docs/error-handling.md 4章の表と常に一致させること（test/errors.spec.ts で照合している）。
 */

export type ErrorCategory = 'USER_ACTION' | 'RETRYABLE' | 'SYSTEM' | 'CONFIG';

/** 利用者に提示する次の操作 */
export type NextAction =
  | 'SELECT_FROM_LIST' // 一覧から選ぶ
  | 'RESCAN' // 読み直す
  | 'RETAKE' // 撮り直す
  | 'RETRY' // 再試行
  | 'RELOAD' // 再読み込み
  | 'BACK_TO_START' // 最初に戻る
  | 'NONE'; // 画面に出さない

export type ErrorSource = 'web' | 'edge' | 'api';

export interface ErrorDefinition {
  source: readonly ErrorSource[];
  /** API・edge が返す HTTP ステータス。web 内で完結するものは null */
  httpStatus: number | null;
  category: ErrorCategory;
  /** 作業者向けの文言（「API」「推論」などの用語を使わない） */
  userMessage: string;
  nextAction: NextAction;
}

export const ERROR_CATALOG = {
  CAMERA_PERMISSION_DENIED: {
    source: ['web'],
    httpStatus: null,
    category: 'USER_ACTION',
    userMessage:
      'カメラの使用が許可されていません。ブラウザの設定でカメラを許可するか、一覧からオーダーを選んでください。',
    nextAction: 'SELECT_FROM_LIST',
  },
  CAMERA_UNAVAILABLE: {
    source: ['web'],
    httpStatus: null,
    category: 'USER_ACTION',
    userMessage:
      'カメラを起動できませんでした。他のアプリがカメラを使っていないか確認するか、一覧からオーダーを選んでください。',
    nextAction: 'SELECT_FROM_LIST',
  },
  QR_ENGINE_LOAD_FAILED: {
    source: ['web'],
    httpStatus: null,
    category: 'SYSTEM',
    userMessage:
      'コードの読み取り機能を準備できませんでした。ページを再読み込みするか、一覧からオーダーを選んでください。',
    nextAction: 'SELECT_FROM_LIST',
  },
  QR_INVALID_FORMAT: {
    source: ['web'],
    httpStatus: null,
    category: 'USER_ACTION',
    userMessage:
      'このコードはデモ用オーダーのコードではありません。オーダーのQRコードを読み取ってください。',
    nextAction: 'RESCAN',
  },
  IMAGE_DECODE_FAILED: {
    source: ['web'],
    httpStatus: null,
    category: 'USER_ACTION',
    userMessage: '写真を読み込めませんでした。もう一度撮影してください。',
    nextAction: 'RETAKE',
  },
  NETWORK_OFFLINE: {
    source: ['web'],
    httpStatus: null,
    category: 'RETRYABLE',
    userMessage: '通信できませんでした。電波の状態を確認して、もう一度お試しください。',
    nextAction: 'RETRY',
  },
  REQUEST_TIMEOUT: {
    source: ['web'],
    httpStatus: null,
    category: 'RETRYABLE',
    userMessage: '応答がありませんでした。もう一度お試しください。',
    nextAction: 'RETRY',
  },
  REQUEST_ABORTED: {
    source: ['web'],
    httpStatus: null,
    category: 'RETRYABLE',
    userMessage: '画面を離れたため、判定を中断しました。もう一度お試しください。',
    nextAction: 'RETRY',
  },
  RESPONSE_INVALID: {
    source: ['web'],
    httpStatus: null,
    category: 'SYSTEM',
    userMessage:
      'サーバーから想定外の応答がありました。最初からやり直してください。続く場合は担当者に連絡してください。',
    nextAction: 'BACK_TO_START',
  },
  AUTH_REQUIRED: {
    source: ['edge'],
    httpStatus: 401,
    category: 'USER_ACTION',
    userMessage: 'ログインが必要です。ページを再読み込みしてください。',
    nextAction: 'RELOAD',
  },
  UPLOAD_TOO_LARGE: {
    source: ['edge', 'api'],
    httpStatus: 413,
    category: 'USER_ACTION',
    userMessage: '写真のサイズが大きすぎます。もう一度撮影してください。',
    nextAction: 'RETAKE',
  },
  RATE_LIMITED: {
    source: ['edge'],
    httpStatus: 429,
    category: 'RETRYABLE',
    userMessage: 'アクセスが集中しています。少し待ってから、もう一度お試しください。',
    nextAction: 'RETRY',
  },
  UPSTREAM_UNAVAILABLE: {
    source: ['edge'],
    httpStatus: 502,
    category: 'SYSTEM',
    userMessage:
      '判定サーバーが応答していません。少し待ってから、もう一度お試しください。続く場合は担当者に連絡してください。',
    nextAction: 'RETRY',
  },
  UPSTREAM_TIMEOUT: {
    source: ['edge'],
    httpStatus: 504,
    category: 'RETRYABLE',
    userMessage: '判定サーバーの応答が遅れています。もう一度お試しください。',
    nextAction: 'RETRY',
  },
  VALIDATION_FAILED: {
    source: ['api'],
    httpStatus: 400,
    category: 'SYSTEM',
    userMessage:
      '送信内容に不備があります。最初からやり直してください。続く場合は担当者に連絡してください。',
    nextAction: 'BACK_TO_START',
  },
  ORDER_NOT_FOUND: {
    source: ['api'],
    httpStatus: 404,
    category: 'USER_ACTION',
    userMessage: '登録されていないオーダーです。オーダーのQRコードを読み直してください。',
    nextAction: 'RESCAN',
  },
  IMAGE_UNSUPPORTED_TYPE: {
    source: ['api'],
    httpStatus: 415,
    category: 'USER_ACTION',
    userMessage: 'この形式の写真は使えません。もう一度撮影してください。',
    nextAction: 'RETAKE',
  },
  IMAGE_INVALID: {
    source: ['api'],
    httpStatus: 400,
    category: 'USER_ACTION',
    userMessage: '写真が壊れているため読み込めません。もう一度撮影してください。',
    nextAction: 'RETAKE',
  },
  INSPECTION_IN_PROGRESS: {
    source: ['api'],
    httpStatus: 409,
    category: 'RETRYABLE',
    userMessage: '同じ判定を処理しています。しばらく待ってから、もう一度お試しください。',
    nextAction: 'RETRY',
  },
  DEV_MODE_DISABLED: {
    source: ['api'],
    httpStatus: 403,
    category: 'CONFIG',
    userMessage: '開発モードは無効です。',
    nextAction: 'BACK_TO_START',
  },
  CONFIG_INVALID_EXPECTED: {
    source: ['api'],
    httpStatus: 422,
    category: 'CONFIG',
    userMessage: '登録データに不備があるため判定できません。担当者に連絡してください。',
    nextAction: 'BACK_TO_START',
  },
  STORAGE_WRITE_FAILED: {
    source: ['api'],
    httpStatus: 500,
    category: 'SYSTEM',
    userMessage:
      '写真を保存できませんでした。もう一度お試しください。続く場合は担当者に連絡してください。',
    nextAction: 'RETRY',
  },
  DB_UNAVAILABLE: {
    source: ['api'],
    httpStatus: 503,
    category: 'SYSTEM',
    userMessage:
      'データベースに接続できません。少し待ってから、もう一度お試しください。続く場合は担当者に連絡してください。',
    nextAction: 'RETRY',
  },
  PERSIST_FAILED: {
    source: ['api'],
    httpStatus: 500,
    category: 'SYSTEM',
    userMessage: '判定結果を保存できなかったため、結果を表示できません。もう一度お試しください。',
    nextAction: 'RETRY',
  },
  AI_TIMEOUT: {
    source: ['api'],
    httpStatus: 504,
    category: 'RETRYABLE',
    userMessage: '読み取りに時間がかかりすぎました。もう一度お試しください。',
    nextAction: 'RETRY',
  },
  AI_RATE_LIMITED: {
    source: ['api'],
    httpStatus: 503,
    category: 'RETRYABLE',
    userMessage: '読み取りサービスが混み合っています。少し待ってから、もう一度お試しください。',
    nextAction: 'RETRY',
  },
  AI_OVERLOADED: {
    source: ['api'],
    httpStatus: 503,
    category: 'RETRYABLE',
    userMessage: '読み取りサービスが混み合っています。少し待ってから、もう一度お試しください。',
    nextAction: 'RETRY',
  },
  AI_UNAVAILABLE: {
    source: ['api'],
    httpStatus: 502,
    category: 'SYSTEM',
    userMessage:
      '読み取りサービスに接続できません。少し待ってから、もう一度お試しください。続く場合は担当者に連絡してください。',
    nextAction: 'RETRY',
  },
  AI_AUTH: {
    source: ['api'],
    httpStatus: 502,
    category: 'CONFIG',
    userMessage: '読み取りサービスの設定に不備があります。担当者に連絡してください。',
    nextAction: 'BACK_TO_START',
  },
  AI_BAD_REQUEST: {
    source: ['api'],
    httpStatus: 502,
    category: 'CONFIG',
    userMessage: '読み取りサービスへの依頼に不備があります。担当者に連絡してください。',
    nextAction: 'BACK_TO_START',
  },
  INSPECTION_TIMEOUT: {
    source: ['api'],
    httpStatus: 504,
    category: 'RETRYABLE',
    userMessage: '判定が時間内に終わりませんでした。もう一度お試しください。',
    nextAction: 'RETRY',
  },
  SYS_ABANDONED: {
    source: ['api'],
    httpStatus: null,
    category: 'SYSTEM',
    userMessage: '判定が途中で止まりました。',
    nextAction: 'NONE',
  },
  SYS_UNEXPECTED: {
    source: ['web', 'api'],
    httpStatus: 500,
    category: 'SYSTEM',
    userMessage:
      '想定外のエラーが発生しました。最初からやり直してください。続く場合は担当者に連絡してください。',
    nextAction: 'BACK_TO_START',
  },
} as const satisfies Record<string, ErrorDefinition>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export const ERROR_CODES = Object.keys(ERROR_CATALOG) as ErrorCode[];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ERROR_CATALOG, value);
}

export function getErrorDefinition(code: ErrorCode): ErrorDefinition {
  return ERROR_CATALOG[code];
}

/** 開発者への通知対象か（docs/error-handling.md 5.2） */
export function shouldNotify(code: ErrorCode): boolean {
  const {category} = ERROR_CATALOG[code];
  return category === 'SYSTEM' || category === 'CONFIG';
}

/** API・edge が返すエラー応答の本体（すべてのエラー応答はこの形） */
export interface ErrorResponseBody {
  error: {
    code: ErrorCode;
    category: ErrorCategory;
    message: string;
    requestId: string | null;
    inspectionId: string | null;
  };
}

/**
 * アプリ内で投げるエラー。catch した側は必ずこのコードで扱いを決める。
 * cause には元の例外を入れる（ログには message と name だけを出す）。
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly detail: string | undefined;

  constructor(code: ErrorCode, options?: {detail?: string; cause?: unknown}) {
    super(options?.detail ? `${code}: ${options.detail}` : code, {cause: options?.cause});
    this.name = 'AppError';
    this.code = code;
    this.detail = options?.detail;
  }

  get category(): ErrorCategory {
    return ERROR_CATALOG[this.code].category;
  }
}

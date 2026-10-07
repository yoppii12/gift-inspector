/**
 * タイムアウトの予算（ミリ秒）。外側ほど長くする。
 * docs/error-handling.md 3.2 と infra/openresty の設定値と一致させること。
 * 暫定値。10/9 の実API計測で確定する。
 */
export const TIMEOUTS_MS = {
  /** AI 1試行 */
  aiAttempt: 30_000,
  /** 一時障害時の再試行前の待機 */
  aiRetryBackoff: 2_000,
  /** retry-after ヘッダーをこの値まで尊重する */
  aiRetryAfterMax: 5_000,
  /** API の検品処理全体 */
  inspectionTotal: 65_000,
  /** Fastify requestTimeout */
  serverRequest: 70_000,
  /** OpenResty proxy_read_timeout（参照用。設定は infra/openresty） */
  edgeProxyRead: 75_000,
  /** フロントの送信 */
  clientRequest: 85_000,
  /** PENDING のまま放置された検品を SYS_ABANDONED とみなす経過時間 */
  pendingAbandoned: 5 * 60_000,
} as const;

/** 1検品あたりのAI試行の上限 */
export const AI_MAX_ATTEMPTS = 2;

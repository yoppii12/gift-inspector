import {type ClientError, request, shouldReport, toClientError} from './api';

/**
 * web で起きたエラーを API に送る（開発者がログ・通知で気づけるように）。
 * 送信の失敗は画面表示に影響させず、コンソールに残す。
 */
export function reportClientError(error: unknown, options: {force?: boolean} = {}): void {
  const err: ClientError = toClientError(error);
  if (!options.force && !shouldReport(err)) return;

  const cause = err.cause instanceof Error ? err.cause : undefined;
  request('/api/client-errors', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      code: err.code,
      message: (err.detail ?? cause?.message ?? err.message).slice(0, 2_000),
      stack: (cause?.stack ?? err.stack)?.slice(0, 8_000),
      inspectionId: err.inspectionId,
      requestId: err.requestId,
      url: location.href.slice(0, 500),
      userAgent: navigator.userAgent.slice(0, 500),
    }),
    timeoutMs: 10_000,
  }).catch((sendErr: unknown) => {
    console.error('クライアントエラーの送信に失敗しました', err, sendErr);
  });
}

/** 画面のどこでも捕まらなかった例外を拾う（最上位の ErrorBoundary と併用） */
export function installGlobalErrorHandlers(onError: (err: ClientError) => void): void {
  window.addEventListener('error', event => {
    const err = toClientError(event.error ?? event.message);
    reportClientError(err, {force: true});
    onError(err);
  });
  window.addEventListener('unhandledrejection', event => {
    const err = toClientError(event.reason);
    reportClientError(err, {force: true});
    onError(err);
  });
}

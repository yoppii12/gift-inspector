import {ERROR_CATALOG, type ErrorCode} from '@gift-inspector/shared';

/**
 * OpenResty が自分で返すエラー（API に届く前・API が応答しないとき）を、
 * API と同じ JSON 形式（ErrorResponseBody）で返すための設定を生成する。
 * 文言はエラーカタログから取るので、手で書き写さない。
 */
export const EDGE_ERRORS: ReadonlyArray<{status: number; code: ErrorCode}> = [
  {status: 413, code: 'UPLOAD_TOO_LARGE'},
  {status: 429, code: 'RATE_LIMITED'},
  {status: 502, code: 'UPSTREAM_UNAVAILABLE'},
  {status: 503, code: 'UPSTREAM_UNAVAILABLE'},
  {status: 504, code: 'UPSTREAM_TIMEOUT'},
];

export const ERROR_PAGES_PATH = 'infra/openresty/snippets/error-pages.conf';
export const ERROR_LOCATIONS_PATH = 'infra/openresty/snippets/error-locations.conf';

const HEADER = `# このファイルは apps/api/scripts/gen-nginx-error-pages.ts が生成する。直接編集しないこと。
# 再生成: npm run gen:nginx -w @gift-inspector/api
`;

function locationName(status: number): string {
  return `@edge_error_${status}`;
}

function body(code: ErrorCode): string {
  const def = ERROR_CATALOG[code];
  if (/["'\\$]/.test(def.userMessage)) {
    throw new Error(`${code} の文言に nginx の文字列で扱えない文字が含まれています`);
  }
  // $request_id は nginx が展開する（API のログ・アクセスログと突き合わせられる）
  return `{"error":{"code":"${code}","category":"${def.category}","message":"${def.userMessage}","requestId":"$request_id","inspectionId":null}}`;
}

/** location /api/ の中で include する */
export function renderErrorPages(): string {
  return (
    HEADER +
    EDGE_ERRORS.map(e => `error_page ${e.status} ${locationName(e.status)};`).join('\n') +
    '\n'
  );
}

/** server 直下で include する（named location） */
export function renderErrorLocations(): string {
  return (
    HEADER +
    EDGE_ERRORS.map(
      e => `location ${locationName(e.status)} {
  default_type application/json;
  return ${e.status} '${body(e.code)}';
}`
    ).join('\n\n') +
    '\n'
  );
}

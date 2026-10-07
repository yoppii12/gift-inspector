import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

import {ERROR_CATALOG} from '@gift-inspector/shared';
import {describe, expect, it} from 'vitest';

import {
  EDGE_ERRORS,
  ERROR_LOCATIONS_PATH,
  ERROR_PAGES_PATH,
  renderErrorLocations,
  renderErrorPages,
} from '../src/edge/error-pages';

const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${p}`, import.meta.url)), 'utf8');

describe('OpenResty のエラー応答', () => {
  it('コミット済みの設定がカタログから生成したものと一致する（ずれたら npm run gen:nginx）', () => {
    expect(read(ERROR_PAGES_PATH)).toBe(renderErrorPages());
    expect(read(ERROR_LOCATIONS_PATH)).toBe(renderErrorLocations());
  });

  it.each(EDGE_ERRORS)('$status は $code の JSON を返し、web 側で解釈できる', ({status, code}) => {
    const block = renderErrorLocations()
      .split('location ')
      .find(b => b.startsWith(`@edge_error_${status} `));
    expect(block).toBeDefined();
    const json = /return \d+ '(.*)';/.exec(block ?? '')?.[1] ?? '';
    const parsed = JSON.parse(json.replace('$request_id', 'req-1')) as {
      error: {code: string; message: string};
    };
    expect(parsed.error.code).toBe(code);
    expect(parsed.error.message).toBe(ERROR_CATALOG[code].userMessage);
  });

  it('サイト設定が生成したスニペットを読み込んでいる', () => {
    const site = read('infra/openresty/gift-inspector.conf');
    expect(site).toContain('snippets/error-pages.conf');
    expect(site).toContain('snippets/error-locations.conf');
    expect(site).toContain('proxy_intercept_errors off');
  });

  it('タイムアウト値が設計（shared/timeouts.ts）と一致する', async () => {
    const {TIMEOUTS_MS} = await import('@gift-inspector/shared');
    const site = read('infra/openresty/gift-inspector.conf');
    expect(site).toContain(`proxy_read_timeout ${TIMEOUTS_MS.edgeProxyRead / 1000}s;`);
  });

  it('add_header を持つ location はセキュリティヘッダーも読み込む（nginx の継承の落とし穴）', () => {
    const site = read('infra/openresty/gift-inspector.conf');
    const locations = site.split(/\n\s*location /).slice(1);
    for (const loc of locations) {
      const bodyText = loc.slice(0, loc.indexOf('\n  }'));
      if (/^\s*add_header /m.test(bodyText)) {
        expect(bodyText, loc.split('\n')[0]).toContain('security-headers.conf');
      }
    }
  });
});

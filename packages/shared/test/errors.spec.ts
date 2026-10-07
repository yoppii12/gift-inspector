import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';

import {AppError, ERROR_CATALOG, ERROR_CODES, isErrorCode, shouldNotify} from '../src';

const DOC_PATH = fileURLToPath(new URL('../../../docs/error-handling.md', import.meta.url));

interface DocRow {
  code: string;
  source: string[];
  httpStatus: string;
  category: string;
}

/** docs/error-handling.md 4章のカタログ表を読み取る */
function readCatalogTable(): DocRow[] {
  const doc = readFileSync(DOC_PATH, 'utf8');
  const start = doc.indexOf('## 4. エラーカタログ');
  const end = doc.indexOf('## 5.', start);
  expect(start, '4章が見つからない').toBeGreaterThan(-1);
  return doc
    .slice(start, end)
    .split('\n')
    .filter(line => /^\| `[A-Z_]+` \|/.test(line))
    .map(line => {
      // 先頭は行頭の空要素
      const [, code = '', source = '', httpStatus = '', category = ''] = line
        .split('|')
        .map(c => c.trim());
      return {code: code.replace(/`/g, ''), source: source.split('/'), httpStatus, category};
    });
}

describe('エラーカタログ', () => {
  const rows = readCatalogTable();

  it('設計書の表と errors.ts のコードが完全に一致する', () => {
    expect(rows.map(r => r.code).sort()).toEqual([...ERROR_CODES].sort());
  });

  it.each(rows)('$code: 分類・発生源・HTTPステータスが設計書と一致する', row => {
    expect(isErrorCode(row.code)).toBe(true);
    if (!isErrorCode(row.code)) return;
    const def = ERROR_CATALOG[row.code];
    expect(def.category).toBe(row.category);
    expect([...def.source].sort()).toEqual([...row.source].sort());
    if (def.httpStatus === null) {
      expect(row.httpStatus).toBe('–');
    } else {
      // 設計書側は "502/503" のように複数書くことがある。先頭が errors.ts の値
      expect(row.httpStatus.split('/')[0]).toBe(String(def.httpStatus));
    }
  });

  it.each(ERROR_CODES)('%s: 利用者向けの文言と次の操作が定義されている', code => {
    const def = ERROR_CATALOG[code];
    expect(def.userMessage.length).toBeGreaterThan(0);
    expect(def.nextAction).toBeTruthy();
    // 作業者向けの文言に技術用語を出さない
    expect(def.userMessage).not.toMatch(/API|推論|サーバーエラー|exception/i);
  });

  it('SYSTEM と CONFIG は通知対象、それ以外は通知しない', () => {
    for (const code of ERROR_CODES) {
      const {category} = ERROR_CATALOG[code];
      expect(shouldNotify(code)).toBe(category === 'SYSTEM' || category === 'CONFIG');
    }
  });

  it('isErrorCode は未知の値を拒否する', () => {
    expect(isErrorCode('NOT_A_CODE')).toBe(false);
    expect(isErrorCode('toString')).toBe(false);
    expect(isErrorCode(undefined)).toBe(false);
  });

  it('AppError はコードと元の例外を保持する', () => {
    const cause = new Error('ENOSPC');
    const err = new AppError('STORAGE_WRITE_FAILED', {detail: 'disk full', cause});
    expect(err.code).toBe('STORAGE_WRITE_FAILED');
    expect(err.category).toBe('SYSTEM');
    expect(err.cause).toBe(cause);
    expect(err.message).toBe('STORAGE_WRITE_FAILED: disk full');
  });
});

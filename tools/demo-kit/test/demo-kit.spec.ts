import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import jsQR from 'jsqr';
import {PNG} from 'pngjs';
import {describe, expect, it} from 'vitest';

import {type DemoOrder, loadDemoOrders, validateOrder} from '../src/data';
import {printedContent, renderNoshiKitPdf} from '../src/noshi';
import {renderQrPng} from '../src/qr';
import {SEED_SQL_RELATIVE_PATH, renderSeedSql} from '../src/seed-sql';

const orders = loadDemoOrders();

describe('デモ用オーダーの元データ', () => {
  it('5件あり、OK と意図的な NG の両方を含む', () => {
    expect(orders).toHaveLength(5);
    expect(orders.filter(o => o.expected === 'OK').length).toBeGreaterThan(0);
    expect(orders.filter(o => o.expected === 'NG').length).toBeGreaterThan(0);
  });

  it('NG ケースが主判定の3項目（表書き・宛名・カード）をすべて網羅する', () => {
    const ng = orders.filter(o => o.expected === 'NG');
    const r = (o: DemoOrder) => o.registered;
    expect(ng.some(o => o.printed.omotegaki !== r(o).omotegaki)).toBe(true);
    expect(ng.some(o => o.printed.atena !== r(o).atena)).toBe(true);
    expect(ng.some(o => o.printed.cardText !== r(o).cardText)).toBe(true);
  });

  it('コミット済みの SQL シードが元データと一致する（ずれたら npm run demo-kit で再生成）', () => {
    const committed = readFileSync(
      fileURLToPath(new URL(`../../../${SEED_SQL_RELATIVE_PATH}`, import.meta.url)),
      'utf8'
    );
    expect(committed).toBe(renderSeedSql(orders));
  });
});

describe('元データの矛盾検出', () => {
  const base = orders[0] as DemoOrder;
  const clone = (): DemoOrder => structuredClone(base);

  it('想定OKなのに印刷内容が違えば検出する', () => {
    const o = clone();
    o.printed.atena = '別人 太郎';
    expect(validateOrder(o).join()).toMatch(/想定OK/);
  });

  it('想定NGなのに印刷内容が同じなら検出する', () => {
    const o = clone();
    o.expected = 'NG';
    expect(validateOrder(o).join()).toMatch(/想定NG/);
  });

  it('カード必須なのに文面がなければ検出する', () => {
    const o = clone();
    o.registered.cardText = null;
    o.printed.cardText = null;
    expect(validateOrder(o).join()).toMatch(/カード/);
  });

  it('のしもカードも不要なら検出する', () => {
    const o = clone();
    Object.assign(o.registered, {
      noshiRequired: false,
      cardRequired: false,
      omotegaki: null,
      atena: null,
      noshiType: null,
      cardText: null,
    });
    expect(validateOrder(o).join()).toMatch(/のしもカードも不要/);
  });
});

describe('QR コード', () => {
  it.each(orders.map(o => o.orderCode))('%s: 生成した PNG を読み取ると同じ値になる', async code => {
    const png = PNG.sync.read(await renderQrPng(code));
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    expect(decoded?.data).toBe(code);
  });
});

describe('SQL の生成', () => {
  it('シングルクォートとバックスラッシュをエスケープする', () => {
    const o = structuredClone(orders[0] as DemoOrder);
    o.registered.cardText = "It's \\ ok";
    o.printed.cardText = o.registered.cardText;
    expect(renderSeedSql([o])).toContain("'It''s \\\\ ok'");
  });
});

describe('擬似のし・カード', () => {
  it('印刷するのは現物の内容（printed）で、意図的 NG のオーダーは登録内容と違う文字になる', () => {
    const byCode = Object.fromEntries(orders.map(o => [o.orderCode, o]));
    const c3 = printedContent(byCode['GIFT-DEMO-003'] as DemoOrder);
    const c4 = printedContent(byCode['GIFT-DEMO-004'] as DemoOrder);
    const c5 = printedContent(byCode['GIFT-DEMO-005'] as DemoOrder);
    expect(c3.omotegaki).toBe('御祝');
    expect(c3.omotegaki).not.toBe(byCode['GIFT-DEMO-003']?.registered.omotegaki);
    expect(c4.atena).toBe('渡部 直樹');
    expect(c5.cardText).toContain('ご多幸');
  });

  it('印刷物に載せる情報は、のし・カードの現物の内容とオーダー番号だけ（登録内容・想定結果は載せない）', () => {
    for (const o of orders) {
      const c = printedContent(o);
      expect(Object.keys(c).sort()).toEqual([
        'atena',
        'cardText',
        'hasNoshi',
        'mizuhiki',
        'omotegaki',
        'orderCode',
      ]);
      const text = JSON.stringify(c);
      expect(text).not.toContain(o.note);
      expect(text).not.toContain('想定');
    }
  });

  it('5オーダー分の PDF（1オーダー1ページ）を出力する', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'noshi-')), 'kit.pdf');
    const pages = await renderNoshiKitPdf(orders, out);
    const pdf = readFileSync(out);
    expect(pages).toBe(5);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(5);
    // 日本語フォント（3種）の埋め込みに 15 秒前後かかる
  }, 60_000);
});

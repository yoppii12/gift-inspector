/**
 * デモ用データ一式を生成する。
 *   npm run demo-kit                 SQL シード + QR（PNG）+ 印刷用 QR 一覧（PDF）+ 擬似のし・カード（PDF）
 *   npm run seed-sql -w @gift-inspector/demo-kit   SQL シードのみ
 * 出力先: db/seeds/001_demo_orders.sql、tools/demo-kit/out/
 */
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {loadDemoOrders} from './data';
import {renderNoshiKitPdf} from './noshi';
import {renderQrPng, renderQrSheetPdf} from './qr';
import {SEED_SQL_RELATIVE_PATH, renderSeedSql} from './seed-sql';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const OUT_DIR = fileURLToPath(new URL('../out/', import.meta.url));

function yymmdd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

async function main(): Promise<void> {
  const orders = loadDemoOrders();

  const seedPath = join(REPO_ROOT, SEED_SQL_RELATIVE_PATH);
  writeFileSync(seedPath, renderSeedSql(orders));
  console.log(`SQL シード: ${SEED_SQL_RELATIVE_PATH}（${orders.length}件）`);
  if (process.argv.includes('--seed-sql-only')) return;

  const now = new Date();
  const qrDir = join(OUT_DIR, 'qr');
  mkdirSync(qrDir, {recursive: true});
  for (const order of orders) {
    writeFileSync(join(qrDir, `${order.orderCode}.png`), await renderQrPng(order.orderCode));
  }
  console.log(`QR（PNG）: ${qrDir}`);

  const pdfPath = join(OUT_DIR, `${yymmdd(now)}_デモ用QRコード一覧.pdf`);
  const printedOn = now.toLocaleDateString('ja-JP', {timeZone: 'Asia/Tokyo'});
  await renderQrSheetPdf(orders, pdfPath, printedOn);
  console.log(`印刷用 PDF: ${pdfPath}`);

  const noshiPath = join(OUT_DIR, `${yymmdd(now)}_擬似のし・カード.pdf`);
  const pages = await renderNoshiKitPdf(orders, noshiPath);
  console.log(`擬似のし・カード PDF: ${noshiPath}（${pages}ページ）`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

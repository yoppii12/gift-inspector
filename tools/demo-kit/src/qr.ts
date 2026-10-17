import {createWriteStream} from 'node:fs';
import {fileURLToPath} from 'node:url';

import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

import type {DemoOrder} from './data';

/** 組織のデザインルール: ベース #FFFFFF / メイン #171A31（＋濃淡）。アクセントは使わない */
const COLOR = {
  base: '#FFFFFF',
  main: '#171A31',
  main60: '#737583',
  main15: '#E0E1E4',
} as const;

const FONT_PATH = fileURLToPath(
  new URL(
    '../../../node_modules/@fontsource/noto-sans-jp/files/noto-sans-jp-japanese-500-normal.woff',
    import.meta.url
  )
);
const FONT_REGULAR_PATH = FONT_PATH.replace('-500-', '-400-');

export async function renderQrPng(orderCode: string): Promise<Buffer> {
  return QRCode.toBuffer(orderCode, {
    errorCorrectionLevel: 'M',
    margin: 4,
    width: 600,
    color: {dark: COLOR.main, light: COLOR.base},
  });
}

/** A4 1枚に QR を並べた印刷用 PDF を書き出す（2列×3段） */
export async function renderQrSheetPdf(
  orders: DemoOrder[],
  outPath: string,
  printedOn: string
): Promise<void> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 40,
    info: {Title: 'デモ用オーダー QRコード一覧'},
  });
  const done = new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(outPath);
    stream.on('finish', resolve);
    stream.on('error', reject);
    doc.on('error', reject);
    doc.pipe(stream);
  });

  doc.registerFont('jp', FONT_PATH);
  doc.registerFont('jp-regular', FONT_REGULAR_PATH);

  const pageW = doc.page.width;
  const margin = 40;
  const cols = 2;
  const rowsPerPage = 3;
  const headerH = 56;
  const cellW = (pageW - margin * 2) / cols;
  const cellH = (doc.page.height - margin * 2 - headerH - 20) / rowsPerPage;
  // 実物のオーダーは並べる物まで載せるので、QR を少し小さくして文字の場所を空ける
  const qrSize = 104;

  const drawHeader = () => {
    doc
      .font('jp')
      .fontSize(16)
      .fillColor(COLOR.main)
      .text('デモ用オーダー QRコード一覧', margin, margin);
    doc
      .font('jp-regular')
      .fontSize(9)
      .fillColor(COLOR.main60)
      .text(`印刷日 ${printedOn} / QRコードの値はオーダーコードです`, margin, margin + 24);
  };

  drawHeader();
  for (const [i, order] of orders.entries()) {
    const slot = i % (cols * rowsPerPage);
    if (i > 0 && slot === 0) {
      doc.addPage();
      drawHeader();
    }
    const x = margin + (slot % cols) * cellW;
    const y = margin + headerH + Math.floor(slot / cols) * cellH;

    doc
      .lineWidth(0.6)
      .strokeColor(COLOR.main15)
      .rect(x + 4, y + 4, cellW - 8, cellH - 8)
      .stroke();
    doc.image(await renderQrPng(order.orderCode), x + 16, y + 14, {width: qrSize});

    const r = order.registered;
    const textX = x + 16;
    let textY = y + 14 + qrSize + 4;
    doc.font('jp').fontSize(12).fillColor(COLOR.main).text(order.orderCode, textX, textY);
    textY += 18;
    const lines = [
      r.noshiRequired
        ? `のし：${[r.omotegaki, r.noshiType, r.noshiSize].filter(Boolean).join('／')}`
        : 'のし：なし',
      [
        r.noshiRequired ? `名入れ：${r.atena ?? 'なし'}` : null,
        `カード：${r.cardRequired ? 'あり' : 'なし'}`,
      ]
        .filter(Boolean)
        .join('　'),
      r.bagType !== null || r.carrierBag !== null
        ? [
            r.bagType !== null ? `ラッピング：${r.bagType}` : null,
            r.carrierBag !== null ? `手提げ袋：${r.carrierBag ? 'あり' : 'なし'}` : null,
          ]
            .filter(Boolean)
            .join('　')
        : null,
      order.kind === 'real' ? `並べる物：${order.setup ?? ''}` : null,
    ].filter((l): l is string => l !== null);
    doc.font('jp-regular').fontSize(8.5).fillColor(COLOR.main60);
    const textW = cellW - 32;
    for (const line of lines) {
      doc.text(line, textX, textY, {width: textW, lineGap: 1});
      textY += doc.heightOfString(line, {width: textW, lineGap: 1}) + 2;
    }
  }

  doc.end();
  await done;
}

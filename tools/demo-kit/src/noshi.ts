/**
 * 擬似のし・メッセージカードの印刷用 PDF（実物サンプル受領までの社内検証用、#20）。
 * 印刷する内容は demo_orders.json の printed（現物の内容）。意図的 NG のオーダーは登録内容と違う文字になる。
 *
 * 印刷物には登録内容・想定結果を一切載せない（写真に写り込むと AI に正解の手がかりを与えるため。
 * CLAUDE.md 2章「読取と照合の分離」）。載せるのはオーダー番号と切り取り線だけ。
 */
import {createWriteStream} from 'node:fs';
import {fileURLToPath} from 'node:url';

import PDFDocument from 'pdfkit';

import type {DemoOrder} from './data';

const mm = (v: number) => (v * 72) / 25.4;

const font = (pkg: string, file: string) =>
  fileURLToPath(new URL(`../../../node_modules/@fontsource/${pkg}/files/${file}`, import.meta.url));

/** 毛筆体（のしの表書き・名入れ）と明朝体（カードの印刷文字）。どちらも OFL-1.1 */
export const FONTS = {
  brush: font('yuji-syuku', 'yuji-syuku-japanese-400-normal.woff'),
  mincho: font('shippori-mincho', 'shippori-mincho-japanese-500-normal.woff'),
  label: font('noto-sans-jp', 'noto-sans-jp-japanese-400-normal.woff'),
};

const INK = '#1a1a1a';
const RED = '#c8102e';
const GUIDE = '#9d9ea8';

/** 印刷する内容（現物）。登録内容（registered）ではなく printed を使う */
export function printedContent(order: DemoOrder) {
  return {
    orderCode: order.orderCode,
    hasNoshi: order.registered.noshiRequired,
    omotegaki: order.printed.omotegaki,
    atena: order.printed.atena,
    mizuhiki: order.printed.noshiType,
    cardText: order.printed.cardText,
  };
}

type Doc = PDFKit.PDFDocument;

/**
 * 縦書き（1文字ずつ中央に置く。空白は半文字分あける）。
 * 文字数が多いときは maxHeight に収まるよう文字を小さくする（重ならないように）。
 */
function verticalText(
  doc: Doc,
  text: string,
  centerX: number,
  top: number,
  size: number,
  maxHeight: number
) {
  const chars = [...text];
  const units = chars.reduce((n, c) => n + (c.trim() ? 1 : 0.5), 0);
  const fitted = Math.min(size, maxHeight / Math.max(1, units) / 1.08);
  const step = fitted * 1.08;
  doc.fontSize(fitted);
  let y = top;
  for (const ch of chars) {
    if (!ch.trim()) {
      y += step * 0.5;
      continue;
    }
    const w = doc.widthOfString(ch);
    doc.text(ch, centerX - w / 2, y, {lineBreak: false});
    y += step;
  }
}

/** 水引（紅白の帯＋蝶結びの輪、または結び切りの結び目） */
function mizuhiki(doc: Doc, x: number, y: number, width: number, type: string | null) {
  const lines = 5;
  const gap = mm(1.4);
  for (let i = 0; i < lines; i++) {
    doc
      .lineWidth(mm(0.9))
      .strokeColor(i % 2 === 0 ? RED : '#e8e8e8')
      .moveTo(x, y + i * gap)
      .lineTo(x + width, y + i * gap)
      .stroke();
  }
  const cx = x + width / 2;
  const cy = y + ((lines - 1) * gap) / 2;
  doc.lineWidth(mm(1.1)).strokeColor(RED);
  if (type === '蝶結び') {
    // 左右の輪と、下に垂れる2本の足
    doc.ellipse(cx - mm(9), cy, mm(9), mm(6)).stroke();
    doc.ellipse(cx + mm(9), cy, mm(9), mm(6)).stroke();
    doc
      .moveTo(cx - mm(2), cy)
      .lineTo(cx - mm(10), cy + mm(22))
      .stroke();
    doc
      .moveTo(cx + mm(2), cy)
      .lineTo(cx + mm(10), cy + mm(22))
      .stroke();
  } else {
    // 結び切り: 輪を作らず、交差させて固く結んだ形
    doc
      .moveTo(cx - mm(7), cy - mm(6))
      .lineTo(cx + mm(7), cy + mm(6))
      .stroke();
    doc
      .moveTo(cx + mm(7), cy - mm(6))
      .lineTo(cx - mm(7), cy + mm(6))
      .stroke();
    doc.circle(cx, cy, mm(3)).fillAndStroke(RED, RED);
    doc
      .moveTo(cx - mm(3), cy + mm(2))
      .lineTo(cx - mm(6), cy + mm(18))
      .stroke();
    doc
      .moveTo(cx + mm(3), cy + mm(2))
      .lineTo(cx + mm(6), cy + mm(18))
      .stroke();
  }
}

function cutLine(doc: Doc, x: number, y: number, w: number, h: number) {
  doc
    .save()
    .lineWidth(0.5)
    .strokeColor(GUIDE)
    .dash(4, {space: 3})
    .rect(x, y, w, h)
    .stroke()
    .undash()
    .restore();
}

function label(doc: Doc, text: string, x: number, y: number) {
  doc.font('label').fontSize(8).fillColor(GUIDE).text(text, x, y, {lineBreak: false});
}

/** のし紙（100mm × 240mm）: 上段に表書き、中央に水引、下段に名入れ */
function drawNoshi(doc: Doc, c: ReturnType<typeof printedContent>, x: number, y: number) {
  const w = mm(100);
  const h = mm(240);
  cutLine(doc, x, y, w, h);
  doc.rect(x, y, w, h).fill('#fdfcf8');
  const cx = x + w / 2;
  doc.font('brush').fillColor(INK);
  verticalText(doc, c.omotegaki ?? '', cx, y + mm(14), mm(30), mm(84));
  mizuhiki(doc, x, y + mm(108), w, c.mizuhiki);
  // 水引で塗り色が変わるため、文字の色を戻す
  doc.font('brush').fillColor(INK);
  verticalText(doc, c.atena ?? '', cx, y + mm(140), mm(20), mm(92));
  label(doc, `${c.orderCode} のし（点線で切り取って撮影）`, x, y + h + mm(2));
}

/** メッセージカード（80mm × 120mm、横書きの印刷文字） */
function drawCard(doc: Doc, c: ReturnType<typeof printedContent>, x: number, y: number) {
  const w = mm(80);
  const h = mm(120);
  cutLine(doc, x, y, w, h);
  doc.rect(x, y, w, h).fill('#fffefa');
  doc
    .font('mincho')
    .fontSize(mm(4.6))
    .fillColor(INK)
    .text(c.cardText ?? '', x + mm(8), y + mm(18), {width: w - mm(16), lineGap: mm(3)});
  label(doc, `${c.orderCode} カード（点線で切り取って撮影）`, x, y + h + mm(2));
}

/** A4 縦1枚に1オーダー分（のし＋カード） */
export async function renderNoshiKitPdf(orders: DemoOrder[], outPath: string): Promise<number> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 0,
    autoFirstPage: false,
    info: {Title: '擬似のし・メッセージカード'},
  });
  const done = new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(outPath);
    stream.on('finish', resolve);
    stream.on('error', reject);
    doc.on('error', reject);
    doc.pipe(stream);
  });
  doc.registerFont('brush', FONTS.brush);
  doc.registerFont('mincho', FONTS.mincho);
  doc.registerFont('label', FONTS.label);

  let pages = 0;
  for (const order of orders) {
    const c = printedContent(order);
    doc.addPage();
    pages++;
    // A4（210mm）に収める: のし 12〜112mm、カード 120〜200mm
    if (c.hasNoshi) drawNoshi(doc, c, mm(12), mm(22));
    if (c.cardText) drawCard(doc, c, mm(120), mm(22));
    label(doc, `擬似のし・カード（社内検証用） ${c.orderCode}`, mm(12), mm(10));
  }
  doc.end();
  await done;
  return pages;
}

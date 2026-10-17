import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import jpeg from 'jpeg-js';

/** 検査を通る最小の JPEG（SOI・APP0・SOF0 で 1600×1200・EOI） */
export function fakeJpeg(extraBytes = 64): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([
      0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00,
      0x01, 0x00, 0x00,
    ]),
    Buffer.from([
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0xb0, 0x06, 0x40, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11,
      0x01, 0x03, 0x11, 0x01,
    ]),
    Buffer.alloc(extraBytes, 0x11),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** HEIC の先頭（ftyp heic） */
export function fakeHeic(): Buffer {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from('ftypheic', 'latin1'),
    Buffer.alloc(64),
  ]);
}

export interface MultipartPart {
  name: string;
  value: string | Buffer;
  filename?: string;
  contentType?: string;
}

/** app.inject 用の multipart 本文を作る */
export function multipart(parts: MultipartPart[]): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = '----gift-inspector-test-boundary';
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const disposition = p.filename
      ? `form-data; name="${p.name}"; filename="${p.filename}"`
      : `form-data; name="${p.name}"`;
    const type = p.filename ? `\r\nContent-Type: ${p.contentType ?? 'image/jpeg'}` : '';
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}${type}\r\n\r\n`));
    chunks.push(typeof p.value === 'string' ? Buffer.from(p.value) : p.value);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: {'content-type': `multipart/form-data; boundary=${boundary}`},
  };
}

export function inspectionForm(inspectionId: string, orderCode: string, image: Buffer) {
  return multipart([
    {name: 'inspection_id', value: inspectionId},
    {name: 'order_code', value: orderCode},
    {name: 'image', value: image, filename: 'photo.jpg'},
  ]);
}

export interface ManualExpectedForm {
  omotegaki?: string;
  atena?: string;
  cardText?: string;
  noshiType?: string;
  noshiRequired?: string;
  cardRequired?: string;
}

/** 開発用の手入力モードの送信内容（正解の項目は image より前） */
export function manualForm(inspectionId: string, image: Buffer, e: ManualExpectedForm) {
  return multipart([
    {name: 'inspection_id', value: inspectionId},
    {name: 'order_code', value: 'MANUAL'},
    {name: 'expected_omotegaki', value: e.omotegaki ?? ''},
    {name: 'expected_atena', value: e.atena ?? ''},
    {name: 'expected_card_text', value: e.cardText ?? ''},
    {name: 'expected_noshi_type', value: e.noshiType ?? ''},
    {name: 'noshi_required', value: e.noshiRequired ?? 'true'},
    {name: 'card_required', value: e.cardRequired ?? 'true'},
    {name: 'image', value: image, filename: 'photo.jpg'},
  ]);
}

export function tempDir(prefix = 'gi-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** のし紙の長短の計測（#55）のテスト用: グレーの背景に白い長方形（回転可）を描いた JPEG */
export interface Sheet {
  cx: number;
  cy: number;
  long: number;
  short: number;
  /** 度 */
  angle?: number;
  /** 紙の中に描く濃い印（文字・水引の代わり） */
  marks?: boolean;
  rgb?: [number, number, number];
}

/** 1600×1200 のグレーの背景に、白い長方形（回転可）を描いた JPEG */
export function photo(sheets: Sheet[], width = 1600, height = 1200): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // カーペットのような少しまだらなグレー
      const noise = ((x * 7 + y * 13) % 17) - 8;
      let rgb: [number, number, number] = [96 + noise, 98 + noise, 104 + noise];
      for (const s of sheets) {
        const t = ((s.angle ?? 0) * Math.PI) / 180;
        const dx = x - s.cx;
        const dy = y - s.cy;
        const u = dx * Math.cos(t) + dy * Math.sin(t);
        const v = -dx * Math.sin(t) + dy * Math.cos(t);
        if (Math.abs(u) <= s.long / 2 && Math.abs(v) <= s.short / 2) {
          rgb = s.rgb ?? [244, 243, 240];
          // 中央付近に水引の線と、表書きの文字の代わりの濃い四角
          if (s.marks && (Math.abs(v) < 3 || (Math.abs(u) < 8 && v < -10 && v > -40))) {
            rgb = [60, 60, 60];
          }
        }
      }
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
      data[i + 3] = 255;
    }
  }
  return jpeg.encode({data, width, height}, 85).data;
}

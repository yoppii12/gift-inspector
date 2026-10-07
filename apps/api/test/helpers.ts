import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

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

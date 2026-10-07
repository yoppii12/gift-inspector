/**
 * 撮影画像の検査と保存。
 * 画像は端末側で長辺 1600px の JPEG に再エンコードしてから送られる前提（D8）。
 * サーバーでは中身をデコードせず（ネイティブ依存を避ける）、形式・途中切れ・サイズだけを検査する。
 */
import {createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {AppError} from '@gift-inspector/shared';

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

export interface InspectedImage {
  mime: ImageMime;
  ext: 'jpg' | 'png' | 'webp';
  width: number | null;
  height: number | null;
}

const HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'mif1',
  'msf1',
  'avif',
]);

/** 先頭・末尾のバイト列で形式を判定する。対応外は IMAGE_UNSUPPORTED_TYPE、壊れていれば IMAGE_INVALID */
export function inspectImage(buf: Buffer): InspectedImage {
  if (buf.length < 16)
    throw new AppError('IMAGE_INVALID', {detail: `サイズが小さすぎる（${buf.length}B）`});

  // JPEG: FF D8 FF ... FF D9
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    if (!hasJpegEnd(buf))
      throw new AppError('IMAGE_INVALID', {detail: 'JPEG の終端がない（途中で切れている）'});
    return {mime: 'image/jpeg', ext: 'jpg', ...jpegSize(buf)};
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A ... IEND
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (buf.lastIndexOf(Buffer.from('IEND', 'latin1')) < 0) {
      throw new AppError('IMAGE_INVALID', {detail: 'PNG の終端がない（途中で切れている）'});
    }
    return {
      mime: 'image/png',
      ext: 'png',
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
    };
  }
  // WebP: "RIFF" <size> "WEBP"
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    if (buf.readUInt32LE(4) + 8 > buf.length) {
      throw new AppError('IMAGE_INVALID', {
        detail: 'WebP のサイズが不足している（途中で切れている）',
      });
    }
    return {mime: 'image/webp', ext: 'webp', width: null, height: null};
  }
  // HEIC/AVIF: ftyp ボックス
  if (buf.toString('latin1', 4, 8) === 'ftyp' && HEIF_BRANDS.has(buf.toString('latin1', 8, 12))) {
    throw new AppError('IMAGE_UNSUPPORTED_TYPE', {
      detail: `HEIF 形式（${buf.toString('latin1', 8, 12)}）`,
    });
  }
  throw new AppError('IMAGE_UNSUPPORTED_TYPE', {
    detail: `先頭バイト ${buf.subarray(0, 4).toString('hex')}`,
  });
}

function hasJpegEnd(buf: Buffer): boolean {
  // 末尾に余分なバイトが付く端末があるため、最後の 64 バイト以内に EOI があればよい
  const tail = buf.subarray(Math.max(0, buf.length - 64));
  for (let i = tail.length - 2; i >= 0; i--) {
    if (tail[i] === 0xff && tail[i + 1] === 0xd9) return true;
  }
  return false;
}

/** JPEG の SOF マーカーから寸法を読む。読めなければ null（検査には使わない） */
function jpegSize(buf: Buffer): {width: number | null; height: number | null} {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return {width: null, height: null};
    const marker = buf[i + 1] as number;
    const len = buf.readUInt16BE(i + 2);
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return {height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7)};
    i += 2 + len;
  }
  return {width: null, height: null};
}

export interface SavedImage {
  /** IMAGE_DIR からの相対パス */
  relativePath: string;
  sha256: string;
  bytes: number;
}

/**
 * IMAGE_DIR/<YYYY-MM-DD>/<inspectionId>.<ext> に保存する（2027/1末にディレクトリごと消せる）。
 * 失敗は STORAGE_WRITE_FAILED。同名ファイルが既にあれば上書きしない（冪等性はDBで担保する）。
 */
export async function saveImage(
  imageDir: string,
  inspectionId: string,
  buf: Buffer,
  image: InspectedImage,
  now: Date
): Promise<SavedImage> {
  const day = now.toISOString().slice(0, 10);
  const relativePath = join(day, `${inspectionId}.${image.ext}`);
  try {
    await mkdir(join(imageDir, day), {recursive: true, mode: 0o750});
    await writeFile(join(imageDir, relativePath), buf, {mode: 0o640, flag: 'wx'});
  } catch (err: unknown) {
    const code = (err as {code?: unknown}).code;
    // 再送時に画像だけ残っている場合（前回 INSERT 前に落ちた）は、そのまま使う
    if (code !== 'EEXIST') {
      throw new AppError('STORAGE_WRITE_FAILED', {
        detail: err instanceof Error ? err.message : String(err),
        cause: err,
      });
    }
  }
  return {relativePath, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length};
}

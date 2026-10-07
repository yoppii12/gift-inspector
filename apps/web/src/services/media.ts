import {ClientError} from './api';

/** QR 読取ライブラリが返すエラーの種類 */
export interface ScannerErrorLike {
  kind: string;
  message: string;
  cause?: unknown;
}

/**
 * QR 読取用カメラ（getUserMedia）の失敗をエラーコードに写像する。
 * 'aborted' は画面を離れたときの正常な停止なのでエラーにしない（null を返す）。
 */
export function cameraErrorToClientError(err: ScannerErrorLike): ClientError | null {
  switch (err.kind) {
    case 'aborted':
      return null;
    case 'permission-denied':
      return new ClientError('CAMERA_PERMISSION_DENIED', {detail: err.message, cause: err.cause});
    default:
      // no-camera / in-use / overconstrained / insecure-context / unsupported / security など
      return new ClientError('CAMERA_UNAVAILABLE', {
        detail: `${err.kind}: ${err.message}`,
        cause: err.cause,
      });
  }
}

/** 送信前に画像を縮小・再エンコードする長辺の上限（docs/error-handling.md・メモリ対策） */
export const IMAGE_MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;

export interface PreparedImage {
  blob: Blob;
  width: number;
  height: number;
  originalBytes: number;
}

/**
 * OS カメラで撮った写真を、向きを補正したうえで長辺 1600px の JPEG に再エンコードする。
 * EXIF（位置情報など）はここで落ちる。読めない形式（Chrome での HEIC など）は IMAGE_DECODE_FAILED。
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, {imageOrientation: 'from-image'});
  } catch (err: unknown) {
    throw new ClientError('IMAGE_DECODE_FAILED', {detail: `${file.type || '不明な形式'}`, cause: err});
  }
  try {
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new ClientError('IMAGE_DECODE_FAILED', {detail: 'canvas を使えません'});
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>(resolve =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY)
    );
    if (!blob) throw new ClientError('IMAGE_DECODE_FAILED', {detail: 'JPEG に変換できません'});
    return {blob, width, height, originalBytes: file.size};
  } finally {
    bitmap.close();
  }
}

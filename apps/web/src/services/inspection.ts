import {
  INSPECTION_FIELDS,
  type InspectionResult,
  ORDER_CODE_PATTERN,
  type OrderView,
} from '@gift-inspector/shared';

import {ClientError, request} from './api';

export async function listOrders(): Promise<OrderView[]> {
  return (await request<{orders: OrderView[]}>('/api/orders')).orders;
}

/** QR の読取値からオーダーを取得する。形式が違えばサーバーに問い合わせずに QR_INVALID_FORMAT */
export async function getOrder(code: string): Promise<OrderView> {
  if (!ORDER_CODE_PATTERN.test(code)) {
    throw new ClientError('QR_INVALID_FORMAT', {detail: code.slice(0, 64)});
  }
  return (await request<{order: OrderView}>(`/api/orders/${encodeURIComponent(code)}`)).order;
}

/** 撮影ごとに発行する検品 ID（UUID v4）。再試行は新しい ID で送る（docs/error-handling.md 3.3） */
export function newInspectionId(): string {
  return crypto.randomUUID();
}

/**
 * 検品を送信する。判定が行われれば InspectionResult、行われなければ ClientError（検品 ID つき）。
 * フィールドは inspection_id → order_code → image の順に入れる（サーバーがエラー応答に ID を載せられるように）。
 */
export async function postInspection(
  inspectionId: string,
  orderCode: string,
  image: Blob,
  options: {signal?: AbortSignal; fetchImpl?: typeof fetch} = {}
): Promise<InspectionResult> {
  const form = new FormData();
  form.append(INSPECTION_FIELDS.inspectionId, inspectionId);
  form.append(INSPECTION_FIELDS.orderCode, orderCode);
  form.append(INSPECTION_FIELDS.image, image, 'photo.jpg');
  const result = await request<InspectionResult>('/api/inspections', {
    method: 'POST',
    body: form,
    inspectionId,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  });
  // 応答の取り違え（別の検品の結果）を表示しない
  if (result.inspectionId !== inspectionId || result.orderCode !== orderCode) {
    throw new ClientError('RESPONSE_INVALID', {
      inspectionId,
      detail: `応答の検品 ID・オーダーが送信内容と一致しない（${result.inspectionId} / ${result.orderCode}）`,
    });
  }
  return result;
}

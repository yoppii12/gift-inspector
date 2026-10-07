import {
  INSPECTION_FIELDS,
  type InspectionResult,
  ITEM_RESULTS,
  MANUAL_ORDER_CODE,
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
  options: {signal?: AbortSignal; fetchImpl?: typeof fetch; manual?: OrderView | null} = {}
): Promise<InspectionResult> {
  const form = new FormData();
  form.append(INSPECTION_FIELDS.inspectionId, inspectionId);
  form.append(INSPECTION_FIELDS.orderCode, orderCode);
  if (orderCode === MANUAL_ORDER_CODE) {
    // 開発用の手入力モード: 正解を image より前に入れる（サーバーは DEV_MODE_ENABLED のときだけ受け付ける）
    const m = options.manual;
    if (!m) throw new ClientError('SYS_UNEXPECTED', {detail: '手入力モードなのに正解がない'});
    form.append(INSPECTION_FIELDS.expectedOmotegaki, m.omotegaki ?? '');
    form.append(INSPECTION_FIELDS.expectedAtena, m.atena ?? '');
    form.append(INSPECTION_FIELDS.expectedCardText, m.cardText ?? '');
    form.append(INSPECTION_FIELDS.expectedNoshiType, m.noshiType ?? '');
    form.append(INSPECTION_FIELDS.noshiRequired, String(m.noshiRequired));
    form.append(INSPECTION_FIELDS.cardRequired, String(m.cardRequired));
  }
  form.append(INSPECTION_FIELDS.image, image, 'photo.jpg');
  const result = await request<InspectionResult>('/api/inspections', {
    method: 'POST',
    body: form,
    inspectionId,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  });
  // 応答の取り違え（別の検品の結果）を表示しない
  const expectedMode = orderCode === MANUAL_ORDER_CODE ? 'manual' : 'order';
  if (
    result.inspectionId !== inspectionId ||
    result.orderCode !== orderCode ||
    result.mode !== expectedMode
  ) {
    throw new ClientError('RESPONSE_INVALID', {
      inspectionId,
      detail: `応答の検品 ID・オーダーが送信内容と一致しない（${result.inspectionId} / ${result.orderCode}）`,
    });
  }
  const problem = findResultProblem(result);
  if (problem) throw new ClientError('RESPONSE_INVALID', {inspectionId, detail: problem});
  return result;
}

const OVERALLS = ['OK', 'NG', 'UNREADABLE'] as const;

/**
 * 判定結果の応答を、表示する前に検証する（「OK でないものを OK と表示しない」画面側の守り）。
 * 問題があれば理由を返す。サーバーの判定ロジックを複製するのではなく、矛盾だけを検出する。
 */
export function findResultProblem(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return '応答がオブジェクトではない';
  const r = result as Partial<InspectionResult>;
  if (!OVERALLS.includes(r.overall as (typeof OVERALLS)[number]))
    return `総合結果が不正: ${String(r.overall)}`;
  if (!Array.isArray(r.items) || r.items.length === 0) return '項目の結果がない';
  if (!Array.isArray(r.refWarnings)) return '参考判定の警告がない';
  for (const item of r.items) {
    if (!ITEM_RESULTS.includes(item?.result)) return `項目の結果が不正: ${String(item?.result)}`;
  }
  const judged = r.items.filter(i => i.result !== 'SKIP');
  if (r.overall === 'OK') {
    if (judged.length === 0) return '判定した項目がないのに OK';
    const notOk = judged.find(i => i.result !== 'OK');
    if (notOk) return `総合が OK なのに ${notOk.key} が ${notOk.result}`;
  }
  if (r.overall === 'NG' && r.ngReason !== 'REF_MISMATCH' && !judged.some(i => i.result === 'NG')) {
    return '総合が NG なのに NG の項目がない';
  }
  if (r.overall === 'UNREADABLE' && judged.some(i => i.result === 'NG'))
    return '総合が判定不能なのに NG の項目がある';
  return null;
}

/** URL に ?dev=1 があるときだけ、開発用の手入力モードの入口を出す（サーバー側でも有効化が必要） */
export function isDevModeRequested(search = location.search): boolean {
  return new URLSearchParams(search).get('dev') === '1';
}

export function isManualOrder(order: OrderView): boolean {
  return order.orderCode === MANUAL_ORDER_CODE;
}

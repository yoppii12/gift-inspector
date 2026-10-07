import type {ItemKey, ItemReason, ItemResult, RefWarning, UnreadableReason} from './status';

/**
 * POST /api/inspections の応答（判定が行われたとき。HTTP 200）。
 * overall が ERROR になる場合はこの形ではなく、エラー応答（ErrorResponseBody、inspectionId つき）で返す。
 */
export interface InspectionResult {
  inspectionId: string;
  orderCode: string;
  overall: 'OK' | 'NG' | 'UNREADABLE';
  /** overall=NG のうち、参考判定の警告だけが理由のとき 'REF_MISMATCH' */
  ngReason: 'ITEM' | 'REF_MISMATCH' | null;
  unreadableReason: UnreadableReason | null;
  items: InspectionItem[];
  refWarnings: RefWarning[];
  /** 参考判定の読取値（表示用） */
  reference: {
    noshiPresent: boolean | null;
    cardPresent: boolean | null;
    mizuhikiRead: string | null;
    mizuhikiExpected: string | null;
  };
  completedAt: string;
  /** 同じ inspection_id の再送で、保存済みの結果を返したとき true */
  replayed: boolean;
}

export interface InspectionItem {
  key: ItemKey;
  label: string;
  result: ItemResult;
  reason: ItemReason;
  /** 正解（登録内容） */
  expected: string | null;
  /** AI の読取値（そのまま） */
  read: string | null;
}

/**
 * multipart のフィールド名。クライアントは inspection_id → order_code → image の順に append すること
 * （画像の受信中にエラーになっても、エラー応答に検品 ID を載せられるように）。
 */
export const INSPECTION_FIELDS = {
  inspectionId: 'inspection_id',
  orderCode: 'order_code',
  image: 'image',
} as const;

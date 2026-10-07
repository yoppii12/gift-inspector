import type {
  ItemKey,
  ItemReason,
  ItemResult,
  MizuhikiType,
  RefWarning,
  UnreadableReason,
} from './status';

/**
 * POST /api/inspections の応答（判定が行われたとき。HTTP 200）。
 * overall が ERROR になる場合はこの形ではなく、エラー応答（ErrorResponseBody、inspectionId つき）で返す。
 */
export interface InspectionResult {
  inspectionId: string;
  /** 開発用の手入力モードでは MANUAL_ORDER_CODE */
  orderCode: string;
  /** order = オーダーの登録内容で判定、manual = 開発用に正解を手入力して判定 */
  mode: 'order' | 'manual';
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
  // 以下は開発用の手入力モード（order_code = MANUAL_ORDER_CODE）のときだけ送る。image より前に入れる
  expectedOmotegaki: 'expected_omotegaki',
  expectedAtena: 'expected_atena',
  expectedCardText: 'expected_card_text',
  expectedNoshiType: 'expected_noshi_type',
  noshiRequired: 'noshi_required',
  cardRequired: 'card_required',
} as const;

/** 開発用の手入力モードで order_code に入れる値（オーダーの形式 GIFT-DEMO-NNN とは重ならない） */
export const MANUAL_ORDER_CODE = 'MANUAL';

/** GET /api/orders・/api/orders/:code が返すオーダー（正解情報。画面に表示する） */
export interface OrderView {
  orderCode: string;
  omotegaki: string | null;
  atena: string | null;
  cardText: string | null;
  noshiType: MizuhikiType | null;
  noshiRequired: boolean;
  cardRequired: boolean;
}

export const REF_WARNING_LABELS: Record<RefWarning, string> = {
  NOSHI_MISSING: 'のしが写っていません',
  NOSHI_UNEXPECTED: 'のし不要のオーダーに、のしが写っています',
  CARD_MISSING: 'メッセージカードが写っていません',
  CARD_UNEXPECTED: 'カード不要のオーダーに、メッセージカードが写っています',
  MIZUHIKI_MISMATCH: '水引の種類が登録と異なります',
  MIZUHIKI_UNKNOWN: '水引の種類を判別できませんでした',
};

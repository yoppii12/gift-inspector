import type {
  BagType,
  ItemKey,
  ItemReason,
  ItemResult,
  MizuhikiType,
  ReferenceKey,
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
  /** 参考判定（表示用。オーダーで対象になっている項目だけ。判定には使わない） */
  references: ReferenceItem[];
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
  /** AI が「表書きの位置に何も印字されていない」と答えた（表書きのみ。画面で「印字なし」と表示する。#51） */
  readBlank?: boolean;
}

/** 参考判定の1項目（#53） */
export interface ReferenceItem {
  key: ReferenceKey;
  label: string;
  /** 登録内容の表示（例: 「あり」「紙平袋」「花結び」） */
  expected: string;
  /** 読み取り結果の表示。読み取れなかったときは null */
  read: string | null;
  /** MATCH = 一致、MISMATCH = 不一致（警告あり）、UNKNOWN = 読み取れず判別できない */
  status: 'MATCH' | 'MISMATCH' | 'UNKNOWN';
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
  /** ラッピングの袋（#53）。null は参考判定の対象外 */
  bagType: BagType | null;
  /** 紙手提げ袋（黒）を付けるか（#53）。null は参考判定の対象外 */
  carrierBag: boolean | null;
}

export const REF_WARNING_LABELS: Record<RefWarning, string> = {
  NOSHI_MISSING: 'のしが写っていません',
  NOSHI_UNEXPECTED: 'のし不要のオーダーに、のしが写っています',
  CARD_MISSING: 'メッセージカードが写っていません',
  CARD_UNEXPECTED: 'カード不要のオーダーに、メッセージカードが写っています',
  MIZUHIKI_MISMATCH: '水引の種類が登録と異なります',
  MIZUHIKI_UNKNOWN: '水引の種類を判別できませんでした',
  BAG_MISSING: 'ラッピングの袋が写っていません',
  BAG_MISMATCH: 'ラッピングの袋の種類が登録と異なります',
  BAG_UNEXPECTED: 'ラッピングなしのオーダーに、袋が写っています',
  SEAL_MISSING: '紙平袋のシールが写っていません',
  MANUAL_MISSING: '布巾着袋の取扱説明書が写っていません',
  CARRIER_BAG_MISSING: '紙手提げ袋が写っていません',
  CARRIER_BAG_UNEXPECTED: '手提げ袋不要のオーダーに、紙手提げ袋が写っています',
};

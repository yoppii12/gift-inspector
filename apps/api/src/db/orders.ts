import type {MizuhikiType} from '@gift-inspector/shared';
import type {RowDataPacket} from 'mysql2/promise';

import {type Db, withDb} from './pool';

export interface DemoOrder {
  orderCode: string;
  omotegaki: string | null;
  atena: string | null;
  cardText: string | null;
  noshiType: MizuhikiType | null;
  noshiRequired: boolean;
  cardRequired: boolean;
}

interface OrderRow extends RowDataPacket {
  order_code: string;
  omotegaki: string | null;
  atena: string | null;
  card_text: string | null;
  noshi_type: MizuhikiType | null;
  noshi_required: number;
  card_required: number;
}

const COLUMNS =
  'order_code, omotegaki, atena, card_text, noshi_type, noshi_required, card_required';

function toOrder(row: OrderRow): DemoOrder {
  return {
    orderCode: row.order_code,
    omotegaki: row.omotegaki,
    atena: row.atena,
    cardText: row.card_text,
    noshiType: row.noshi_type,
    noshiRequired: row.noshi_required === 1,
    cardRequired: row.card_required === 1,
  };
}

export async function listOrders(db: Db): Promise<DemoOrder[]> {
  return withDb(async () => {
    const [rows] = await db.query<OrderRow[]>(
      `SELECT ${COLUMNS} FROM demo_orders ORDER BY sort_order, order_code`
    );
    return rows.map(toOrder);
  });
}

export async function findOrder(db: Db, orderCode: string): Promise<DemoOrder | null> {
  return withDb(async () => {
    const [rows] = await db.query<OrderRow[]>(
      `SELECT ${COLUMNS} FROM demo_orders WHERE order_code = ?`,
      [orderCode]
    );
    const row = rows[0];
    return row ? toOrder(row) : null;
  });
}

/** 検品の記録用に内部 ID つきで取得する（API の応答には ID を出さない） */
export async function findOrderWithId(
  db: Db,
  orderCode: string
): Promise<{id: number; order: DemoOrder} | null> {
  return withDb(async () => {
    const [rows] = await db.query<(OrderRow & {id: number})[]>(
      `SELECT id, ${COLUMNS} FROM demo_orders WHERE order_code = ?`,
      [orderCode]
    );
    const row = rows[0];
    return row ? {id: row.id, order: toOrder(row)} : null;
  });
}

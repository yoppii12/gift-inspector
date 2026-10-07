import type {DemoOrder} from './data';

export const SEED_SQL_RELATIVE_PATH = 'db/seeds/001_demo_orders.sql';

function sqlString(value: string | null): string {
  if (value === null) return 'NULL';
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/** demo_orders.json から SQL シードを生成する（何度流しても同じ状態になる UPSERT） */
export function renderSeedSql(orders: DemoOrder[]): string {
  const rows = orders.map((o, i) => {
    const r = o.registered;
    const values = [
      sqlString(o.orderCode),
      String(i + 1),
      sqlString(r.omotegaki),
      sqlString(r.atena),
      sqlString(r.cardText),
      sqlString(r.noshiType),
      r.noshiRequired ? '1' : '0',
      r.cardRequired ? '1' : '0',
      sqlString(`想定: ${o.expected}。${o.note}`),
    ];
    return `  (${values.join(', ')})`;
  });

  return `-- このファイルは tools/demo-kit が db/seeds/demo_orders.json から生成する。直接編集しないこと。
-- 再生成: npm run demo-kit
-- デモ用オーダー（想定結果は demo_note。API では返さない）。何度流しても同じ状態になる。

INSERT INTO demo_orders
  (order_code, sort_order, omotegaki, atena, card_text, noshi_type, noshi_required, card_required, demo_note)
VALUES
${rows.join(',\n')}
AS new
ON DUPLICATE KEY UPDATE
  sort_order = new.sort_order,
  omotegaki = new.omotegaki,
  atena = new.atena,
  card_text = new.card_text,
  noshi_type = new.noshi_type,
  noshi_required = new.noshi_required,
  card_required = new.card_required,
  demo_note = new.demo_note;
`;
}

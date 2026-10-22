-- このファイルは tools/demo-kit が db/seeds/demo_orders.json から生成する。直接編集しないこと。
-- 再生成: npm run demo-kit
-- デモ用オーダー（想定結果は demo_note。API では返さない）。何度流しても同じ状態になる。

INSERT INTO demo_orders
  (order_code, sort_order, omotegaki, atena, card_text, noshi_type, noshi_required, card_required, noshi_size, bag_type, carrier_bag, demo_note)
VALUES
  ('GIFT-DEMO-001', 1, '御祝', '佐藤 花子', 'ご出産おめでとうございます。心ばかりの品をお贈りします。', '花結び', 1, 1, NULL, NULL, NULL, '想定: OK。登録内容どおり（のし＋カード）'),
  ('GIFT-DEMO-002', 2, '内祝', '高橋 健一', NULL, '花結び', 1, 0, NULL, NULL, NULL, '想定: OK。カードなしのオーダー（のしのみ）'),
  ('GIFT-DEMO-003', 3, '御礼', '鈴木 一郎', 'このたびは大変お世話になりました。心ばかりの品をお贈りいたします。', '花結び', 1, 1, NULL, NULL, NULL, '想定: NG。表書きNG（登録「御礼」／現物「御祝」）'),
  ('GIFT-DEMO-004', 4, '快気祝', '渡辺 直樹', NULL, '結び切り', 1, 0, NULL, NULL, NULL, '想定: NG。宛名NG（登録「渡辺」／現物「渡部」の1文字違い）'),
  ('GIFT-DEMO-005', 5, '寿', '山本 恵', 'ご結婚おめでとうございます。お二人の末永いお幸せをお祈りいたします。', '結び切り', 1, 1, NULL, NULL, NULL, '想定: NG。カードNG（登録「お幸せを」／現物「ご多幸を」）'),
  ('GIFT-DEMO-006', 6, '御祝', NULL, 'HAPPY BIRTHDAY! おめでとうございます。', '花結び', 1, 1, '長い', '紙平袋', 0, '想定: OK。実物: 長いのし＋カード＋紙平袋・シール。参考判定もすべて一致'),
  ('GIFT-DEMO-007', 7, '内祝', NULL, NULL, '結び切り', 1, 0, '短い', '布巾着袋', 1, '想定: OK。実物: 短いのし＋布巾着袋・取扱説明書＋紙手提げ袋。参考判定もすべて一致'),
  ('GIFT-DEMO-008', 8, '御祝', NULL, NULL, '花結び', 1, 0, '長い', 'なし', 0, '想定: NG。表書きNG（登録「御祝」／現物「寿」）。参考: のし紙の大きさも違う（登録 長い／現物 短い）'),
  ('GIFT-DEMO-009', 9, '無地', NULL, NULL, '花結び', 1, 0, '短い', 'なし', 0, '想定: OK。表書き「無地」（印字なしが正解）。名入れなし'),
  ('GIFT-DEMO-010', 10, '内祝', NULL, 'HAPPY BIRTHDAY! おめでとうございます。', '結び切り', 1, 1, '長い', '布巾着袋', 1, '想定: OK。実物: 長いのし（結び切り）＋カード＋布巾着袋・取扱説明書＋紙手提げ袋。参考判定もすべて一致')
AS new
ON DUPLICATE KEY UPDATE
  sort_order = new.sort_order,
  omotegaki = new.omotegaki,
  atena = new.atena,
  card_text = new.card_text,
  noshi_type = new.noshi_type,
  noshi_required = new.noshi_required,
  card_required = new.card_required,
  noshi_size = new.noshi_size,
  bag_type = new.bag_type,
  carrier_bag = new.carrier_bag,
  demo_note = new.demo_note;

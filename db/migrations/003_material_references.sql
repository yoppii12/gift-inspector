-- 003: ラッピング資材・手提げ袋の参考判定（#53）
-- NULL は参考判定の対象外（デモ用の擬似のし・カードのオーダーなど）

ALTER TABLE demo_orders
  ADD COLUMN bag_type ENUM('紙平袋','布巾着袋','なし') NULL
    COMMENT 'ラッピングの袋（紙平袋はシール貼り、布巾着袋は取扱説明書の同梱）。NULL は参考判定の対象外'
    AFTER card_required,
  ADD COLUMN carrier_bag TINYINT(1) NULL
    COMMENT '紙手提げ袋（黒）を付けるか。NULL は参考判定の対象外'
    AFTER bag_type;

ALTER TABLE inspections
  ADD COLUMN expected_bag_type VARCHAR(16) NULL AFTER expected_card_required,
  ADD COLUMN expected_carrier_bag TINYINT(1) NULL AFTER expected_bag_type;

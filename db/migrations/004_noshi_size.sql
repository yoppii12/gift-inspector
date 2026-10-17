-- 004: のし紙の長短（縦横比の計測による参考判定。#55）
-- NULL は参考判定の対象外

ALTER TABLE demo_orders
  ADD COLUMN noshi_size ENUM('長い','短い') NULL
    COMMENT 'のし紙の大きさ（高さは共通で長さが違う）。NULL は参考判定の対象外'
    AFTER noshi_type;

ALTER TABLE inspections
  ADD COLUMN expected_noshi_size VARCHAR(8) NULL AFTER expected_card_required,
  ADD COLUMN noshi_aspect_ratio DECIMAL(6,3) NULL COMMENT 'のし紙の縦横比（長辺÷短辺）の計測値' AFTER judge_detail,
  ADD COLUMN noshi_size_measured VARCHAR(8) NULL COMMENT '縦横比から判定した大きさ（判定できなければ NULL）' AFTER noshi_aspect_ratio,
  ADD COLUMN noshi_size_reason VARCHAR(32) NULL COMMENT '計測の結果（MEASURED / BORDERLINE / NOT_FOUND / MULTIPLE / UNSUPPORTED_FORMAT / ERROR）' AFTER noshi_size_measured;

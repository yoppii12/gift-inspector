-- 004: のし紙の長短（縦横比の計測による参考判定。#55）
-- NULL は参考判定の対象外
-- 途中で失敗した場合: SHOW COLUMNS FROM demo_orders; SHOW COLUMNS FROM inspections; で追加済みの列を確かめ、
--   残りの ALTER だけを手で流してから INSERT INTO schema_migrations (version) VALUES ('004_noshi_size');

ALTER TABLE demo_orders
  ADD COLUMN noshi_size ENUM('長い','短い') NULL
    COMMENT 'のし紙の大きさ（高さは共通で長さが違う）。NULL は参考判定の対象外'
    AFTER noshi_type,
  -- のし不要のオーダーに大きさは登録しない
  ADD CONSTRAINT ck_noshi_size CHECK (noshi_required = 1 OR noshi_size IS NULL);

ALTER TABLE inspections
  ADD COLUMN expected_noshi_size VARCHAR(8) NULL AFTER expected_card_required,
  ADD COLUMN noshi_aspect_ratio DECIMAL(6,3) NULL COMMENT 'のし紙の縦横比（長辺÷短辺）の計測値' AFTER judge_detail,
  ADD COLUMN noshi_size_measured VARCHAR(8) NULL COMMENT '縦横比から判定した大きさ（判定できなければ NULL）' AFTER noshi_aspect_ratio,
  ADD COLUMN noshi_size_reason VARCHAR(32) NULL COMMENT '計測の結果（apps/api/src/measure/noshi-size.ts の NoshiSizeReason）' AFTER noshi_size_measured,
  ADD COLUMN noshi_size_detail JSON NULL COMMENT '候補ごとの縦横比・長方形度・面積比・縁に触れているか（しきい値の調整用）' AFTER noshi_size_reason;

-- 002: 水引を「花結び」に（お客様の呼び方。初期は「蝶結び」）、名入れなしのオーダーを許可（#51）
-- 表書き「無地」は表書きを印字しないことが正解（値は '無地'。空ではないので ck_noshi はそのまま満たす）
-- 検品記録（inspections.expected_noshi_type・read_noshi_type）は当時の値（蝶結び）のまま残す
--
-- 途中で失敗した場合（MySQL の DDL は戻せない）: 次で状態を確かめ、残りの文だけを手で流してから
--   INSERT INTO schema_migrations (version) VALUES ('002_hanamusubi_blank'); で適用済みにする
--   SELECT CONSTRAINT_NAME FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE();
--   SHOW COLUMNS FROM demo_orders LIKE 'noshi_type';

ALTER TABLE demo_orders DROP CHECK ck_noshi;

ALTER TABLE demo_orders MODIFY noshi_type ENUM('蝶結び','結び切り','花結び') NULL COMMENT '水引種別';
UPDATE demo_orders SET noshi_type = '花結び' WHERE noshi_type = '蝶結び';
ALTER TABLE demo_orders MODIFY noshi_type ENUM('花結び','結び切り') NULL COMMENT '水引種別';

-- 名入れ（atena）は、のしありでも NULL（名入れなし）を許す。値があるなら空白だけは不可
ALTER TABLE demo_orders ADD CONSTRAINT ck_noshi CHECK (
  (noshi_required = 1
    AND omotegaki IS NOT NULL AND CHAR_LENGTH(TRIM(omotegaki)) > 0
    AND (atena IS NULL OR CHAR_LENGTH(TRIM(atena)) > 0)
    AND noshi_type IS NOT NULL)
  OR (noshi_required = 0 AND omotegaki IS NULL AND atena IS NULL AND noshi_type IS NULL)
);

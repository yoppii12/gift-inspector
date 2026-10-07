-- 001_init: デモ用オーダーと検品記録
-- 設計: docs/error-handling.md（ステータス・記録項目）、CLAUDE.md 5章（データモデル案）
-- 2027/1末の全削除: TRUNCATE inspections; と画像ディレクトリの削除（docs/ops.md）

CREATE TABLE demo_orders (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_code      VARCHAR(32)  NOT NULL COMMENT 'QRコードの値（GIFT-DEMO-NNN）',
  sort_order      SMALLINT     NOT NULL DEFAULT 0,
  omotegaki       VARCHAR(64)  NULL     COMMENT '表書き',
  atena           VARCHAR(128) NULL     COMMENT '宛名（名入れ）',
  card_text       VARCHAR(1000) NULL    COMMENT 'メッセージカードの印刷文面',
  noshi_type      ENUM('蝶結び','結び切り') NULL COMMENT '水引種別',
  noshi_required  TINYINT(1)   NOT NULL,
  card_required   TINYINT(1)   NOT NULL,
  demo_note       VARCHAR(255) NULL     COMMENT '操作者用メモ（撮影物の内容・想定結果）。APIでは返さない',
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_demo_orders_code (order_code),
  -- 正解データの不備を入口で防ぐ（API側でも検査し CONFIG_INVALID_EXPECTED にする）
  CONSTRAINT ck_order_code CHECK (REGEXP_LIKE(order_code, '^GIFT-DEMO-[0-9]{3}$', 'c')),
  CONSTRAINT ck_noshi CHECK (
    (noshi_required = 1
      AND omotegaki IS NOT NULL AND CHAR_LENGTH(TRIM(omotegaki)) > 0
      AND atena IS NOT NULL AND CHAR_LENGTH(TRIM(atena)) > 0
      AND noshi_type IS NOT NULL)
    OR (noshi_required = 0 AND omotegaki IS NULL AND atena IS NULL AND noshi_type IS NULL)
  ),
  CONSTRAINT ck_card CHECK (
    (card_required = 1 AND card_text IS NOT NULL AND CHAR_LENGTH(TRIM(card_text)) > 0)
    OR (card_required = 0 AND card_text IS NULL)
  ),
  CONSTRAINT ck_something_required CHECK (noshi_required = 1 OR card_required = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE inspections (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  inspection_id       CHAR(36)     NOT NULL COMMENT 'クライアントが撮影ごとに発行するUUID（二重送信防止）',
  request_id          VARCHAR(64)  NULL     COMMENT 'OpenResty/API のリクエストID',
  order_id            INT UNSIGNED NULL     COMMENT '開発用の隠しモードでは NULL',
  mode                ENUM('order','manual') NOT NULL,

  -- 処理状態と結果
  status              ENUM('PENDING','DONE') NOT NULL DEFAULT 'PENDING',
  overall             ENUM('OK','NG','UNREADABLE','ERROR') NULL COMMENT 'PENDING の間は NULL',
  error_code          VARCHAR(64)  NULL     COMMENT 'overall=ERROR のときのエラーコード（packages/shared/src/errors.ts）',
  error_detail        VARCHAR(1000) NULL,
  unreadable_reason   VARCHAR(64)  NULL,

  -- 判定時点の正解値（オーダーを後で直しても、判定の根拠を追えるように複製する）
  expected_omotegaki      VARCHAR(64)   NULL,
  expected_atena          VARCHAR(128)  NULL,
  expected_card_text      VARCHAR(1000) NULL,
  expected_noshi_type     VARCHAR(16)   NULL,
  expected_noshi_required TINYINT(1)    NOT NULL,
  expected_card_required  TINYINT(1)    NOT NULL,

  -- 画像（ファイルは IMAGE_DIR 配下。公開ディレクトリの外）
  image_path          VARCHAR(255) NULL     COMMENT 'IMAGE_DIR からの相対パス',
  image_sha256        CHAR(64)     NULL,
  image_bytes         INT UNSIGNED NULL,
  image_mime          VARCHAR(32)  NULL,
  image_width         SMALLINT UNSIGNED NULL,
  image_height        SMALLINT UNSIGNED NULL,

  -- AI 呼び出し
  ai_provider         VARCHAR(32)  NULL,
  ai_model            VARCHAR(64)  NULL,
  prompt_version      VARCHAR(32)  NULL,
  schema_version      SMALLINT UNSIGNED NULL,
  ai_attempt_count    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  ai_attempts         JSON         NULL     COMMENT '試行ごとの記録（生の応答・stop_reason・レイテンシ・エラー分類）',
  ai_raw_response     JSON         NULL     COMMENT '採用した試行の生の応答',
  tokens_in           INT UNSIGNED NULL,
  tokens_out          INT UNSIGNED NULL,

  -- AI の読取値（参考判定を含む）
  read_omotegaki      VARCHAR(255)  NULL,
  read_atena          VARCHAR(255)  NULL,
  read_card_text      VARCHAR(2000) NULL,
  read_noshi_type     VARCHAR(16)   NULL,
  noshi_present       TINYINT(1)    NULL,
  card_present        TINYINT(1)    NULL,

  -- 項目ごとの結果
  result_omotegaki    ENUM('OK','NG','UNREADABLE','SKIP') NULL,
  result_atena        ENUM('OK','NG','UNREADABLE','SKIP') NULL,
  result_card         ENUM('OK','NG','UNREADABLE','SKIP') NULL,
  reason_omotegaki    VARCHAR(32)  NULL,
  reason_atena        VARCHAR(32)  NULL,
  reason_card         VARCHAR(32)  NULL,
  ref_warnings        JSON         NULL     COMMENT '参考判定の警告コードの配列',
  judge_detail        JSON         NULL     COMMENT '正規化後の文字列・比較の詳細',

  -- 実行環境
  app_version         VARCHAR(64)  NULL,
  client_ua           VARCHAR(500) NULL,

  created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at        DATETIME(3)  NULL,
  duration_ms         INT UNSIGNED NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uk_inspections_inspection_id (inspection_id),
  KEY ix_inspections_status_created (status, created_at),
  KEY ix_inspections_created (created_at),
  KEY ix_inspections_order (order_id),
  CONSTRAINT fk_inspections_order FOREIGN KEY (order_id) REFERENCES demo_orders (id),
  -- 完了した検品は必ず総合結果を持つ。ERROR は必ずエラーコードを持つ（気づけないエラーを残さない）
  CONSTRAINT ck_done_has_overall CHECK (status = 'PENDING' OR overall IS NOT NULL),
  CONSTRAINT ck_pending_no_overall CHECK (status = 'DONE' OR overall IS NULL),
  CONSTRAINT ck_error_has_code CHECK (overall IS NULL OR overall <> 'ERROR' OR error_code IS NOT NULL),
  CONSTRAINT ck_order_mode CHECK ((mode = 'order' AND order_id IS NOT NULL) OR (mode = 'manual' AND order_id IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

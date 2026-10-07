#!/usr/bin/env bash
# マイグレーションとシードを適用する。
#   使い方: db/migrate.sh [--seed]
#   接続情報は MySQL のオプションファイルで渡す（パスワードをコマンドラインに出さない）:
#     MYSQL_DEFAULTS_FILE=/etc/gift-inspector/mysql-client.cnf db/migrate.sh --seed
#   未指定なら ~/.my.cnf を使う。DB 名は DB_NAME（既定 gift_inspector）。
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DB_NAME=${DB_NAME:-gift_inspector}
DEFAULTS=()
if [[ -n "${MYSQL_DEFAULTS_FILE:-}" ]]; then
  DEFAULTS=(--defaults-extra-file="$MYSQL_DEFAULTS_FILE")
fi

mysql_exec() {
  mysql "${DEFAULTS[@]}" --batch --skip-column-names --default-character-set=utf8mb4 "$DB_NAME" "$@"
}

log() { echo "[migrate] $*"; }
fail() { echo "[migrate] ERROR: $*" >&2; exit 1; }

mysql_exec -e "SELECT 1" > /dev/null || fail "DB '$DB_NAME' に接続できません"

mysql_exec -e "
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) NOT NULL PRIMARY KEY,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"

shopt -s nullglob
for file in "$SCRIPT_DIR"/migrations/*.sql; do
  version=$(basename "$file" .sql)
  applied=$(mysql_exec -e "SELECT COUNT(*) FROM schema_migrations WHERE version='${version}'")
  if [[ "$applied" == "1" ]]; then
    log "skip   $version（適用済み）"
    continue
  fi
  log "apply  $version"
  # MySQL の DDL はトランザクションで戻せない。失敗したら中断し、手で状態を確認する
  mysql_exec < "$file" || fail "$version の適用に失敗しました。DB の状態を確認してください"
  mysql_exec -e "INSERT INTO schema_migrations (version) VALUES ('${version}')"
done

if [[ "${1:-}" == "--seed" ]]; then
  for file in "$SCRIPT_DIR"/seeds/*.sql; do
    log "seed   $(basename "$file")"
    mysql_exec < "$file" || fail "$(basename "$file") の投入に失敗しました"
  done
  count=$(mysql_exec -e "SELECT COUNT(*) FROM demo_orders")
  log "demo_orders: ${count} 件"
fi
log "完了"

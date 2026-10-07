#!/usr/bin/env bash
# 検品 API の結合テスト（実際の MySQL 8.0 を使う）。スキーマを作り直してシードを投入してから実行する。
#
#   npm run test:db -w @gift-inspector/api                   Docker で MySQL 8.0 を起動して実行
#   npm run test:db -w @gift-inspector/api -- --down         Docker のコンテナを削除
#   npm run test:db -w @gift-inspector/api -- --external     起動済みの MySQL に接続して実行（Docker を使わない）
#
# --external のときは、次の環境変数で接続先を渡す（パスワードはコマンドラインに出さない）:
#   TEST_DB_HOST（既定 127.0.0.1） TEST_DB_PORT（既定 33306） TEST_DB_USER（既定 root） TEST_DB_PASSWORD（既定 空）
#   MYSQL_CLIENT（既定 mysql。8.0 のクライアントを指定）
#   ※ 指定した DB（TEST_DB_NAME、既定 gift_inspector_test）は削除して作り直す。本番・開発の DB を指定しないこと
#
# VPS と同じ 8.0 系（8.0.19 以降）が必要。CHECK 制約は 8.0.16 以降、シードの `AS new` は 8.0.19 以降で有効。
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
NAME=gift-inspector-test-mysql
IMAGE=mysql:8.0

log() { echo "[test-db] $*"; }
fail() { echo "[test-db] ERROR: $*" >&2; exit 1; }

MODE=docker
case "${1:-}" in
  --down)
    docker rm -f "$NAME" > /dev/null 2>&1 && log "削除しました" || log "コンテナはありません"
    exit 0
    ;;
  --external) MODE=external ;;
  "") ;;
  *) fail "不明な引数: $1" ;;
esac

export TEST_DB_HOST=${TEST_DB_HOST:-127.0.0.1}
export TEST_DB_PORT=${TEST_DB_PORT:-33306}
export TEST_DB_USER=${TEST_DB_USER:-root}
export TEST_DB_PASSWORD=${TEST_DB_PASSWORD:-}
export TEST_DB_NAME=${TEST_DB_NAME:-gift_inspector_test}

case "$TEST_DB_NAME" in
  gift_inspector) fail "TEST_DB_NAME に gift_inspector（本番・開発用）は指定できません" ;;
  *_test) ;;
  *) fail "TEST_DB_NAME は _test で終わる名前にしてください（作り直すため）: $TEST_DB_NAME" ;;
esac

if [[ "$MODE" == docker ]]; then
  if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
    docker rm -f "$NAME" > /dev/null 2>&1 || true
    log "Docker で起動: $IMAGE（${TEST_DB_HOST}:${TEST_DB_PORT}）"
    docker run -d --name "$NAME" -p "127.0.0.1:${TEST_DB_PORT}:3306" \
      --tmpfs /var/lib/mysql:rw -e MYSQL_ALLOW_EMPTY_PASSWORD=yes \
      "$IMAGE" --character-set-server=utf8mb4 --collation-server=utf8mb4_0900_ai_ci \
      --default-time-zone=+00:00 > /dev/null
  fi
  run_mysql() { docker exec -i "$NAME" mysql -uroot --default-character-set=utf8mb4 "$@"; }
else
  CLIENT=${MYSQL_CLIENT:-mysql}
  command -v "$CLIENT" > /dev/null || fail "MySQL クライアントが見つかりません: $CLIENT"
  log "起動済みの MySQL に接続: ${TEST_DB_HOST}:${TEST_DB_PORT}"
  run_mysql() {
    MYSQL_PWD=$TEST_DB_PASSWORD "$CLIENT" --no-defaults -h"$TEST_DB_HOST" -P"$TEST_DB_PORT" -u"$TEST_DB_USER" \
      --default-character-set=utf8mb4 "$@"
  }
fi

log "接続を待っています"
for _ in $(seq 1 60); do
  if run_mysql -e "SELECT 1" > /dev/null 2>&1; then break; fi
  sleep 2
done
run_mysql -e "SELECT 1" > /dev/null 2>&1 || fail "MySQL に接続できません"

version=$(run_mysql -N -e "SELECT VERSION()")
log "MySQL ${version}"
[[ "$version" =~ ^8\.0\.([0-9]+) ]] && (( BASH_REMATCH[1] >= 19 )) \
  || fail "MySQL 8.0.19 以降が必要です（${version}）"

log "${TEST_DB_NAME} を作り直してシードを投入"
{
  echo "DROP DATABASE IF EXISTS \`${TEST_DB_NAME}\`;"
  echo "CREATE DATABASE \`${TEST_DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
  echo "USE \`${TEST_DB_NAME}\`;"
  cat "$ROOT_DIR"/db/migrations/*.sql "$ROOT_DIR"/db/seeds/*.sql
} | run_mysql

log "テスト実行"
cd "$ROOT_DIR"
npx vitest run --project api test/inspections.db.spec.ts

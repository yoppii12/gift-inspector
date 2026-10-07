#!/usr/bin/env bash
# ローカル（開発機）から VPS へデプロイする。VPS 上ではビルドしない（1GB メモリのため。D2）。
#   使い方: infra/scripts/deploy.sh [ssh先]      例: infra/scripts/deploy.sh gift-vps
#   ssh先の既定は gift-vps（~/.ssh/config に Host gift-vps を定義しておく。docs/vps-setup.md 12章）
#   --skip-checks で lint・テストを省略（緊急時のみ）
set -euo pipefail

HOST=gift-vps
SKIP_CHECKS=false
for arg in "$@"; do
  case "$arg" in
    --skip-checks) SKIP_CHECKS=true ;;
    *) HOST=$arg ;;
  esac
done

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"

log() { echo -e "\033[1m[deploy]\033[0m $*"; }
fail() { echo -e "\033[1;31m[deploy] ERROR:\033[0m $*" >&2; exit 1; }

VERSION=$(git rev-parse --short HEAD)
if [[ -n "$(git status --porcelain)" ]]; then
  VERSION="${VERSION}-dirty"
  log "未コミットの変更があります（版: ${VERSION}）"
fi

if ! $SKIP_CHECKS; then
  log "lint・型検査・テスト"
  npm run check
fi

log "ビルド（版: ${VERSION}）"
APP_VERSION=$VERSION npm run build

log "VPS へ転送: ${HOST}"
rsync -az --delete apps/web/dist/ "${HOST}:/srv/gift-inspector/web/"
rsync -az --delete apps/api/dist/ "${HOST}:/srv/gift-inspector/api/"
rsync -az --delete db/ "${HOST}:/srv/gift-inspector/db/"
rsync -az --delete infra/ "${HOST}:/srv/gift-inspector/infra/"

log "API を再起動（sudo のパスワードを求められます）"
ssh -t "$HOST" "sudo sed -i 's/^APP_VERSION=.*/APP_VERSION=${VERSION}/' /etc/gift-inspector/api.env \
  && sudo systemctl restart gift-inspector-api"

log "起動確認"
for _ in {1..10}; do
  if ssh "$HOST" "curl -fsS --max-time 5 http://127.0.0.1:3000/api/health" > /dev/null 2>&1; then
    ssh "$HOST" "curl -sS http://127.0.0.1:3000/api/health"; echo
    log "完了（版: ${VERSION}）"
    exit 0
  fi
  sleep 2
done
ssh "$HOST" "curl -sS http://127.0.0.1:3000/api/health; echo; sudo journalctl -u gift-inspector-api -n 30 --no-pager -o cat" || true
fail "API のヘルスチェックが通りません。上のログを確認してください"

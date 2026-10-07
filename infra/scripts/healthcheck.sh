#!/usr/bin/env bash
# VPS のヘルスチェック（cron で5分ごとに実行。/etc/cron.d/gift-inspector）
#   - API の /api/health（DB・画像ディレクトリ・AI設定）
#   - サービスの稼働（openresty / mysql / gift-inspector-api）
#   - メモリ・スワップ・ディスク・証明書の残り日数
# 異常が始まったとき・復旧したときに Slack へ通知し、続いている間は1時間ごとに再通知する。
# 結果は常に syslog（journalctl -t gift-inspector-health）にも残す。
#   手動実行: sudo /srv/gift-inspector/infra/scripts/healthcheck.sh --print
set -uo pipefail

ENV_FILE=${ENV_FILE:-/etc/gift-inspector/api.env}
STATE_FILE=${STATE_FILE:-/var/lib/gift-inspector/healthcheck.state}
DOMAIN=${DOMAIN:-gift-inspector-dev.laplust.com}
API_URL=${API_URL:-http://127.0.0.1:3000/api/health}
REMIND_SEC=3600

# 閾値（docs/vps-setup.md 15章の 2G プラン移行基準と合わせる）
MIN_MEM_AVAILABLE_MB=100
MAX_SWAP_USED_MB=300
MIN_DISK_FREE_MB=1024
MIN_CERT_DAYS=14

PRINT=false
[[ "${1:-}" == "--print" ]] && PRINT=true

SLACK_WEBHOOK_URL=""
if [[ -r "$ENV_FILE" ]]; then
  SLACK_WEBHOOK_URL=$(grep -E '^SLACK_WEBHOOK_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' || true)
fi

problems=()

# --- API ---
api_body=$(curl -sS --max-time 10 -w '\n%{http_code}' "$API_URL" 2>&1)
api_status=$(tail -n1 <<<"$api_body")
api_json=$(sed '$d' <<<"$api_body")
if [[ "$api_status" != "200" ]]; then
  failed=$(grep -oE '"[a-z]+":\{"ok":false[^}]*\}' <<<"$api_json" | tr '\n' ' ')
  problems+=("API ヘルスチェック異常 (HTTP ${api_status}) ${failed:-$api_json}")
fi

# --- サービス ---
for svc in openresty mysql gift-inspector-api; do
  if ! systemctl is-active --quiet "$svc"; then
    problems+=("サービス停止: ${svc} ($(systemctl is-active "$svc" 2>&1))")
  fi
done

# --- メモリ・スワップ ---
mem_avail_mb=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
swap_total_mb=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
swap_free_mb=$(awk '/SwapFree/ {print int($2/1024)}' /proc/meminfo)
swap_used_mb=$((swap_total_mb - swap_free_mb))
(( mem_avail_mb < MIN_MEM_AVAILABLE_MB )) && problems+=("空きメモリ不足: ${mem_avail_mb}MB")
(( swap_used_mb > MAX_SWAP_USED_MB )) && problems+=("スワップ使用量が多い: ${swap_used_mb}MB")
(( swap_total_mb == 0 )) && problems+=("スワップが無効")

# 直近1時間の OOM kill
if journalctl -k --since "-1h" -q 2>/dev/null | grep -qiE 'out of memory|oom-kill'; then
  problems+=("直近1時間に OOM kill が発生")
fi

# --- ディスク ---
disk_free_mb=$(df -Pm /var/lib/gift-inspector 2>/dev/null | awk 'NR==2 {print $4}')
if [[ -n "$disk_free_mb" ]] && (( disk_free_mb < MIN_DISK_FREE_MB )); then
  problems+=("ディスク空き不足: ${disk_free_mb}MB")
fi

# --- 証明書 ---
cert=/etc/letsencrypt/live/${DOMAIN}/fullchain.pem
if [[ -r "$cert" ]]; then
  end=$(openssl x509 -enddate -noout -in "$cert" | cut -d= -f2)
  days=$(( ( $(date -d "$end" +%s) - $(date +%s) ) / 86400 ))
  (( days < MIN_CERT_DAYS )) && problems+=("証明書の残り日数: ${days}日（自動更新を確認）")
else
  problems+=("証明書が見つからない: ${cert}")
fi

summary="mem_avail=${mem_avail_mb}MB swap_used=${swap_used_mb}MB disk_free=${disk_free_mb:-?}MB"

notify() {
  local text=$1
  [[ -z "$SLACK_WEBHOOK_URL" ]] && return 0
  local payload
  payload=$(printf '%s' "$text" | python3 -c 'import json,sys; print(json.dumps({"text": sys.stdin.read()}))')
  if ! curl -sS --max-time 10 -H 'content-type: application/json' -d "$payload" "$SLACK_WEBHOOK_URL" > /dev/null; then
    logger -t gift-inspector-health -p user.err "Slack 通知に失敗しました"
  fi
}

now=$(date +%s)
prev_state="OK"; prev_notified=0
[[ -r "$STATE_FILE" ]] && read -r prev_state prev_notified < "$STATE_FILE"

if (( ${#problems[@]} > 0 )); then
  detail=$(printf '• %s\n' "${problems[@]}")
  logger -t gift-inspector-health -p user.err "NG ${summary} | ${problems[*]}"
  $PRINT && printf 'NG %s\n%s\n' "$summary" "$detail"
  if [[ "$prev_state" != "NG" ]] || (( now - prev_notified >= REMIND_SEC )); then
    notify ":rotating_light: [gift-inspector VPS] ヘルスチェック異常（$(hostname)）
${detail}
• ${summary}"
    echo "NG ${now}" > "$STATE_FILE"
  fi
  exit 1
fi

logger -t gift-inspector-health -p user.info "OK ${summary}"
$PRINT && echo "OK ${summary}"
if [[ "$prev_state" == "NG" ]]; then
  notify ":white_check_mark: [gift-inspector VPS] ヘルスチェックが復旧しました（$(hostname)）
• ${summary}"
fi
echo "OK ${now}" > "$STATE_FILE"
exit 0

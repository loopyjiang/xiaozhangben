#!/bin/bash
# 每 5 分钟探一次本机健康检查。
# 连续两次不通才重启（约 10 分钟），避免刚好撞上更新部署时误重启。
set -uo pipefail

URL="${HEALTH_URL:-http://127.0.0.1:8080/api/health}"
SERVICE="${SERVICE:-ledger}"
STATE="${STATE_FILE:-/run/ledger-watchdog.fails}"

log() { echo "[$(date '+%F %T')] $*"; }

if curl -sf --max-time 6 "$URL" >/dev/null 2>&1; then
  [ -f "$STATE" ] && rm -f "$STATE"
  exit 0
fi

FAILS=0
if [ -f "$STATE" ]; then
  FAILS=$(cat "$STATE" 2>/dev/null || echo 0)
  case "$FAILS" in ''|*[!0-9]*) FAILS=0 ;; esac
fi
FAILS=$((FAILS + 1))
echo "$FAILS" > "$STATE"
log "健康检查失败（连续第 $FAILS 次）"

if [ "$FAILS" -lt 2 ]; then
  exit 0
fi

log "连续失败，重启 $SERVICE"
systemctl restart "$SERVICE" || log "重启命令执行失败"
rm -f "$STATE"
sleep 5

if curl -sf --max-time 8 "$URL" >/dev/null 2>&1; then
  log "重启后恢复正常"
  exit 0
fi

log "重启后仍不健康，需要人工介入"
exit 1

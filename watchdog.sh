#!/usr/bin/env bash
# ai-relay 自愈：活体/就绪/公开接口/依赖服务三项巡检，异常即重启
set -u

LOG=/opt/ai-relay/logs/watchdog.log
mkdir -p /opt/ai-relay/logs

log() {
  echo "$(date -Is) $*" >> "$LOG"
}

restart_relay() {
  log "action=restart_relay reason=$1"
  systemctl restart ai-relay
  sleep 3
}

# 1) relay 活体
health_code="$(curl -s -o /dev/null -w '%{http_code}' -m 8 http://127.0.0.1:8801/health || echo 000)"
if [ "$health_code" != "200" ]; then
  restart_relay "health=$health_code"
  health_code="$(curl -s -o /dev/null -w '%{http_code}' -m 8 http://127.0.0.1:8801/health || echo 000)"
fi

# 2) 公开接口与就绪
ready_code="$(curl -s -o /dev/null -w '%{http_code}' -m 8 http://127.0.0.1:8801/ready || echo 000)"
public_code="$(curl -s -o /dev/null -w '%{http_code}' -m 8 http://127.0.0.1:8801/api/public || echo 000)"
if [ "$public_code" != "200" ]; then
  restart_relay "public=$public_code"
fi

# 3) 依赖服务
for unit in nginx mihomo; do
  if ! systemctl is-active --quiet "$unit"; then
    log "action=restart_unit unit=$unit"
    systemctl restart "$unit" 2>/dev/null || true
  fi
done

# 4) 记录快照
token="$(cat /opt/ai-relay/token 2>/dev/null || true)"
pools="$(curl -s -m 8 -H "Authorization: Bearer ${token}" http://127.0.0.1:8801/api/pools || echo '{}')"
counts="$(printf '%s' "$pools" | python3 -c 'import json,sys; d=json.load(sys.stdin).get("pools", {}); print(len(d.get("tools", [])), len(d.get("chat", [])))' 2>/dev/null || echo 'nan nan')"
log "relay health=$health_code ready=$ready_code public=$public_code pools=$counts"

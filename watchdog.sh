#!/usr/bin/env bash
set -u

LOG=/opt/ai-relay/logs/watchdog.log
mkdir -p /opt/ai-relay/logs

log() {
  echo "$(date -Is) $*" >> "$LOG"
}

health_code="$(curl -s -o /dev/null -w '%{http_code}' -m 8 http://127.0.0.1:8801/health || echo 000)"
ready_code="$(curl -s -o /dev/null -w '%{http_code}' -m 8 http://127.0.0.1:8801/ready || echo 000)"

if [ "$health_code" != "200" ]; then
  log "relay liveness=$health_code action=restart"
  systemctl restart ai-relay
  exit 0
fi

if [ "$ready_code" = "503" ]; then
  log "relay ready=$ready_code all providers cooling down"
else
  token="$(cat /opt/ai-relay/token 2>/dev/null || true)"
  pools="$(curl -s -m 8 -H "Authorization: Bearer $token" http://127.0.0.1:8801/api/pools || echo '{}')"
  counts="$(printf '%s' "$pools" | python3 -c 'import json,sys; d=json.load(sys.stdin).get("pools", {}); print(len(d.get("tools", [])), len(d.get("chat", [])))' 2>/dev/null || echo 'nan nan')"
  log "relay healthy=$health_code ready=$ready_code pools=$counts"
fi

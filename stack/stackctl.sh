#!/usr/bin/env bash
set -u

RELAY_SERVICE=ai-relay.service
WATCHDOG_TIMER=ai-relay-watchdog.timer

relay_health() {
  curl -sS -m 8 http://127.0.0.1:8801/health 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print("ready" if d.get("ok") else "degraded")' 2>/dev/null || echo down
}

credential_summary() {
  curl -sS -m 8 http://127.0.0.1:8801/api/public 2>/dev/null |
    python3 -c 'import json,sys; d=json.load(sys.stdin).get("providerSetup", {}); print("%s configured / %s pending" % (d.get("configured", 0), d.get("pending", 0)))' 2>/dev/null ||
    echo unavailable
}

status() {
  printf '%-18s %s\n' 'relay-core' "$(systemctl is-active "$RELAY_SERVICE" 2>/dev/null || true)"
  printf '%-18s %s\n' 'relay-health' "$(relay_health)"
  printf '%-18s %s\n' 'edge-nginx' "$(systemctl is-active nginx.service 2>/dev/null || true)"
  printf '%-18s %s\n' 'provider-keys' "$(credential_summary)"
  printf '%-18s %s\n' 'provider-setup' 'http://<RELAY_HOST>:8080/setup'
  printf '%-18s %s\n' 'watchdog' "$(systemctl is-active "$WATCHDOG_TIMER" 2>/dev/null || true)"
}

start_stack() {
  systemctl start nginx.service "$RELAY_SERVICE"
  systemctl start "$WATCHDOG_TIMER" 2>/dev/null || true
}

stop_stack() {
  systemctl stop "$WATCHDOG_TIMER" 2>/dev/null || true
  systemctl stop "$RELAY_SERVICE" nginx.service
}

case "${1:-status}" in
  status)
    status
    ;;
  health)
    relay_health
    ;;
  start)
    start_stack
    status
    ;;
  stop)
    stop_stack
    ;;
  restart)
    stop_stack
    start_stack
    status
    ;;
  logs)
    journalctl -u "$RELAY_SERVICE" -n 80 --no-pager
    ;;
  login)
    printf 'Provider setup: http://<RELAY_HOST>:8080/setup\n'
    printf 'Relay API: http://<RELAY_HOST>:8080/v1\n'
    ;;
  *)
    echo "usage: stackctl {status|health|start|stop|restart|logs|login}" >&2
    exit 2
    ;;
esac

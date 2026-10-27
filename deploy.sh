#!/usr/bin/env bash
set -euo pipefail

# 部署目标从环境变量或本地 .env.local 读取（.env.local 不入库）
LOCAL_ENV="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.env.local"
if [ -f "$LOCAL_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$LOCAL_ENV"
  set +a
fi

: "${RELAY_HOST:?请设置 RELAY_HOST（如 relay.example.com 或 ~/.ssh/config 别名），可写入 .env.local}"
HOST="$RELAY_HOST"
REMOTE_DIR="${RELAY_REMOTE_DIR:-/opt/ai-relay}"
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$REMOTE_DIR/backups/$STAMP"

node --check "$LOCAL_DIR/router.js"
node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$LOCAL_DIR/config.json"

ssh "$HOST" "mkdir -p '$BACKUP_DIR'"
ssh "$HOST" "
  set -e
  test -f '$REMOTE_DIR/server.js' && cp -p '$REMOTE_DIR/server.js' '$BACKUP_DIR/server.js' || true
  test -f '$REMOTE_DIR/config.json' && cp -p '$REMOTE_DIR/config.json' '$BACKUP_DIR/config.json' || true
  test -f /etc/systemd/system/ai-relay.service && cp -p /etc/systemd/system/ai-relay.service '$BACKUP_DIR/ai-relay.service' || true
"

scp "$LOCAL_DIR/router.js" "$LOCAL_DIR/config.json" "$LOCAL_DIR/watchdog.sh" "$HOST:$REMOTE_DIR/"
scp "$LOCAL_DIR/systemd/ai-relay.service" "$HOST:/etc/systemd/system/ai-relay.service"
scp "$LOCAL_DIR/systemd/ai-relay-watchdog.service" "$LOCAL_DIR/systemd/ai-relay-watchdog.timer" "$HOST:/etc/systemd/system/"

if ! ssh "$HOST" "
  set -e
  chmod 755 '$REMOTE_DIR/watchdog.sh'
  node --check '$REMOTE_DIR/router.js'
  systemctl daemon-reload
  systemctl enable --now ai-relay-watchdog.timer
  systemctl restart ai-relay
  for i in \$(seq 1 30); do
    code=\$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:8801/health || echo 000)
    [ \"\$code\" = 200 ] && exit 0
    sleep 1
  done
  exit 1
"; then
  ssh "$HOST" "
    set -e
    cp -p '$BACKUP_DIR/server.js' '$REMOTE_DIR/server.js' 2>/dev/null || true
    cp -p '$BACKUP_DIR/config.json' '$REMOTE_DIR/config.json' 2>/dev/null || true
    cp -p '$BACKUP_DIR/ai-relay.service' /etc/systemd/system/ai-relay.service 2>/dev/null || true
    systemctl daemon-reload
    systemctl restart ai-relay
  "
  echo "deployment failed; rolled back from $BACKUP_DIR" >&2
  exit 1
fi

echo "deployed router to $HOST:$REMOTE_DIR (backup: $BACKUP_DIR)"

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
  test -f '$REMOTE_DIR/router.js' && cp -p '$REMOTE_DIR/router.js' '$BACKUP_DIR/router.js' || true
  test -f '$REMOTE_DIR/server.js' && cp -p '$REMOTE_DIR/server.js' '$BACKUP_DIR/server.js' || true
  test -f '$REMOTE_DIR/config.json' && cp -p '$REMOTE_DIR/config.json' '$BACKUP_DIR/config.json' || true
  test -f '$REMOTE_DIR/dashboard.html' && cp -p '$REMOTE_DIR/dashboard.html' '$BACKUP_DIR/dashboard.html' || true
  test -f '$REMOTE_DIR/provider-setup.html' && cp -p '$REMOTE_DIR/provider-setup.html' '$BACKUP_DIR/provider-setup.html' || true
  test -f '$REMOTE_DIR/provider-catalog.json' && cp -p '$REMOTE_DIR/provider-catalog.json' '$BACKUP_DIR/provider-catalog.json' || true
  test -f '$REMOTE_DIR/watchdog.sh' && cp -p '$REMOTE_DIR/watchdog.sh' '$BACKUP_DIR/watchdog.sh' || true
  test -f /etc/systemd/system/ai-relay.service && cp -p /etc/systemd/system/ai-relay.service '$BACKUP_DIR/ai-relay.service' || true
"

scp "$LOCAL_DIR/router.js" "$LOCAL_DIR/config.json" "$LOCAL_DIR/watchdog.sh" "$LOCAL_DIR/dashboard.html" "$LOCAL_DIR/provider-setup.html" "$LOCAL_DIR/provider-catalog.json" "$LOCAL_DIR/score-run.sh" "$HOST:$REMOTE_DIR/"

# v6.0.0：源维护管道（scripts/ + data/ + docs/）整体同步，不触碰 token/secrets/state/logs。
# 用 tar 一次传完，避免逐个 scp 漏文件；data/ 里的 history/audit 是追加型证据，远端同名文件会被本机版本覆盖。
TARBALL="/tmp/ftc-sources-$STAMP.tgz"
# COPYFILE_DISABLE=1：macOS tar 默认写入 com.apple.provenance 扩展头，Linux tar 会刷警告
COPYFILE_DISABLE=1 tar --no-xattrs -C "$LOCAL_DIR" -czf "$TARBALL" scripts data docs
scp "$TARBALL" "$HOST:/tmp/ftc-sources-$STAMP.tgz"
rm -f "$TARBALL"
ssh "$HOST" "
  set -e
  mkdir -p '$REMOTE_DIR/scripts' '$REMOTE_DIR/data' '$REMOTE_DIR/docs'
  tar -xzf /tmp/ftc-sources-$STAMP.tgz -C '$REMOTE_DIR'
  rm -f /tmp/ftc-sources-$STAMP.tgz
  chmod 755 '$REMOTE_DIR/scripts/sources-cron.sh' '$REMOTE_DIR/score-run.sh'
"

scp "$LOCAL_DIR/systemd/ai-relay.service" "$HOST:/etc/systemd/system/ai-relay.service"
scp "$LOCAL_DIR/systemd/ai-relay-watchdog.service" "$LOCAL_DIR/systemd/ai-relay-watchdog.timer" "$HOST:/etc/systemd/system/"
scp "$LOCAL_DIR/systemd/ai-relay-score.service" "$LOCAL_DIR/systemd/ai-relay-score.timer" "$HOST:/etc/systemd/system/"
scp "$LOCAL_DIR/systemd/ai-relay-sources.service" "$LOCAL_DIR/systemd/ai-relay-sources.timer" "$HOST:/etc/systemd/system/"

if ! ssh "$HOST" "
  set -e
  install -d -m 700 '$REMOTE_DIR/state'
  chmod 755 '$REMOTE_DIR/watchdog.sh'
  chmod 600 '$REMOTE_DIR/config.json'
  node --check '$REMOTE_DIR/router.js'
  systemctl daemon-reload
  systemctl enable --now ai-relay-watchdog.timer
  chmod 755 '$REMOTE_DIR/score-run.sh' '$REMOTE_DIR/scripts/sources-cron.sh'
  systemctl enable --now ai-relay-score.timer
  systemctl enable --now ai-relay-sources.timer
  systemctl restart ai-relay
  for i in \$(seq 1 30); do
    code=\$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:8801/health || echo 000)
    [ \"\$code\" = 200 ] && break
    sleep 1
  done
  [ \"\$code\" = 200 ] || { echo 'health check failed' >&2; exit 1; }
  curl -s --max-time 3 http://127.0.0.1:8801/api/info | grep -q version || { echo 'api/info failed' >&2; exit 1; }
  exit 0
"; then
  ssh "$HOST" "
    set -e
    cp -p '$BACKUP_DIR/router.js' '$REMOTE_DIR/router.js' 2>/dev/null || true
    cp -p '$BACKUP_DIR/server.js' '$REMOTE_DIR/server.js' 2>/dev/null || true
    cp -p '$BACKUP_DIR/config.json' '$REMOTE_DIR/config.json' 2>/dev/null || true
    cp -p '$BACKUP_DIR/dashboard.html' '$REMOTE_DIR/dashboard.html' 2>/dev/null || true
    cp -p '$BACKUP_DIR/provider-setup.html' '$REMOTE_DIR/provider-setup.html' 2>/dev/null || true
    cp -p '$BACKUP_DIR/provider-catalog.json' '$REMOTE_DIR/provider-catalog.json' 2>/dev/null || true
    cp -p '$BACKUP_DIR/watchdog.sh' '$REMOTE_DIR/watchdog.sh' 2>/dev/null || true
    cp -p '$BACKUP_DIR/ai-relay.service' /etc/systemd/system/ai-relay.service 2>/dev/null || true
    systemctl daemon-reload
    systemctl restart ai-relay
  "
  echo "deployment failed; rolled back from $BACKUP_DIR" >&2
  exit 1
fi

echo "deployed router to $HOST:$REMOTE_DIR (backup: $BACKUP_DIR)"

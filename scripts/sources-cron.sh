#!/usr/bin/env bash
# 服务器端每日源复核入口（systemd ai-relay-sources.timer）。
# 只读复核：探测本机可达性并写 data/runtime-health.json，不改注册表状态/目录/文档。
# 权威更新由 GitHub Actions 的 sources:all 完成（境外 runner 网络更完整），
# 避免「101 服务器连不上某境外域名」被误写成「该免费源已失效」。
# 不重启 relay、不改 config.json，不影响正在运行的服务。
set -u
RELAY_DIR="${RELAY_DIR:-/opt/ai-relay}"
LOG_DIR="$RELAY_DIR/logs"
mkdir -p "$LOG_DIR"
cd "$RELAY_DIR" || { echo "relay dir missing: $RELAY_DIR" >&2; exit 1; }

if [ ! -f scripts/sources.mjs ] || [ ! -f data/sources.json ]; then
  echo "source pipeline not deployed: needs scripts/sources.mjs + data/sources.json" >&2
  exit 1
fi

export SOURCES_TIMEOUT_MS="${SOURCES_TIMEOUT_MS:-10000}"
export SOURCES_CONCURRENCY="${SOURCES_CONCURRENCY:-6}"
export SOURCES_RUNTIME_ID="${SOURCES_RUNTIME_ID:-$(hostname)}"

STAMP="$(date -u +%FT%TZ)"
echo "[$STAMP] runtime-check start ($SOURCES_RUNTIME_ID)" >> "$LOG_DIR/sources.log"
node scripts/sources.mjs runtime-check >> "$LOG_DIR/sources.log" 2>&1
CODE=$?
echo "[$STAMP] runtime-check exit=$CODE" >> "$LOG_DIR/sources.log"
exit "$CODE"

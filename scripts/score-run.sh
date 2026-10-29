#!/usr/bin/env bash
# 每日巡检：调用 relay 自身的评分接口，探测所有启用上游
set -u
TOKEN="$(cat /opt/ai-relay/token 2>/dev/null || true)"
if [ -z "$TOKEN" ]; then
  echo "relay token missing" >&2
  exit 1
fi
curl -s -m 600 -X POST \
  -H "Authorization: Bearer ***" \
  http://127.0.0.1:8801/api/score/run
echo

#!/usr/bin/env bash
# 每日巡检：调用 relay 自身的评分接口，探测所有启用上游。
# v6.0.0 修复：此前读取了 token 却硬编码 `Bearer ***`，/api/score/run 位于鉴权门之后，
# 每日 09:00 的定时任务一直返回 401，评分巡检从未真正执行。
set -u
TOKEN_FILE="${RELAY_TOKEN_FILE:-/opt/ai-relay/token}"
TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null || true)"
if [ -z "$TOKEN" ]; then
  echo "relay token missing at $TOKEN_FILE" >&2
  exit 1
fi

# 用 curl --config - 从 stdin 传 header，避免 token 出现在命令行参数 / ps 输出里。
RESPONSE="$({ printf 'header = "Authorization: Bearer %s"\n' "$TOKEN"
              printf 'header = "Content-Type: application/json"\n'; } \
            | curl -s -m 600 -w '\n%{http_code}' --config - -X POST \
                http://127.0.0.1:8801/api/score/run)"
CODE="${RESPONSE##*$'\n'}"
BODY="${RESPONSE%$'\n'*}"
printf '%s\n' "$BODY"
if [ "$CODE" != "200" ]; then
  echo "score run failed: HTTP $CODE" >&2
  exit 1
fi

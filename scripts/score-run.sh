#!/usr/bin/env bash
# 兼容入口：实际逻辑统一在仓库根目录 score-run.sh（避免两份副本漂移）。
# systemd ai-relay-score.service 指向 /opt/ai-relay/score-run.sh。
set -u
exec "$(dirname "$0")/../score-run.sh" "$@"

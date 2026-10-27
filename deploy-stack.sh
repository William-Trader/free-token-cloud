#!/usr/bin/env bash
set -euo pipefail

LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_ENV="$LOCAL_DIR/.env.local"
if [ -f "$LOCAL_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$LOCAL_ENV"
  set +a
fi

: "${RELAY_HOST:?RELAY_HOST is required}"
HOST="$RELAY_HOST"
ROOT=/opt/free-token-cloud

ssh "$HOST" "install -d -m 755 '$ROOT' '$ROOT/bin' '$ROOT/stack' '$ROOT/docs' '$ROOT/components'"
scp "$LOCAL_DIR/stack/MANIFEST.json" "$LOCAL_DIR/stack/provider-policy.json" "$HOST:$ROOT/stack/"
scp "$LOCAL_DIR/stack/stackctl.sh" "$HOST:$ROOT/bin/stackctl"
scp "$LOCAL_DIR/docs/ARCHITECTURE.md" "$LOCAL_DIR/docs/PROVIDER-SOURCES.md" "$LOCAL_DIR/docs/HARNESS.md" "$HOST:$ROOT/docs/"
scp "$LOCAL_DIR/LICENSE" "$HOST:$ROOT/"

ssh "$HOST" "
  set -e
  chmod 755 '$ROOT/bin/stackctl'
  ln -sfn /opt/ai-relay '$ROOT/components/relay-core'
  ln -sfn /etc/nginx/sites-available/ai-relay '$ROOT/components/nginx-ai-relay'
  '$ROOT/bin/stackctl' status
"

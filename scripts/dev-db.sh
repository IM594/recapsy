#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${HOME}/Library/Application Support/RecaplySense/db"
BIND_ADDR="127.0.0.1:21890"
LOG_LEVEL="info"

mkdir -p "${DATA_DIR}"

echo "Starting SurrealDB standalone..."
echo "  Bind: ${BIND_ADDR}"
echo "  Data: ${DATA_DIR}"
echo ""

exec surreal start \
  --bind "${BIND_ADDR}" \
  --user root \
  --pass root \
  --log "${LOG_LEVEL}" \
  "surrealkv://${DATA_DIR}"

#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

PYTHON_BIN="${PYTHON_BIN:-}"
if [[ -z "$PYTHON_BIN" ]]; then
  BUNDLED_PYTHON="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3"
  if [[ -x "$BUNDLED_PYTHON" ]]; then
    PYTHON_BIN="$BUNDLED_PYTHON"
  else
    PYTHON_BIN="python3"
  fi
fi

"$PYTHON_BIN" scripts/financial_monitor_pipeline.py \
  --profile prod \
  --clients "Ventus" \
  --output outputs/financial_monitor/financial_monitor_pipeline.xlsx

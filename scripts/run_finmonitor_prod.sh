#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

python3 scripts/financial_monitor_pipeline.py \
  --profile prod \
  --clients "Ventus" \
  --output outputs/financial_monitor/financial_monitor_pipeline.xlsx

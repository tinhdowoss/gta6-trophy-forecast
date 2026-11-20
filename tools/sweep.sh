#!/bin/sh
# Runs tools/backtest.ts once per FORECAST_PARAMS JSON given on the command line and prints the overall and final-shape
# losses of main.ts for each, so parameter choices can be compared side by side.
#   sh tools/sweep.sh '{"spreadExp":0.75}' '{"spreadExp":1}'   [CASES=<dir>]
cd "$(dirname "$0")/.." || exit 1
for p in "$@"; do
  r=$(FORECAST_PARAMS="$p" node tools/backtest.ts --quiet ${CASES:+--cases "$CASES"} | grep -E '^(ALL|final) +main' | awk '{print $1"="$4" cov="$7}' | tr '\n' ' ')
  echo "$r $p"
done

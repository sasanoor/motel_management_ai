#!/usr/bin/env bash
# MotelMitra - stop the app on Mac / Linux:  ./stop_app.sh
cd "$(dirname "$0")"
for name in backend frontend; do
  f="logs/.$name.pid"
  if [ -f "$f" ]; then pkill -P "$(cat "$f")" 2>/dev/null; kill "$(cat "$f")" 2>/dev/null; rm -f "$f"; fi
done
echo "[$(date '+%F %T')] MotelMitra stopped." | tee -a "logs/start_app_$(date +%F).txt"

#!/usr/bin/env bash
# MotelMitra - start the whole app on Mac / Linux:  ./start_app.sh
# Logs: logs/start_app_YYYY-MM-DD.txt, logs/backend_YYYY-MM-DD.txt, logs/frontend_YYYY-MM-DD.txt
cd "$(dirname "$0")"
ROOT="$(pwd)"
LAN=1                       # 1 = localhost + WiFi (default), 0 = this PC only
FRONT_PORT=5173; BACK_PORT=8000
D="$(date +%F)"
mkdir -p logs
LOG="$ROOT/logs/start_app_$D.txt"
log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }
fail() { log "ERROR: $*"; exit 1; }

log "================ Starting MotelMitra ================"

# detect this machine's IPv4 address (default-route interface first)
IP=""
if [ "$LAN" = "1" ]; then
  IP="$(ipconfig getifaddr "$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')" 2>/dev/null)"
  [ -z "$IP" ] && IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')"
  [ -z "$IP" ] && IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [ -z "$IP" ]; then log "WARNING: no network IPv4 address found, starting on this machine only."; LAN=0; else log "This machine's IPv4 address: $IP"; fi
fi
if [ "$LAN" = "1" ]; then
  BIND=0.0.0.0
  export ALLOWED_HOSTS="127.0.0.1,localhost,$IP"
  export CORS_ALLOWED_ORIGINS="http://localhost:$FRONT_PORT,http://127.0.0.1:$FRONT_PORT,http://$IP:$FRONT_PORT"
else
  BIND=127.0.0.1
  export ALLOWED_HOSTS="127.0.0.1,localhost"
  export CORS_ALLOWED_ORIGINS="http://localhost:$FRONT_PORT,http://127.0.0.1:$FRONT_PORT"
fi
links() {
  log "This machine:  http://localhost:$FRONT_PORT"
  [ "$LAN" = "1" ] && log "Other devices: http://$IP:$FRONT_PORT"
  { echo "MotelMitra links (updated $(date '+%F %T'))"; echo
    echo "This machine:     http://localhost:$FRONT_PORT"
    [ "$LAN" = "1" ] && { echo "WiFi devices:     http://$IP:$FRONT_PORT"; echo "Django admin:     http://$IP:$BACK_PORT/admin/"; }
    echo; echo "The WiFi address can change if the router restarts. Start the app again to refresh it."; } > "$ROOT/app_links.txt"
}
APPVER="$(cat "$ROOT/VERSION" 2>/dev/null | tr -d '[:space:]')"
if curl -s -o /dev/null http://localhost:5173; then
  RUNNING="$(curl -s http://127.0.0.1:8000/api/version/ | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
  if [ "$RUNNING" = "$APPVER" ]; then
    log "MotelMitra is already running (version $APPVER)."; links; exit 0
  fi
  log "Update found: restarting MotelMitra to load version $APPVER..."
  "$ROOT/stop_app.sh" >/dev/null 2>&1; sleep 2
fi

PY="$(command -v python3 || command -v python)" || fail "Python not found."
command -v npm >/dev/null || fail "Node.js not found."
log "Python: $($PY --version 2>&1)   Node: $(node --version)"

[ -f backend/.env ] || { cp backend/.env.example backend/.env; log "WARNING: created backend/.env from .env.example. Set your DB password."; }

$PY -c "import django, rest_framework, corsheaders, rest_framework_simplejwt, dotenv" 2>/dev/null || {
  log "Installing Python packages (first run)..."
  $PY -m pip install -r backend/requirements.txt >>"$LOG" 2>&1 || fail "pip install failed. See $LOG"
}
[ -d frontend/node_modules ] || {
  log "Installing frontend packages (first run)..."
  (cd frontend && npm install >>"$LOG" 2>&1) || fail "npm install failed. See $LOG"
}

log "Applying database updates..."
(cd backend && $PY manage.py migrate --noinput >>"$LOG" 2>&1) || fail "Database update failed. Check MySQL and backend/.env"

find logs -name '*.txt' -mtime +30 -delete 2>/dev/null

log "Starting backend on $BIND:$BACK_PORT, log file: logs/backend_$D.txt"
( cd backend && echo -e "\n===== Backend started $(date '+%F %T') on $BIND:$BACK_PORT (allowed hosts: $ALLOWED_HOSTS) =====" >>"$ROOT/logs/backend_$D.txt"
  PYTHONUNBUFFERED=1 nohup $PY manage.py runserver $BIND:$BACK_PORT --noreload >>"$ROOT/logs/backend_$D.txt" 2>&1 &
  echo $! > "$ROOT/logs/.backend.pid" )

log "Starting frontend on $BIND:$FRONT_PORT, log file: logs/frontend_$D.txt"
( cd frontend && echo -e "\n===== Frontend started $(date '+%F %T') =====" >>"$ROOT/logs/frontend_$D.txt"
  NO_COLOR=1 nohup node node_modules/vite/bin/vite.js --host $BIND --port $FRONT_PORT --strictPort >>"$ROOT/logs/frontend_$D.txt" 2>&1 &
  echo $! > "$ROOT/logs/.frontend.pid" )

log "Waiting for the app to come up..."
for i in $(seq 40); do curl -s -o /dev/null http://127.0.0.1:8000/api/auth/me/ && break; sleep 1; done
curl -s -o /dev/null http://127.0.0.1:8000/api/auth/me/ || fail "Backend did not start. See logs/backend_$D.txt"
for i in $(seq 40); do curl -s -o /dev/null http://localhost:5173 && break; sleep 1; done
curl -s -o /dev/null http://localhost:5173 || fail "Frontend did not start. See logs/frontend_$D.txt"

if [ "$LAN" = "1" ]; then
  if curl -s -o /dev/null --max-time 4 "http://$IP:$FRONT_PORT"; then log "WiFi address check: OK"
  else log "WARNING: app is not answering on $IP. Other devices may not connect (check firewall)."; fi
fi
log "MotelMitra is running."
links
{ command -v open >/dev/null && open http://localhost:5173 || xdg-open http://localhost:5173; } >/dev/null 2>&1
log "To stop: ./stop_app.sh"

#!/usr/bin/env bash
# Local test environment: every Worker under `wrangler dev`, one shared set of
# local D1 databases, test-only secrets. Nothing here touches production
# (the maintenance gate still reads admin.inpriv.xyz/public/state, read-only).
#
#   tests/local.sh up     create databases + .dev.vars, start the Workers
#   tests/local.sh down   stop them and delete the local state and .dev.vars
#
# Ports: landing 8795, temp 8796, admin 8797, id 8798, mail 8799, and the
# test-only HTML sanitizer Worker on 8794.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.wrangler/t"            # gitignored
LOGS="$ROOT/.wrangler/logs"
WR="npx --yes wrangler@4.83.0"
# test-only values, never used anywhere real
ENC_KEY="test-only-key-0123456789abcdefgh"            # 32 bytes
SERVICE_KEY="test-service-key-not-real"
WHSEC="whsec_dGVzdC1vbmx5LXdlYmhvb2stc2VjcmV0LTEyMzQ="
TOTP="JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"

workers=("worker:8795" ".temp/worker:8796" ".admin/worker:8797" ".id/worker:8798" ".mail/worker:8799" "tests/html-worker:8794")

up() {
  mkdir -p "$STATE" "$LOGS"
  cat > "$ROOT/.id/worker/.dev.vars" <<EOF
ID_ENC_KEY=$ENC_KEY
SERVICE_KEY=$SERVICE_KEY
DEV_MAIL_LOG=1
DEV_ORIGINS=http://127.0.0.1:8799,http://localhost:8799
EOF
  cat > "$ROOT/.mail/worker/.dev.vars" <<EOF
ID_ENC_KEY=$ENC_KEY
SERVICE_KEY=$SERVICE_KEY
RESEND_WEBHOOK_SECRET=$WHSEC
ID_ORIGIN=http://127.0.0.1:8798
EOF
  cat > "$ROOT/.temp/worker/.dev.vars" <<EOF
RESEND_WEBHOOK_SECRET=$WHSEC
EOF
  cat > "$ROOT/.admin/worker/.dev.vars" <<EOF
ADMIN_USER=test-admin
TOTP_SECRET=$TOTP
EOF
  (cd "$ROOT/.id/worker" && $WR d1 execute inpriv-id --local --persist-to "$STATE" --file ../schema.sql >/dev/null)
  (cd "$ROOT/.mail/worker" && $WR d1 execute inpriv-mail --local --persist-to "$STATE" --file ../schema.sql >/dev/null)
  (cd "$ROOT/.temp/worker" && $WR d1 execute inpriv-temp --local --persist-to "$STATE" --file schema.sql >/dev/null)
  for w in "${workers[@]}"; do
    dir="${w%%:*}"; port="${w##*:}"
    # A copy of wrangler.toml without the production routes: wrangler dev
    # then hands the Worker the real local URL (no https/www redirect, dev
    # cookie names) and doesn't rewrite hosts in headers.
    python3 -c 'import re,sys; s=open(sys.argv[1]).read(); open(sys.argv[2],"w").write(re.sub(r"(?ms)^routes = \[.*?^\]\n", "", s))' \
      "$ROOT/$dir/wrangler.toml" "$ROOT/$dir/wrangler.dev.toml"
    (cd "$ROOT/$dir" && setsid nohup $WR dev -c wrangler.dev.toml --local --persist-to "$STATE" --port "$port" --ip 127.0.0.1 \
      --test-scheduled < /dev/null > "$LOGS/$port.log" 2>&1 & echo $! >> "$LOGS/pids")
    sleep 2
  done
  for w in "${workers[@]}"; do
    port="${w##*:}"
    for _ in $(seq 1 60); do
      curl -s -o /dev/null --max-time 5 "http://127.0.0.1:$port/" && break
      sleep 1
    done
  done
  echo "up: logs in $LOGS"
}

down() {
  # each Worker runs in its own session (setsid): stop the whole group
  if [ -f "$LOGS/pids" ]; then
    while read -r pid; do kill -- "-$pid" 2>/dev/null || true; done < "$LOGS/pids"
    sleep 1
  fi
  for port in 8794 8795 8796 8797 8798 8799; do
    pid=$(ss -ltnp 2>/dev/null | grep ":$port " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)
    [ -n "$pid" ] && { kill "$pid" 2>/dev/null; sleep 1; kill -9 "$pid" 2>/dev/null; } || true
  done
  rm -f "$ROOT/.id/worker/.dev.vars" "$ROOT/.mail/worker/.dev.vars" "$ROOT/.temp/worker/.dev.vars" "$ROOT/.admin/worker/.dev.vars"
  for w in "${workers[@]}"; do rm -f "$ROOT/${w%%:*}/wrangler.dev.toml"; done
  rm -rf "$STATE" "$LOGS"
  echo down
}

"${1:-up}"

#!/usr/bin/env bash
# Install htmlz as a systemd service on any Linux box with python3.11+.
# Run as root. Idempotent — re-run to re-deploy.
#
#   sudo bash infra/systemd-install.sh
#
# For containerized deploys, use the Dockerfile + docker-compose.yml at the
# repo root instead.

set -euo pipefail

[ "$EUID" = "0" ] || { echo "run as root (sudo)"; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${HTMLZ_PORT:-80}"

# ── deps ──────────────────────────────────────────────────────────────
PY=""
for c in python3.11 python3.12 python3.13 python3; do
  if command -v "$c" >/dev/null 2>&1; then
    ver=$($c -c 'import sys; print(sys.version_info[0]*100+sys.version_info[1])')
    if [ "$ver" -ge 310 ]; then PY="$c"; break; fi
  fi
done
[ -n "$PY" ] || { echo "need python ≥ 3.10"; exit 1; }
echo "using $PY ($($PY --version))"

$PY -m pip install --quiet \
  fastapi==0.115.0 \
  uvicorn==0.30.6 \
  python-multipart==0.0.20 \
  beautifulsoup4==4.12.3

# ── install files ─────────────────────────────────────────────────────
install -d -m 0755 /etc/htmlz /etc/htmlz/skill
install -d -m 0755 /var/htmlz/data /var/htmlz/state/comments

install -m 0644 "$ROOT/api/app.py"               /etc/htmlz/app.py
install -m 0644 "$ROOT/api/widget.js"            /etc/htmlz/widget.js
install -m 0755 "$ROOT/skill/htmlz"              /etc/htmlz/skill/htmlz
install -m 0644 "$ROOT/skill/SKILL.md"           /etc/htmlz/skill/SKILL.md
install -m 0755 "$ROOT/skill/install-remote.sh"  /etc/htmlz/skill/install-remote.sh

# ── systemd unit ──────────────────────────────────────────────────────
cat > /etc/systemd/system/htmlz.service <<UNIT
[Unit]
Description=htmlz HTML page host
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$(command -v $PY) -m uvicorn app:app --app-dir /etc/htmlz --host 0.0.0.0 --port $PORT
Environment=HTMLZ_DATA_ROOT=/var/htmlz/data
Environment=HTMLZ_MANIFEST=/var/htmlz/state/manifest.json
Environment=HTMLZ_COMMENTS_DIR=/var/htmlz/state/comments
Environment=HTMLZ_WIDGET=/etc/htmlz/widget.js
Environment=HTMLZ_SKILL_DIR=/etc/htmlz/skill
Environment=HTMLZ_INSTALL_SCRIPT=/etc/htmlz/skill/install-remote.sh
Restart=always
RestartSec=5
User=root
StandardOutput=append:/var/log/htmlz.log
StandardError=append:/var/log/htmlz.log

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now htmlz.service

sleep 2
if curl -fsS "http://127.0.0.1:$PORT/healthz" > /dev/null; then
  echo "✓ htmlz is running on :$PORT"
  echo "  logs: journalctl -u htmlz.service -f"
else
  echo "✗ healthcheck failed — see: journalctl -u htmlz.service -n 50"
  exit 1
fi

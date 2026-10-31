#!/bin/bash
# NexusMail one-paste installer for a Google Compute Engine Ubuntu VM (use as the VM's "Startup script").
# Metadata keys (VM > Edit > Custom metadata):  admin-password (required), gemini-key (optional),
#   repo-url (default https://github.com/balitandsons/nexusmail.git), github-token (only if the repo is private),
#   domain (optional; default <ip>.sslip.io, which needs no DNS setup).
# Safe to re-run: every reboot it pulls the latest code, rebuilds and restarts.
set -euo pipefail
exec > >(tee -a /var/log/nexusmail-setup.log) 2>&1

md() { curl -fs -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" || true; }
ADMIN_PASSWORD="$(md admin-password)"
GEMINI_KEY="$(md gemini-key)"
REPO="$(md repo-url)"; REPO="${REPO:-https://github.com/balitandsons/nexusmail.git}"
GH_TOKEN="$(md github-token)"
DOMAIN="$(md domain)"
[ -n "$ADMIN_PASSWORD" ] || { echo "Set the 'admin-password' metadata key first."; exit 1; }
IP="$(curl -fs -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip)"
DOMAIN="${DOMAIN:-${IP//./-}.sslip.io}"
APP=/opt/nexusmail

# 1 GB VMs run out of memory while building, so add swap once.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

export DEBIAN_FRONTEND=noninteractive
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gpg git
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi
apt-get install -y git

id nexusmail >/dev/null 2>&1 || useradd --system --create-home --home-dir "$APP" --shell /usr/sbin/nologin nexusmail
CLONE_URL="$REPO"; [ -n "$GH_TOKEN" ] && CLONE_URL="${REPO/https:\/\//https://x-access-token:${GH_TOKEN}@}"
if [ -d "$APP/src/.git" ]; then
  git -C "$APP/src" remote set-url origin "$CLONE_URL"; git -C "$APP/src" pull --ff-only
else
  git clone "$CLONE_URL" "$APP/src"
fi
git -C "$APP/src" remote set-url origin "$REPO"   # don't leave the token on disk
mkdir -p "$APP/data"

cat > "$APP/.env" <<ENV
ADMIN_PASSWORD=$ADMIN_PASSWORD
PORT=3000
TRUST_PROXY=1
APP_TIMEZONE=Asia/Kolkata
PUBLIC_URL=https://$DOMAIN
DATA_DIR=$APP/data
GEMINI_API_KEY=$GEMINI_KEY
GEMINI_MODEL=gemini-3.8-flash
ENV
chmod 600 "$APP/.env"
chown -R nexusmail:nexusmail "$APP"

sudo -u nexusmail bash -c "cd $APP/src && npm ci --no-audit --no-fund && npm run build"

cat > /etc/systemd/system/nexusmail.service <<UNIT
[Unit]
Description=NexusMail
After=network-online.target
[Service]
User=nexusmail
WorkingDirectory=$APP/src
EnvironmentFile=$APP/.env
ExecStart=/usr/bin/npx tsx server/index.ts
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
  reverse_proxy 127.0.0.1:3000
}
CADDY

systemctl daemon-reload
systemctl enable nexusmail
systemctl restart nexusmail
systemctl restart caddy
echo "NexusMail is running at https://$DOMAIN"

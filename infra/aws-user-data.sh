#!/bin/bash
# EC2 user-data for htmlz. Runs once at first boot via cloud-init.
# Tested on Amazon Linux 2023 (ARM64 and x86_64).
#
# What this does:
#   1. Installs Docker + Compose plugin + git.
#   2. Clones https://github.com/kaushalvivek/htmlz to /opt/htmlz.
#   3. Brings it up via `docker compose up -d --build`.
#   4. Writes a smoke-test result to /var/log/htmlz-bootstrap.log.

set -euxo pipefail

dnf update -y
dnf install -y docker git

# Compose plugin (AL2023 ships docker, but not the plugin).
ARCH=$(uname -m)
install -d -m 0755 /usr/libexec/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${ARCH}" \
  -o /usr/libexec/docker/cli-plugins/docker-compose
chmod +x /usr/libexec/docker/cli-plugins/docker-compose

systemctl enable --now docker
# So `ec2-user` can run docker once you SSM in:
usermod -aG docker ec2-user

# Clone + run.
cd /opt
git clone --depth 1 https://github.com/kaushalvivek/htmlz htmlz
cd htmlz
docker compose up -d --build

# Smoke check.
sleep 5
{
  echo "==> $(date -u +%FT%TZ)  htmlz bootstrap"
  docker compose ps
  curl -fsS http://127.0.0.1:8000/healthz && echo
} > /var/log/htmlz-bootstrap.log 2>&1 || echo "healthcheck failed — see logs" >> /var/log/htmlz-bootstrap.log

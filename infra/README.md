# infra/

How to deploy htmlz. Two paths — pick whichever you prefer.

## Path A: Docker (recommended)

From the repo root:

```bash
docker compose up -d --build
```

The service listens on `:8000`. Data lives in `./data/` (the published HTML
files) and `./state/` (the manifest + per-page comments) on the host.
Both directories survive container rebuilds.

Logs:

```bash
docker logs -f htmlz
```

Update:

```bash
git pull
docker compose up -d --build
```

## Path B: systemd on a Linux box

For a single VM or VPS (no Docker). Needs Python 3.10+ and `pip`.

```bash
sudo bash infra/systemd-install.sh
```

The installer:

- Installs `fastapi`, `uvicorn`, `python-multipart`, `beautifulsoup4` via pip.
- Drops `app.py`, `widget.js`, and the skill files into `/etc/htmlz/`.
- Creates `/var/htmlz/data/` and `/var/htmlz/state/`.
- Writes `/etc/systemd/system/htmlz.service` and starts it.
- Runs a healthcheck against `http://127.0.0.1:80/healthz`.

Override the port with `HTMLZ_PORT=8080 sudo -E bash infra/systemd-install.sh`.

Logs:

```bash
journalctl -u htmlz.service -f
# or
sudo tail -f /var/log/htmlz.log
```

Update — re-run the installer; the service restarts itself.

## Landing page

`infra/index.html` is the page served at `/`. It tells visitors how to
install the agent skill against *this* server (the displayed URL is
templated client-side from `window.location`, so it always matches the
host they hit).

For Docker, copy it into the mounted data volume:

```bash
cp infra/index.html ./data/index.html
```

For systemd, copy it after install:

```bash
sudo cp infra/index.html /var/htmlz/data/index.html
```

## Trust model

There is no authentication. The URL is the credential — anyone who can
reach this server *and* has the URL of a page can read, update, comment,
and delete that page. Slugs end in a 10-character base32 random suffix
(~50 bits of entropy) so they aren't guessable, and there is no
enumeration endpoint.

That model only works if your *network* is private. Put htmlz behind one
of these:

- **Tailscale / ZeroTier / Nebula** — only your devices can reach it.
- **A VPN** (WireGuard, OpenVPN, Tailscale Funnel with ACLs).
- **Cloudflare Access** or similar zero-trust proxy.
- **A home LAN** behind a NAT router.
- **A private cloud subnet** (AWS VPC, GCP VPC, etc.).

Do **not** put it on the public internet without one of these in front of
it. The trust model is "the network is private," not "the URL is secret
against an attacker who can scan ports."

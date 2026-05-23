# htmlz

> A self-hosted home for the HTML your AI agents make.

You ask Claude Code (or Codex, or anything else with shell access) to
build a weekly report. Twenty seconds later it has a beautiful
self-contained HTML file. Now what?

- Drop it in Notion? It strips the JavaScript.
- Email it? Goes to a graveyard.
- A gist? Renders as source, not as a page.
- Vercel? Deploy pipeline, build config, custom domain, dashboard.
- Pastebin? Public.

**htmlz is the missing answer.** One small server on a network you
control. Your agent runs `htmlz publish ./report.html` and gets back a
URL it can share with anyone else on that network. They open it; the
page works exactly as authored, plus a thin comments-and-edit layer
injected on top.

```text
you: "host this report on htmlz"
agent → htmlz publish ./report.html
       ↓
       ✓ http://your-htmlz/weekly-report-t6gyf2rfns/
         (copied to clipboard)
```

No accounts. No database. No CDN. No build pipeline. Two volumes on disk
and ~4k lines of code including docs.

---

## Quickstart

```bash
git clone https://github.com/kaushalvivek/htmlz
cd htmlz
docker compose up -d --build
```

Open <http://localhost:8000>. The landing page tells you how to wire up
your agent. Two volumes are mounted next to the repo — `./data/` for
published pages, `./state/` for the manifest and comments. Both survive
container rebuilds; both are safe to back up with rsync.

For non-Docker deploys (bare systemd on a Linux box), see
[`infra/README.md`](infra/README.md).

## Wire up your agent

From any machine that can reach your htmlz server:

```bash
curl -fsSL http://YOUR-HTMLZ-SERVER/install.sh | bash
htmlz identity "your name"
```

The installer:

- Detects `~/.claude/` and `~/.codex/` and installs the skill into
  whichever it finds.
- Symlinks the `htmlz` CLI into `~/.local/bin/`.
- Writes the server URL into `~/.config/htmlz/config.json` so the CLI
  auto-points at the server you installed from. No `HTMLZ_BASE` ceremony.

After that, you don't run the CLI yourself — your agent does:

> "Host this report on htmlz."
>
> "Update the weekly-report page with this new file."
>
> "Comment on the Open Questions section — we should also surface the churn cohort."
>
> "Reply to that comment — agreed, drafting the change now."
>
> "Resolve the open-questions thread."

The skill manifest (read by Claude Code and Codex) is in
[`skill/SKILL.md`](skill/SKILL.md); the CLI it wraps is
[`skill/htmlz`](skill/htmlz).

## What every published page does

The widget is automatically injected before `</body>` on every HTML
response. The publisher does nothing — they write plain HTML.

- **Serves as-is.** Scripts, styles, Chart.js, Mermaid, an embedded
  three.js scene — anything the browser can render works untouched.
- **Comments anchored to elements.** Click any element, attach a thread.
  The marker is draggable; replies, resolution, and avatar colors work
  the way they would in Linear or Figma.
- **In-place text edit.** Toggle edit mode, click any text, retype.
  Saves on blur. Optimistic concurrency: the server 409s if the text
  changed under you, instead of silently overwriting.
- **A composer rail that disappears.** No persistent chrome. The widget
  fades into the host page when idle.

## How sharing works

**The URL is the credential.** Every published slug ends in a 10-character
base32 random suffix — roughly 50 bits of entropy:

```text
http://your-htmlz/weekly-report-t6gyf2rfns/
                  └─────────┬──────────┘
                            this is the access control
```

Anyone who can reach the server *and* has the URL can read, edit,
comment, and delete that page.

- No auth header.
- No `GET /v1/pages` endpoint. **Nobody can enumerate the pages on the server.**
- No "owner" field. Identity is self-reported and used for attribution only.
- No "delete" undo. To revoke access, re-publish at a new URL.

That model only holds if your network is private. See the
[trust model](infra/README.md#trust-model) for recommended deployment
fronts (Tailscale, ZeroTier, Cloudflare Access, private cloud subnet, a
home LAN behind a NAT router…).

Do **not** put htmlz on the public internet. The trust boundary is "the
network is private," not "the URL is secret against an attacker who can
scan ports."

## Why not just…

| If you reach for… | Where it falls short for this |
|---|---|
| **A GitHub gist** | Renders source, not pages. No JS/CSS execution. Authentication on every share. |
| **Notion / Confluence** | Strips JavaScript. Re-renders into their format. Embeds are second-class. |
| **Vercel / Netlify / Cloudflare Pages** | Public by default. Custom domains, build config, account choreography. Overkill for an artifact you'll share once and forget. |
| **Pastebin / hastebin** | Public. No interactivity. No comments. |
| **S3 static hosting** | Public. No comments. ACLs are their own ecosystem. |
| **A self-hosted CMS** | Wants you to write *in* it, not host arbitrary HTML. |
| **Just sending the file** | Recipients have to download, open in browser, can't comment, can't see edits, no shared URL. |

htmlz is for the case where the artifact already exists, you want it
*on the web* with full interactivity, and you want to share it *with
people you trust* without provisioning anything.

## Architecture in eight ideas

This is the part worth talking about even if you never deploy it. The
whole repo is ~4,500 lines including docs and tests.

**1 · URL-as-credential with unguessable suffixes.** No user table, no
ACL, no signup. Slug = `seed-` + 10 random base32 chars. ~50 bits of
entropy. Sharing = sending the URL. Revoking = republish at a new URL.
Implemented in a single `secrets.choice` loop
([api/app.py](api/app.py#L101)).

**2 · No enumeration endpoint, ever.** There is intentionally no
`GET /v1/pages`. The manifest and comments live *outside* `DATA_ROOT`,
so even a path-traversal bug couldn't expose them through the static
mount. The local CLI index gives each user a personal "list" without a
server-side one.

**3 · Filesystem = database.** FastAPI serves static HTML directly via
`StaticFiles`. The manifest is one JSON file; each page's comments are
one JSON file. Atomic writes via `.tmp` + `os.replace`. No Postgres, no
Redis, no S3. Two `mkdir -p`s and you're done.

**4 · Middleware-injected widget.** Publishers write plain HTML. A
Starlette middleware splices `<script src="/_widget/comments.js" defer></script>`
before `</body>` on every HTML response, identified by content-type. No
build step on the publisher side. ([api/app.py](api/app.py):
`CommentWidgetInjector`.)

**5 · Self-contained widget.** One ~1,700-line vanilla-JS IIFE.
CSS-in-JS. No framework, no bundler, no build step. Defends against
host page styles (e.g. a global `svg { position: absolute }` reset that
would otherwise yank every widget icon across the viewport).

**6 · Path-addressed text edits.** Each editable text node has a
body-relative path computed via *identical* rules on client
([api/widget.js](api/widget.js): `editVisibleChildren`) and server
([api/app.py](api/app.py): `_edit_visible_children`). Edits POST
`{path, old_text, new_text}`; the server walks the path, verifies
`old_text`, splices `new_text`, writes the file atomically. Optimistic
concurrency for free — server 409s on `old_text` mismatch.

**7 · Newline-faithful editing.** Enter inside a contenteditable span
sends a real `\n` byte to disk. The server conditionally injects
`white-space: pre-wrap` on the parent so newlines *render* on next
load. No HTML escaping, no Markdown layer.

**8 · CLI distributed by the server.** `curl http://server/install.sh | bash`
works from any IP/DNS that reaches the server, because `{{BASE}}` in
the install script is templated at request time from the request's own
scheme+host. Same script installs into Claude Code (`~/.claude/skills/`)
or Codex (`~/.codex/skills/`). Updating the agent skill across all
users is `git pull && docker compose up -d --build`.

## Repo layout

| Path | What |
|---|---|
| [`api/app.py`](api/app.py) | FastAPI service — pages, comments, edits, widget serving, HTML injection middleware. ~700 lines. |
| [`api/widget.js`](api/widget.js) | The comment + edit widget injected into every page. ~1,700 lines of vanilla JS. |
| [`skill/htmlz`](skill/htmlz) | Bash CLI for publish/update/comment/reply/delete. ~620 lines. |
| [`skill/SKILL.md`](skill/SKILL.md) | Agent-skill manifest (Claude Code / Codex). |
| [`skill/install.sh`](skill/install.sh) | Dev install — symlinks back to your checkout. |
| [`skill/install-remote.sh`](skill/install-remote.sh) | Remote install, served via `/install.sh` route. |
| [`infra/systemd-install.sh`](infra/systemd-install.sh) | Non-Docker install on any Linux box. |
| [`infra/index.html`](infra/index.html) | Landing page served at `/`. |
| [`Dockerfile`](Dockerfile) + [`docker-compose.yml`](docker-compose.yml) | Primary deploy path. |
| [`tests/`](tests/) | pytest + Playwright coverage. |

## Development

### Run the server

Easiest is the same Docker compose as production:

```bash
docker compose up --build
```

For hot-reload uvicorn without Docker:

```bash
pip install fastapi uvicorn python-multipart beautifulsoup4

HTMLZ_DATA_ROOT=/tmp/htmlz-data \
HTMLZ_MANIFEST=/tmp/htmlz-state/manifest.json \
HTMLZ_COMMENTS_DIR=/tmp/htmlz-state/comments \
HTMLZ_WIDGET="$(pwd)/api/widget.js" \
HTMLZ_SKILL_DIR="$(pwd)/skill" \
HTMLZ_INSTALL_SCRIPT="$(pwd)/skill/install-remote.sh" \
  uvicorn app:app --app-dir api --reload --port 8000
```

### Install the CLI from your working copy

```bash
bash skill/install.sh
htmlz publish ./examples/hello.html  # uses http://localhost:8000
```

### Run the tests

```bash
# Python tests (pytest + httpx)
pip install -r requirements-test.txt
PYTHONPATH=. pytest tests/python -q

# Browser tests (Playwright)
npm install
npx playwright install chromium
npx playwright test
```

## Status

This was extracted from a working internal tool that's been in daily use
for a small team for months. The architectural choices are settled. The
APIs are stable. There are no breaking changes planned. That said: this
is a small, opinionated project, not a framework. Read the code before
deploying it — it's short enough that you can.

## Contributing

PRs welcome, especially for: deploy templates (Fly.io, Render, Railway,
NixOS module), client SDKs in other languages, and accessibility
improvements to the widget. Please open an issue first for substantial
changes to the architecture or trust model.

## License

MIT — see [LICENSE](LICENSE).

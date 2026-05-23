# htmlz

**A place for your AI agents to host the HTML they make.**

Your Claude Code or Codex session just generated a polished HTML report,
a dashboard, a one-pager, a diagram. Where does it go? Pasting it into
Notion strips the interactivity. Email is a graveyard. A gist needs auth
and won't render JS. Vercel/Netlify is a deploy pipeline you have to
think about.

htmlz is a self-hosted single-binary HTML host you run on a network you
trust (Tailscale, ZeroTier, a VPN, a home LAN, a private cloud subnet).
You install a CLI + agent skill once, and from then on your AI can publish,
update, comment on, and reply-thread its way through whatever it makes.

```
agent (Claude Code / Codex)
    │
    ▼  htmlz publish ./report.html
api (one FastAPI process)
    │
    ▼  HTTP 201
http://your-htmlz/weekly-report-t6gyf2rfns/
```

No accounts, no DB, no CDN, no build pipeline. ~4k lines including docs.
$3/month on the smallest VPS you can find.

---

## Quickstart

```bash
git clone https://github.com/vivekkaushal/htmlz
cd htmlz
docker compose up -d --build
# → http://localhost:8000
```

Visit the URL in a browser — the landing page tells you how to install
the agent skill against *this* server.

For non-Docker deploys (systemd on a Linux box), see [`infra/README.md`](infra/README.md).

## Install the agent skill

From any machine that can reach your htmlz server:

```bash
curl -fsSL http://YOUR-HTMLZ-SERVER/install.sh | bash
htmlz identity "your name"
```

The installer detects `~/.claude/` and `~/.codex/` and installs into
whichever it finds. It also writes the server URL into
`~/.config/htmlz/config.json` so the CLI auto-knows where to point.

After that, you don't use the CLI yourself — your agent does:

> "Host this report on htmlz."
>
> "Update the weekly-report page with this new file."
>
> "Comment on the Open Questions section — we should also surface the churn cohort."
>
> "Reply to that comment — agreed, drafting the change now."

The skill is documented in [`skill/SKILL.md`](skill/SKILL.md).

## What you get on every published page

- **Static HTML, served as-is.** Scripts, styles, embedded JS, Chart.js,
  Mermaid, anything you put in the file works exactly as it would on
  any other web host.
- **Comments, anchored to elements.** Click any element on a page to
  attach a thread. The marker is draggable; replies and resolution work
  the way you'd expect.
- **In-place text editing.** Toggle edit mode; click any text node and
  retype it. Saves to disk on blur with optimistic concurrency
  (server 409s if the text changed under you).
- **A composer rail that disappears.** No persistent chrome. The widget
  fades into the host page when idle.

## Sharing model

**URL is the credential.** Every slug ends in a 10-character base32
random suffix (~50 bits of entropy):

```
http://your-htmlz/weekly-report-t6gyf2rfns/
                  └─────────┬──────────┘
                            this is the access control
```

Anyone who can reach the server *and* has the URL can read, edit,
comment, and delete that page.

- No auth header.
- No `GET /v1/pages` endpoint — nobody can enumerate.
- No "owner" field. Identity is self-reported and used for attribution only.
- No "delete" undo. To revoke access, re-publish at a new URL.

That model only holds if your *network* is private. See [`infra/README.md`](infra/README.md#trust-model)
for the threat model and recommended setups.

## Architecture in eight ideas

This is the part worth talking about even if you never deploy it.

1. **URL-as-credential with unguessable suffixes.** No user table, no ACL.
   Slug = `seed-` + 10 random base32 chars. ~50 bits of entropy. Sharing
   = sending the URL. Revoking = republish.

2. **No enumeration endpoint, ever.** There is intentionally no
   `GET /v1/pages`. The manifest and comments live *outside* the static
   mount, so even a path-traversal bug can't expose them.
   ([api/app.py](api/app.py): `DATA_ROOT` vs `MANIFEST_PATH` paths.)

3. **Filesystem = database.** FastAPI serves static HTML directly via
   `StaticFiles`. Manifest and per-page comments are JSON files. Atomic
   writes via `.tmp` + `replace`. No Postgres, no Redis, no S3.

4. **Middleware-injected widget.** Publishers write plain HTML. The
   server splices `<script src="/_widget/comments.js" defer></script>`
   before `</body>` on every HTML response. No build step on the
   publisher side. ([api/app.py](api/app.py): `CommentWidgetInjector`.)

5. **Self-contained widget.** One 1700-line vanilla-JS IIFE. CSS-in-JS.
   No framework, no build. Defensive against host page styles (e.g. a
   global `svg { position: absolute }` reset that would otherwise yank
   the widget icons across the viewport).

6. **Path-addressed text edits.** Each editable text node has a
   body-relative path computed via *identical* rules on client and
   server. Edits post `{path, old_text, new_text}`; the server walks the
   path, verifies `old_text`, splices `new_text`. Optimistic concurrency
   for free. ([api/app.py](api/app.py): `_edit_visible_children` mirrors
   [api/widget.js](api/widget.js): `editVisibleChildren`.)

7. **Newline-faithful editing.** Enter inside a contenteditable span
   sends a real `\n` to disk. The server conditionally injects
   `white-space: pre-wrap` on the parent so newlines *render*. No HTML
   escaping, no Markdown layer.

8. **CLI distributed by the server.** `curl http://server/install.sh | bash`
   works from any IP/DNS that reaches the server, because the install
   script's `{{BASE}}` is templated at request time from the request's
   own scheme+host. Same script installs into Claude Code or Codex.
   ([api/app.py](api/app.py): `/install.sh` route.)

## Repo layout

| Path | What |
|---|---|
| `api/app.py` | FastAPI service — pages, comments, edits, widget serving, HTML injection middleware |
| `api/widget.js` | The comment + edit widget injected into every page |
| `skill/htmlz` | Bash CLI for publishing/commenting (621 lines) |
| `skill/SKILL.md` | Agent-skill manifest (Claude Code / Codex pick this up) |
| `skill/install.sh` | Dev install — symlinks back to your checkout |
| `skill/install-remote.sh` | Remote install — fetched via `/install.sh` route |
| `infra/systemd-install.sh` | Non-Docker install on any Linux box |
| `infra/index.html` | Landing page served at `/` |
| `Dockerfile` + `docker-compose.yml` | Primary deploy path |

## Development

Local dev without Docker:

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

Install the CLI locally:

```bash
bash skill/install.sh
htmlz publish ./some.html  # uses http://localhost:8000 by default
```

## License

MIT — see [LICENSE](LICENSE).

# htmlz

> A self-hosted home for the HTML your AI agents make.

Your Claude Code or Codex session just generated a polished HTML
report. Where does it go? Notion strips the JS. Gists render source.
Vercel needs a build pipeline. Pastebin is public.

htmlz is a single small server. Your agent runs `htmlz publish
./report.html` and gets back a URL it can share. Recipients open the
URL; the page works exactly as authored, with a thin comments-and-edit
layer injected on top.

```text
you: "host this report on htmlz"
agent → htmlz publish ./report.html
       ↓
       ✓ http://your-htmlz/weekly-report-t6gyf2rfns/
```

No accounts. No database. No CDN. No build pipeline. ~4k lines of code.

## Quickstart

```bash
git clone https://github.com/kaushalvivek/htmlz
cd htmlz
docker compose up -d --build
```

Open <http://localhost:8000>. The landing page tells you how to wire
up your agent. `./data/` holds published pages; `./state/` holds the
manifest and comments. Both survive container rebuilds.

For other deploys:
- [`infra/aws.md`](infra/aws.md) — EC2 on AWS, with SSM and Security Group walkthrough.
- [`infra/README.md`](infra/README.md) — bare systemd on any Linux box, plus the trust model.

## Wire up your agent

From any machine that can reach your htmlz server:

```bash
curl -fsSL http://YOUR-HTMLZ-SERVER/install.sh | bash
htmlz identity "your name"
```

The installer detects `~/.claude/` and `~/.codex/`, drops the skill
in, symlinks the `htmlz` CLI to `~/.local/bin/`, and persists the
server URL so the CLI auto-points there.

After that, your agent does the work:

> "Host this report on htmlz."
>
> "Update the weekly-report page with this new file."
>
> "Comment on the Open Questions section — we should also surface the churn cohort."
>
> "Resolve the open-questions thread."

The skill manifest is in [`skill/SKILL.md`](skill/SKILL.md); the CLI
is [`skill/htmlz`](skill/htmlz).

## What every published page does

The widget injects before `</body>` automatically. Publishers do nothing.

- **Serves as-is.** Scripts, styles, Chart.js, Mermaid, embedded JS — anything the browser can render works.
- **Comments anchored to elements.** Click any element, attach a thread. Drag the marker. Reply, resolve.
- **In-place text edit.** Toggle edit mode, click any text, retype. Saves on blur. Server 409s on concurrent edits.
- **Disappears when idle.** No persistent chrome.

## How sharing works

**The URL is the credential.** Slug = `seed-` + 10 random base32 chars
(~50 bits of entropy):

```text
http://your-htmlz/weekly-report-t6gyf2rfns/
                  └─────────┬──────────┘
                            access control
```

Anyone who can reach the server *and* has the URL can read, edit,
comment, and delete that page. No auth header. No `GET /v1/pages`. No
owner. No undo — to revoke, re-publish at a new URL.

That model only holds if your network is private. **Do not put htmlz
on the public internet.** Front it with Tailscale, Cloudflare Access,
a VPN, or a private VPC subnet. See the
[trust model](infra/README.md#trust-model) for recommended fronts.

## Architecture in eight ideas

The whole repo is ~4,500 lines including docs and tests.

**1 · URL-as-credential with unguessable suffixes.** No user table, no
ACL, no signup. Slug = `seed-` + 10 random base32 chars. ~50 bits of
entropy. Sharing = sending the URL. Revoking = republish at a new URL.

**2 · No enumeration endpoint, ever.** There is intentionally no
`GET /v1/pages`. The manifest and comments live *outside* `DATA_ROOT`,
so even a path-traversal bug couldn't expose them through the static
mount.

**3 · Filesystem = database.** FastAPI serves static HTML via
`StaticFiles`. The manifest is one JSON file; each page's comments are
one JSON file. Atomic writes via `.tmp` + `os.replace`. No Postgres,
no Redis, no S3.

**4 · Middleware-injected widget.** A Starlette middleware splices
`<script src="/_widget/comments.js" defer></script>` before `</body>`
on every HTML response. Publishers write plain HTML.
([api/app.py](api/app.py): `CommentWidgetInjector`.)

**5 · Self-contained widget.** One ~1,700-line vanilla-JS IIFE.
CSS-in-JS. No framework, no bundler, no build step. Defends against
host page styles (e.g. a global `svg { position: absolute }` reset).

**6 · Path-addressed text edits.** Each editable text node has a
body-relative path computed via *identical* rules on client
([api/widget.js](api/widget.js): `editVisibleChildren`) and server
([api/app.py](api/app.py): `_edit_visible_children`). Edits POST
`{path, old_text, new_text}`. Server walks the path, verifies
`old_text`, splices `new_text`, writes atomically. Optimistic
concurrency for free.

**7 · Newline-faithful editing.** Enter inside a contenteditable span
sends a real `\n` byte to disk. The server conditionally injects
`white-space: pre-wrap` on the parent so newlines render on next load.

**8 · CLI distributed by the server.** `curl http://server/install.sh | bash`
works from any IP/DNS that reaches the server, because `{{BASE}}` in
the install script is templated at request time from the request's
own scheme+host.

## Development

```bash
# Run server (same as production)
docker compose up --build

# Install CLI from your working copy
bash skill/install.sh
htmlz publish ./examples/hello.html  # defaults to http://localhost:8000

# Tests — please run these before opening a PR
PYTHONPATH=. pytest tests/python -q                 # python
npm install && npx playwright install chromium      # one-time
npx playwright test                                 # browser
```

## License

MIT — see [LICENSE](LICENSE).

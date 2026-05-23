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

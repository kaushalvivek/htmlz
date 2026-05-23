---
name: htmlz
description: "Use whenever an AI agent generates an HTML artifact and the user wants it hosted somewhere viewable — reports, dashboards, diagrams, one-pagers, mockups, demos. Triggers: 'host this HTML', 'put this on htmlz', 'publish to my htmlz', 'update the X page', 'add a comment on the X page', 'reply to that comment'."
---

# htmlz

CLI wrapper around a self-hosted HTML page host (htmlz). The URL is the
credential — there is no auth header, no owner concept, no listing
endpoint. The skill caches each user's locally-published slugs at
`~/.config/htmlz/pages.json` so they can be referenced by prefix.

The CLI binary is `htmlz`.

## When to use

- The user asks to host an HTML report, diagram, dashboard, or doc they
  (or you) just generated.
- The user asks to update a previously published page (new content, title,
  description, or tags).
- The user asks to add or reply to comments on a page, or resolve a thread.
- The user asks to delete a page (see destructive-actions rules below).

## Verbs

```
htmlz publish FILE                       # new page
htmlz update  SLUG [FILE]                # replace content/meta
htmlz info    SLUG                       # metadata + URL
htmlz open    SLUG                       # open in browser
htmlz list                               # YOUR pages (local index)
htmlz track   SLUG [--title T]           # add existing slug to local index
htmlz untrack SLUG                       # remove from local index
htmlz delete  SLUG [--yes]               # DESTRUCTIVE: remove page + comments

htmlz comment  SLUG --text "..." --body "..."     # root, text-anchored
htmlz comment  SLUG --selector "..." --body "..." # root, selector-anchored
htmlz reply    SLUG COMMENT_ID --body "..."
htmlz comments SLUG [--resolved]                  # list
htmlz resolve  SLUG COMMENT_ID [--off]            # --off reopens
htmlz delete-comment SLUG COMMENT_ID [--yes]

htmlz identity [NAME]                    # show or set
```

`SLUG` accepts a unique prefix from the local index (e.g. `notes` resolves
to `notes-t6gyf2rfns`). Full slugs always work.

`--body -` (or omitting `--body`) opens `$EDITOR` for the comment body, like
`git commit`.

## Examples

Publish an HTML report:

```bash
htmlz publish ./weekly-report.html \
  --slug weekly-report --title "Weekly report — May 23"
```

Update the same page after edits:

```bash
htmlz update weekly-report ./weekly-report.html
```

Comment on a specific section, anchored by text:

```bash
htmlz comment weekly-report \
  --text "Open questions" \
  --body "We should also surface the churn cohort here."
```

Reply to a comment:

```bash
htmlz reply weekly-report c_abc123def456 --body "Agreed — drafting."
```

List comments (unresolved by default):

```bash
htmlz comments weekly-report
htmlz comments weekly-report --resolved   # include resolved threads
```

Adopt an existing page on a fresh machine (without re-publishing):

```bash
htmlz track weekly-report-t6gyf2rfns --title "Weekly report"
# now `htmlz update weekly-report ...` works from this machine
```

## Destructive actions (require explicit user confirmation)

`delete` and `delete-comment` are irreversible. There is no undo, no trash,
no restore path. **Before invoking either verb, you (the agent) MUST get
explicit confirmation from the user for the specific slug or comment ID
about to be deleted** — use AskUserQuestion or wait for an unambiguous
"yes, delete it" in the conversation. Do not infer permission from
broader requests like "clean things up" or "tidy the list."

```bash
# Page delete — interactive prompt shows title, URL, and comment count:
htmlz delete weekly-report

# --yes skips the prompt. ONLY pass --yes after the user has explicitly
# approved deleting this specific page in the current turn. --yes exists
# for scripted/CI use, not for agent convenience.
htmlz delete weekly-report --yes
```

Deleting a page removes the HTML, every comment thread on it, and the
local index entry. Comment deletes cascade to replies (root only).

## Anti-patterns

- **Don't try to list pages remotely.** There is no `GET /v1/pages` endpoint —
  enumeration would defeat the URL-as-credential model. The local `list` verb
  only shows what *this user* published.
- **Don't strip the random suffix when sharing URLs.** The 10-char suffix is
  what keeps slugs unguessable. Share the full URL.
- **Don't bake a user name into scripts or CI.** Identity is stored in
  `~/.config/htmlz/identity.json` and asked once on first comment. For CI,
  set it explicitly with `htmlz identity <name>` during setup.
- **Make `--text` anchors at least 4 characters of literal page content.** The
  server accepts anything, but the in-page widget needs ≥4 chars to attempt
  text-content matching; shorter anchors leave the marker unrenderable.

## Failure modes worth knowing

| Symptom | Likely cause |
|---|---|
| `network error reaching <base>` | Server is down, or you're not on the network where it's reachable. |
| `conflict: slug seed 'X' is reserved` | Reserved seed (`v1`, `api`, `health`, etc.). Pick a different `--slug`. |
| `bad request: file must be HTML (starts with <!doctype or <html>)` | The file isn't HTML, or has leading non-HTML content. |
| `'foo' is ambiguous; matches: …` | Local index has multiple `foo-*` slugs. Use the full slug or a longer prefix. |
| `not found: no page with slug 'X'` | Slug doesn't exist on the server (typo, or it was a local-only entry from a failed publish). |

## Storage

```
~/.config/htmlz/
├── identity.json    {"name": "..."}
├── pages.json       {"pages": [{slug, title, url, published_at}]}
└── config.json      {"base": "..."}   # optional base-URL override
```

Override the server base with `$HTMLZ_BASE` for one-off invocations.

## Source

Two install paths:

```bash
# zero-clone, fetches from your live htmlz server:
curl -fsSL http://YOUR-HTMLZ-SERVER/install.sh | bash

# from-repo (dev install — symlinks back to a checked-out repo):
bash skill/install.sh
```

The curl path installs into `~/.claude/skills/htmlz/` and/or
`~/.codex/skills/htmlz/` (whichever exist) and symlinks the CLI to
`~/.local/bin/htmlz`.

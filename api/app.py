"""htmlz API — a self-hosted HTML page host that AI agents can publish to.

Sharing model: the URL is the credential. Anyone who can reach the server
and has the URL can read, update, comment, reply, resolve, and delete.
No auth header, no owner field, no enumeration. To share, you send the URL.
To revoke, you re-publish at a new URL.

Deploy this on a network you trust — Tailscale, ZeroTier, Cloudflare
Access, your home LAN, a VPN. The unguessable suffix on each slug
(10 base32-ish chars, ~50 bits) is what carries the entropy an access
control list would carry in a multi-tenant system.

Slugs are seed + 10 random chars (e.g. `quick-notes-t6gyf2rfns`).
The manifest and per-page comments live outside DATA_ROOT so the static
mount can't serve them as an enumeration backdoor.

Routes:
    GET    /healthz                                 smoke probe
    POST   /v1/pages                                create a new page
    PUT    /v1/pages/{slug}                         replace content / metadata
    DELETE /v1/pages/{slug}                         delete page + comments (irreversible)
    POST   /v1/pages/{slug}/edits                   in-place text-node edit
    GET    /v1/pages/{slug}/comments                list comments
    POST   /v1/pages/{slug}/comments                add comment or reply
    PATCH  /v1/pages/{slug}/comments/{cid}          toggle resolved / move marker
    DELETE /v1/pages/{slug}/comments/{cid}          delete (cascades to replies)
    GET    /_widget/comments.js                     comment widget bundle
    GET    /install.sh                              curl-pipe installer for the CLI/skill
    GET    /_skill/{filename}                       individual CLI/skill files
    /*                                              static files from DATA_ROOT
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Any

from bs4 import BeautifulSoup, Comment, NavigableString
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

DATA_ROOT = Path(os.environ.get("HTMLZ_DATA_ROOT", "/var/htmlz/data"))
MANIFEST_PATH = Path(
    os.environ.get("HTMLZ_MANIFEST", "/var/htmlz/state/manifest.json")
)
COMMENTS_DIR = Path(
    os.environ.get("HTMLZ_COMMENTS_DIR", "/var/htmlz/state/comments")
)
WIDGET_PATH = Path(os.environ.get("HTMLZ_WIDGET", "/etc/htmlz/widget.js"))
SKILL_DIR = Path(os.environ.get("HTMLZ_SKILL_DIR", "/etc/htmlz/skill"))
INSTALL_SCRIPT_PATH = Path(
    os.environ.get("HTMLZ_INSTALL_SCRIPT", "/etc/htmlz/skill/install-remote.sh")
)
SKILL_FILES = frozenset({"SKILL.md", "htmlz"})

SLUG_SEED_RE = re.compile(r"^[a-z][a-z0-9-]{0,49}$")
FULL_SLUG_RE = re.compile(r"^[a-z][a-z0-9-]{1,63}$")
RESERVED_SLUGS = frozenset({
    "v1", "api", "health", "healthz", "static", "assets",
    "index", "_manifest", "_widget", "_skill", "pages",
})
_SUFFIX_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"
SUFFIX_LEN = 10

MAX_BYTES = 5 * 1024 * 1024
MAX_TAGS = 10
MAX_TAG_LEN = 32

MAX_NAME_LEN = 80
MAX_BODY_LEN = 4000
MAX_SELECTOR_LEN = 512
MAX_TEXT_ANCHOR_LEN = 240
MAX_EDIT_TEXT_LEN = 16384
MAX_EDIT_PATH_DEPTH = 64

logger = logging.getLogger("htmlz")
logging.basicConfig(level=logging.INFO, format="%(message)s")

app = FastAPI(title="htmlz", version="0.1.0")
_write_lock = asyncio.Lock()


# ── helpers ─────────────────────────────────────────────────────────────────


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _gen_id(prefix: str, length: int = 10) -> str:
    return prefix + "".join(secrets.choice(_SUFFIX_ALPHABET) for _ in range(length))


def _gen_suffix() -> str:
    return "".join(secrets.choice(_SUFFIX_ALPHABET) for _ in range(SUFFIX_LEN))


def _validate_seed(seed: str) -> None:
    if seed in RESERVED_SLUGS:
        raise HTTPException(409, f"slug seed '{seed}' is reserved")
    if not SLUG_SEED_RE.match(seed):
        raise HTTPException(400, "slug seed must match [a-z][a-z0-9-]{0,49}")


def _validate_full_slug(slug: str) -> None:
    if slug in RESERVED_SLUGS:
        raise HTTPException(409, f"slug '{slug}' is reserved")
    if not FULL_SLUG_RE.match(slug):
        raise HTTPException(400, "slug must match [a-z][a-z0-9-]{1,63}")


def _validate_html(content: bytes) -> None:
    if len(content) > MAX_BYTES:
        raise HTTPException(413, f"HTML exceeds {MAX_BYTES // 1024 // 1024} MB")
    if len(content) == 0:
        raise HTTPException(400, "empty file")
    head = content[:1024].decode("utf-8", errors="ignore").lower().lstrip()
    if not (head.startswith("<!doctype") or head.startswith("<html")):
        raise HTTPException(400, "file must be HTML (starts with <!doctype or <html>)")


def _parse_tags(raw: str | None) -> list[str]:
    if not raw:
        return []
    tags = [t.strip() for t in raw.split(",") if t.strip()]
    if len(tags) > MAX_TAGS:
        raise HTTPException(400, f"max {MAX_TAGS} tags")
    for tag in tags:
        if len(tag) > MAX_TAG_LEN:
            raise HTTPException(400, f"tag '{tag}' exceeds {MAX_TAG_LEN} chars")
    return tags


def _load_manifest() -> list[dict[str, Any]]:
    if not MANIFEST_PATH.exists():
        return []
    try:
        data = json.loads(MANIFEST_PATH.read_text())
        pages = data.get("pages")
        return pages if isinstance(pages, list) else []
    except json.JSONDecodeError:
        logger.warning(json.dumps({"event": "manifest_unreadable", "path": str(MANIFEST_PATH)}))
        return []


def _save_manifest_atomic(pages: list[dict[str, Any]]) -> None:
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = MANIFEST_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"pages": pages}, indent=2, sort_keys=True))
    tmp.replace(MANIFEST_PATH)


def _write_html_atomic(slug: str, content: bytes) -> None:
    slug_dir = DATA_ROOT / slug
    slug_dir.mkdir(parents=True, exist_ok=True)
    final = slug_dir / "index.html"
    tmp = final.with_suffix(".html.tmp")
    tmp.write_bytes(content)
    tmp.replace(final)


def _audit(op: str, slug: str, **extra: Any) -> None:
    entry = {"ts": _now(), "op": op, "slug": slug, **extra}
    logger.info(json.dumps(entry))


def _patch_meta(
    base: dict[str, Any],
    *,
    title: str | None,
    description: str | None,
    tags: list[str] | None,
) -> dict[str, Any]:
    meta = dict(base)
    if title is not None:
        meta["title"] = title
    if description is not None:
        meta["description"] = description
    if tags is not None:
        meta["tags"] = tags
    meta["updated_at"] = _now()
    return meta


def _slug_exists(slug: str) -> bool:
    return any(p["slug"] == slug for p in _load_manifest())


# ── comments storage ────────────────────────────────────────────────────────


def _comments_path(slug: str) -> Path:
    return COMMENTS_DIR / f"{slug}.json"


def _load_comments(slug: str) -> list[dict[str, Any]]:
    path = _comments_path(slug)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text())
        items = data.get("comments")
        return items if isinstance(items, list) else []
    except json.JSONDecodeError:
        logger.warning(json.dumps({"event": "comments_unreadable", "slug": slug}))
        return []


def _save_comments_atomic(slug: str, items: list[dict[str, Any]]) -> None:
    COMMENTS_DIR.mkdir(parents=True, exist_ok=True)
    path = _comments_path(slug)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"comments": items}, indent=2, sort_keys=True))
    tmp.replace(path)


def _clean_name(raw: str) -> str:
    name = raw.strip()
    if not name:
        raise HTTPException(400, "user_name required")
    if len(name) > MAX_NAME_LEN:
        raise HTTPException(400, f"user_name exceeds {MAX_NAME_LEN} chars")
    return name


def _clean_body(raw: str) -> str:
    body = raw.strip()
    if not body:
        raise HTTPException(400, "body required")
    if len(body) > MAX_BODY_LEN:
        raise HTTPException(400, f"body exceeds {MAX_BODY_LEN} chars")
    return body


# ── models for comment endpoints ───────────────────────────────────────────


class CommentAnchor(BaseModel):
    selector: str | None = Field(default=None, max_length=MAX_SELECTOR_LEN)
    text: str | None = Field(default=None, max_length=MAX_TEXT_ANCHOR_LEN)
    preview: str | None = Field(default=None, max_length=MAX_TEXT_ANCHOR_LEN)
    # Drag offset relative to the anchored element. Persists where the user
    # dropped the marker. 0/0 means "default position next to element".
    offset_dx: int = 0
    offset_dy: int = 0


class CommentCreate(BaseModel):
    user_name: str
    body: str
    # Replies: parent_id only.
    parent_id: str | None = None
    # Thread roots: anchor.
    anchor: CommentAnchor | None = None


class CommentPatch(BaseModel):
    resolved: bool | None = None
    offset_dx: int | None = None
    offset_dy: int | None = None


class EditRequest(BaseModel):
    # Body-relative path: indices into edit-visible children (see
    # _edit_visible_children). Terminal step must point to a text node.
    path: list[int] = Field(min_length=1, max_length=MAX_EDIT_PATH_DEPTH)
    old_text: str = Field(max_length=MAX_EDIT_TEXT_LEN)
    new_text: str = Field(max_length=MAX_EDIT_TEXT_LEN)


# ── core write endpoints ────────────────────────────────────────────────────


@app.get("/healthz", include_in_schema=False)
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/v1/pages", status_code=201)
async def create_page(
    slug: Annotated[str, Form(min_length=1, max_length=50)],
    title: Annotated[str, Form(min_length=1, max_length=200)],
    file: Annotated[UploadFile, File()],
    description: Annotated[str, Form(max_length=500)] = "",
    tags: Annotated[str, Form()] = "",
) -> dict[str, Any]:
    _validate_seed(slug)
    parsed_tags = _parse_tags(tags)
    content = await file.read()
    _validate_html(content)

    async with _write_lock:
        pages = _load_manifest()
        existing_slugs = {p["slug"] for p in pages}
        for _ in range(8):
            full_slug = f"{slug}-{_gen_suffix()}"
            if full_slug not in existing_slugs:
                break
        else:
            raise HTTPException(500, "could not allocate unique slug")

        now = _now()
        meta = {
            "slug": full_slug,
            "title": title,
            "description": description,
            "tags": parsed_tags,
            "created_at": now,
            "updated_at": now,
        }
        _write_html_atomic(full_slug, content)
        pages.append(meta)
        _save_manifest_atomic(pages)

    _audit("create", full_slug, content_length=len(content))
    return {"url": f"/{full_slug}/", "slug": full_slug, "meta": meta}


@app.put("/v1/pages/{slug}")
async def update_page(
    slug: str,
    title: Annotated[str | None, Form(max_length=200)] = None,
    description: Annotated[str | None, Form(max_length=500)] = None,
    tags: Annotated[str | None, Form()] = None,
    file: Annotated[UploadFile | None, File()] = None,
) -> dict[str, Any]:
    _validate_full_slug(slug)

    content: bytes | None = None
    if file is not None:
        content = await file.read()
        _validate_html(content)

    parsed_tags = _parse_tags(tags) if tags is not None else None

    if content is None and title is None and description is None and parsed_tags is None:
        raise HTTPException(400, "no fields to update — provide file and/or title/description/tags")

    async with _write_lock:
        pages = _load_manifest()
        idx = next((i for i, p in enumerate(pages) if p["slug"] == slug), None)
        if idx is None:
            raise HTTPException(404, f"no page with slug '{slug}'")
        meta = _patch_meta(
            pages[idx],
            title=title,
            description=description,
            tags=parsed_tags,
        )
        if content is not None:
            _write_html_atomic(slug, content)
        pages[idx] = meta
        _save_manifest_atomic(pages)

    _audit("update", slug, content_length=len(content) if content else 0)
    return {"url": f"/{slug}/", "slug": slug, "meta": meta}


@app.delete("/v1/pages/{slug}", status_code=204)
async def delete_page(slug: str) -> Response:
    _validate_full_slug(slug)
    async with _write_lock:
        pages = _load_manifest()
        idx = next((i for i, p in enumerate(pages) if p["slug"] == slug), None)
        if idx is None:
            raise HTTPException(404, f"no page with slug '{slug}'")
        pages.pop(idx)
        _save_manifest_atomic(pages)
        shutil.rmtree(DATA_ROOT / slug, ignore_errors=True)
        comments_path = _comments_path(slug)
        if comments_path.exists():
            comments_path.unlink()
    _audit("delete", slug)
    return Response(status_code=204)


# ── in-place text edits ────────────────────────────────────────────────────


_WHITESPACE_PROP_RE = re.compile(r"(^|;)\s*white-space\s*:", re.IGNORECASE)


def _ensure_parent_preserves_newlines(parent: Any) -> None:
    """Ensure `parent` renders `\\n` inside its text nodes as line breaks.

    Default `white-space: normal` collapses `\\n` to a single space. The edit
    endpoint preserves user-typed `\\n` byte-faithfully in the NavigableString,
    so without a white-space hint on the container, paragraph breaks the user
    typed in edit mode silently disappear on save.
    """
    if not hasattr(parent, "get") or not hasattr(parent, "__setitem__"):
        return
    style = (parent.get("style") or "").strip()
    if _WHITESPACE_PROP_RE.search(style):
        return
    if style and not style.endswith(";"):
        style += ";"
    if style:
        style += " "
    style += "white-space: pre-wrap;"
    parent["style"] = style


def _edit_visible_children(node: Any) -> list[Any]:
    """Children counted for edit path indexing.

    Client and server must apply identical rules so a path computed in the
    browser resolves to the same node on disk. Skip:
      - HTML comments
      - <script> / <style> elements (the widget script is middleware-injected
        on serve, so the file never has it; symmetric skip keeps both sides
        ignoring scripts everywhere)
      - elements with [data-htmlz-ui] (widget DOM, added at runtime; the
        file shouldn't have them either, but defensive skipping keeps the
        rule symmetric)
    """
    out: list[Any] = []
    for child in node.contents:
        if isinstance(child, Comment):
            continue
        if isinstance(child, NavigableString):
            out.append(child)
            continue
        if child.name in ("script", "style"):
            continue
        if child.has_attr("data-htmlz-ui"):
            continue
        out.append(child)
    return out


@app.post("/v1/pages/{slug}/edits")
async def edit_text_node(slug: str, payload: EditRequest) -> dict[str, Any]:
    """Replace a single text node addressed by structural path.

    Path is body-relative. The terminal node must be a text NavigableString
    whose value equals `old_text`; on mismatch we 409 rather than silently
    overwrite. Same trust model as PUT — URL is the credential.
    """
    _validate_full_slug(slug)
    if not _slug_exists(slug):
        raise HTTPException(404, f"no page with slug '{slug}'")

    async with _write_lock:
        html_path = DATA_ROOT / slug / "index.html"
        if not html_path.exists():
            raise HTTPException(404, f"no file for slug '{slug}'")
        soup = BeautifulSoup(html_path.read_text(encoding="utf-8"), "html.parser")
        body = soup.body
        if body is None:
            raise HTTPException(409, "file has no <body>")

        cur: Any = body
        for depth, idx in enumerate(payload.path):
            if isinstance(cur, NavigableString):
                raise HTTPException(409, f"path step {depth} descends into a leaf node")
            kids = _edit_visible_children(cur)
            if idx < 0 or idx >= len(kids):
                raise HTTPException(
                    409,
                    f"path step {depth} (index {idx}) out of range; have {len(kids)} children",
                )
            cur = kids[idx]

        if not isinstance(cur, NavigableString) or isinstance(cur, Comment):
            raise HTTPException(409, "path does not address a text node")
        if str(cur) != payload.old_text:
            raise HTTPException(409, "old_text mismatch — page changed under you")

        if "\n" in payload.new_text:
            _ensure_parent_preserves_newlines(cur.parent)
        cur.replace_with(NavigableString(payload.new_text))
        _write_html_atomic(slug, str(soup).encode("utf-8"))

        pages = _load_manifest()
        midx = next((i for i, p in enumerate(pages) if p["slug"] == slug), None)
        if midx is not None:
            pages[midx]["updated_at"] = _now()
            _save_manifest_atomic(pages)

    _audit(
        "edit",
        slug,
        path=payload.path,
        old_len=len(payload.old_text),
        new_len=len(payload.new_text),
    )
    return {"ok": True}


# ── comment endpoints ──────────────────────────────────────────────────────


@app.get("/v1/pages/{slug}/comments")
def list_comments(slug: str, include_resolved: bool = False) -> dict[str, Any]:
    _validate_full_slug(slug)
    if not _slug_exists(slug):
        raise HTTPException(404, f"no page with slug '{slug}'")
    items = _load_comments(slug)
    if not include_resolved:
        resolved_threads = {c["id"] for c in items if c.get("parent_id") is None and c.get("resolved")}
        items = [c for c in items if c["id"] not in resolved_threads and c.get("parent_id") not in resolved_threads]
    return {"comments": items}


@app.post("/v1/pages/{slug}/comments", status_code=201)
async def create_comment(slug: str, payload: CommentCreate) -> dict[str, Any]:
    _validate_full_slug(slug)
    if not _slug_exists(slug):
        raise HTTPException(404, f"no page with slug '{slug}'")
    name = _clean_name(payload.user_name)
    body = _clean_body(payload.body)

    is_reply = payload.parent_id is not None
    if not is_reply and payload.anchor is None:
        raise HTTPException(400, "thread root requires anchor")
    if is_reply and payload.anchor is not None:
        raise HTTPException(400, "replies cannot carry an anchor")
    if payload.anchor is not None and not (payload.anchor.selector or payload.anchor.text):
        raise HTTPException(400, "anchor requires at least one of selector or text")

    async with _write_lock:
        items = _load_comments(slug)
        if is_reply:
            parent = next((c for c in items if c["id"] == payload.parent_id), None)
            if parent is None:
                raise HTTPException(404, f"no parent comment '{payload.parent_id}'")
            if parent.get("parent_id") is not None:
                root_id = parent["parent_id"]
            else:
                root_id = parent["id"]
        cid = _gen_id("c_", 12)
        now = _now()
        entry: dict[str, Any] = {
            "id": cid,
            "parent_id": root_id if is_reply else None,
            "user_name": name,
            "body": body,
            "created_at": now,
        }
        if is_reply:
            entry["anchor"] = None
        else:
            entry["anchor"] = payload.anchor.model_dump() if payload.anchor else None
            entry["resolved"] = False
        items.append(entry)
        _save_comments_atomic(slug, items)

    _audit("comment.create", slug, comment_id=cid, parent=root_id if is_reply else None, user=name)
    return entry


@app.patch("/v1/pages/{slug}/comments/{cid}")
async def patch_comment(slug: str, cid: str, payload: CommentPatch) -> dict[str, Any]:
    _validate_full_slug(slug)
    has_resolved = payload.resolved is not None
    has_offset = payload.offset_dx is not None or payload.offset_dy is not None
    if not has_resolved and not has_offset:
        raise HTTPException(400, "nothing to patch")
    async with _write_lock:
        items = _load_comments(slug)
        idx = next((i for i, c in enumerate(items) if c["id"] == cid), None)
        if idx is None:
            raise HTTPException(404, f"no comment '{cid}'")
        target = items[idx]
        if target.get("parent_id") is not None:
            raise HTTPException(400, "only thread roots can be patched")
        ops: list[str] = []
        if has_resolved:
            target["resolved"] = bool(payload.resolved)
            ops.append("resolve" if payload.resolved else "unresolve")
        if has_offset:
            anchor = dict(target.get("anchor") or {})
            if payload.offset_dx is not None:
                anchor["offset_dx"] = int(payload.offset_dx)
            if payload.offset_dy is not None:
                anchor["offset_dy"] = int(payload.offset_dy)
            target["anchor"] = anchor
            ops.append("move")
        items[idx] = target
        _save_comments_atomic(slug, items)
    _audit("comment." + "/".join(ops), slug, comment_id=cid)
    return target


@app.delete("/v1/pages/{slug}/comments/{cid}", status_code=204)
async def delete_comment(slug: str, cid: str) -> Response:
    _validate_full_slug(slug)
    async with _write_lock:
        items = _load_comments(slug)
        idx = next((i for i, c in enumerate(items) if c["id"] == cid), None)
        if idx is None:
            raise HTTPException(404, f"no comment '{cid}'")
        target = items[idx]
        if target.get("parent_id") is None:
            items = [c for c in items if c["id"] != cid and c.get("parent_id") != cid]
            cascade = True
        else:
            items = [c for c in items if c["id"] != cid]
            cascade = False
        _save_comments_atomic(slug, items)
    _audit("comment.delete", slug, comment_id=cid, cascade=cascade)
    return Response(status_code=204)


# ── widget bundle ──────────────────────────────────────────────────────────


@app.get("/_widget/comments.js", include_in_schema=False)
def widget_js() -> FileResponse:
    if not WIDGET_PATH.exists():
        raise HTTPException(503, "widget not deployed")
    return FileResponse(
        WIDGET_PATH,
        media_type="application/javascript",
        headers={"Cache-Control": "public, max-age=60"},
    )


# ── skill distribution ─────────────────────────────────────────────────────


@app.get("/install.sh", include_in_schema=False)
def install_script(request: Request) -> Response:
    """Curl-pipe installer. Templates {{BASE}} with the request's scheme+host
    so the same script works from any DNS name or IP that points at this box."""
    if not INSTALL_SCRIPT_PATH.exists():
        raise HTTPException(503, "installer not deployed")
    base = f"{request.url.scheme}://{request.url.netloc}"
    body = INSTALL_SCRIPT_PATH.read_text().replace("{{BASE}}", base)
    return Response(
        content=body,
        media_type="text/x-shellscript",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/_skill/{filename}", include_in_schema=False)
def skill_file(filename: str) -> FileResponse:
    if filename not in SKILL_FILES:
        raise HTTPException(404, "unknown skill file")
    path = SKILL_DIR / filename
    if not path.exists():
        raise HTTPException(503, f"{filename} not deployed")
    return FileResponse(
        path,
        media_type="text/plain; charset=utf-8",
        headers={"Cache-Control": "public, max-age=60"},
    )


# ── HTML injection middleware ──────────────────────────────────────────────


_INJECTION_TAG = b'<script src="/_widget/comments.js" defer></script>'


class CommentWidgetInjector(BaseHTTPMiddleware):
    """Inject the comment widget into every HTML response served from a page slug.

    Runs *after* the static mount returns the page bytes. Identifies HTML by
    response Content-Type, locates the last `</body>`, and prepends the script
    tag. Inert on JSON / JS / favicon / non-page responses.
    """

    async def dispatch(self, request: Request, call_next):  # type: ignore[override]
        response = await call_next(request)
        ctype = (response.headers.get("content-type") or "").lower()
        if not ctype.startswith("text/html"):
            return response
        path = request.url.path
        if path == "/" or path.startswith("/_widget/") or path.startswith("/v1/"):
            return response
        body = b""
        async for chunk in response.body_iterator:
            body += chunk
        idx = body.rfind(b"</body>")
        if idx == -1:
            return Response(content=body, status_code=response.status_code,
                            media_type=response.media_type)
        new_body = body[:idx] + _INJECTION_TAG + body[idx:]
        headers = dict(response.headers)
        headers.pop("content-length", None)
        return Response(content=new_body, status_code=response.status_code,
                        headers=headers, media_type=response.media_type)


app.add_middleware(CommentWidgetInjector)


# Static mount MUST come last — catches everything unmatched.
DATA_ROOT.mkdir(parents=True, exist_ok=True)
MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
COMMENTS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/", StaticFiles(directory=str(DATA_ROOT), html=True), name="root")

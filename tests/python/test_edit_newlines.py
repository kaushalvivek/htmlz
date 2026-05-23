"""Regression tests for newline preservation in /v1/pages/{slug}/edits.

The editable-html widget sends Enter keystrokes as literal `\\n` in the
text node payload. Without the fix on this branch, the server stores the
`\\n` byte-faithfully but the rendered HTML collapses it to a space under
default `white-space: normal` — the user's paragraph break vanishes on
reload. These tests pin the behavior that:

  - `\\n` survives in the saved text node (byte-faithful, as the feature
    commit promised)
  - the edited NavigableString's parent declares an inline `white-space`
    so the rendered HTML actually shows the break
  - existing inline `white-space` author intent is respected
  - the single-NavigableString structure is preserved, so subsequent
    edits on the same path keep working without a page reload
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from bs4 import BeautifulSoup
from fastapi.testclient import TestClient


@pytest.fixture
def app_client(tmp_path, monkeypatch):
    monkeypatch.setenv("HTMLZ_DATA_ROOT", str(tmp_path / "data"))
    monkeypatch.setenv(
        "HTMLZ_MANIFEST", str(tmp_path / "state" / "manifest.json")
    )
    monkeypatch.setenv(
        "HTMLZ_COMMENTS_DIR", str(tmp_path / "state" / "comments")
    )
    monkeypatch.setenv("HTMLZ_WIDGET", str(tmp_path / "widget.js"))
    monkeypatch.setenv("HTMLZ_SKILL_DIR", str(tmp_path / "skill"))
    monkeypatch.setenv(
        "HTMLZ_INSTALL_SCRIPT", str(tmp_path / "skill" / "install.sh")
    )

    (tmp_path / "data").mkdir()
    (tmp_path / "state" / "comments").mkdir(parents=True)
    (tmp_path / "skill").mkdir()
    (tmp_path / "widget.js").write_text("// stub")
    (tmp_path / "skill" / "install.sh").write_text("# stub")

    # Force re-import so the env vars are picked up at module load.
    for name in list(sys.modules):
        if name == "api.app" or name.startswith("api.app."):
            del sys.modules[name]
    from api.app import app

    return TestClient(app), tmp_path


@pytest.fixture
def page(app_client):
    client, _ = app_client
    html = (
        b"<!doctype html><html><body>"
        b"<p>Original paragraph text.</p>"
        b"</body></html>"
    )
    resp = client.post(
        "/v1/pages",
        files={"file": ("t.html", html, "text/html")},
        data={"slug": "newlines", "title": "Newlines"},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["slug"]


def _locate_text_node(client_and_tmp, slug):
    _, tmp_path = client_and_tmp
    fp = tmp_path / "data" / slug / "index.html"
    soup = BeautifulSoup(fp.read_text(), "html.parser")
    body = soup.body
    p_idx = next(
        i for i, ch in enumerate(body.contents)
        if getattr(ch, "name", None) == "p"
    )
    p = body.contents[p_idx]
    text_idx = next(i for i, ch in enumerate(p.contents) if isinstance(ch, str))
    return fp, str(p.contents[text_idx]), [p_idx, text_idx]


def _read_p(file_path):
    return BeautifulSoup(file_path.read_text(), "html.parser").body.find("p")


def test_newlines_survive_save_and_parent_gets_white_space_style(app_client, page):
    client, _ = app_client
    fp, original, path = _locate_text_node(app_client, page)
    new_text = "first line\nsecond line\n\nthird paragraph"

    resp = client.post(
        f"/v1/pages/{page}/edits",
        json={"path": path, "old_text": original, "new_text": new_text},
    )
    assert resp.status_code == 200, resp.text

    p = _read_p(fp)
    text_node = next(c for c in p.contents if isinstance(c, str))

    assert "\n" in str(text_node), "\\n must survive byte-faithfully in saved text node"
    for needle in ("first line", "second line", "third paragraph"):
        assert needle in str(text_node)

    style = (p.get("style") or "").lower()
    assert "white-space" in style, (
        f"expected white-space declaration on edited parent; got style={style!r}"
    )
    white_space_value = (
        style.split("white-space")[1].split(":")[1].split(";")[0].strip()
    )
    assert white_space_value.startswith("pre"), (
        f"expected pre-* white-space, got {white_space_value!r}"
    )


def test_single_line_edit_does_not_add_style(app_client, page):
    client, _ = app_client
    fp, original, path = _locate_text_node(app_client, page)

    resp = client.post(
        f"/v1/pages/{page}/edits",
        json={"path": path, "old_text": original, "new_text": "Just one line"},
    )
    assert resp.status_code == 200

    p = _read_p(fp)
    style = (p.get("style") or "").lower()
    assert "white-space" not in style, (
        f"single-line edits should leave style alone; got {style!r}"
    )


def test_existing_white_space_author_intent_wins(app_client, page):
    client, tmp_path = app_client
    fp = tmp_path / "data" / page / "index.html"
    soup = BeautifulSoup(fp.read_text(), "html.parser")
    soup.body.find("p")["style"] = "white-space: nowrap; color: red;"
    fp.write_text(str(soup))

    _, original, path = _locate_text_node(app_client, page)
    resp = client.post(
        f"/v1/pages/{page}/edits",
        json={"path": path, "old_text": original, "new_text": "a\nb"},
    )
    assert resp.status_code == 200

    p = _read_p(fp)
    style = (p.get("style") or "").lower()
    assert "nowrap" in style, "author-declared white-space must not be overwritten"
    assert "pre-wrap" not in style
    text_node = next(c for c in p.contents if isinstance(c, str))
    assert "\n" in str(text_node), "\\n still saved even when render style hides it"


def test_subsequent_edit_on_same_path_works(app_client, page):
    """A <br>-splicing approach would have invalidated the path on the
    next edit (the original single text node would have been replaced by
    multiple nodes). The white-space-style approach keeps the single-NS
    shape, so the wrapping span's stored path is still addressable."""
    client, _ = app_client
    _, original, path = _locate_text_node(app_client, page)

    first = "a\nb"
    resp = client.post(
        f"/v1/pages/{page}/edits",
        json={"path": path, "old_text": original, "new_text": first},
    )
    assert resp.status_code == 200, resp.text

    second = "a\nb\nc"
    resp = client.post(
        f"/v1/pages/{page}/edits",
        json={"path": path, "old_text": first, "new_text": second},
    )
    assert resp.status_code == 200, resp.text

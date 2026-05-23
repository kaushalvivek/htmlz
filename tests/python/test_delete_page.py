"""Tests for DELETE /v1/pages/{slug}.

Pin the contract:
  - 204 on success; page disappears from the manifest, HTML directory is
    removed, and the per-page comments file (if any) is removed too.
  - 404 if the slug doesn't exist.
  - Deleting a page with active comments cascades cleanly — the URL is
    gone, so orphaned comments would never be reachable anyway.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
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

    for name in list(sys.modules):
        if name == "api.app" or name.startswith("api.app."):
            del sys.modules[name]
    from api.app import app

    return TestClient(app), tmp_path


def _publish(client, slug_seed="doomed"):
    html = b"<!doctype html><html><body><p>Bye.</p></body></html>"
    resp = client.post(
        "/v1/pages",
        files={"file": ("t.html", html, "text/html")},
        data={"slug": slug_seed, "title": "Doomed"},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["slug"]


def test_delete_removes_html_manifest_and_comments(app_client):
    client, tmp_path = app_client
    slug = _publish(client)

    resp = client.post(
        f"/v1/pages/{slug}/comments",
        json={
            "user_name": "tester",
            "body": "hi",
            "anchor": {"text": "Bye.", "preview": "Bye."},
        },
    )
    assert resp.status_code == 201, resp.text

    html_path = tmp_path / "data" / slug / "index.html"
    manifest_path = tmp_path / "state" / "manifest.json"
    comments_path = tmp_path / "state" / "comments" / f"{slug}.json"
    assert html_path.exists()
    assert slug in manifest_path.read_text()
    assert comments_path.exists()

    resp = client.delete(f"/v1/pages/{slug}")
    assert resp.status_code == 204, resp.text

    assert not html_path.exists()
    assert not (tmp_path / "data" / slug).exists()
    assert slug not in manifest_path.read_text()
    assert not comments_path.exists()


def test_delete_missing_slug_returns_404(app_client):
    client, _ = app_client
    resp = client.delete("/v1/pages/never-existed-abcdefghij")
    assert resp.status_code == 404


def test_delete_without_comments_file_is_fine(app_client):
    client, tmp_path = app_client
    slug = _publish(client, slug_seed="nocomments")
    comments_path = tmp_path / "state" / "comments" / f"{slug}.json"
    assert not comments_path.exists()

    resp = client.delete(f"/v1/pages/{slug}")
    assert resp.status_code == 204


def test_get_after_delete_is_404_static(app_client):
    client, _ = app_client
    slug = _publish(client, slug_seed="gone")
    client.delete(f"/v1/pages/{slug}")
    resp = client.get(f"/{slug}/")
    assert resp.status_code == 404

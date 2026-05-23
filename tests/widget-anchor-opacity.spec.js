import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WIDGET_JS = readFileSync(
  path.join(__dirname, "..", "api", "widget.js"),
  "utf8",
);

const SLUG = "opacity-deck";
const PAGE_URL = `http://test.local/${SLUG}/`;

const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>opacity deck</title>
<style>
  html, body { margin: 0; padding: 0; height: 100vh; overflow: hidden; background: #fff; }
  .slide {
    position: fixed; inset: 0;
    display: flex; align-items: center; justify-content: center;
    opacity: 0; pointer-events: none;
  }
  .slide.active { opacity: 1; pointer-events: auto; }
  .anchor { padding: 32px; border: 1px solid #999; font: 16px sans-serif; }
</style></head>
<body>
  <div class="slide active" data-slide="1">
    <h1 id="anchor-slide-1" class="anchor">Slide one anchor</h1>
  </div>
  <div class="slide" data-slide="2">
    <h1 id="anchor-slide-2" class="anchor">Slide two anchor</h1>
  </div>
  <script>
    window.__goto = (n) => {
      document.querySelectorAll(".slide").forEach((s) =>
        s.classList.toggle("active", Number(s.dataset.slide) === n),
      );
    };
  </script>
  <script>${WIDGET_JS}</script>
</body></html>`;

const STUB_THREAD = {
  id: "thread-1",
  parent_id: null,
  user_name: "Test User",
  body: "Comment anchored on slide 1",
  anchor: {
    selector: "#anchor-slide-1",
    text: "Slide one anchor",
    preview: "Slide one anchor",
    offset_dx: 0,
    offset_dy: 0,
  },
  created_at: "2026-05-22T10:00:00Z",
  resolved: false,
};

test.describe("comment widget — anchor visibility on slide change", () => {
  test.beforeEach(async ({ page }) => {
    await page.route(`**/${SLUG}/`, (route) =>
      route.fulfill({ body: FIXTURE_HTML, contentType: "text/html" }),
    );
    await page.route(`**/v1/pages/${SLUG}/comments*`, (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ json: { comments: [STUB_THREAD] } });
      }
      return route.fulfill({ json: {} });
    });
  });

  test("marker on an opacity:0 slide hides instead of painting over the active slide", async ({
    page,
  }) => {
    await page.goto(PAGE_URL);

    const marker = page.locator(".htmlz-marker");

    await expect(marker).toBeVisible();

    await page.evaluate(() => window.__goto(2));
    await expect(marker).toBeHidden();

    await page.evaluate(() => window.__goto(1));
    await expect(marker).toBeVisible();
  });
});

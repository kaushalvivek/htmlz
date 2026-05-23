import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WIDGET_JS = readFileSync(
  path.join(__dirname, "..", "api", "widget.js"),
  "utf8",
);

const SLUG = "newline-test";
const PAGE_URL = `http://test.local/${SLUG}/`;

const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>newline test</title>
<style>
  body { margin: 40px; font: 16px sans-serif; }
  #target { padding: 24px; border: 1px solid #999; display: inline-block; }
</style></head>
<body>
  <h1 id="target">Comment me</h1>
  <script>${WIDGET_JS}</script>
</body></html>`;

test.describe("compose newlines", () => {
  let postedBody = null;
  let storedComments = [];

  test.beforeEach(async ({ page }) => {
    postedBody = null;
    storedComments = [];

    await page.route(`**/${SLUG}/`, (route) =>
      route.fulfill({ body: FIXTURE_HTML, contentType: "text/html" }),
    );
    await page.route(`**/v1/pages/${SLUG}/comments*`, async (route) => {
      const req = route.request();
      if (req.method() === "GET") {
        return route.fulfill({ json: { comments: storedComments } });
      }
      if (req.method() === "POST") {
        const payload = req.postDataJSON();
        postedBody = payload.body;
        const stored = {
          id: "c_" + Date.now(),
          parent_id: null,
          user_name: payload.user_name,
          body: payload.body,
          anchor: payload.anchor,
          created_at: new Date().toISOString(),
          resolved: false,
        };
        storedComments.push(stored);
        return route.fulfill({ status: 201, json: stored });
      }
      return route.fulfill({ json: {} });
    });
  });

  test("newlines in the textarea survive round-trip to rendered comment", async ({
    page,
  }) => {
    await page.goto(PAGE_URL);

    await page.evaluate(() =>
      localStorage.setItem("ih-comments-name", "Test User"),
    );
    await page.reload();

    // Enter comment mode and click the target to open the new-comment popover.
    await page.keyboard.press("c");
    await page.locator("#target").click();

    const ta = page.locator(".htmlz-compose-pop textarea");
    await expect(ta).toBeVisible();

    await ta.focus();
    await page.keyboard.type("first line");
    await page.keyboard.press("Enter");
    await page.keyboard.type("second line");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("third paragraph");

    expect(await ta.inputValue()).toBe(
      "first line\nsecond line\n\nthird paragraph",
    );

    // Cmd/Ctrl-Enter submits.
    await page.keyboard.press("ControlOrMeta+Enter");

    await expect.poll(() => postedBody).not.toBeNull();
    expect(postedBody).toBe("first line\nsecond line\n\nthird paragraph");

    // Open the marker → thread popover → assert rendered body preserves
    // newlines (white-space: pre-wrap makes them lay out as separate lines).
    const marker = page.locator(".htmlz-marker");
    await expect(marker).toBeVisible();
    await marker.click();

    const rendered = page.locator(".htmlz-comment-body").first();
    await expect(rendered).toHaveText(
      "first line\nsecond line\n\nthird paragraph",
    );

    const computedHeight = await rendered.evaluate((el) => el.clientHeight);
    const singleLineHeight = await rendered.evaluate((el) => {
      const s = getComputedStyle(el);
      return parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.2;
    });
    expect(computedHeight).toBeGreaterThan(singleLineHeight * 2.5);
  });
});

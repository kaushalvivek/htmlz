/* htmlz comment widget
 *
 * Injected into every published page via FastAPI middleware. Designed to
 * disappear into the host page when idle and emerge cleanly when invoked.
 *
 * - Composer rail (bottom-right): single pill, two icons (comment mode + threads)
 * - Comment-mode banner (top center) so the mode is unambiguous
 * - Markers (26px circles) show the root commenter's initial; "+N" badge for replies
 * - Inline thread popover anchored to the marker; no separate side panel for it
 * - Sidebar lists threads visible on the current view only
 * - Identity is captured inline in the first compose; no modal
 *
 * URL is the credential. No auth.
 */
(function () {
  "use strict";
  if (window.__htmlzLoaded) return;
  window.__htmlzLoaded = true;

  const slug = (window.location.pathname.split("/").filter(Boolean)[0] || "").trim();
  if (!slug) return;

  const API = "/v1/pages/" + encodeURIComponent(slug) + "/comments";
  const NAME_KEY = "htmlz-name";
  const NS = "htmlz";
  const DRAG_THRESHOLD = 4;
  const POPOVER_WIDTH = 360;
  const POPOVER_HEIGHT_EST = 380;

  // ── state ────────────────────────────────────────────────────────────
  let mode = "idle"; // 'idle' | 'comment' | 'edit'
  let comments = [];
  let userName = (localStorage.getItem(NAME_KEY) || "").trim();
  let hoveredEl = null;
  let showResolved = false;
  let editToast = null;
  let editToastTimer = 0;

  /** threadId -> { marker, anchorEl, offsetX, offsetY, dragging } */
  const markerState = new Map();
  let openPopover = null;
  let openPopoverEntry = null;
  let sidePanel = null;
  let banner = null;
  let rail = null;
  let railListBadge = null;

  // ── DOM helpers ──────────────────────────────────────────────────────
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === "class") e.className = attrs[k];
      else if (k === "style") e.setAttribute("style", attrs[k]);
      else if (k.startsWith("on") && typeof attrs[k] === "function") e[k] = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    if (children) for (const c of [].concat(children)) {
      if (c == null) continue;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return e;
  }

  function timeAgo(iso) {
    if (!iso) return "";
    const d = Date.now() - new Date(iso).getTime();
    if (d < 60_000) return "just now";
    if (d < 3600_000) return Math.floor(d / 60_000) + "m";
    if (d < 86400_000) return Math.floor(d / 3600_000) + "h";
    if (d < 30 * 86400_000) return Math.floor(d / 86400_000) + "d";
    return new Date(iso).toISOString().slice(0, 10);
  }

  function initialOf(name) {
    const cleaned = (name || "").trim();
    if (!cleaned) return "?";
    return cleaned[0].toUpperCase();
  }

  // Deterministic avatar color: same person → same hue across surfaces.
  // FNV-1a 32-bit, using Math.imul so the multiply doesn't overflow into NaN
  // territory the way `*` does for large 32-bit values in JS.
  function avatarIndexFor(name) {
    const s = (name || "").trim().toLowerCase();
    if (!s) return 3; // slate as a calm fallback
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h % 6;
  }
  function avatarClassFor(name) {
    return NS + "-av-" + avatarIndexFor(name);
  }

  // ── icon helper ──────────────────────────────────────────────────────
  const ICON_SVG = {
    pencil:
      '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    chat:
      '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    trash:
      '<polyline points="3 6 5 6 21 6"/>' +
      '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
      '<line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
    type:
      '<polyline points="4 7 4 4 20 4 20 7"/>' +
      '<line x1="9" y1="20" x2="15" y2="20"/>' +
      '<line x1="12" y1="4" x2="12" y2="20"/>',
  };

  function icon(name, size = 16) {
    const wrap = document.createElement("span");
    wrap.setAttribute("data-" + NS + "-ui", "1");
    wrap.style.display = "inline-flex";
    wrap.innerHTML =
      '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true">' + ICON_SVG[name] + "</svg>";
    return wrap;
  }

  // ── anchor compute / resolve ─────────────────────────────────────────
  function shouldSkipForAnchor(node) {
    return !!node.closest && !!node.closest("[data-" + NS + "-ui]");
  }
  function buildSelector(target) {
    if (!target || target.nodeType !== 1) return null;
    if (target.id) return "#" + CSS.escape(target.id);
    const parts = [];
    let cur = target;
    while (cur && cur.nodeType === 1 && cur !== document.body && parts.length < 8) {
      let part = cur.tagName.toLowerCase();
      if (cur.parentNode) {
        const sameTag = Array.prototype.filter.call(
          cur.parentNode.children, (c) => c.tagName === cur.tagName
        );
        if (sameTag.length > 1) {
          const idx = Array.prototype.indexOf.call(sameTag, cur) + 1;
          part += ":nth-of-type(" + idx + ")";
        }
      }
      parts.unshift(part);
      cur = cur.parentNode;
    }
    return "body > " + parts.join(" > ");
  }
  function anchorFromElement(target) {
    const selector = buildSelector(target);
    const text = (target.textContent || "").trim().slice(0, 200);
    const preview = text || target.tagName.toLowerCase();
    return { selector, text: text || null, preview: preview.slice(0, 120) };
  }
  function resolveAnchor(anchor) {
    if (!anchor) return null;
    if (anchor.selector) {
      try {
        const node = document.querySelector(anchor.selector);
        if (node && !shouldSkipForAnchor(node)) return node;
      } catch (_) { /* invalid selector */ }
    }
    if (anchor.text) {
      const needle = anchor.text.trim();
      if (needle.length < 4) return null;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (shouldSkipForAnchor(node)) continue;
        const txt = (node.textContent || "").trim();
        if (txt.startsWith(needle.slice(0, 60))) return node;
      }
    }
    return null;
  }
  function isAnchorVisible(node) {
    if (!node || !document.body.contains(node)) return false;
    if (typeof node.checkVisibility === "function") {
      // checkVisibility() with no options ignores opacity, so decks that hide
      // inactive slides via `opacity: 0` (keeping the slide mounted for fade
      // transitions) leave anchors "visible" — markers then paint on top of
      // whatever slide is now active. Opt in to the full check.
      return node.checkVisibility({
        opacityProperty: true,
        visibilityProperty: true,
        contentVisibilityAuto: true,
      });
    }
    const r = node.getBoundingClientRect();
    return r.width !== 0 || r.height !== 0;
  }

  // ── styles ───────────────────────────────────────────────────────────
  const CSS_TEXT = `
    [data-${NS}-ui] {
      --htmlz-ink: #0a0a0a;
      --htmlz-ink-2: #404040;
      --htmlz-ink-3: #737373;
      --htmlz-ink-4: #a3a3a3;
      --htmlz-bg: #ffffff;
      --htmlz-bg-soft: #fafaf9;
      --htmlz-bg-hover: #f5f5f4;
      --htmlz-border: #e7e5e4;
      --htmlz-border-strong: #d6d3d1;
      --htmlz-ring: rgba(10,10,10,0.08);
      --htmlz-av-0: #c47a7a;
      --htmlz-av-1: #7a9b76;
      --htmlz-av-2: #c89368;
      --htmlz-av-3: #6e7d8d;
      --htmlz-av-4: #9b7aa6;
      --htmlz-av-5: #889466;
      --htmlz-radius-sm: 6px;
      --htmlz-radius-md: 12px;
      --htmlz-shadow-sm: 0 1px 2px rgba(10,10,10,0.04);
      --htmlz-shadow-md: 0 1px 2px rgba(10,10,10,0.04), 0 4px 10px rgba(10,10,10,0.06);
      --htmlz-shadow-lg: 0 1px 2px rgba(10,10,10,0.04), 0 12px 32px rgba(10,10,10,0.10);
      font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      box-sizing: border-box;
      -webkit-font-smoothing: antialiased;
    }
    [data-${NS}-ui] *, [data-${NS}-ui] *::before, [data-${NS}-ui] *::after { box-sizing: border-box; }
    [data-${NS}-ui] button { font-family: inherit; }
    /* Defensive reset: some host pages apply global \`svg { position: absolute }\`
       (e.g. canvases that use SVGs for connector overlays). That would yank every
       icon inside the widget across the viewport. Force inline behavior for our SVGs. */
    [data-${NS}-ui] svg {
      position: static !important;
      inset: auto !important;
      width: auto; height: auto;
      max-width: none; max-height: none;
      display: inline-block;
      flex-shrink: 0;
      pointer-events: auto;
      vertical-align: middle;
    }

    /* ── Composer rail: primary CTA + secondary icon ── */
    .${NS}-rail {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483600;
      display: inline-flex; align-items: center; gap: 8px;
    }
    .${NS}-rail-secondary {
      appearance: none; cursor: pointer;
      display: inline-flex; align-items: center; gap: 6px;
      height: 36px; padding: 0 12px;
      background: var(--htmlz-bg);
      border: 1px solid var(--htmlz-border);
      color: var(--htmlz-ink-2);
      border-radius: 999px;
      box-shadow: var(--htmlz-shadow-sm);
      font: 600 12.5px/1 inherit;
      letter-spacing: -0.005em;
      transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
    }
    .${NS}-rail-secondary:hover {
      background: var(--htmlz-bg-hover); color: var(--htmlz-ink);
      border-color: var(--htmlz-border-strong);
    }
    .${NS}-rail-secondary.${NS}-rail-secondary-active {
      background: var(--htmlz-ink); color: #ffffff;
      border-color: var(--htmlz-ink);
    }
    .${NS}-rail-count {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 18px; height: 18px; padding: 0 6px;
      background: var(--htmlz-ink); color: #ffffff;
      border-radius: 999px;
      font: 600 10.5px/1 inherit;
      margin-right: -2px;
    }
    .${NS}-rail-secondary.${NS}-rail-secondary-active .${NS}-rail-count {
      background: #ffffff; color: var(--htmlz-ink);
    }
    .${NS}-rail-primary {
      appearance: none; border: 0; cursor: pointer;
      display: inline-flex; align-items: center; gap: 8px;
      height: 36px; padding: 0 14px;
      background: var(--htmlz-ink); color: #ffffff;
      border-radius: 999px;
      font: 600 12.5px/1 inherit;
      letter-spacing: -0.005em;
      box-shadow: var(--htmlz-shadow-md);
      transition: background 0.14s ease;
    }
    .${NS}-rail-primary:hover { background: var(--htmlz-ink-2); }
    .${NS}-rail-primary kbd {
      font: 500 10px/1 ui-monospace, "JetBrains Mono", monospace;
      padding: 3px 5px;
      background: rgba(255,255,255,0.14);
      border-radius: 4px;
      color: rgba(255,255,255,0.78);
      margin-left: 2px;
    }

    /* ── Comment-mode banner ── */
    .${NS}-banner {
      position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
      z-index: 2147483600;
      display: inline-flex; align-items: center; gap: 10px;
      padding: 8px 14px;
      background: var(--htmlz-ink); color: white;
      border-radius: 999px;
      font: 500 12.5px/1 inherit;
      box-shadow: var(--htmlz-shadow-md);
      letter-spacing: -0.005em;
    }
    .${NS}-banner kbd {
      font: 500 11px/1 ui-monospace, "JetBrains Mono", monospace;
      padding: 3px 6px;
      background: rgba(255,255,255,0.14);
      border-radius: 4px;
      color: rgba(255,255,255,0.92);
    }

    /* ── Marker: filled colored avatar disk ── */
    .${NS}-marker {
      position: fixed; z-index: 2147483500;
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px;
      background: var(--htmlz-av-3);
      border: 1.5px solid #ffffff;
      border-radius: 999px;
      box-shadow: 0 0 0 1px rgba(10,10,10,0.08), 0 1px 2px rgba(10,10,10,0.10), 0 4px 8px rgba(10,10,10,0.06);
      cursor: grab; user-select: none; touch-action: none;
      font: 600 12px/1 inherit; color: #ffffff;
      letter-spacing: 0;
      transition: transform 0.18s cubic-bezier(.2,.7,.2,1), box-shadow 0.18s ease;
    }
    .${NS}-marker.${NS}-av-0 { background: var(--htmlz-av-0); }
    .${NS}-marker.${NS}-av-1 { background: var(--htmlz-av-1); }
    .${NS}-marker.${NS}-av-2 { background: var(--htmlz-av-2); }
    .${NS}-marker.${NS}-av-3 { background: var(--htmlz-av-3); }
    .${NS}-marker.${NS}-av-4 { background: var(--htmlz-av-4); }
    .${NS}-marker.${NS}-av-5 { background: var(--htmlz-av-5); }
    .${NS}-marker:hover {
      transform: scale(1.06);
      box-shadow: 0 0 0 1px rgba(10,10,10,0.12), 0 2px 4px rgba(10,10,10,0.12), 0 8px 16px rgba(10,10,10,0.08);
    }
    .${NS}-marker.${NS}-dragging {
      cursor: grabbing; transition: none;
      transform: scale(1.08);
    }
    .${NS}-marker.${NS}-active {
      box-shadow: 0 0 0 1px var(--htmlz-ink), 0 0 0 4px rgba(10,10,10,0.10), 0 4px 8px rgba(10,10,10,0.10);
    }
    .${NS}-marker.${NS}-resolved {
      opacity: 0.4;
    }
    .${NS}-marker-dot {
      position: absolute; right: -1px; bottom: -1px;
      width: 8px; height: 8px;
      background: var(--htmlz-ink);
      border: 1.5px solid #ffffff;
      border-radius: 999px;
    }
    .${NS}-marker.${NS}-resolved .${NS}-marker-dot { background: var(--htmlz-ink-4); }

    /* Hover affordance in comment mode */
    .${NS}-hover {
      outline: 2px solid var(--htmlz-ink) !important;
      outline-offset: 2px !important;
    }
    body.${NS}-mode * { cursor: crosshair !important; }
    body.${NS}-mode [data-${NS}-ui],
    body.${NS}-mode [data-${NS}-ui] * { cursor: auto !important; }
    body.${NS}-mode [data-${NS}-ui] button,
    body.${NS}-mode [data-${NS}-ui] a { cursor: pointer !important; }
    body.${NS}-mode [data-${NS}-ui] textarea,
    body.${NS}-mode [data-${NS}-ui] input { cursor: text !important; }

    /* ── Avatar (shared: marker uses .htmlz-marker; popover/sidebar use .htmlz-av) ── */
    .${NS}-av {
      flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center;
      width: 24px; height: 24px;
      background: var(--htmlz-av-3);
      border-radius: 999px;
      color: #ffffff;
      font: 600 10.5px/1 inherit;
      letter-spacing: 0;
    }
    .${NS}-av.${NS}-av-0 { background: var(--htmlz-av-0); }
    .${NS}-av.${NS}-av-1 { background: var(--htmlz-av-1); }
    .${NS}-av.${NS}-av-2 { background: var(--htmlz-av-2); }
    .${NS}-av.${NS}-av-3 { background: var(--htmlz-av-3); }
    .${NS}-av.${NS}-av-4 { background: var(--htmlz-av-4); }
    .${NS}-av.${NS}-av-5 { background: var(--htmlz-av-5); }
    .${NS}-av-lg { width: 28px; height: 28px; font-size: 11.5px; }

    /* ── Thread popover ── */
    .${NS}-thread {
      position: fixed; z-index: 2147483640;
      width: 360px; max-height: min(70vh, 560px);
      background: var(--htmlz-bg);
      border: 1px solid var(--htmlz-border);
      border-radius: var(--htmlz-radius-md);
      box-shadow: var(--htmlz-shadow-lg);
      display: flex; flex-direction: column;
      color: var(--htmlz-ink); font: 13px/1.55 inherit;
      overflow: hidden;
      animation: ${NS}-fade-up 0.18s cubic-bezier(.2,.7,.2,1);
    }
    @keyframes ${NS}-fade-up {
      from { opacity: 0; transform: translateY(4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .${NS}-thread-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 8px 10px 16px;
      border-bottom: 1px solid var(--htmlz-border);
      flex-shrink: 0;
    }
    .${NS}-thread-title {
      font: 600 10.5px/1 inherit;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--htmlz-ink-3);
    }
    .${NS}-thread-actions { display: flex; gap: 2px; }
    .${NS}-icon-btn {
      appearance: none; border: 0; background: transparent;
      width: 28px; height: 28px;
      display: inline-flex; align-items: center; justify-content: center;
      color: var(--htmlz-ink-3); cursor: pointer;
      border-radius: var(--htmlz-radius-sm);
      transition: background 0.14s ease, color 0.14s ease;
    }
    .${NS}-icon-btn:hover { background: var(--htmlz-bg-hover); color: var(--htmlz-ink); }
    .${NS}-icon-btn.${NS}-resolved-on {
      color: var(--htmlz-av-1);
    }
    .${NS}-icon-btn.${NS}-resolved-on:hover { background: var(--htmlz-bg-hover); }

    .${NS}-thread-body {
      flex: 1; min-height: 0; overflow-y: auto;
      padding: 14px 16px 4px;
      position: relative;
    }
    /* Vertical hairline running through the avatar column. Drawn as a
       pseudo on the body so it sits behind the row avatars (each avatar
       has its own white bg, so the line gets "broken" by each disk). */
    .${NS}-thread-body::before {
      content: "";
      position: absolute;
      left: 27px; /* 16px padding + 11px (half of 24px avatar - 1px line) */
      top: 14px;
      bottom: 0;
      width: 1px;
      background: var(--htmlz-border);
      pointer-events: none;
    }
    .${NS}-comment {
      position: relative;
      display: flex; gap: 10px; align-items: flex-start;
      padding: 0 0 14px;
    }
    .${NS}-comment:last-child { padding-bottom: 14px; }
    .${NS}-comment .${NS}-av {
      position: relative;
      z-index: 1;
      box-shadow: 0 0 0 3px var(--htmlz-bg);
    }
    .${NS}-comment-content { flex: 1; min-width: 0; }
    .${NS}-comment-meta {
      font: 12px/1.3 inherit; color: var(--htmlz-ink-3);
      margin-bottom: 2px;
    }
    .${NS}-comment-meta strong {
      color: var(--htmlz-ink); font-weight: 600;
      font-size: 13px;
      margin-right: 2px;
    }
    .${NS}-comment-body {
      white-space: pre-wrap; word-break: break-word;
      font-size: 13px; color: var(--htmlz-ink-2);
      line-height: 1.55;
    }
    .${NS}-comment-delete {
      appearance: none; border: 0; background: transparent;
      width: 24px; height: 24px;
      flex-shrink: 0;
      color: var(--htmlz-ink-4); cursor: pointer;
      border-radius: 4px;
      opacity: 0;
      transition: opacity 0.14s ease, background 0.14s ease, color 0.14s ease;
      display: inline-flex; align-items: center; justify-content: center;
      margin-top: -2px;
    }
    .${NS}-comment:hover .${NS}-comment-delete { opacity: 1; }
    .${NS}-comment-delete:hover { background: var(--htmlz-bg-hover); color: var(--htmlz-ink); }

    /* ── Compose area (shared between thread + new-comment) ── */
    .${NS}-compose {
      border-top: 1px solid var(--htmlz-border);
      padding: 12px 16px 14px;
      background: var(--htmlz-bg-soft);
      flex-shrink: 0;
    }
    .${NS}-compose-pop {
      position: fixed; z-index: 2147483640;
      width: 340px; padding: 14px;
      background: var(--htmlz-bg);
      border: 1px solid var(--htmlz-border);
      border-radius: var(--htmlz-radius-md);
      box-shadow: var(--htmlz-shadow-lg);
      color: var(--htmlz-ink); font: 13px/1.55 inherit;
      animation: ${NS}-fade-up 0.18s cubic-bezier(.2,.7,.2,1);
    }
    .${NS}-compose textarea, .${NS}-compose-pop textarea {
      width: 100%; resize: vertical; min-height: 64px;
      font: inherit; font-size: 13px; line-height: 1.55;
      color: var(--htmlz-ink);
      background: var(--htmlz-bg);
      border: 1px solid var(--htmlz-border);
      border-radius: var(--htmlz-radius-sm);
      padding: 8px 10px;
      transition: border-color 0.14s ease, box-shadow 0.14s ease;
    }
    .${NS}-compose textarea:focus, .${NS}-compose-pop textarea:focus {
      outline: 0; border-color: var(--htmlz-ink-2);
      box-shadow: 0 0 0 3px var(--htmlz-ring);
    }
    .${NS}-name-input {
      width: 100%; margin-top: 8px;
      font: inherit; font-size: 12.5px; line-height: 1.4;
      color: var(--htmlz-ink);
      background: var(--htmlz-bg); border: 1px solid var(--htmlz-border);
      border-radius: var(--htmlz-radius-sm); padding: 7px 9px;
      transition: border-color 0.14s ease, box-shadow 0.14s ease;
    }
    .${NS}-name-input:focus {
      outline: 0; border-color: var(--htmlz-ink-2);
      box-shadow: 0 0 0 3px var(--htmlz-ring);
    }
    .${NS}-compose-foot {
      margin-top: 10px;
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
    }
    .${NS}-posting-as {
      font: 12px/1.3 inherit; color: var(--htmlz-ink-3);
      display: inline-flex; align-items: center; gap: 4px;
    }
    .${NS}-posting-as:empty { display: none; }
    .${NS}-posting-as em { font-style: normal; color: var(--htmlz-ink-2); font-weight: 500; }
    .${NS}-link {
      appearance: none; background: transparent; border: 0; padding: 0;
      color: var(--htmlz-ink-3); cursor: pointer; font: inherit;
      text-decoration: underline;
      text-decoration-color: var(--htmlz-border-strong);
      text-underline-offset: 2px;
    }
    .${NS}-link:hover { color: var(--htmlz-ink); text-decoration-color: var(--htmlz-ink-3); }
    .${NS}-btn-primary {
      appearance: none; cursor: pointer;
      background: var(--htmlz-ink); color: white;
      border: 0; border-radius: var(--htmlz-radius-sm);
      padding: 8px 16px; font: 600 12px/1 inherit;
      letter-spacing: -0.005em;
      transition: background 0.14s ease;
    }
    .${NS}-btn-primary:hover { background: var(--htmlz-ink-2); }
    .${NS}-btn-primary:disabled { background: var(--htmlz-ink-4); cursor: not-allowed; }
    .${NS}-btn-ghost {
      appearance: none; cursor: pointer;
      background: transparent; color: var(--htmlz-ink-2);
      border: 1px solid var(--htmlz-border); border-radius: var(--htmlz-radius-sm);
      padding: 6px 12px; font: 500 12px/1 inherit;
      transition: background 0.14s ease, border-color 0.14s ease;
    }
    .${NS}-btn-ghost:hover { background: var(--htmlz-bg-hover); border-color: var(--htmlz-border-strong); }

    /* ── Sidebar ── */
    .${NS}-sidebar {
      position: fixed; right: 16px; bottom: 64px;
      width: 340px; max-height: min(70vh, 560px); z-index: 2147483630;
      background: var(--htmlz-bg);
      border: 1px solid var(--htmlz-border);
      border-radius: var(--htmlz-radius-md);
      box-shadow: var(--htmlz-shadow-lg);
      display: flex; flex-direction: column;
      font: 13px/1.55 inherit; color: var(--htmlz-ink);
      overflow: hidden;
      animation: ${NS}-fade-up 0.18s cubic-bezier(.2,.7,.2,1);
    }
    .${NS}-sidebar-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 8px 10px 16px;
      border-bottom: 1px solid var(--htmlz-border);
    }
    .${NS}-sidebar-head h3 {
      margin: 0;
      font: 600 10.5px/1 inherit;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--htmlz-ink-3);
    }
    .${NS}-sidebar-list { flex: 1; min-height: 0; overflow-y: auto; }
    .${NS}-sidebar-row {
      display: flex; gap: 12px; align-items: flex-start;
      padding: 12px 16px;
      cursor: pointer;
      border-bottom: 1px solid var(--htmlz-border);
      transition: background 0.14s ease;
    }
    .${NS}-sidebar-row:hover { background: var(--htmlz-bg-soft); }
    .${NS}-sidebar-row:last-of-type { border-bottom: 0; }
    .${NS}-sidebar-row.${NS}-resolved { opacity: 0.5; }
    .${NS}-sidebar-row .${NS}-av { margin-top: 1px; }
    .${NS}-row-content { flex: 1; min-width: 0; }
    .${NS}-row-name {
      font: 600 13px/1.3 inherit; color: var(--htmlz-ink);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .${NS}-row-snippet {
      font: 12.5px/1.5 inherit; color: var(--htmlz-ink-2); margin-top: 3px;
      overflow: hidden; text-overflow: ellipsis;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    }
    .${NS}-row-meta {
      font: 11.5px/1.3 inherit; color: var(--htmlz-ink-4); margin-top: 5px;
    }
    .${NS}-sidebar-empty {
      padding: 32px 20px; text-align: center;
      color: var(--htmlz-ink-3); font-size: 12.5px; line-height: 1.5;
    }
    .${NS}-sidebar-foot {
      padding: 10px 14px;
      border-top: 1px solid var(--htmlz-border);
      display: flex; justify-content: center;
    }
    .${NS}-sidebar-foot .${NS}-btn-ghost {
      font-size: 11.5px;
      padding: 5px 12px;
    }

    /* ── Edit mode: in-place text editing ── */
    /* Per-text-node wrapper. Inline so it doesn't reflow the host's layout.
       white-space: pre-wrap is required so Enter keystrokes produce a
       visible line break while editing; without it the typed \n collapses
       to a space and the user thinks Enter did nothing. */
    [data-htmlz-edit] {
      outline: 1px dashed transparent;
      outline-offset: 2px;
      border-radius: 2px;
      white-space: pre-wrap;
      transition: outline-color 0.12s ease, background 0.12s ease;
    }
    body.${NS}-edit-mode [data-htmlz-edit] {
      outline-color: rgba(10,10,10,0.18);
      cursor: text;
    }
    body.${NS}-edit-mode [data-htmlz-edit]:hover {
      outline-color: var(--htmlz-ink-2);
      background: rgba(10,10,10,0.04);
    }
    [data-htmlz-edit]:focus {
      outline: 2px solid var(--htmlz-ink) !important;
      outline-offset: 2px;
      background: rgba(10,10,10,0.05);
    }
    [data-htmlz-edit][data-htmlz-edit-state="saving"] {
      outline: 2px solid var(--htmlz-av-2) !important;
    }
    [data-htmlz-edit][data-htmlz-edit-state="saved"] {
      outline: 2px solid #10b981 !important;
      background: rgba(16,185,129,0.10);
    }
    [data-htmlz-edit][data-htmlz-edit-state="error"] {
      outline: 2px solid #b91c1c !important;
      background: rgba(185,28,28,0.10);
    }

    /* Edit-mode error toast (also reused for save failures) */
    .${NS}-toast {
      position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
      z-index: 2147483700;
      padding: 8px 14px;
      background: #fef2f2; color: #991b1b;
      border: 1px solid #fecaca;
      border-radius: var(--htmlz-radius-sm);
      box-shadow: var(--htmlz-shadow-md);
      font: 500 12.5px/1.3 inherit;
      max-width: 80vw;
    }
  `;

  function injectStyles() {
    const style = el("style", { "data-htmlz-ui": "1" });
    style.textContent = CSS_TEXT;
    document.head.appendChild(style);
  }

  // ── network ──────────────────────────────────────────────────────────
  async function fetchComments() {
    const r = await fetch(API + "?include_resolved=true", { cache: "no-store" });
    if (!r.ok) return [];
    const data = await r.json();
    comments = Array.isArray(data.comments) ? data.comments : [];
    return comments;
  }
  async function postComment(payload) {
    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error("create failed: " + r.status);
    return r.json();
  }
  async function patchComment(cid, payload) {
    const r = await fetch(API + "/" + encodeURIComponent(cid), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error("patch failed: " + r.status);
    return r.json();
  }
  async function deleteComment(cid) {
    const r = await fetch(API + "/" + encodeURIComponent(cid), { method: "DELETE" });
    if (!r.ok) throw new Error("delete failed: " + r.status);
  }

  // ── thread grouping ──────────────────────────────────────────────────
  function getThreads() {
    const roots = comments.filter((c) => c.parent_id == null);
    return roots.map((root) => ({
      root,
      replies: comments
        .filter((c) => c.parent_id === root.id)
        .sort((a, b) => (a.created_at < b.created_at ? -1 : 1)),
    }));
  }
  function getVisibleThreads() {
    return getThreads().filter((t) => {
      const entry = markerState.get(t.root.id);
      return entry && isAnchorVisible(entry.anchorEl);
    });
  }
  function getVisibleUnresolvedCount() {
    return getVisibleThreads().filter((t) => !t.root.resolved).length;
  }
  function visibleThreadsKey() {
    return getVisibleThreads()
      .map((t) => t.root.id + ":" + (t.root.resolved ? "1" : "0") + ":" + t.replies.length)
      .sort()
      .join(",");
  }

  // ── markers ──────────────────────────────────────────────────────────
  function syncMarkers() {
    const threads = getThreads();
    const liveIds = new Set(threads.map((t) => t.root.id));

    for (const [id, entry] of Array.from(markerState)) {
      const stillLive = liveIds.has(id);
      const root = stillLive ? threads.find((t) => t.root.id === id).root : null;
      const hide = !stillLive || (root.resolved && !showResolved);
      if (hide) {
        if (entry.marker.parentNode) entry.marker.parentNode.removeChild(entry.marker);
        markerState.delete(id);
        if (openPopoverEntry === entry) closePopover();
      }
    }

    for (const { root, replies } of threads) {
      if (root.resolved && !showResolved) continue;
      let entry = markerState.get(root.id);
      if (!entry) {
        const marker = el("div", { class: NS + "-marker", "data-htmlz-ui": "1" });
        document.body.appendChild(marker);
        entry = { marker, anchorEl: null, offsetX: 0, offsetY: 0, dragging: false };
        markerState.set(root.id, entry);
        attachMarkerInteractions(entry, root.id);
      }
      entry.anchorEl = resolveAnchor(root.anchor);
      entry.offsetX = (root.anchor && root.anchor.offset_dx) || 0;
      entry.offsetY = (root.anchor && root.anchor.offset_dy) || 0;
      paintMarker(entry, root, replies);
    }
    repositionMarkers();
  }

  function paintMarker(entry, root, replies) {
    const m = entry.marker;
    m.classList.toggle(NS + "-resolved", !!root.resolved);
    // Reset any previous color class, then apply the deterministic one.
    for (let i = 0; i < 6; i++) m.classList.remove(NS + "-av-" + i);
    m.classList.add(avatarClassFor(root.user_name));
    const replyHint = replies.length
      ? " · " + (1 + replies.length) + " messages"
      : "";
    m.title = root.user_name + replyHint + "\n" + (root.body || "").slice(0, 160);

    // Render initial + neutral reply dot (count lives in tooltip, not on the chip).
    while (m.firstChild) m.removeChild(m.firstChild);
    m.appendChild(document.createTextNode(initialOf(root.user_name)));
    if (replies.length > 0) {
      m.appendChild(el("span", { class: NS + "-marker-dot" }));
    }
  }

  let _lastVisibleKey = null;
  function repositionMarkers() {
    for (const [, entry] of markerState) positionMarker(entry);
    if (openPopover && openPopoverEntry) {
      const markerHidden = openPopoverEntry.marker.style.display === "none";
      if (markerHidden) {
        if (openPopover.style.display !== "none") openPopover.style.display = "none";
      } else {
        if (openPopover.style.display === "none") {
          openPopover.style.display = "";
          openPopover._lastTop = openPopover._lastLeft = undefined;
        }
        positionPopover(openPopover, openPopoverEntry);
      }
    }
    const key = visibleThreadsKey();
    if (key !== _lastVisibleKey) {
      _lastVisibleKey = key;
      renderRail();
      if (sidePanel) renderSidebar();
    }
  }

  function positionMarker(entry) {
    if (entry.dragging) return;
    const m = entry.marker;
    if (!isAnchorVisible(entry.anchorEl)) {
      if (m.style.display !== "none") m.style.display = "none";
      return;
    }
    const rect = entry.anchorEl.getBoundingClientRect();
    const offscreen =
      rect.bottom < -40 || rect.top > window.innerHeight + 40 ||
      rect.right < -40  || rect.left > window.innerWidth + 40;
    if (offscreen) {
      if (m.style.display !== "none") m.style.display = "none";
      return;
    }
    if (m.style.display === "none") m.style.display = "";
    // Anchor in the right gutter, vertically centered against the element.
    // Falls back to the inside-corner placement when the page's right margin
    // is too narrow to fit a 28px disk + breathing room — keeps the marker
    // on screen instead of clipping past the viewport edge.
    const base = baseMarkerPosition(rect);
    const top = base.top + entry.offsetY;
    const left = base.left + entry.offsetX;
    if (entry._lastTop !== top) { m.style.top = top + "px"; entry._lastTop = top; }
    if (entry._lastLeft !== left) { m.style.left = left + "px"; entry._lastLeft = left; }
  }

  function baseMarkerPosition(rect) {
    const MARKER = 28;
    const GUTTER_GAP = 8;
    const VIEWPORT_PAD = 12;
    const wantLeft = rect.right + GUTTER_GAP;
    const fitsOutside = wantLeft + MARKER <= window.innerWidth - VIEWPORT_PAD;
    const left = fitsOutside
      ? wantLeft
      : rect.right - MARKER + 4;
    const top = rect.top + (rect.height / 2) - (MARKER / 2);
    return { top, left };
  }

  function attachMarkerInteractions(entry, threadId) {
    let startX = 0, startY = 0, startOffX = 0, startOffY = 0, moved = false;
    function onDown(e) {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      startX = e.clientX; startY = e.clientY;
      startOffX = entry.offsetX; startOffY = entry.offsetY;
      moved = false;
      entry.dragging = true;
      entry._lastTop = entry._lastLeft = undefined;
      entry.marker.classList.add(NS + "-dragging");
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    }
    function onMove(e) {
      if (!entry.dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) moved = true;
      if (moved) {
        entry.offsetX = startOffX + dx; entry.offsetY = startOffY + dy;
        const rect = entry.anchorEl.getBoundingClientRect();
        const base = baseMarkerPosition(rect);
        entry.marker.style.top = (base.top + entry.offsetY) + "px";
        entry.marker.style.left = (base.left + entry.offsetX) + "px";
        if (openPopover && openPopoverEntry === entry) positionPopover(openPopover, entry);
      }
    }
    async function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      entry.dragging = false;
      entry.marker.classList.remove(NS + "-dragging");
      if (moved) {
        try {
          await patchComment(threadId, {
            offset_dx: Math.round(entry.offsetX),
            offset_dy: Math.round(entry.offsetY),
          });
        } catch (_) { /* keep local position */ }
      } else {
        openThreadPopover(threadId, entry);
      }
    }
    entry.marker.addEventListener("mousedown", onDown);
  }

  // ── popover positioning ──────────────────────────────────────────────
  function positionPopover(pop, entry) {
    const m = entry.marker.getBoundingClientRect();
    const ph = pop.offsetHeight || POPOVER_HEIGHT_EST;
    let left = m.right + 10;
    let top = m.top - 8;
    if (left + POPOVER_WIDTH > window.innerWidth - 12) {
      left = m.left - POPOVER_WIDTH - 10;
    }
    if (left < 12) left = 12;
    if (top + ph > window.innerHeight - 12) top = window.innerHeight - ph - 12;
    if (top < 12) top = 12;
    if (pop._lastTop !== top) { pop.style.top = top + "px"; pop._lastTop = top; }
    if (pop._lastLeft !== left) { pop.style.left = left + "px"; pop._lastLeft = left; }
  }
  function closePopover() {
    if (openPopover && openPopover.parentNode) openPopover.parentNode.removeChild(openPopover);
    if (openPopoverEntry) openPopoverEntry.marker.classList.remove(NS + "-active");
    openPopover = null;
    openPopoverEntry = null;
  }

  // ── thread popover ───────────────────────────────────────────────────
  function openThreadPopover(threadId, entry) {
    closePopover(); closeSidebar();
    const thread = getThreads().find((t) => t.root.id === threadId);
    if (!thread) return;
    const popover = buildThreadPopover(thread, entry);
    document.body.appendChild(popover);
    openPopover = popover;
    openPopoverEntry = entry;
    entry.marker.classList.add(NS + "-active");
    positionPopover(popover, entry);

    setTimeout(() => {
      const onDocClick = (e) => {
        if (popover.contains(e.target) || entry.marker.contains(e.target)) return;
        document.removeEventListener("mousedown", onDocClick, true);
        closePopover();
      };
      document.addEventListener("mousedown", onDocClick, true);
    }, 0);
  }

  function buildThreadPopover(thread, entry) {
    // Head: root author + time on the left, resolve + close on the right.
    const resolveBtn = el("button", {
      class: NS + "-icon-btn" + (thread.root.resolved ? " " + NS + "-resolved-on" : ""),
      title: thread.root.resolved ? "Reopen thread" : "Resolve thread",
      "data-htmlz-ui": "1",
    }, [icon("check")]);
    resolveBtn.onclick = async () => {
      try {
        await patchComment(thread.root.id, { resolved: !thread.root.resolved });
        await fetchComments();
        syncMarkers();
        if (!thread.root.resolved) {
          closePopover();
        } else {
          openThreadPopover(thread.root.id, entry);
        }
      } catch (err) { alert("Failed: " + err.message); }
    };
    const closeBtn = el("button", {
      class: NS + "-icon-btn", title: "Close", "data-htmlz-ui": "1",
    }, [icon("close")]);
    closeBtn.onclick = closePopover;

    const head = el("div", { class: NS + "-thread-head" }, [
      el("div", { class: NS + "-thread-title" }, "Thread"),
      el("div", { class: NS + "-thread-actions" }, [resolveBtn, closeBtn]),
    ]);

    // Body: every entry — root included — uses the same avatar + name + body
    // pattern, so the root reads as the first message of one conversation
    // rather than a separate object.
    const body = el("div", { class: NS + "-thread-body" });

    const allEntries = [
      { c: thread.root, isRoot: true },
      ...thread.replies.map((r) => ({ c: r, isRoot: false })),
    ];
    for (const { c, isRoot } of allEntries) {
      const delBtn = el("button", {
        class: NS + "-comment-delete",
        title: isRoot ? "Delete thread" : "Delete reply",
        "data-htmlz-ui": "1",
      }, [icon("trash", 14)]);
      delBtn.onclick = async () => {
        const msg = isRoot
          ? "Delete this thread and all its replies?"
          : "Delete this reply?";
        if (!confirm(msg)) return;
        try {
          await deleteComment(c.id);
          await fetchComments();
          syncMarkers();
          if (isRoot) closePopover();
          else openThreadPopover(thread.root.id, entry);
        } catch (err) { alert("Failed: " + err.message); }
      };
      body.appendChild(el("div", { class: NS + "-comment" }, [
        el("div", { class: NS + "-av " + avatarClassFor(c.user_name) }, initialOf(c.user_name)),
        el("div", { class: NS + "-comment-content" }, [
          el("div", { class: NS + "-comment-meta" }, [
            el("strong", null, c.user_name),
            document.createTextNode(" · " + timeAgo(c.created_at)),
          ]),
          el("div", { class: NS + "-comment-body" }, c.body),
        ]),
        delBtn,
      ]));
    }

    // Compose area at the bottom.
    const compose = buildComposeArea({
      placeholder: "Reply…",
      submitLabel: "Reply",
      onSubmit: async (text, name) => {
        await postComment({ user_name: name, body: text, parent_id: thread.root.id });
        await fetchComments();
        syncMarkers();
        openThreadPopover(thread.root.id, entry);
      },
    });

    return el("div", { class: NS + "-thread", "data-htmlz-ui": "1" }, [head, body, compose]);
  }

  // ── compose area (shared) ────────────────────────────────────────────
  function buildComposeArea(opts) {
    const wrap = el("div", { class: NS + "-compose", "data-htmlz-ui": "1" });
    const ta = el("textarea", { placeholder: opts.placeholder || "Comment…" });
    let nameInput = null;
    let editingName = false;

    const submit = el("button", {
      class: NS + "-btn-primary", "data-htmlz-ui": "1",
    }, opts.submitLabel || "Comment");

    const postingAs = el("span", { class: NS + "-posting-as" });

    function renderFoot() {
      while (postingAs.firstChild) postingAs.removeChild(postingAs.firstChild);
      if (userName && !editingName) {
        postingAs.appendChild(document.createTextNode("posting as "));
        postingAs.appendChild(el("em", null, userName));
        const changeBtn = el("button", { class: NS + "-link", type: "button" }, "change");
        changeBtn.onclick = () => { editingName = true; renderFoot(); };
        postingAs.appendChild(document.createTextNode(" · "));
        postingAs.appendChild(changeBtn);
        if (nameInput && nameInput.parentNode) nameInput.parentNode.removeChild(nameInput);
        nameInput = null;
      } else {
        // No name yet — show the name input only; leave the footer text
        // empty (CSS hides empty `.htmlz-posting-as` via :empty) so we never
        // render the half-string "posting as " with nothing after it.
        if (!nameInput) {
          nameInput = el("input", {
            class: NS + "-name-input",
            type: "text",
            placeholder: "your name",
            value: userName || "",
            autocomplete: "name",
          });
          // Insert just below the textarea, above the footer.
          ta.insertAdjacentElement("afterend", nameInput);
        }
      }
    }

    async function doSubmit() {
      const body = (ta.value || "").trim();
      if (!body) { ta.focus(); return; }
      let name = userName;
      if (!name || editingName) {
        name = ((nameInput && nameInput.value) || "").trim();
        if (!name) { nameInput && nameInput.focus(); return; }
        if (name.length > 80) name = name.slice(0, 80);
        userName = name;
        localStorage.setItem(NAME_KEY, name);
        editingName = false;
      }
      submit.disabled = true;
      try {
        await opts.onSubmit(body, name);
      } catch (err) {
        alert("Failed: " + err.message);
        submit.disabled = false;
      }
    }
    submit.onclick = doSubmit;
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doSubmit(); }
    });

    const foot = el("div", { class: NS + "-compose-foot" }, [postingAs, submit]);
    wrap.appendChild(ta);
    wrap.appendChild(foot);
    renderFoot();
    setTimeout(() => ta.focus(), 30);
    return wrap;
  }

  // ── new-comment popover (comment mode) ───────────────────────────────
  function showNewCommentPopover(target) {
    const anchor = anchorFromElement(target);
    const rect = target.getBoundingClientRect();
    let top = rect.bottom + 10;
    let left = rect.left;
    if (left + 340 > window.innerWidth - 12) left = window.innerWidth - 352;
    if (left < 12) left = 12;
    if (top + 200 > window.innerHeight - 12) top = window.innerHeight - 212;
    if (top < 12) top = 12;

    const pop = el("div", {
      class: NS + "-compose-pop", "data-htmlz-ui": "1",
      style: `top:${top}px;left:${left}px;`,
    });

    const compose = buildComposeArea({
      placeholder: "Comment…",
      submitLabel: "Comment",
      onSubmit: async (text, name) => {
        await postComment({ user_name: name, body: text, anchor });
        await fetchComments();
        syncMarkers();
        if (pop.parentNode) pop.parentNode.removeChild(pop);
        exitMode();
      },
    });
    // Strip the shared compose's outer styling — the popover is the surface.
    compose.classList.remove(NS + "-compose");
    pop.appendChild(compose);

    // Close on outside click or Esc.
    setTimeout(() => {
      const onDoc = (e) => {
        if (pop.contains(e.target)) return;
        document.removeEventListener("mousedown", onDoc, true);
        if (pop.parentNode) pop.parentNode.removeChild(pop);
      };
      document.addEventListener("mousedown", onDoc, true);
    }, 0);
    pop.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { if (pop.parentNode) pop.parentNode.removeChild(pop); }
    });

    document.body.appendChild(pop);
  }

  // ── comment mode ─────────────────────────────────────────────────────
  function toggleMode() { if (mode === "comment") exitMode(); else enterMode(); }
  function enterMode() {
    if (mode === "edit") exitEditMode();
    closePopover(); closeSidebar();
    mode = "comment";
    document.body.classList.add(NS + "-mode");
    document.addEventListener("mouseover", onHover, true);
    document.addEventListener("mouseout", onUnhover, true);
    document.addEventListener("click", onPickElement, true);
    showBanner("Comment mode — click any element");
    renderRail();
  }
  function exitMode() {
    mode = "idle";
    document.body.classList.remove(NS + "-mode");
    document.removeEventListener("mouseover", onHover, true);
    document.removeEventListener("mouseout", onUnhover, true);
    document.removeEventListener("click", onPickElement, true);
    if (hoveredEl) hoveredEl.classList.remove(NS + "-hover");
    hoveredEl = null;
    hideBanner();
    renderRail();
  }
  function onHover(e) {
    if (shouldSkipForAnchor(e.target)) return;
    if (hoveredEl) hoveredEl.classList.remove(NS + "-hover");
    hoveredEl = e.target;
    hoveredEl.classList.add(NS + "-hover");
  }
  function onUnhover(e) {
    if (e.target === hoveredEl) {
      hoveredEl.classList.remove(NS + "-hover");
      hoveredEl = null;
    }
  }
  function onPickElement(e) {
    if (shouldSkipForAnchor(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    const target = e.target;
    if (hoveredEl) hoveredEl.classList.remove(NS + "-hover");
    showNewCommentPopover(target);
  }

  // ── mode banner (shared comment + edit) ──────────────────────────────
  function showBanner(text) {
    hideBanner();
    banner = el("div", { class: NS + "-banner", "data-htmlz-ui": "1" }, [
      document.createTextNode(text),
      el("kbd", null, "Esc"),
    ]);
    document.body.appendChild(banner);
  }
  function hideBanner() {
    if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
    banner = null;
  }

  // ── sidebar (visible threads) ────────────────────────────────────────
  function closeSidebar() {
    if (sidePanel && sidePanel.parentNode) sidePanel.parentNode.removeChild(sidePanel);
    sidePanel = null;
    renderRail();
  }
  function toggleSidebar() {
    if (sidePanel) closeSidebar();
    else openSidebar();
  }
  function openSidebar() {
    closePopover();
    renderSidebar();
    renderRail();
  }
  function renderSidebar() {
    if (sidePanel && sidePanel.parentNode) sidePanel.parentNode.removeChild(sidePanel);
    const threads = getVisibleThreads();
    const unresolved = threads.filter((t) => !t.root.resolved);
    const resolved = threads.filter((t) => t.root.resolved);

    const closeBtn = el("button", {
      class: NS + "-icon-btn", title: "Close", "data-htmlz-ui": "1",
    }, [icon("close")]);
    closeBtn.onclick = closeSidebar;

    const head = el("div", { class: NS + "-sidebar-head" }, [
      el("h3", null, "Threads in view"),
      closeBtn,
    ]);

    const list = el("div", { class: NS + "-sidebar-list" });
    const shown = showResolved ? threads : unresolved;
    if (!shown.length) {
      const allCount = getThreads().length;
      list.appendChild(el("div", { class: NS + "-sidebar-empty" },
        allCount === 0
          ? "No comments yet. Click the pencil icon and pick an element."
          : "No comments on what's in view."));
    } else {
      shown.sort((a, b) => (a.root.created_at < b.root.created_at ? 1 : -1));
      for (const t of shown) {
        const row = el("div", {
          class: NS + "-sidebar-row" + (t.root.resolved ? " " + NS + "-resolved" : ""),
        }, [
          el("div", {
            class: NS + "-av " + NS + "-av-lg " + avatarClassFor(t.root.user_name),
          }, initialOf(t.root.user_name)),
          el("div", { class: NS + "-row-content" }, [
            el("div", { class: NS + "-row-name" }, t.root.user_name),
            el("div", { class: NS + "-row-snippet" }, t.root.body || ""),
            el("div", { class: NS + "-row-meta" },
              timeAgo(t.root.created_at) +
              (t.replies.length ? " · " + (1 + t.replies.length) + " messages" : "")),
          ]),
        ]);
        row.onclick = () => {
          const entry = markerState.get(t.root.id);
          if (!entry || !entry.anchorEl) return;
          entry.anchorEl.scrollIntoView({ behavior: "smooth", block: "center" });
          setTimeout(() => {
            repositionMarkers();
            const e2 = markerState.get(t.root.id);
            if (e2 && e2.marker.style.display !== "none") openThreadPopover(t.root.id, e2);
          }, 300);
        };
        list.appendChild(row);
      }
    }

    const resolvedToggle = el("button", {
      class: NS + "-btn-ghost",
      "data-htmlz-ui": "1",
    }, showResolved
      ? "Hide resolved (" + resolved.length + ")"
      : "Show resolved (" + resolved.length + ")");
    resolvedToggle.onclick = () => {
      showResolved = !showResolved;
      _lastVisibleKey = null; // force refresh
      syncMarkers();
      renderSidebar();
    };
    const foot = el("div", { class: NS + "-sidebar-foot" }, [resolvedToggle]);

    sidePanel = el("div", { class: NS + "-sidebar", "data-htmlz-ui": "1" }, [head, list, foot]);
    document.body.appendChild(sidePanel);
  }

  // ── edit mode (in-place text) ────────────────────────────────────────
  //
  // The atom of editing is the text node. On entering edit mode we walk
  // <body>, compute a body-relative path for every non-empty text node, and
  // wrap each in a <span data-htmlz-edit contenteditable="plaintext-only">. On
  // blur we POST {path, old_text, new_text} to /v1/pages/{slug}/edits; the
  // server walks the same path through the file's parsed tree, verifies
  // old_text, and splices in new_text. Everything around the edited node is
  // byte-stable.
  //
  // Path counting must match server-side _edit_visible_children: skip HTML
  // comments, <script>, <style>, and [data-htmlz-ui] elements at every level.

  function isEditSkippableElement(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE") return true;
    if (el.hasAttribute && el.hasAttribute("data-htmlz-ui")) return true;
    return false;
  }

  function editVisibleChildren(parent) {
    const out = [];
    for (const child of parent.childNodes) {
      if (child.nodeType === 8) continue; // Comment
      if (child.nodeType === 3) { out.push(child); continue; } // Text
      if (child.nodeType !== 1) continue; // skip CDATA, PI, etc.
      if (isEditSkippableElement(child)) continue;
      out.push(child);
    }
    return out;
  }

  function pathFromBody(node) {
    const path = [];
    let cur = node;
    while (cur && cur !== document.body) {
      const parent = cur.parentNode;
      if (!parent) return null;
      const kids = editVisibleChildren(parent);
      const idx = kids.indexOf(cur);
      if (idx === -1) return null;
      path.unshift(idx);
      cur = parent;
    }
    return cur === document.body ? path : null;
  }

  function isInsideSkippedSubtree(textNode) {
    let p = textNode.parentNode;
    while (p && p !== document.body) {
      if (isEditSkippableElement(p)) return true;
      p = p.parentNode;
    }
    return false;
  }

  function collectEditableTextNodes() {
    const walker = document.createTreeWalker(
      document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          if (isInsideSkippedSubtree(n)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );
    const out = [];
    while (walker.nextNode()) out.push(walker.currentNode);
    return out;
  }

  function toggleEditMode() { if (mode === "edit") exitEditMode(); else enterEditMode(); }

  function enterEditMode() {
    if (mode === "comment") exitMode();
    closePopover();
    mode = "edit";
    document.body.classList.add(NS + "-edit-mode");

    // Two passes so all paths are computed against the original DOM before
    // we start wrapping (wrapping replaces text nodes with spans, which
    // still preserves positions but makes later .indexOf(textNode) brittle
    // if the same text node has already been wrapped).
    const targets = collectEditableTextNodes();
    const wrapPlan = [];
    for (const tn of targets) {
      const path = pathFromBody(tn);
      if (!path || !path.length) continue;
      wrapPlan.push({ textNode: tn, path, original: tn.nodeValue });
    }
    for (const item of wrapPlan) {
      const span = document.createElement("span");
      span.setAttribute("data-htmlz-edit", "1");
      span.setAttribute("data-htmlz-edit-path", item.path.join("."));
      span.setAttribute("data-htmlz-edit-original", item.original);
      span.setAttribute("contenteditable", "plaintext-only");
      span.setAttribute("spellcheck", "true");
      item.textNode.parentNode.replaceChild(span, item.textNode);
      span.appendChild(document.createTextNode(item.original));
      span.addEventListener("blur", onEditBlur);
      span.addEventListener("keydown", onEditKey);
    }

    showBanner("Editing — click any text");
    renderRail();
  }

  function exitEditMode() {
    // Commit any pending edit before tearing down.
    if (document.activeElement && document.activeElement.getAttribute &&
        document.activeElement.getAttribute("data-htmlz-edit") === "1") {
      document.activeElement.blur();
    }
    mode = "idle";
    document.body.classList.remove(NS + "-edit-mode");
    const spans = document.querySelectorAll('[data-htmlz-edit="1"]');
    spans.forEach((span) => {
      const txt = span.textContent;
      const tn = document.createTextNode(txt);
      if (span.parentNode) span.parentNode.replaceChild(tn, span);
    });
    hideBanner();
    renderRail();
  }

  function onEditKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
      e.currentTarget.blur();
    }
    // Enter inserts a newline within plaintext-only; let it through. Pages
    // that want single-line editing for headings will see line-wrapping
    // visually, but the saved text-node contents stay byte-faithful.
  }

  function onEditBlur(e) {
    saveEdit(e.currentTarget);
  }

  async function saveEdit(span) {
    const pathStr = span.getAttribute("data-htmlz-edit-path");
    const original = span.getAttribute("data-htmlz-edit-original");
    const current = span.textContent;
    if (current === original) return;
    if (!pathStr) return;
    const path = pathStr.split(".").map((s) => parseInt(s, 10));

    span.setAttribute("data-htmlz-edit-state", "saving");
    try {
      const r = await fetch("/v1/pages/" + encodeURIComponent(slug) + "/edits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, old_text: original, new_text: current }),
      });
      if (!r.ok) {
        let detail = "Save failed (" + r.status + ")";
        try {
          const body = await r.json();
          if (body && body.detail) detail = body.detail;
        } catch (_) { /* non-JSON */ }
        span.setAttribute("data-htmlz-edit-state", "error");
        showEditToast(detail);
        // Revert visual so the user sees the on-disk state.
        span.textContent = original;
        setTimeout(() => span.removeAttribute("data-htmlz-edit-state"), 1800);
        return;
      }
      span.setAttribute("data-htmlz-edit-original", current);
      span.setAttribute("data-htmlz-edit-state", "saved");
      setTimeout(() => {
        if (span.getAttribute("data-htmlz-edit-state") === "saved") {
          span.removeAttribute("data-htmlz-edit-state");
        }
      }, 900);
    } catch (err) {
      span.setAttribute("data-htmlz-edit-state", "error");
      showEditToast("Network error — change not saved");
      span.textContent = original;
      setTimeout(() => span.removeAttribute("data-htmlz-edit-state"), 1800);
    }
  }

  function showEditToast(text) {
    if (editToast && editToast.parentNode) editToast.parentNode.removeChild(editToast);
    editToast = el("div", { class: NS + "-toast", "data-htmlz-ui": "1" }, text);
    document.body.appendChild(editToast);
    if (editToastTimer) clearTimeout(editToastTimer);
    editToastTimer = setTimeout(() => {
      if (editToast && editToast.parentNode) editToast.parentNode.removeChild(editToast);
      editToast = null;
      editToastTimer = 0;
    }, 3000);
  }

  // ── composer rail ────────────────────────────────────────────────────
  function renderRail() {
    if (!rail) {
      // Threads-in-view: secondary pill, chat icon + inline count chip.
      const listBtn = el("button", {
        class: NS + "-rail-secondary",
        "data-htmlz-ui": "1",
        onclick: toggleSidebar,
      });
      listBtn.appendChild(icon("chat", 16));
      listBtn.appendChild(document.createTextNode("Threads"));
      railListBadge = el("span", { class: NS + "-rail-count" });
      railListBadge.style.display = "none";
      listBtn.appendChild(railListBadge);

      // Edit: secondary pill toggling in-place text edit mode.
      const editBtn = el("button", {
        class: NS + "-rail-secondary",
        "data-htmlz-ui": "1",
        onclick: toggleEditMode,
      });

      // Comment: primary, filled CTA with label + kbd hint.
      const commentBtn = el("button", {
        class: NS + "-rail-primary",
        "data-htmlz-ui": "1",
        onclick: toggleMode,
      });

      rail = el("div", { class: NS + "-rail", "data-htmlz-ui": "1" }, [listBtn, editBtn, commentBtn]);
      rail._commentBtn = commentBtn;
      rail._listBtn = listBtn;
      rail._editBtn = editBtn;
      document.body.appendChild(rail);
    }

    // Repaint the primary CTA contents to reflect mode.
    const cta = rail._commentBtn;
    while (cta.firstChild) cta.removeChild(cta.firstChild);
    if (mode === "comment") {
      cta.appendChild(icon("close", 16));
      cta.appendChild(document.createTextNode("Cancel"));
      cta.appendChild(el("kbd", null, "Esc"));
      cta.title = "Exit comment mode";
    } else {
      cta.appendChild(icon("pencil", 16));
      cta.appendChild(document.createTextNode("Comment"));
      cta.appendChild(el("kbd", null, "c"));
      cta.title = "Start commenting";
    }

    // Repaint the Edit pill contents to reflect mode.
    const eb = rail._editBtn;
    while (eb.firstChild) eb.removeChild(eb.firstChild);
    if (mode === "edit") {
      eb.appendChild(icon("check", 16));
      eb.appendChild(document.createTextNode("Done"));
      eb.appendChild(el("kbd", null, "Esc"));
      eb.title = "Exit edit mode";
    } else {
      eb.appendChild(icon("type", 16));
      eb.appendChild(document.createTextNode("Edit"));
      eb.appendChild(el("kbd", null, "e"));
      eb.title = "Edit text in place";
    }
    eb.classList.toggle(NS + "-rail-secondary-active", mode === "edit");

    // Threads pill state + badge.
    rail._listBtn.classList.toggle(NS + "-rail-secondary-active", !!sidePanel);
    rail._listBtn.title = sidePanel ? "Close threads list" : "Threads on this view (t)";
    const count = getVisibleUnresolvedCount();
    if (count > 0) {
      railListBadge.textContent = count > 99 ? "99+" : String(count);
      railListBadge.style.display = "";
    } else {
      railListBadge.style.display = "none";
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────
  function startTrackingLoop() {
    function tick() {
      repositionMarkers();
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    installShortcuts();
  }

  // Keyboard shortcuts. Attached at capture phase so host pages that bind
  // their own listeners on window (e.g. a canvas app that binds `c` for a
  // filter, or `Esc` to close a detail panel) don't pre-empt us.
  function installShortcuts() {
    function consume(e) {
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
    }
    window.addEventListener("keydown", (e) => {
      // Edit mode owns the keyboard. Host pages routinely bind nav shortcuts
      // (arrow keys, space, digits, PageUp/Down) at document level — those
      // would steal characters mid-edit. We stop propagation here at
      // window-capture so the event never reaches host handlers, but we do
      // NOT preventDefault, so the browser's default text-input behavior
      // (typing, caret movement, selection) still runs inside spans.
      if (mode === "edit") {
        if (e.key === "Escape") {
          const ae = document.activeElement;
          if (ae && ae.getAttribute && ae.getAttribute("data-htmlz-edit") === "1") {
            // First Esc: blur the focused span to commit. Second Esc (now
            // with no span focused) exits edit mode.
            ae.blur();
            e.preventDefault();
          } else {
            exitEditMode();
            e.preventDefault();
          }
        }
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
        return;
      }

      // Esc closes the topmost widget layer, even from inside our text fields.
      if (e.key === "Escape") {
        if (openPopover) { closePopover(); consume(e); return; }
        if (sidePanel)   { closeSidebar(); consume(e); return; }
        if (mode === "comment") { exitMode(); consume(e); return; }
        return;
      }
      // 'c' / 't' / 'e' only when not typing into something.
      const t = e.target;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || (t.isContentEditable));
      if (typing) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "c" || e.key === "C") { toggleMode(); consume(e); }
      else if (e.key === "t" || e.key === "T") { toggleSidebar(); consume(e); }
      else if (e.key === "e" || e.key === "E") { toggleEditMode(); consume(e); }
    }, true);
  }

  async function boot() {
    injectStyles();
    renderRail();
    startTrackingLoop();
    await fetchComments();
    syncMarkers();
    setInterval(async () => {
      await fetchComments();
      syncMarkers();
    }, 30_000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

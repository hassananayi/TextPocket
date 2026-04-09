// content.js — TextPocket v1.1

(function () {
  if (window.__tpLoaded) return;
  window.__tpLoaded = true;

  // ─────────────────────────────────────────────────────────────────────────
  // Constants
  // ─────────────────────────────────────────────────────────────────────────
  const MAX_RESULTS = 8;
  const DEBOUNCE_MS = 40;
  const TP_ID       = "__tp_dropdown__";

  // ─────────────────────────────────────────────────────────────────────────
  // State
  // ─────────────────────────────────────────────────────────────────────────
  let TRIGGER        = "/";
  let fuseInstance   = null;
  let snippets       = [];
  let dropdownEl     = null;
  let activeTarget   = null;
  let triggerStart   = -1;
  let selectedIndex  = 0;
  let currentResults = [];
  let debounceTimer  = null;
  let fuseReady      = false;

  // Per-frame paste state
  let lastFocusedEditable = null;
  let savedRange          = null;
  let savedInputSel       = null;

  // ─────────────────────────────────────────────────────────────────────────
  // Fuse.js — lazy-loaded once per frame
  // ─────────────────────────────────────────────────────────────────────────
  function loadFuse(cb) {
    if (window.Fuse) { cb(); return; }
    const s = document.createElement("script");
    s.src    = chrome.runtime.getURL("assets/fuse.min.js");
    s.onload = cb;
    (document.head || document.documentElement).appendChild(s);
  }

  function buildIndex() {
    if (!window.Fuse || !snippets.length) { fuseReady = false; return; }
    fuseInstance = new Fuse(snippets, {
      includeScore:   true,
      threshold:      0.4,
      ignoreLocation: true,
      keys: [
        { name: "name",    weight: 0.65 },
        { name: "tags",    weight: 0.20 },
        { name: "content", weight: 0.15 }
      ]
    });
    fuseReady = true;
  }

  function refreshData(cb) {
    chrome.storage.local.get(["items"], data => {
      const items = data.items || [];
      snippets = items.filter(i => i.type === "snippet");
      loadFuse(() => { buildIndex(); if (cb) cb(); });
    });
  }
  refreshData();

  function refreshTrigger() {
    chrome.storage.local.get(["settings"], d => {
      TRIGGER = (d.settings && d.settings.trigger) ? d.settings.trigger : "/";
    });
  }
  refreshTrigger();

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === "tp_items_changed") refreshData();
  });
  chrome.storage.onChanged.addListener((c, a) => {
    if (a === "local" && c.settings) refreshTrigger();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Editable detection
  // ─────────────────────────────────────────────────────────────────────────
  function isEditable(el) {
    if (!el) return false;
    if (el.isContentEditable === true) return true;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") {
      const t = (el.type || "").toLowerCase();
      return !["hidden","submit","button","file","checkbox","radio","range","color"].includes(t);
    }
    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Per-frame selection snapshot
  // ─────────────────────────────────────────────────────────────────────────
  document.addEventListener("focusin", e => {
    if (isEditable(e.target)) {
      lastFocusedEditable = e.target;
      savedRange = null; savedInputSel = null;
    }
  }, true);

  document.addEventListener("mousedown", () => {
    const a = document.activeElement;
    if (!isEditable(a)) return;
    if (a.isContentEditable) {
      const sel = getFrameSelection();
      if (sel && sel.rangeCount > 0) {
        try { savedRange = sel.getRangeAt(0).cloneRange(); } catch (_) { savedRange = null; }
      }
    } else {
      savedInputSel = { start: a.selectionStart, end: a.selectionEnd };
    }
  }, true);

  document.addEventListener("contextmenu", () => {
    const a = document.activeElement;
    if (!a || !a.isContentEditable) return;
    lastFocusedEditable = a;
    if (!savedRange) {
      const sel = getFrameSelection();
      if (sel && sel.rangeCount > 0) {
        try { savedRange = sel.getRangeAt(0).cloneRange(); } catch (_) {}
      }
    }
  }, true);

  // ─────────────────────────────────────────────────────────────────────────
  // getFrameSelection — handles shadow DOM
  // ─────────────────────────────────────────────────────────────────────────
  function getFrameSelection() {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) return sel;
    try {
      const root = document.activeElement && document.activeElement.shadowRoot;
      if (root && root.getSelection) return root.getSelection();
    } catch (_) {}
    return sel;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Search with boosting
  // ─────────────────────────────────────────────────────────────────────────
  function scoreResults(query, rawResults) {
    const now = Date.now();
    return rawResults.map(r => {
      const s = r.item;
      let score = 1 - (r.score || 0);
      score += Math.min(Math.log1p(s.usageCount || 0) / Math.log1p(50), 1) * 0.4;
      if (s.lastUsedAt) {
        const days = (now - s.lastUsedAt) / 86400000;
        score += Math.max(0, 1 - days / 14) * 0.2;
      }
      return { snippet: s, score };
    }).sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS);
  }

  function search(query) {
    if (!query) {
      const sorted = [...snippets].sort((a, b) => {
        const ua = a.usageCount || 0, ub = b.usageCount || 0;
        if (ub !== ua) return ub - ua;
        return (b.lastUsedAt || 0) - (a.lastUsedAt || 0);
      });
      return sorted.slice(0, MAX_RESULTS).map(s => ({ snippet: s, score: 1 }));
    }
    if (!fuseReady || !fuseInstance) {
      const q = query.toLowerCase();
      return snippets
        .filter(s => s.name.toLowerCase().includes(q) || (s.tags||[]).some(t => t.toLowerCase().includes(q)))
        .slice(0, MAX_RESULTS)
        .map(s => ({ snippet: s, score: 1 }));
    }
    return scoreResults(query, fuseInstance.search(query));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  function highlight(text, query) {
    if (!query) return esc(text);
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx < 0) return esc(text);
    return esc(text.slice(0, idx))
      + `<mark class="tp-hl">${esc(text.slice(idx, idx + query.length))}</mark>`
      + esc(text.slice(idx + query.length));
  }

  // Returns a Bootstrap Icons class name for the snippet
  function snippetIconClass(name, content) {
    const n = (name + content).toLowerCase();
    if (/@/.test(content))                     return "bi-envelope";
    if (/https?:\/\//.test(content))           return "bi-link-45deg";
    if (/password|pwd|pass/i.test(n))          return "bi-key";
    if (/address|addr|street/i.test(n))        return "bi-geo-alt";
    if (/phone|tel|mobile/i.test(n))           return "bi-telephone";
    if (/sql|select|from /i.test(n))           return "bi-database";
    if (/\n/.test(content))                    return "bi-file-text";
    if (/code|func|def |var |const /i.test(n)) return "bi-code-slash";
    return null; // fall back to letter initial
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Bootstrap Icons — lazy-load the CSS once per document
  // ─────────────────────────────────────────────────────────────────────────
  function ensureBootstrapIcons() {
    const BI_ID = "__tp_bi_css__";
    if (document.getElementById(BI_ID)) return;
    const link = document.createElement("link");
    link.id   = BI_ID;
    link.rel  = "stylesheet";
    link.href = chrome.runtime.getURL("assets/bootstrap-icons.min.css");
    (document.head || document.documentElement).appendChild(link);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Styles
  // ─────────────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById("__tp_styles__")) return;
    ensureBootstrapIcons();
    const style = document.createElement("style");
    style.id = "__tp_styles__";
    style.textContent = `
#${TP_ID} {
  all: initial;
  position: fixed !important;
  z-index: 2147483647 !important;
  width: 344px;
  background: #fff;
  border: 1px solid rgba(0,0,0,.13);
  border-radius: 10px;
  box-shadow: 0 0 0 1px rgba(0,0,0,.03), 0 2px 4px rgba(0,0,0,.06), 0 8px 24px rgba(0,0,0,.10), 0 24px 48px rgba(0,0,0,.07);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", Arial, sans-serif !important;
  font-size: 13px;
  line-height: 1;
  color: #0f1117;
  -webkit-font-smoothing: antialiased;
  animation: _tp_in 120ms cubic-bezier(.2,.9,.4,1) both;
}
@keyframes _tp_in {
  from { opacity: 0; transform: translateY(-4px) scale(.99); }
  to   { opacity: 1; transform: translateY(0)    scale(1);   }
}
@media (prefers-color-scheme: dark) {
  #${TP_ID} {
    background: #1c1e26;
    border-color: rgba(255,255,255,.10);
    color: #e9eaf0;
    box-shadow: 0 0 0 1px rgba(255,255,255,.04), 0 2px 4px rgba(0,0,0,.25), 0 8px 24px rgba(0,0,0,.40), 0 24px 48px rgba(0,0,0,.35);
  }
}
#${TP_ID} ._tp_head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px 8px;
  border-bottom: 1px solid rgba(0,0,0,.07);
  flex-shrink: 0;
}
@media (prefers-color-scheme: dark) {
  #${TP_ID} ._tp_head { border-color: rgba(255,255,255,.07); }
}
#${TP_ID} ._tp_search_ic {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  color: #9ca3af;
  font-size: 13px;
}
#${TP_ID} ._tp_q {
  flex: 1;
  font-size: 12.5px;
  font-weight: 500;
  color: #374151;
  letter-spacing: -.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
@media (prefers-color-scheme: dark) {
  #${TP_ID} ._tp_q { color: #c9cdd8; }
}
#${TP_ID} ._tp_kbd_hint {
  display: flex;
  gap: 3px;
  align-items: center;
  flex-shrink: 0;
}
#${TP_ID} ._tp_k {
  font-family: inherit;
  font-size: 9px;
  font-weight: 500;
  color: #9ca3af;
  background: rgba(0,0,0,.05);
  border: 1px solid rgba(0,0,0,.10);
  border-radius: 3px;
  padding: 1px 4px;
  line-height: 14px;
}
@media (prefers-color-scheme: dark) {
  #${TP_ID} ._tp_k {
    background: rgba(255,255,255,.06);
    border-color: rgba(255,255,255,.10);
    color: #6b7280;
  }
}
#${TP_ID} ._tp_list {
  overflow-y: auto;
  max-height: 352px;
  padding: 4px;
  scrollbar-width: thin;
}
#${TP_ID} ._tp_item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
  transition: background 60ms;
  position: relative;
}
#${TP_ID} ._tp_item + ._tp_item { margin-top: 1px; }
#${TP_ID} ._tp_item:hover  { background: rgba(0,0,0,.04); }
#${TP_ID} ._tp_item.active { background: #f0f4ff; }
@media (prefers-color-scheme: dark) {
  #${TP_ID} ._tp_item:hover  { background: rgba(255,255,255,.05); }
  #${TP_ID} ._tp_item.active { background: rgba(79,126,248,.14);  }
}
#${TP_ID} ._tp_item.active::before {
  content: "";
  position: absolute;
  left: 0; top: 5px; bottom: 5px;
  width: 2px;
  border-radius: 99px;
  background: #3a6af0;
}
#${TP_ID} ._tp_icon {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: #f3f4f8;
  border: 1px solid rgba(0,0,0,.07);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
  color: #3a6af0;
  flex-shrink: 0;
}
@media (prefers-color-scheme: dark) {
  #${TP_ID} ._tp_icon {
    background: rgba(255,255,255,.07);
    border-color: rgba(255,255,255,.08);
    color: #6b93ff;
  }
}
#${TP_ID} ._tp_text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
#${TP_ID} ._tp_name {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: inherit;
  line-height: 1.2;
}
#${TP_ID} ._tp_preview {
  font-size: 11px;
  font-family: ui-monospace, monospace;
  color: #6b7280;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.3;
}
#${TP_ID} ._tp_empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 28px 16px;
  color: #9ca3af;
  text-align: center;
}
#${TP_ID} ._tp_empty i {
  font-size: 28px;
  opacity: 0.45;
  line-height: 1;
  display: block;
}
#${TP_ID} ._tp_empty ._tp_empty_title {
  font-size: 12.5px;
  font-weight: 600;
  color: #6b7280;
  line-height: 1.3;
}
#${TP_ID} ._tp_empty ._tp_empty_sub {
  font-size: 11px;
  color: #9ca3af;
  line-height: 1.5;
}
@media (prefers-color-scheme: dark) {
  #${TP_ID} ._tp_empty i { color: #4b5563; }
  #${TP_ID} ._tp_empty ._tp_empty_title { color: #6b7280; }
  #${TP_ID} ._tp_empty ._tp_empty_sub { color: #4b5563; }
}
#${TP_ID} mark.tp-hl {
  background: #fef08a;
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}
@media (prefers-color-scheme: dark) {
  #${TP_ID} mark.tp-hl { background: rgba(250,204,21,.25); }
}
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CARET POSITION — returns {x, y, lineHeight} of the cursor
  // The dropdown is placed 10px below the caret baseline.
  // ─────────────────────────────────────────────────────────────────────────
  function getCaretCoordinates(el) {
    // ── contentEditable ───────────────────────────────────────────────────
    if (el.isContentEditable) {
      const sel = getFrameSelection();
      if (sel && sel.rangeCount > 0) {
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        // getBoundingClientRect on a collapsed range gives a 0-width rect at
        // the cursor insertion point. top+height = baseline area.
        if (rect.height > 0) {
          return { x: rect.left, y: rect.top + rect.height, lineHeight: rect.height };
        }
      }
      // Fallback: use the element's bounding rect
      const elRect = el.getBoundingClientRect();
      return { x: elRect.left + 10, y: elRect.top + 20, lineHeight: 16 };
    }

    // ── input / textarea ──────────────────────────────────────────────────
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const pos = triggerStart >= 0 ? triggerStart : (el.selectionStart || 0);

      const mirror = document.createElement("div");
      const cs     = window.getComputedStyle(el);
      const elRect = el.getBoundingClientRect();

      Object.assign(mirror.style, {
        position:      "absolute",
        visibility:    "hidden",
        top:           "-9999px",
        left:          "-9999px",
        whiteSpace:    el.tagName === "TEXTAREA" ? "pre-wrap" : "pre",
        wordWrap:      "break-word",
        overflowWrap:  "break-word",
        width:         cs.width,
        font:          cs.font,
        fontFamily:    cs.fontFamily,
        fontSize:      cs.fontSize,
        fontWeight:    cs.fontWeight,
        letterSpacing: cs.letterSpacing,
        lineHeight:    cs.lineHeight,
        paddingTop:    cs.paddingTop,
        paddingRight:  cs.paddingRight,
        paddingBottom: cs.paddingBottom,
        paddingLeft:   cs.paddingLeft,
        boxSizing:     cs.boxSizing,
        border:        cs.border,
      });

      mirror.textContent = (el.value || "").substring(0, pos);

      const caret = document.createElement("span");
      caret.textContent = "|";
      mirror.appendChild(caret);
      document.body.appendChild(mirror);

      const mirrorRect = mirror.getBoundingClientRect();
      const caretRect  = caret.getBoundingClientRect();

      // Offset from mirror origin to caret, then add element's viewport position
      const x = elRect.left + (caretRect.left - mirrorRect.left);
      const y = elRect.top  + (caretRect.top  - mirrorRect.top) + caretRect.height
                - el.scrollTop;   // account for scroll inside textarea

      document.body.removeChild(mirror);

      const lh = parseFloat(cs.lineHeight) || caretRect.height || 16;
      return { x, y: elRect.top + (caretRect.top - mirrorRect.top) + lh - el.scrollTop, lineHeight: lh };
    }

    // ── generic fallback ──────────────────────────────────────────────────
    const rect = el.getBoundingClientRect();
    return { x: rect.left + 10, y: rect.top + 20, lineHeight: 16 };
  }

  function positionDropdown() {
    if (!dropdownEl || !activeTarget) return;

    const caret    = getCaretCoordinates(activeTarget);
    if (!caret) return;

    const SPACING        = 10;   // gap between caret bottom and dropdown top
    const dropdownWidth  = 344;
    const dropdownHeight = dropdownEl.offsetHeight || 200;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Prefer below the caret; flip above if it would clip
    let top  = caret.y + SPACING;
    let left = caret.x;

    if (top + dropdownHeight > vh - SPACING) {
      // Not enough room below — place above the caret
      top = (caret.y - caret.lineHeight) - dropdownHeight - SPACING;
    }

    // Clamp inside the viewport
    top  = Math.max(SPACING, Math.min(top,  vh - dropdownHeight - SPACING));
    left = Math.max(SPACING, Math.min(left, vw - dropdownWidth  - SPACING));

    dropdownEl.style.left = `${left}px`;
    dropdownEl.style.top  = `${top}px`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Dropdown DOM
  // ─────────────────────────────────────────────────────────────────────────
  function createDropdown() {
    injectStyles();
    if (dropdownEl) return;
    dropdownEl = document.createElement("div");
    dropdownEl.id = TP_ID;
    dropdownEl.setAttribute("role", "listbox");
    document.body.appendChild(dropdownEl);
    dropdownEl.addEventListener("mousedown", e => e.preventDefault());
  }

  function renderDropdown(query) {
    if (!dropdownEl) createDropdown();
    currentResults = search(query);
    selectedIndex = 0;

    const queryDisplay = query ? TRIGGER + query : TRIGGER;

    const headerHtml = `
      <div class="_tp_head">
        <span class="_tp_search_ic"><i class="bi bi-search"></i></span>
        <div class="_tp_q">${esc(queryDisplay)}</div>
        <div class="_tp_kbd_hint">
          <span class="_tp_k">↑↓</span>
          <span class="_tp_k">↵</span>
          <span class="_tp_k">Esc</span>
        </div>
      </div>`;

    let listHtml = "";
    if (!currentResults.length) {
      // ── Improved empty state with Bootstrap Icon ──
      const hasQuery = !!(query && query.length);
      listHtml = `
        <div class="_tp_empty">
          <i class="bi ${hasQuery ? "bi-search" : "bi-clipboard2"}"></i>
          <div class="_tp_empty_title">${hasQuery ? `No results for "${esc(query)}"` : "No snippets yet"}</div>
          <div class="_tp_empty_sub">${hasQuery
            ? "Try a different keyword or check your folders."
            : "Open TextPocket to add your first snippet."
          }</div>
        </div>`;
    } else {
      currentResults.forEach((r, i) => {
        const s         = r.snippet;
        const iconClass = snippetIconClass(s.name, s.content || "");
        const iconHtml  = iconClass
          ? `<i class="bi ${iconClass}"></i>`
          : `<span>${esc(s.name.charAt(0).toUpperCase())}</span>`;
        const preview = (s.content || "").replace(/\s+/g, " ").slice(0, 58)
                        + ((s.content || "").length > 58 ? "…" : "");

        listHtml += `
          <div class="_tp_item${i === 0 ? " active" : ""}" data-idx="${i}" role="option" aria-selected="${i === 0}">
            <div class="_tp_icon">${iconHtml}</div>
            <div class="_tp_text">
              <div class="_tp_name">${highlight(s.name, query)}</div>
              <div class="_tp_preview">${esc(preview)}</div>
            </div>
          </div>`;
      });
    }

    dropdownEl.innerHTML = headerHtml + `<div class="_tp_list">${listHtml}</div>`;

    // Wire events
    dropdownEl.querySelectorAll("._tp_item").forEach(el => {
      el.addEventListener("click", () => {
        const idx = parseInt(el.dataset.idx, 10);
        if (currentResults[idx]) selectResult(currentResults[idx].snippet);
      });
      el.addEventListener("mousemove", () => {
        const idx = parseInt(el.dataset.idx, 10);
        if (idx !== selectedIndex) {
          selectedIndex = idx;
          highlightActive();
        }
      });
    });

    setTimeout(() => positionDropdown(), 0);
  }

  function highlightActive() {
    if (!dropdownEl) return;
    dropdownEl.querySelectorAll("._tp_item").forEach((el, i) => {
      const on = i === selectedIndex;
      el.classList.toggle("active", on);
      el.setAttribute("aria-selected", on);
    });
    const active = dropdownEl.querySelector("._tp_item.active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Show / hide
  // ─────────────────────────────────────────────────────────────────────────
  function showDropdown(query) {
    createDropdown();
    renderDropdown(query);
    dropdownEl.style.display = "flex";
  }

  function hideDropdown() {
    if (dropdownEl) {
      dropdownEl.style.display = "none";
      dropdownEl.innerHTML = "";
    }
    activeTarget = null;
    triggerStart = -1;
    currentResults = [];
    selectedIndex = 0;
  }

  function isDropdownVisible() {
    return !!(dropdownEl && dropdownEl.style.display !== "none");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Get query from trigger
  // ─────────────────────────────────────────────────────────────────────────
  function getQuery(el) {
    if (el.isContentEditable) {
      const sel = getFrameSelection();
      if (!sel || !sel.rangeCount) return null;
      const range = sel.getRangeAt(0);
      if (!range.collapsed) return null;

      let node = range.startContainer;
      let curIdx = range.startOffset;

      // Handle element nodes (like in ProseMirror)
      if (node.nodeType !== Node.TEXT_NODE) {
        const walker = document.createTreeWalker(
          node,
          NodeFilter.SHOW_TEXT,
          null,
          false
        );
        let lastTextNode = null;
        while (walker.nextNode()) { lastTextNode = walker.currentNode; }
        if (lastTextNode) {
          node = lastTextNode;
          curIdx = lastTextNode.textContent.length;
        } else {
          return null;
        }
      }

      const text = node.textContent;
      let trigIdx = -1;
      for (let i = curIdx - 1; i >= 0; i--) {
        if (text[i] === TRIGGER) { trigIdx = i; break; }
        if (text[i] === " " || text[i] === "\n") break;
      }
      if (trigIdx < 0) return null;

      const before = trigIdx > 0 ? text[trigIdx - 1] : null;
      if (before && before !== " " && before !== "\n") return null;

      window.__tpTriggerNode  = node;
      window.__tpTriggerIndex = trigIdx;

      return text.slice(trigIdx + 1, curIdx);
    }

    // input / textarea
    const pos = el.selectionStart;
    const val = el.value;
    if (triggerStart < 0 || triggerStart >= pos) return null;
    const seg = val.slice(triggerStart, pos);
    if (seg.includes(" ") || seg.includes("\n")) return null;
    return seg.slice(1);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SIMPLE PASTE STRATEGY - Works everywhere like Ctrl+V
  // ─────────────────────────────────────────────────────────────────────────

  async function pasteText(el, text) {
    let originalClipboard = "";
    try {
      try { originalClipboard = await navigator.clipboard.readText(); } catch (_) {}
      el.focus();
      await navigator.clipboard.writeText(text);
      let success = document.execCommand("paste");
      if (!success) {
        success = document.execCommand("insertText", false, text);
      }
      if (originalClipboard) {
        await navigator.clipboard.writeText(originalClipboard);
      }
      return success;
    } catch (err) {
      if (originalClipboard) {
        try { await navigator.clipboard.writeText(originalClipboard); } catch (_) {}
      }
      return false;
    }
  }

  function insertTextNative(el, text) {
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const start = el.selectionStart;
      const end   = el.selectionEnd;
      el.value = el.value.substring(0, start) + text + el.value.substring(end);
      el.setSelectionRange(start + text.length, start + text.length);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    return false;
  }

  function insertText(el, text) {
    if (pasteText(el, text)) return true;
    if (insertTextNative(el, text)) return true;
    try {
      if (document.execCommand("insertText", false, text)) {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      }
    } catch (_) {}
    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Remove trigger text
  // ─────────────────────────────────────────────────────────────────────────
  function removeTrigger(el, queryLength) {
    const deleteCount = queryLength + 1;

    if (el.isContentEditable) {
      try {
        const sel = getFrameSelection();
        if (!sel || sel.rangeCount === 0) return false;
        for (let i = 0; i < deleteCount; i++) {
          sel.modify("extend", "backward", "character");
        }
        document.execCommand("delete", false, null);
        window.__tpTriggerNode = null;
        return true;
      } catch (e) {
        return false;
      }
    }

    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const end   = el.selectionStart;
      const start = end - deleteCount;
      if (start >= 0) {
        el.setSelectionRange(start, end);
        document.execCommand("delete", false, null);
        return true;
      }
    }
    return false;
  }

  function selectResult(snippet) {
    if (!activeTarget) { hideDropdown(); return; }

    const query       = getQuery(activeTarget) || "";
    const queryLength = query.length;
    const target      = activeTarget;

    hideDropdown();
    target.focus();
    removeTrigger(target, queryLength);

    setTimeout(async () => {
      await pasteText(target, snippet.content);

      chrome.storage.local.get(["items"], data => {
        const items = data.items || [];
        const idx = items.findIndex(i => i.id === snippet.id);
        if (idx >= 0) {
          items[idx] = {
            ...items[idx],
            usageCount: (items[idx].usageCount || 0) + 1,
            lastUsedAt: Date.now()
          };
          chrome.storage.local.set({ items });
          snippets = items.filter(i => i.type === "snippet");
          buildIndex();
        }
      });
    }, 50);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helper to resolve editable elements
  // ─────────────────────────────────────────────────────────────────────────
  function resolveEditableEl(el) {
    if (!el) return el;
    if (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA") return el;
    const inner = el.querySelector && el.querySelector("[contenteditable='true']");
    if (inner) return inner;
    if (el.shadowRoot) {
      const s = el.shadowRoot.querySelector("[contenteditable='true']");
      if (s) return s;
    }
    return el;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Keyboard handling
  // ─────────────────────────────────────────────────────────────────────────
  const INTERCEPT_KEYS = new Set(["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"]);

  function onKeydown(e) {
    const el = e.target;
    if (!isEditable(el)) return;

    if (isDropdownVisible()) {
      if (INTERCEPT_KEYS.has(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
      switch (e.key) {
        case "ArrowDown":
          selectedIndex = Math.min(selectedIndex + 1, currentResults.length - 1);
          highlightActive();
          break;
        case "ArrowUp":
          selectedIndex = Math.max(selectedIndex - 1, 0);
          highlightActive();
          break;
        case "Enter":
        case "Tab":
          if (currentResults.length) selectResult(currentResults[selectedIndex].snippet);
          else hideDropdown();
          break;
        case "Escape":
          hideDropdown();
          break;
      }
      return;
    }

    // Record trigger position for inputs
    if (!el.isContentEditable && e.key === TRIGGER && !e.ctrlKey && !e.metaKey && !e.altKey) {
      activeTarget  = el;
      triggerStart  = el.selectionStart;
    }
  }

  function onInput(e) {
    const el = e.target;
    if (!isEditable(el)) return;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (isDropdownVisible()) {
        const q = getQuery(el);
        if (q === null) { hideDropdown(); return; }
        renderDropdown(q);
        positionDropdown();
        return;
      }

      const q = getQuery(el);
      if (q === null) return;

      if (el.isContentEditable) activeTarget = el;
      showDropdown(q);
    }, DEBOUNCE_MS);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Event listeners
  // ─────────────────────────────────────────────────────────────────────────
  document.addEventListener("click", e => {
    if (dropdownEl && !dropdownEl.contains(e.target)) hideDropdown();
  }, true);

  document.addEventListener("focusout", () => {
    setTimeout(() => {
      if (document.activeElement !== activeTarget) hideDropdown();
    }, 150);
  }, true);

  document.addEventListener("keydown", onKeydown, true);
  document.addEventListener("input",   onInput,   true);
  window.addEventListener("scroll", () => { if (isDropdownVisible()) positionDropdown(); }, true);
  window.addEventListener("resize",  () => { if (isDropdownVisible()) positionDropdown(); });

  // ─────────────────────────────────────────────────────────────────────────
  // Message handler for popup paste
  // ─────────────────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "tp_paste_snippet") {
      const target = lastFocusedEditable;
      if (target && isEditable(target)) {
        insertText(target, msg.content);
        sendResponse({ ok: true });
      } else {
        navigator.clipboard.writeText(msg.content)
          .then(() => sendResponse({ ok: false, reason: "clipboard_fallback" }))
          .catch(() => sendResponse({ ok: false, reason: "no_target" }));
      }
      return true;
    }
  });
})();

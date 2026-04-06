// content.js — TextPocket v1.0
// Injected into ALL frames (all_frames: true).
// Each frame is self-contained: focus tracking, trigger detection, paste injection.

(function () {
  if (window.__tpLoaded) return;
  window.__tpLoaded = true;

  const IS_TOP_FRAME = (window === window.top);

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
  // Open-popup shortcut (top frame only — no duplicate fires in iframes)
  // ─────────────────────────────────────────────────────────────────────────
  if (IS_TOP_FRAME) {
    let OPEN_SHORTCUT = "Alt+T";
    const refreshShortcut = () => {
      chrome.storage.local.get(["settings"], d => {
        OPEN_SHORTCUT = (d.settings && d.settings.openShortcut) ? d.settings.openShortcut : "Alt+T";
      });
    };
    refreshShortcut();
    chrome.storage.onChanged.addListener((c, a) => { if (a === "local" && c.settings) refreshShortcut(); });

    document.addEventListener("keydown", e => {
      if (isDropdownVisible()) return;
      const parts = [];
      if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
      if (e.altKey)               parts.push("Alt");
      if (e.shiftKey)             parts.push("Shift");
      let key = e.key;
      if (key === " ") key = "Space";
      else if (key.length === 1) key = key.toUpperCase();
      parts.push(key);
      if (parts.join("+") !== OPEN_SHORTCUT.replace(/^Meta\+/, "Ctrl+")) return;
      e.preventDefault(); e.stopPropagation();
      chrome.runtime.sendMessage({ type: "tp_open_popup" }).catch(() => {});
    }, true);
  }

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
  // Per-frame selection snapshot (for paste injection via message)
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
  // getFrameSelection — handles shadow DOM (Canva, complex editors)
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
  // Search — fuzzy with usage + recency boost
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

  // Icon: single character or emoji that represents the snippet type.
  // Intentionally minimal — letter fallback keeps it monochrome-friendly.
  function snippetIcon(name, content) {
    const n = (name + content).toLowerCase();
    if (/@/.test(content))                     return "✉";
    if (/https?:\/\//.test(content))           return "↗";
    if (/password|pwd|pass/i.test(n))          return "⚿";
    if (/address|addr|street/i.test(n))        return "⊙";
    if (/phone|tel|mobile/i.test(n))           return "☏";
    if (/sql|select|from /i.test(n))           return "◧";
    if (/\n/.test(content))                    return "≡";
    if (/code|func|def |var |const /i.test(n)) return "{}";
    return name.charAt(0).toUpperCase();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Styles — injected once per frame document
  // Design goals: monochrome base, one accent color, no emoji clutter,
  //               readable at a glance, instant feel, works on any site bg.
  // ─────────────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById("__tp_styles__")) return;
    const style = document.createElement("style");
    style.id = "__tp_styles__";
    style.textContent = `
/* ── Container ── */
#${TP_ID} {
  all: initial;
  position: fixed !important;
  z-index: 2147483647 !important;
  top: 0; left: 0;
  width: 344px;
  background: #fff;
  border: 1px solid rgba(0,0,0,.13);
  border-radius: 10px;
  box-shadow:
    0 0 0 1px rgba(0,0,0,.03),
    0 2px 4px rgba(0,0,0,.06),
    0 8px 24px rgba(0,0,0,.10),
    0 24px 48px rgba(0,0,0,.07);
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
    box-shadow:
      0 0 0 1px rgba(255,255,255,.04),
      0 2px 4px rgba(0,0,0,.25),
      0 8px 24px rgba(0,0,0,.40),
      0 24px 48px rgba(0,0,0,.35);
  }
}

/* ── Search header ── */
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
}
#${TP_ID} ._tp_search_ic svg { display: block; }
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

/* ── List ── */
#${TP_ID} ._tp_list {
  overflow-y: auto;
  max-height: 352px;
  padding: 4px;
  scrollbar-width: thin;
  scrollbar-color: rgba(0,0,0,.10) transparent;
}
#${TP_ID} ._tp_list::-webkit-scrollbar { width: 3px; }
#${TP_ID} ._tp_list::-webkit-scrollbar-thumb {
  background: rgba(0,0,0,.12);
  border-radius: 99px;
}
@media (prefers-color-scheme: dark) {
  #${TP_ID} ._tp_list::-webkit-scrollbar-thumb { background: rgba(255,255,255,.10); }
}

/* ── Item ── */
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

/* Active: left accent bar */
#${TP_ID} ._tp_item.active::before {
  content: "";
  position: absolute;
  left: 0; top: 5px; bottom: 5px;
  width: 2px;
  border-radius: 99px;
  background: #3a6af0;
}
@media (prefers-color-scheme: dark) {
  #${TP_ID} ._tp_item.active::before { background: #5b87f7; }
}

/* ── Icon ── */
#${TP_ID} ._tp_icon {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: #f3f4f8;
  border: 1px solid rgba(0,0,0,.07);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  color: #374151;
  flex-shrink: 0;
  font-family: inherit;
  line-height: 1;
}
#${TP_ID} ._tp_item.active ._tp_icon {
  background: #e4ecff;
  border-color: rgba(58,106,240,.15);
  color: #3a6af0;
}
@media (prefers-color-scheme: dark) {
  #${TP_ID} ._tp_icon {
    background: rgba(255,255,255,.06);
    border-color: rgba(255,255,255,.08);
    color: #9ca3af;
  }
  #${TP_ID} ._tp_item.active ._tp_icon {
    background: rgba(79,126,248,.15);
    border-color: rgba(79,126,248,.25);
    color: #5b87f7;
  }
}

/* ── Text column ── */
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
  font-family: ui-monospace, "SFMono-Regular", "Fira Code", monospace;
  color: #6b7280;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.3;
}
@media (prefers-color-scheme: dark) {
  #${TP_ID} ._tp_preview { color: #4b5563; }
}

/* ── Empty state ── */
#${TP_ID} ._tp_empty {
  padding: 24px 16px;
  text-align: center;
  font-size: 12px;
  color: #9ca3af;
  line-height: 1.5;
}

/* ── Highlight ── */
#${TP_ID} mark._tp_hl {
  all: unset;
  background: rgba(58,106,240,.14);
  color: #2a56d6;
  border-radius: 2px;
  padding: 0 1px;
}
@media (prefers-color-scheme: dark) {
  #${TP_ID} mark._tp_hl {
    background: rgba(79,126,248,.22);
    color: #7aa3ff;
  }
}
    `;
    (document.head || document.documentElement).appendChild(style);
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
    // Attach to <body> — highest stacking context on the page
    document.body.appendChild(dropdownEl);
    // Prevent mouse clicks inside from stealing focus from the input
    dropdownEl.addEventListener("mousedown", e => e.preventDefault());
  }

  function renderDropdown(query) {
    if (!dropdownEl) createDropdown();
    currentResults = search(query);
    selectedIndex  = 0;

    const queryDisplay = query ? TRIGGER + query : TRIGGER;

    // ── Header ──
    const headerHtml = `
      <div class="_tp_head">
        <span class="_tp_search_ic">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" stroke-width="1.7"/>
            <path d="M10.5 10.5 L14 14" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
          </svg>
        </span>
        <div class="_tp_q">${esc(queryDisplay)}</div>
        <div class="_tp_kbd_hint">
          <span class="_tp_k">↑↓</span>
          <span class="_tp_k">↵</span>
          <span class="_tp_k">Esc</span>
        </div>
      </div>`;

    // ── Items ──
    let listHtml = "";
    if (!currentResults.length) {
      listHtml = `<div class="_tp_empty">No snippets match "${esc(query || TRIGGER)}"</div>`;
    } else {
      currentResults.forEach((r, i) => {
        const s       = r.snippet;
        const icon    = snippetIcon(s.name, s.content || "");
        const preview = (s.content || "").replace(/\s+/g, " ").slice(0, 58)
                        + ((s.content || "").length > 58 ? "…" : "");

        listHtml += `
          <div class="_tp_item${i === 0 ? " active" : ""}" data-idx="${i}" role="option" aria-selected="${i === 0}">
            <div class="_tp_icon">${esc(icon)}</div>
            <div class="_tp_text">
              <div class="_tp_name">${highlight(s.name, query)}</div>
              <div class="_tp_preview">${esc(preview)}</div>
            </div>
          </div>`;
      });
    }

    dropdownEl.innerHTML = headerHtml + `<div class="_tp_list">${listHtml}</div>`;

    // Wire click and hover
    dropdownEl.querySelectorAll("._tp_item").forEach(el => {
      el.addEventListener("click", () => {
        const idx = parseInt(el.dataset.idx, 10);
        if (currentResults[idx]) selectResult(currentResults[idx].snippet);
      });
      el.addEventListener("mousemove", () => {
        const idx = parseInt(el.dataset.idx, 10);
        if (idx !== selectedIndex) { selectedIndex = idx; highlightActive(); }
      });
    });
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
  // Positioning — caret-aware, flips when near viewport edges
  // ─────────────────────────────────────────────────────────────────────────
  function getCaretPos(el) {
    if (el.isContentEditable) {
      const sel = getFrameSelection();
      if (sel && sel.rangeCount) {
        try {
          const r = sel.getRangeAt(0).getBoundingClientRect();
          if (r.width > 0 || r.height > 0)
            return { left: r.left, top: r.top, bottom: r.bottom };
        } catch (_) {}
      }
    }
    const rect = el.getBoundingClientRect();
    return { left: rect.left + 4, top: rect.bottom + 2, bottom: rect.bottom + 2 };
  }

  function positionDropdown() {
    if (!dropdownEl || !activeTarget) return;
    const c   = getCaretPos(activeTarget);
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;
    const dW  = 344;
    const dH  = Math.min(dropdownEl.scrollHeight || 400, 420);

    let left = c.left;
    let top  = c.bottom + 5;

    if (left + dW > vpW - 8) left = Math.max(8, vpW - dW - 8);
    if (top  + dH > vpH - 8) top  = Math.max(8, c.top - dH - 5);

    dropdownEl.style.left = left + "px";
    dropdownEl.style.top  = top  + "px";
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Show / hide
  // ─────────────────────────────────────────────────────────────────────────
  function showDropdown(query) {
    createDropdown();
    renderDropdown(query);
    positionDropdown();
    dropdownEl.style.display = "flex";
  }

  function hideDropdown() {
    if (dropdownEl) { dropdownEl.style.display = "none"; dropdownEl.innerHTML = ""; }
    activeTarget   = null;
    triggerStart   = -1;
    currentResults = [];
    selectedIndex  = 0;
  }

  function isDropdownVisible() {
    return !!(dropdownEl && dropdownEl.style.display !== "none");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // getQuery — reads the typed query from trigger char to cursor
  //
  // For CE: scans the live text node after each input event (not keydown),
  //   which avoids the React/ChatGPT "type twice" bug entirely.
  //
  // For input/textarea: uses triggerStart recorded in keydown + current
  //   selectionStart to slice the query segment.
  //
  // Google Keep / BR cursor fix: when startContainer is an Element node
  //   (cursor after <br>), looks at the previous child text node.
  // ─────────────────────────────────────────────────────────────────────────
  function getQuery(el) {
    if (el.isContentEditable) {
      const sel = getFrameSelection();
      if (!sel || !sel.rangeCount) return null;
      const range = sel.getRangeAt(0);
      if (!range.collapsed) return null;

      let node   = range.startContainer;
      let curIdx = range.startOffset;

      // Resolve element-node cursor → adjacent text node
      if (node.nodeType !== Node.TEXT_NODE) {
        const child = node.childNodes[curIdx - 1];
        if (child && child.nodeType === Node.TEXT_NODE) {
          node = child; curIdx = child.textContent.length;
        } else { return null; }
      }

      const text = node.textContent;
      let trigIdx = -1;
      for (let i = curIdx - 1; i >= 0; i--) {
        if (text[i] === TRIGGER) { trigIdx = i; break; }
        if (text[i] === " " || text[i] === "\n") return null;
      }
      if (trigIdx < 0) return null;
      // Must be at start of text OR preceded by whitespace
      const before = trigIdx > 0 ? text[trigIdx - 1] : null;
      if (before && before !== " " && before !== "\n") return null;
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
  // Insert snippet — replaces "/query" with snippet content
  // ─────────────────────────────────────────────────────────────────────────
  function selectResult(snippet) {
    if (!activeTarget) { hideDropdown(); return; }

    // Bump usage stats (async, non-blocking)
    chrome.storage.local.get(["items"], data => {
      const items = data.items || [];
      const idx   = items.findIndex(i => i.id === snippet.id);
      if (idx >= 0) {
        items[idx] = { ...items[idx], usageCount: (items[idx].usageCount || 0) + 1, lastUsedAt: Date.now() };
        chrome.storage.local.set({ items });
        snippets = items.filter(i => i.type === "snippet");
        buildIndex();
      }
    });

    if (activeTarget.isContentEditable) {
      insertCE(activeTarget, snippet.content);
    } else {
      if (triggerStart < 0) { hideDropdown(); return; }
      const val    = activeTarget.value;
      const curPos = activeTarget.selectionStart;
      activeTarget.value = val.slice(0, triggerStart) + snippet.content + val.slice(curPos);
      const pos = triggerStart + snippet.content.length;
      activeTarget.selectionStart = activeTarget.selectionEnd = pos;
      activeTarget.focus();
      activeTarget.dispatchEvent(new Event("input",  { bubbles: true }));
      activeTarget.dispatchEvent(new Event("change", { bubbles: true }));
    }

    hideDropdown();
  }

  function insertCE(el, content) {
    el.focus();
    const sel = getFrameSelection();
    if (!sel || !sel.rangeCount) { appendText(el, content); return; }

    const range  = sel.getRangeAt(0);
    let   node   = range.startContainer;
    let   curIdx = range.startOffset;

    // Resolve element-node cursor
    if (node.nodeType !== Node.TEXT_NODE) {
      const child = node.childNodes[curIdx - 1];
      if (child && child.nodeType === Node.TEXT_NODE) {
        node = child; curIdx = child.textContent.length;
      }
    }

    // Replace "/query" in text node directly
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent;
      let trigIdx = -1;
      for (let i = curIdx - 1; i >= 0; i--) {
        if (text[i] === TRIGGER) { trigIdx = i; break; }
        if (text[i] === " " || text[i] === "\n") break;
      }
      if (trigIdx >= 0) {
        node.textContent = text.slice(0, trigIdx) + content + text.slice(curIdx);
        const newPos   = trigIdx + content.length;
        const newRange = document.createRange();
        newRange.setStart(node, Math.min(newPos, node.textContent.length));
        newRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(newRange);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }
    }

    // execCommand fallback (React, ProseMirror, TipTap)
    try {
      if (document.execCommand("insertText", false, content)) {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }
    } catch (_) {}

    // DOM fragment last resort
    insertFragment(sel, range, content);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Paste injection — for tp_paste_snippet messages (no trigger involved)
  // ─────────────────────────────────────────────────────────────────────────
  function pasteIntoInput(el, text) {
    el.focus();
    const len   = el.value.length;
    const start = savedInputSel ? Math.min(savedInputSel.start, len) : (el.selectionStart ?? len);
    const end   = savedInputSel ? Math.min(savedInputSel.end,   len) : (el.selectionEnd   ?? len);
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    el.setSelectionRange(start + text.length, start + text.length);
    el.dispatchEvent(new Event("input",  { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    savedInputSel = null;
  }

  function pasteIntoCE(el, text) {
    el.focus();
    const sel = getFrameSelection();
    if (!sel) { appendText(el, text); return; }
    if (savedRange) {
      try { sel.removeAllRanges(); sel.addRange(savedRange); }
      catch (_) { savedRange = null; }
    }
    try {
      if (sel.rangeCount > 0 && document.execCommand("insertText", false, text)) {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        savedRange = null; return;
      }
    } catch (_) {}
    if (sel.rangeCount > 0) {
      try { sel.deleteFromDocument(); } catch (_) {
        try { sel.getRangeAt(0).deleteContents(); } catch (_2) {}
      }
      const range = sel.getRangeAt(0);
      if (range) insertFragment(sel, range, text);
      else appendText(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      appendText(el, text);
    }
    savedRange = null;
  }

  function insertFragment(sel, range, text) {
    range.deleteContents();
    const frag  = document.createDocumentFragment();
    const lines = text.split("\n");
    let   last  = null;
    lines.forEach((line, i) => {
      if (i > 0) { const br = document.createElement("br"); frag.appendChild(br); last = br; }
      if (line)  { const tn = document.createTextNode(line); frag.appendChild(tn); last = tn; }
    });
    range.insertNode(frag);
    if (last) {
      try {
        const nr = document.createRange();
        nr.setStartAfter(last); nr.collapse(true);
        sel.removeAllRanges(); sel.addRange(nr);
      } catch (_) {}
    }
  }

  function appendText(el, text) {
    const node = document.createTextNode(text);
    el.appendChild(node);
    try {
      const r = document.createRange();
      r.setStartAfter(node); r.collapse(true);
      const s = getFrameSelection();
      if (s) { s.removeAllRanges(); s.addRange(r); }
    } catch (_) {}
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function pasteText(el, text) {
    if (!el) return;
    if (el.isContentEditable) pasteIntoCE(el, text);
    else                      pasteIntoInput(el, text);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Keydown — navigation when open; triggerStart recording for input/textarea
  // ─────────────────────────────────────────────────────────────────────────
  function onKeydown(e) {
    const el = e.target;
    if (!isEditable(el)) return;

    if (isDropdownVisible()) {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          selectedIndex = Math.min(selectedIndex + 1, currentResults.length - 1);
          highlightActive();
          break;
        case "ArrowUp":
          e.preventDefault();
          selectedIndex = Math.max(selectedIndex - 1, 0);
          highlightActive();
          break;
        case "Enter":
        case "Tab":
          if (currentResults.length) { e.preventDefault(); selectResult(currentResults[selectedIndex].snippet); }
          break;
        case "Escape":
          e.preventDefault(); hideDropdown();
          break;
        case "Backspace":
          if (!el.isContentEditable) {
            setTimeout(() => { if (getQuery(el) === null) hideDropdown(); }, 0);
          }
          break;
      }
      return;
    }

    // For input/textarea: record trigger position before char is inserted
    if (!el.isContentEditable && e.key === TRIGGER && !e.ctrlKey && !e.metaKey && !e.altKey) {
      activeTarget = el;
      triggerStart = el.selectionStart;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Input — show/update dropdown
  // For CE: detect trigger here (after DOM is updated) to avoid React timing bug
  // ─────────────────────────────────────────────────────────────────────────
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
      if (el.isContentEditable) activeTarget = el; // set here for CE (not keydown)
      showDropdown(q);
    }, DEBOUNCE_MS);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Close on outside click or focus loss
  // ─────────────────────────────────────────────────────────────────────────
  document.addEventListener("click", e => {
    if (dropdownEl && !dropdownEl.contains(e.target)) hideDropdown();
  }, true);

  document.addEventListener("focusout", () => {
    setTimeout(() => { if (document.activeElement !== activeTarget) hideDropdown(); }, 150);
  }, true);

  // ─────────────────────────────────────────────────────────────────────────
  // Wire event listeners
  // ─────────────────────────────────────────────────────────────────────────
  document.addEventListener("keydown", onKeydown, true);
  document.addEventListener("input",   onInput,   true);
  window.addEventListener("scroll", () => { if (isDropdownVisible()) positionDropdown(); }, true);
  window.addEventListener("resize", () => { if (isDropdownVisible()) positionDropdown(); });

  // ─────────────────────────────────────────────────────────────────────────
  // Message handler — tp_paste_snippet (direct paste from popup)
  // ─────────────────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "tp_paste_snippet") {
      const target = lastFocusedEditable;
      if (target && isEditable(target)) {
        pasteText(target, msg.content);
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

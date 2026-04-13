// background.js — TextPocket v1.1

// ── Seed default snippets on first install ───────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["items"], data => {
    if (data.items) return;
    const personalId = "folder-personal";
    const workId     = "folder-work";
    const devId      = "folder-dev";
    chrome.storage.local.set({ items: [
      { type:"folder", id:personalId, name:"Personal", color:"#3a6af0" },
      { type:"folder", id:workId,     name:"Work",     color:"#20a870" },
      { type:"folder", id:devId,      name:"Dev",      color:"#7c5cfc" },
      { type:"snippet", id:"snip-1", name:"My Email",
        content:"hello@example.com",
        folderId:personalId, tags:["email","contact"], usageCount:0, lastUsedAt:null },
      { type:"snippet", id:"snip-2", name:"Home Address",
        content:"123 Main St, Springfield, IL 62701",
        folderId:personalId, tags:["address","contact"], usageCount:0, lastUsedAt:null },
      { type:"snippet", id:"snip-3", name:"Meeting Reply",
        content:"Thanks for reaching out! I'm available on [DATE] at [TIME]. Let me know if that works for you.",
        folderId:workId, tags:["email","reply","meeting"], usageCount:0, lastUsedAt:null },
      { type:"snippet", id:"snip-4", name:"Out of Office",
        content:"I'm out of the office and will return on [DATE]. For urgent matters contact [NAME] at [EMAIL].",
        folderId:workId, tags:["email","ooo"], usageCount:0, lastUsedAt:null },
      { type:"snippet", id:"snip-5", name:"SQL Select",
        content:"SELECT *\nFROM table_name\nWHERE condition = 'value'\nORDER BY id DESC\nLIMIT 100;",
        folderId:devId, tags:["sql","query"], usageCount:0, lastUsedAt:null },
      { type:"snippet", id:"snip-6", name:"Console Log",
        content:"console.log('[DEBUG]', );",
        folderId:devId, tags:["js","debug"], usageCount:0, lastUsedAt:null }
    ]});
  });
});


// ── Open popup via keyboard command (Ctrl+Shift+1) ────────────────────────────
let popupWindowId = null;

async function getSavedBounds() {
  return new Promise(r => chrome.storage.local.get(["popupBounds"], d => r(d.popupBounds || null)));
}
async function saveBounds(b) { chrome.storage.local.set({ popupBounds: b }); }

async function getCenteredPosition(w, h) {
  const displays = await chrome.system.display.getInfo();
  const p = displays.find(d => d.isPrimary) || displays[0];
  return {
    left: Math.round(p.workArea.left + (p.workArea.width  - w) / 2),
    top:  Math.round(p.workArea.top  + (p.workArea.height - h) / 2)
  };
}

chrome.commands.onCommand.addListener(async command => {
  if (command !== "open_popup") return;
  try { await chrome.action.openPopup(); return; } catch (_) {}

  if (popupWindowId !== null) {
    try { await chrome.windows.update(popupWindowId, { focused: true }); return; }
    catch (_) { popupWindowId = null; }
  }

  const saved = await getSavedBounds();
  const W = 598, H = 560;
  let left, top;
  if (saved) { left = saved.left; top = saved.top; }
  else { const pos = await getCenteredPosition(W, H); left = pos.left; top = pos.top; }

  const win = await chrome.windows.create({
    url: chrome.runtime.getURL("popup.html"),
    type: "popup", width: W, height: H, left, top, focused: true
  });
  popupWindowId = win.id;

  chrome.windows.onBoundsChanged.addListener(w => {
    if (w.id !== popupWindowId) return;
    saveBounds({ top: w.top, left: w.left, width: w.width, height: w.height });
  });
});

chrome.windows.onRemoved.addListener(id => { if (id === popupWindowId) popupWindowId = null; });

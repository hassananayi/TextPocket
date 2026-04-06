// popup.js — TextPocket v1.0

// ─── Constants ────────────────────────────────────────────────────────────────
const FOLDER_COLORS = ["#3a6af0","#7c5cfc","#e04444","#f08030","#e8b800","#20a870","#0ea5e9","#ec4899","#6b7280","#1a1d2e"];

// ─── i18n ─────────────────────────────────────────────────────────────────────
let i18n = {};
const LANG_URL = lang => chrome.runtime.getURL(`lang/${lang}.json`);
async function loadLang(lang) {
  let ok = false;
  try { const r = await fetch(LANG_URL(lang)); if (r.ok) { i18n = await r.json(); ok = true; } } catch {}
  if (!ok && lang !== "en") { try { const r = await fetch(LANG_URL("en")); if (r.ok) i18n = await r.json(); } catch {} }
  applyI18n();
}
function t(k, fb) { return i18n[k] || fb || k; }
function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const v = t(el.dataset.i18n); if (v !== el.dataset.i18n) el.textContent = v;
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    const v = t(el.dataset.i18nPlaceholder); if (v !== el.dataset.i18nPlaceholder) el.placeholder = v;
  });
}

// ─── Settings ─────────────────────────────────────────────────────────────────
let cfg = { theme: "light", lang: "en", trigger: "/" };
const getSettings = () => new Promise(r =>
  chrome.storage.local.get(["settings"], d => r(d.settings || { theme:"light", lang:"en", trigger:"/" }))
);
const savSettings = s => new Promise(r => chrome.storage.local.set({ settings: s }, r));

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.querySelectorAll(".seg-btn").forEach(b => b.classList.toggle("active", b.dataset.themeVal === theme));
}
document.querySelectorAll(".seg-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    applyTheme(btn.dataset.themeVal);
    cfg.theme = btn.dataset.themeVal;
    await savSettings(cfg);
    showToast(t("toast_settings_saved","Settings saved"), "success");
  });
});

const langSel = document.getElementById("langSelect");
langSel.addEventListener("change", async () => {
  cfg.lang = langSel.value;
  await savSettings(cfg);
  await loadLang(cfg.lang);
  renderAll();
  showToast(t("toast_settings_saved","Settings saved"), "success");
});

// ─── Trigger character ────────────────────────────────────────────────────────
document.getElementById("saveTriggerBtn").addEventListener("click", async () => {
  const val = document.getElementById("triggerInput").value.trim();
  if (!val) { showToast(t("toast_trigger_empty","Enter a trigger character"), "error"); return; }
  cfg.trigger = val;
  await savSettings(cfg);
  showToast(t("toast_trigger_saved","Trigger saved ✓"), "success");
});
document.getElementById("resetTriggerBtn").addEventListener("click", async () => {
  cfg.trigger = "/";
  document.getElementById("triggerInput").value = "/";
  await savSettings(cfg);
  showToast(t("toast_trigger_saved","Trigger saved ✓"), "success");
});

// ─── Storage ──────────────────────────────────────────────────────────────────
const getItems = () => new Promise(r => chrome.storage.local.get(["items"], d => r(d.items || [])));
const setItems = items => new Promise(r => chrome.storage.local.set({ items }, r));
const uid = () => "id-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function parseTags(str)     { return str.split(",").map(s => s.trim()).filter(Boolean); }
function serializeTags(arr) { return (arr || []).join(", "); }

// ─── View router ──────────────────────────────────────────────────────────────
let currentView = "snippets";
function showView(name) {
  currentView = name;
  ["snippets","add-snip","add-fold","settings"].forEach(v =>
    document.getElementById("view-" + v).classList.toggle("active", v === name)
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────
const toastEl = document.getElementById("toast");
let toastTmr;
function showToast(msg, type = "") {
  toastEl.textContent = msg;
  toastEl.className = "toast show" + (type ? " " + type : "");
  clearTimeout(toastTmr);
  toastTmr = setTimeout(() => { toastEl.className = "toast"; }, 2400);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function guessIcon(name, content) {
  const n = (name + content).toLowerCase();
  if (/@/.test(content))                     return "bi-envelope";
  if (/https?:\/\//.test(content))           return "bi-link-45deg";
  if (/password|pwd|pass/i.test(n))          return "bi-key";
  if (/address|addr|street/i.test(n))        return "bi-geo-alt";
  if (/phone|tel|mobile/i.test(n))           return "bi-telephone";
  if (/sql|select|query/i.test(n))           return "bi-database";
  if (/\n/.test(content))                    return "bi-file-text";
  if (/code|func|def |var |const /i.test(n)) return "bi-code-slash";
  if (/\d{4,}/.test(content))               return "bi-hash";
  return null;
}

// ─── Selected folder ──────────────────────────────────────────────────────────
let selFolder = "__all__";
let sortInst  = null;

async function renderAll() {
  const items = await getItems();
  renderSidebar(items);
  if (currentView === "snippets") renderList(items);
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
function renderSidebar(items) {
  const snippets = items.filter(i => i.type === "snippet");
  const folders  = items.filter(i => i.type === "folder");
  const nav = document.getElementById("folderNav");
  nav.innerHTML = "";

  const lbl = document.createElement("div");
  lbl.className = "nav-lbl";
  lbl.setAttribute("data-i18n", "nav_folders_label");
  lbl.textContent = t("nav_folders_label", "Folders");
  nav.appendChild(lbl);

  nav.appendChild(mkNavItem("__all__", null, "bi-clipboard2", t("nav_all","All Snippets"), snippets.length));
  folders.forEach(f => {
    nav.appendChild(mkNavItem(f.id, f.color, null, f.name, snippets.filter(s => s.folderId === f.id).length, f));
  });
  nav.appendChild(mkNavItem("__ungrouped__", "#9ca3af", null, t("nav_ungrouped","Ungrouped"), snippets.filter(s => !s.folderId).length));
}

function mkNavItem(id, color, iconCls, label, count, folder = null) {
  const div = document.createElement("div");
  div.className = "nav-item" + (selFolder === id ? " active" : "");

  const left = iconCls
    ? `<i class="bi ${iconCls}" style="font-size:15px;color:var(--text2)"></i>`
    : `<span class="nav-dot" style="background:${esc(color||"#9ca3af")}"></span>`;

  div.innerHTML = `${left}<span class="nav-lable">${esc(label)}</span><span class="nav-cnt">${count}</span>${folder ? `<button class="nav-edit" title="Edit"><i class="bi bi-pencil"></i></button>` : ""}`;

  if (folder) {
    div.querySelector(".nav-edit").addEventListener("click", e => { e.stopPropagation(); openEditFoldModal(folder.id); });
  }
  div.addEventListener("click", e => {
    if (e.target.closest(".nav-edit")) return;
    selFolder = id; showView("snippets"); renderAll();
  });
  return div;
}

// ─── Snippet list ─────────────────────────────────────────────────────────────
async function renderList(itemsArg) {
  const items    = itemsArg || await getItems();
  const folders  = items.filter(i => i.type === "folder");
  const snippets = items.filter(i => i.type === "snippet");
  const wrap     = document.getElementById("listWrap");
  const search   = document.getElementById("searchInput").value.trim().toLowerCase();

  const titleEl = document.getElementById("viewTitle");
  if      (selFolder === "__all__")        titleEl.textContent = t("nav_all","All Snippets");
  else if (selFolder === "__ungrouped__")  titleEl.textContent = t("nav_ungrouped","Ungrouped");
  else {
    const f = folders.find(x => x.id === selFolder);
    titleEl.textContent = f ? f.name : t("nav_all","All Snippets");
  }

  if (sortInst) { sortInst.destroy(); sortInst = null; }
  wrap.innerHTML = "";

  if (selFolder === "__all__") {
    let display = snippets;
    if (search) display = display.filter(s =>
      s.name.toLowerCase().includes(search) ||
      (s.content||"").toLowerCase().includes(search) ||
      (s.tags||[]).some(tag => tag.toLowerCase().includes(search))
    );
    if (!display.length) { wrap.appendChild(mkEmpty(search ? t("no_results","No results found.") : t("empty_state","No snippets yet."))); return; }
    display.forEach(s => wrap.appendChild(mkSnipCard(s, items, { showBadge: true, draggable: false })));
    return;
  }

  let display = selFolder === "__ungrouped__"
    ? items.filter(i => i.type === "snippet" && !i.folderId)
    : items.filter(i => i.type === "snippet" && i.folderId === selFolder);

  if (search) display = display.filter(i =>
    i.name.toLowerCase().includes(search) ||
    (i.content||"").toLowerCase().includes(search) ||
    (i.tags||[]).some(tag => tag.toLowerCase().includes(search))
  );
  if (!display.length) { wrap.appendChild(mkEmpty(search ? t("no_results","No results found.") : t("empty_state","No snippets yet."))); return; }
  display.forEach(item => wrap.appendChild(mkSnipCard(item, items, { showBadge: false, draggable: true })));
  initSortable(wrap, items);
}

function mkEmpty(msg) {
  const div = document.createElement("div");
  div.className = "empty-state";
  div.innerHTML = `<i class="bi bi-clipboard2" style="font-size:36px;opacity:.3;"></i><p>${esc(msg)}</p>`;
  return div;
}

// ─── Snippet card ─────────────────────────────────────────────────────────────
function mkSnipCard(snippet, items, { showBadge, draggable }) {
  const iconCls = guessIcon(snippet.name, snippet.content||"");
  const preview = (snippet.content||"").replace(/\n+/g," ↵ ").slice(0,52);
  const folder  = items.find(i => i.type==="folder" && i.id===snippet.folderId);
  const tags    = (snippet.tags||[]).slice(0,3).map(tag => `<span class="snip-tag">${esc(tag)}</span>`).join("");

  const iconHtml = iconCls
    ? `<div class="snip-icon"><i class="bi ${iconCls}"></i></div>`
    : `<div class="snip-icon">${esc(snippet.name.charAt(0).toUpperCase())}</div>`;

  const el = document.createElement("div");
  el.className = "snip-card";
  el.dataset.id = snippet.id;

  const badgeHtml = showBadge && folder
    ? `<span class="snip-tag" style="border-left:2px solid ${esc(folder.color||"#9ca3af")};color:${esc(folder.color||"#9ca3af")}">${esc(folder.name)}</span>`
    : "";
  const hasMeta = tags || badgeHtml;

  el.innerHTML = `
    ${draggable ? `<span class="snip-drag"><i class="bi bi-grip-vertical"></i></span>` : ""}
    ${iconHtml}
    <div class="snip-info">
      <div class="snip-name">${esc(snippet.name)}</div>
      <div class="snip-preview">${esc(preview)}${(snippet.content||"").length>52?"…":""}</div>
      ${hasMeta ? `<div class="snip-tags">${badgeHtml}${tags}</div>` : ""}
    </div>
    <div class="snip-actions">
      <button class="act-btn copy" title="${esc(t("copy","Copy"))}"><i class="bi bi-clipboard"></i></button>
      <button class="act-btn edit" title="${esc(t("edit","Edit"))}"><i class="bi bi-pencil"></i></button>
      <button class="act-btn del"  title="${esc(t("remove","Remove"))}"><i class="bi bi-trash3"></i></button>
    </div>`;

  el.querySelector(".copy").addEventListener("click", e => {
    e.stopPropagation();
    navigator.clipboard.writeText(snippet.content||"").then(() => showToast(t("toast_copied","Copied ✓"), "success"));
  });
  el.querySelector(".edit").addEventListener("click", e => { e.stopPropagation(); openEditSnipModal(snippet.id); });
  el.querySelector(".del").addEventListener("click", async e => {
    e.stopPropagation();
    const its = await getItems();
    await setItems(its.filter(i => !(i.type==="snippet" && i.id===snippet.id)));
    renderAll();
  });
  return el;
}

// ─── Sortable ─────────────────────────────────────────────────────────────────
function initSortable(container, items) {
  if (typeof Sortable === "undefined") return;
  sortInst = Sortable.create(container, {
    animation: 140, handle: ".snip-drag",
    ghostClass: "sortable-ghost", chosenClass: "sortable-chosen",
    filter: ".empty-state",
    onEnd: async () => {
      const allItems   = await getItems();
      const visibleIds = [...container.querySelectorAll("[data-id]")].map(el => el.dataset.id);
      if (!visibleIds.length) return;
      const reordered = visibleIds.map(id => allItems.find(i => i.id === id)).filter(Boolean);
      const firstIdx  = allItems.findIndex(i => i.id === visibleIds[0]);
      if (firstIdx < 0) return;
      const before = allItems.slice(0, firstIdx).filter(i => !visibleIds.includes(i.id));
      const after  = allItems.slice(firstIdx).filter(i => !visibleIds.includes(i.id));
      await setItems([...before, ...reordered, ...after]);
    }
  });
}

// ─── Navigation ───────────────────────────────────────────────────────────────
document.getElementById("btnNewSnippet").addEventListener("click", async () => { await populateFoldSels(); showView("add-snip"); });
document.getElementById("btnNewFolder").addEventListener("click",  () => showView("add-fold"));
document.getElementById("btnSettings").addEventListener("click",   () => showView("settings"));
document.getElementById("btnImportExport").addEventListener("click", () => showView("settings"));
document.getElementById("backFromSnip").addEventListener("click",     () => { showView("snippets"); renderAll(); });
document.getElementById("backFromFold").addEventListener("click",     () => { showView("snippets"); renderAll(); });
document.getElementById("backFromSettings").addEventListener("click", () => { showView("snippets"); renderAll(); });
document.getElementById("searchInput").addEventListener("input", () => renderList());

// ─── Color picker ─────────────────────────────────────────────────────────────
let addColor  = FOLDER_COLORS[0];
let editColor = FOLDER_COLORS[0];

function buildColorPicker(containerId, getC, setC) {
  const c = document.getElementById(containerId);
  c.innerHTML = "";
  FOLDER_COLORS.forEach(hex => {
    const sw = document.createElement("button");
    sw.className = "c-sw" + (getC() === hex ? " selected" : "");
    sw.style.background = hex; sw.title = hex;
    sw.addEventListener("click", () => {
      setC(hex);
      c.querySelectorAll(".c-sw").forEach(s => s.classList.toggle("selected", s.title === hex));
    });
    c.appendChild(sw);
  });
}

// ─── Folder selects ───────────────────────────────────────────────────────────
async function populateFoldSels(selectedId = "") {
  const items   = await getItems();
  const folders = items.filter(i => i.type === "folder");
  const noLbl   = t("no_folder","— No folder —");
  ["folderSelect","editFolderSelect"].forEach(selId => {
    const sel = document.getElementById(selId);
    if (!sel) return;
    const prev = sel.value || selectedId;
    sel.innerHTML = `<option value="">${esc(noLbl)}</option>`;
    folders.forEach(f => {
      const opt = document.createElement("option");
      opt.value = f.id; opt.textContent = f.name;
      if (f.id === prev) opt.selected = true;
      sel.appendChild(opt);
    });
  });
  if (selFolder !== "__all__" && selFolder !== "__ungrouped__") {
    const sel = document.getElementById("folderSelect");
    if (sel) sel.value = selFolder;
  }
}

// ─── Add Snippet ──────────────────────────────────────────────────────────────
const nameInp = document.getElementById("nameInput");
const contInp = document.getElementById("contentInput");
const tagsInp = document.getElementById("tagsInput");

document.getElementById("addSnippetBtn").addEventListener("click", async () => {
  const name    = nameInp.value.trim();
  const content = contInp.value;
  if (!name || !content) { showToast(t("toast_fill_fields","Fill in both fields"), "error"); return; }
  const folderId = document.getElementById("folderSelect").value || null;
  const tags     = parseTags(tagsInp.value);
  const items    = await getItems();

  let insertAt = items.length;
  if (folderId) {
    let last = -1;
    items.forEach((it, i) => { if (it.folderId===folderId || (it.type==="folder"&&it.id===folderId)) last=i; });
    if (last >= 0) insertAt = last + 1;
  }
  items.splice(insertAt, 0, { type:"snippet", id:uid(), name, content, folderId, tags, usageCount:0, lastUsedAt:null });
  await setItems(items);

  nameInp.value = ""; contInp.value = ""; tagsInp.value = "";
  document.getElementById("folderSelect").value = "";
  selFolder = folderId || "__all__";
  showView("snippets"); renderAll();
  showToast(t("toast_snippet_added","Snippet added ✓"), "success");
});

// ─── Add Folder ───────────────────────────────────────────────────────────────
buildColorPicker("folderColorPicker", () => addColor, c => { addColor = c; });

document.getElementById("addFolderBtn").addEventListener("click", async () => {
  const name = document.getElementById("folderNameInput").value.trim();
  if (!name) { showToast(t("toast_fill_name","Enter a folder name"), "error"); return; }
  const items = await getItems();
  const newId = uid();
  items.push({ type:"folder", id:newId, name, color:addColor });
  await setItems(items);
  document.getElementById("folderNameInput").value = "";
  addColor = FOLDER_COLORS[0];
  buildColorPicker("folderColorPicker", () => addColor, c => { addColor = c; });
  selFolder = newId;
  showView("snippets"); renderAll();
  showToast(t("toast_folder_added","Folder created ✓"), "success");
});

// ─── Edit Snippet Modal ───────────────────────────────────────────────────────
const editSnipMod = document.getElementById("editSnipModal");
const editNameInp = document.getElementById("editNameInput");
const editContInp = document.getElementById("editContentInput");
const editTagsInp = document.getElementById("editTagsInput");
let editingSnipId = null;

async function openEditSnipModal(id) {
  const items = await getItems();
  const s = items.find(i => i.id===id && i.type==="snippet");
  if (!s) return;
  editingSnipId     = id;
  editNameInp.value = s.name;
  editContInp.value = s.content;
  editTagsInp.value = serializeTags(s.tags);
  await populateFoldSels(s.folderId||"");
  document.getElementById("editFolderSelect").value = s.folderId||"";
  editSnipMod.classList.add("open");
}

const closeEditSnip = () => { editSnipMod.classList.remove("open"); editingSnipId = null; };
document.getElementById("closeEditSnip").addEventListener("click",  closeEditSnip);
document.getElementById("cancelEditSnip").addEventListener("click", closeEditSnip);
editSnipMod.addEventListener("click", e => { if (e.target===editSnipMod) closeEditSnip(); });

document.getElementById("saveEditSnip").addEventListener("click", async () => {
  if (!editingSnipId) return;
  const name    = editNameInp.value.trim();
  const content = editContInp.value;
  if (!name||!content) { showToast(t("toast_fill_fields","Fill in both fields"),"error"); return; }
  const newFolderId = document.getElementById("editFolderSelect").value||null;
  const tags        = parseTags(editTagsInp.value);
  const items       = await getItems();
  const idx         = items.findIndex(i => i.id===editingSnipId);
  if (idx >= 0) {
    const oldFolderId = items[idx].folderId ?? null;
    items[idx] = { ...items[idx], name, content, folderId:newFolderId, tags };
    if (newFolderId !== oldFolderId) {
      const moved = items.splice(idx,1)[0];
      let insertAt = items.length;
      if (newFolderId) {
        let last=-1;
        items.forEach((it,i) => { if((it.folderId??null)===newFolderId||(it.type==="folder"&&it.id===newFolderId)) last=i; });
        if (last>=0) insertAt=last+1;
      }
      items.splice(insertAt,0,moved);
    }
  }
  await setItems(items);
  closeEditSnip(); renderAll();
  showToast(`${name} ${t("toast_updated","updated ✓")}`, "success");
});

// ─── Edit Folder Modal ────────────────────────────────────────────────────────
const editFoldMod = document.getElementById("editFoldModal");
let editingFoldId = null;

buildColorPicker("editFoldColorPicker", () => editColor, c => { editColor = c; });

async function openEditFoldModal(id) {
  const items = await getItems();
  const f = items.find(i => i.id===id && i.type==="folder");
  if (!f) return;
  editingFoldId = id;
  document.getElementById("editFoldNameInput").value = f.name;
  editColor = f.color||FOLDER_COLORS[0];
  buildColorPicker("editFoldColorPicker", () => editColor, c => { editColor = c; });
  editFoldMod.classList.add("open");
}

const closeEditFold = () => { editFoldMod.classList.remove("open"); editingFoldId = null; };
document.getElementById("closeEditFold").addEventListener("click",  closeEditFold);
document.getElementById("cancelEditFold").addEventListener("click", closeEditFold);
editFoldMod.addEventListener("click", e => { if (e.target===editFoldMod) closeEditFold(); });

document.getElementById("saveEditFold").addEventListener("click", async () => {
  if (!editingFoldId) return;
  const name = document.getElementById("editFoldNameInput").value.trim();
  if (!name) { showToast(t("toast_fill_name","Enter a name"),"error"); return; }
  const items = await getItems();
  const idx = items.findIndex(i => i.id===editingFoldId);
  if (idx>=0) items[idx] = { ...items[idx], name, color:editColor };
  await setItems(items);
  closeEditFold(); renderAll();
  showToast(`"${name}" ${t("toast_updated","updated ✓")}`, "success");
});

document.getElementById("deleteFoldBtn").addEventListener("click", async () => {
  if (!editingFoldId) return;
  const items      = await getItems();
  const folder     = items.find(i => i.id===editingFoldId && i.type==="folder");
  const folderName = folder ? folder.name : "";
  const updated    = items
    .map(i => (i.type==="snippet" && i.folderId===editingFoldId) ? { ...i, folderId:null } : i)
    .filter(i => !(i.type==="folder" && i.id===editingFoldId));
  await setItems(updated);
  if (selFolder === editingFoldId) selFolder = "__all__";
  closeEditFold(); renderAll();
  showToast(`"${folderName}" ${t("toast_folder_deleted","deleted")}`, "");
});

// ─── Export / Import ──────────────────────────────────────────────────────────
document.getElementById("exportBtn").addEventListener("click", async () => {
  const items = await getItems();
  const blob  = new Blob([JSON.stringify(items,null,2)],{type:"application/json"});
  const url   = URL.createObjectURL(blob);
  Object.assign(document.createElement("a"),{href:url,download:"textpocket.json"}).click();
  URL.revokeObjectURL(url);
  showToast(t("toast_exported","Exported ✓"),"success");
});
document.getElementById("importBtn").addEventListener("click", () => document.getElementById("importFileInput").click());
document.getElementById("importFileInput").addEventListener("change", e => {
  const file = e.target.files[0]; if (!file) return;
  const r = new FileReader();
  r.onload = async ev => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!Array.isArray(data)) throw new Error();
      const migrated = data.map(item => {
        if (item.type !== "snippet") return item;
        const { aliases, ...rest } = item;
        return { tags:[], usageCount:0, lastUsedAt:null, ...rest };
      });
      await setItems(migrated); selFolder="__all__"; showView("snippets"); renderAll();
      showToast(migrated.filter(i=>i.type==="snippet").length+" "+t("toast_imported","snippets imported ✓"),"success");
    } catch { showToast(t("toast_invalid_json","Invalid JSON"),"error"); }
    e.target.value="";
  };
  r.readAsText(file);
});

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  cfg = await getSettings();
  applyTheme(cfg.theme);
  langSel.value = cfg.lang || "en";
  document.getElementById("triggerInput").value = cfg.trigger || "/";
  await loadLang(cfg.lang || "en");
  buildColorPicker("folderColorPicker",   () => addColor,  c => { addColor  = c; });
  buildColorPicker("editFoldColorPicker", () => editColor, c => { editColor = c; });
  await renderAll();
});

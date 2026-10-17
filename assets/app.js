/* Façade Stone Dashboard — application logic (IFC-driven).

   Every number, filter, search result and chart comes from the loaded IFC model
   (data/elements.json, produced by tools/export_geom.py or by the in-browser
   converter assets/ifc-core.js). The Excel workbook is not read by the dashboard.
   Fab Sheet PDFs and STL files are only linked by the IFC ticket number; they never
   change an IFC value.

   Data files (relative paths: works from server.py, any static host or a GitHub
   Pages sub-path):
     data/elements.json   IFC elements, properties and geometry manifest
     geom/*.bin           IFC geometry, one file per elevation + CONTEXT
     data/pdf_index.json  fab-sheets/<TICKET>.pdf library index
     data/stl_index.json  stl/<TICKET>.stl library index

   Counting vocabulary (used everywhere):
     IFC elements  = IfcBuildingElementProxy elements with a TICKET NUMBER (one per stone)
     Tickets       = distinct ticket numbers (one ticket can cover many stones)
     Records       = ticket x elevation pairs (IFC 'Architect' value)
     Files         = PDF / STL files found for a ticket */
"use strict";

const $ = s => document.querySelector(s);
const fmt = n => n == null ? "–" : Number(n).toLocaleString("en-US");
const normKey = t => (t == null ? "" : String(t)).replace(/\s+/g, "").toUpperCase();
const canonPhase = v => { if (typeof v !== "string") return v || ""; const m = v.match(/^\s*P\s*(\d+)(?:[\s_\-]*NEW)?\s*$/i); return m ? "P" + Number(m[1]) : v.trim(); };
const encPath = p => p.split("/").map(encodeURIComponent).join("/");
const byNum = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true });
function h(tag, attrs, ...kids){
  const e = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}
const SVGNS = "http://www.w3.org/2000/svg";
function s(tag, attrs, ...kids){ const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs || {})) if (v != null) e.setAttribute(k, v); for (const k of kids.flat()) if (k != null) e.append(k instanceof Node ? k : document.createTextNode(String(k))); return e; }
function icon(id){ const e = s("svg", { class: "i" }); e.append(s("use", { href: "#" + id })); return e; }

/* ---------------------------------------------------------------- manufacturing parameters */
const P_ISSUE = "Issue Status", P_T31 = "T-31-Count", P_T30 = "T-31(30mm.)-Count";
// A count parameter is read exactly as stored. States: absent (no property), empty (""),
// ok (whole number, 0 included), invalid (anything else). A missing value is never zero.
function parseCount(v){
  if (v === undefined || v === null) return { s: "absent" };
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 ? { s: "ok", n: v, raw: v } : { s: "invalid", raw: v };
  const t = String(v).trim();
  if (!t) return { s: "empty", raw: v };
  return /^\d+$/.test(t) ? { s: "ok", n: Number(t), raw: v } : { s: "invalid", raw: v };
}
const countText = c => c.s === "ok" ? String(c.n) : c.s === "absent" ? "not in IFC" : c.s === "empty" ? "empty" : `invalid: "${c.raw}"`;
// Grouping of the free-text Issue Status (derived for filters/badges; the IFC text is always shown as is)
const ISSUE_CATS = [
  { id: "stl", label: "STL file", test: v => /\bSTL\b/i.test(v), cls: "c-stl" },
  { id: "pin", label: "Pin & glued", test: v => /PIN\s*&\s*GLUED/i.test(v), cls: "c-pin" },
  { id: "t31_30", label: "T-31 (30 mm stone)", test: v => /T-31/i.test(v) && /30\s*mm/i.test(v), cls: "c-t31" },
  { id: "t31", label: "T-31", test: v => /T-31/i.test(v) && !/30\s*mm/i.test(v), cls: "c-t31" },
];
function issueCats(v){
  if (typeof v !== "string" || !v.trim()) return [];
  const c = ISSUE_CATS.filter(k => k.test(v)).map(k => k.id);
  return c.length ? c : ["other"];
}
const catLabel = id => id === "other" ? "Other status" : ISSUE_CATS.find(c => c.id === id).label;
// Project rule (from the project team): a stone whose Issue Status asks for an STL file gets <TICKET>.stl
const needsStl = e => typeof e.issue === "string" && /\bSTL\b/i.test(e.issue);
const SUSPECT_MM = 1; // a dimension below 1 mm is reported as a suspect IFC value (e.g. 0.008 = feet converted twice)

/* ---------------------------------------------------------------- state */
const S = { page: "overview", elev: "", phase: "", issue: "", t31: "", files: "", finish: "", flag: "", q: "", others: "show", ctx: true, sel: null, tab: "rec", rtab: "props", listLimit: 400 };
const D = { source: null };
let V = null;
const perf = window.__perf = { t0: performance.now() };

/* ---------------------------------------------------------------- loading */
async function getJSON(url){ const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); }
function loading(txt, frac){ $("#loading").hidden = false; $("#loadTxt").textContent = txt; $("#loadBar").style.width = Math.round((frac || 0) * 100) + "%"; }
function fatal(title, ...paras){
  $("#loading").hidden = true;
  const old = document.querySelector(".viewer .fatal"); if (old) old.remove();
  document.querySelector(".viewer").append(h("div", { class: "fatal" }, h("div", { class: "box" }, h("h2", { text: title }), paras.map(p => h("p", null, p)))));
}
const emptyIndex = base => ({ base, files: {}, unmatched: [], ignored: [], missingIndex: true });

async function boot(){
  if (location.protocol === "file:") {
    $("#projName").textContent = "Not started from a web server";
    setPage("model");
    fatal("Open the dashboard through its link or the start file",
      "Browsers do not let a page opened from disk (file://) read the model and data files.",
      h("span", null, "On this computer: double-click ", h("code", { text: "start-dashboard.bat" }), " (Windows) or ", h("code", { text: "start-dashboard.command" }), " (Mac) in this folder. Online: open the published link."));
    return;
  }
  try {
    loading("Loading the IFC model data…", 0.02);
    const [els, pdf, stl, srv] = await Promise.all([
      getJSON("data/elements.json"),
      getJSON("data/pdf_index.json").catch(() => emptyIndex("fab-sheets/")),
      getJSON("data/stl_index.json").catch(() => emptyIndex("stl/")),
      /\.github\.io$/.test(location.hostname) ? null : fetch("api/status", { cache: "no-store" }).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    D.server = srv && srv.server ? srv : null;
    D.idx = { pdf, stl };
    D.local = { pdf: await idbAll("pdf").catch(() => new Map()), stl: await idbAll("stl").catch(() => new Map()) };
    D.source = { kind: "published", name: els.source, chunk: c => fetch(c.file).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); }) };
    perf.dataMs = performance.now() - perf.t0;
    buildModel(els);
    $("#projName").textContent = "Vancouver Washington Temple · P23830";
    initUI();
    renderAll();
    await startViewer();
  } catch (e) {
    console.error(e);
    fatal("The dashboard data could not be loaded", `${e.message}.`, "Check that the folders data/, geom/ and assets/ are next to index.html and were uploaded completely.");
    $("#ovBody").replaceChildren(h("div", { class: "empty" }, h("b", { text: "The IFC model data could not be loaded" }), e.message));
  }
}

/* ---------------------------------------------------------------- model */
const DIMS = [["L", "Length", "LENGTH"], ["W", "Width", "WIDTH"], ["H", "Height", "HEIGHT"], ["T", "Thickness", "THICKNESS"]];
function buildModel(m){
  D.manifest = m;
  D.els = [null]; D.byGid = new Map(); D.byRevit = new Map(); D.tickets = new Map(); D.recs = new Map();
  const T = (key, name) => { let t = D.tickets.get(key); if (!t) { t = { key, name, recs: [], eids: [] }; D.tickets.set(key, t); } return t; };
  for (const e of m.elements) {
    D.els[e.eid] = e;
    D.byGid.set(e.gid, e.eid); if (e.revitId) D.byRevit.set(String(e.revitId), e.eid);
    if (e.kind !== "stone") continue;
    e.phase = canonPhase(e.phase || e.workset);
    e.key = normKey(e.ticket);
    e.cats = issueCats(e.issue);
    e.c31 = parseCount(e.t31); e.c30 = parseCount(e.t31_30);
    e.suspect = DIMS.filter(([k]) => typeof e[k] === "number" && e[k] > 0 && e[k] < SUSPECT_MM).map(([, n]) => n);
    const t = T(e.key, e.ticket); t.eids.push(e.eid);
    const rk = e.key + "|" + (e.elev || "");
    let r = D.recs.get(rk); if (!r) { r = { key: e.key, elev: e.elev || "", eids: [], t }; D.recs.set(rk, r); t.recs.push(r); }
    r.eids.push(e.eid);
  }
  for (const t of D.tickets.values()) {
    const els = t.eids.map(id => D.els[id]);
    t.issues = new Set(els.map(e => e.issue).filter(v => typeof v === "string" && v.trim()));
    t.stlNeeded = els.some(needsStl);
    t.mixedIssue = new Set(els.map(e => e.issue == null ? "" : e.issue)).size > 1;
  }
  D.recList = [...D.recs.values()].sort((a, b) => byNum(a.key, b.key) || byNum(a.elev, b.elev));
  for (const r of D.recList) {
    const e0 = D.els[r.eids[0]];
    r.search = [r.key, r.t.name, r.elev, ...new Set(r.eids.flatMap(id => { const e = D.els[id]; return [e.phase, e.workset, e.finish, e.detail, e.issue, ...e.cats.map(catLabel),
      e.c31.s === "ok" ? `T31=${e.c31.n}` : "", e.c30.s === "ok" ? `T31-30=${e.c30.n} T31(30MM)=${e.c30.n}` : "", ...DIMS.map(([k]) => e[k] != null ? String(Math.round(e[k])) : "")]; }))].join(" ").toUpperCase();
    r.issueTxt = summarize(r.eids.map(id => D.els[id].issue).filter(v => typeof v === "string" && v.trim()));
    void e0;
  }
  const stones = m.elements.filter(e => e.kind === "stone");
  D.stones = stones;
  D.elevs = [...new Set(stones.map(e => e.elev || ""))].sort(byNum);
  D.phases = [...new Set(stones.map(e => e.phase).filter(Boolean))].sort(byNum);
  D.finishes = [...new Set(stones.map(e => e.finish).filter(Boolean))].sort();
  D.issueValues = countBy(stones.filter(e => typeof e.issue === "string" && e.issue.trim()), e => e.issue);
  refreshFiles();
}
function countBy(list, fn){ const m = new Map(); for (const x of list) { const k = fn(x); m.set(k, (m.get(k) || 0) + 1); } return m; }
function summarize(vals){ const u = [...new Set(vals)]; return u.length === 0 ? "" : u.length === 1 ? u[0] : `${u.length} different`; }
function refreshFiles(){
  for (const t of D.tickets.values()) {
    for (const kind of ["pdf", "stl"]) {
      const f = D.idx[kind].files[t.key], loc = D.local[kind].get(t.key);
      t[kind] = loc ? { local: true, name: loc.name, time: loc.time, bytes: loc.bytes } : f ? { ...f } : null;
    }
  }
  fileCache.clear();
}

/* ---------------------------------------------------------------- filters (element level) */
function elInScope(e, ignore){
  if (e.kind !== "stone") return false;
  if (ignore !== "elev" && S.elev && e.elev !== S.elev) return false;
  if (ignore !== "phase" && S.phase && e.phase !== S.phase) return false;
  if (S.finish && e.finish !== S.finish) return false;
  if (S.issue) {
    const has = typeof e.issue === "string" && e.issue.trim();
    if (S.issue === "any" ? !has : S.issue === "none" ? has : S.issue.startsWith("cat:") ? !e.cats.includes(S.issue.slice(4)) : S.issue.startsWith("raw:") ? e.issue !== S.issue.slice(4) : false) return false;
  }
  if (S.t31) {
    const [p, v] = S.t31.split(":");
    const c = p === "t31" ? e.c31 : p === "t30" ? e.c30 : null;
    if (p === "either") { if (e.c31.s !== "ok" && e.c30.s !== "ok") return false; }
    else if (p === "none") { if (e.c31.s === "ok" || e.c30.s === "ok") return false; }
    else if (p === "invalid") { if (e.c31.s !== "invalid" && e.c30.s !== "invalid" && e.c31.s !== "empty" && e.c30.s !== "empty") return false; }
    else if (c) { if (c.s !== "ok" || (v !== undefined && c.n !== Number(v))) return false; }
  }
  if (S.files) {
    const t = D.tickets.get(e.key);
    if (S.files === "nopdf" && t.pdf) return false;
    if (S.files === "stl" && !t.stl) return false;
    if (S.files === "stl-missing" && !(t.stlNeeded && !t.stl)) return false;
    if (S.files === "stl-extra" && !(t.stl && !t.stlNeeded)) return false;
  }
  if (S.flag) {
    if (S.flag === "pos" && !e.posFix) return false;
    if (S.flag === "away" && !e.away) return false;
    if (S.flag === "dims" && !e.suspect.length) return false;
    if (S.flag === "mixed" && !D.tickets.get(e.key).mixedIssue) return false;
  }
  return true;
}
const scoped = () => D.stones.filter(e => elInScope(e));
const recInScope = r => r.eids.some(id => elInScope(D.els[id]));
const matchesQuery = r => !S.q || S.q.toUpperCase().split(/\s+/).filter(Boolean).every(t => r.search.includes(t));
const anyFilter = () => !!(S.elev || S.phase || S.finish || S.issue || S.t31 || S.files || S.flag);
function setFilter(patch, page){
  Object.assign(S, patch); S.listLimit = 400;
  for (const [id, k] of [["#fPhase", "phase"], ["#fIssue", "issue"], ["#fT31", "t31"], ["#fFiles", "files"], ["#fFinish", "finish"], ["#fFlag", "flag"]]) {
    const sel = $(id); if (!sel) continue;
    if (S[k] && ![...sel.options].some(o => o.value === S[k])) sel.append(h("option", { value: S[k], text: optionText(k, S[k]) }));
    sel.value = S[k];
  }
  if (page) setPage(page);
  renderAll(); applyView();
  if (V && patch.elev !== undefined) { if (S.elev) V.fitTo(stoneEids(x => x.elev === S.elev && !x.away), true, "outside"); }
}
function optionText(k, v){
  if (k === "issue" && v.startsWith("raw:")) return "Issue Status: " + v.slice(4);
  if (k === "t31") { const [p, n] = v.split(":"); return `${p === "t30" ? P_T30 : P_T31} = ${n}`; }
  return v;
}

/* ---------------------------------------------------------------- UI wiring */
function initUI(){
  const fill = (sel, list, label) => { sel.replaceChildren(sel.options[0]); for (const v of list) sel.append(h("option", { value: v, text: label ? label(v) : v })); };
  fill($("#fPhase"), D.phases); fill($("#fFinish"), D.finishes);
  const iss = $("#fIssue"); iss.replaceChildren(h("option", { value: "", text: "All" }), h("option", { value: "any", text: "Any Issue Status" }), h("option", { value: "none", text: "No Issue Status" }),
    h("optgroup", { label: "Group" }, [...ISSUE_CATS.map(c => c.id), "other"].map(id => h("option", { value: "cat:" + id, text: catLabel(id) }))),
    h("optgroup", { label: "Exact IFC value" }, [...D.issueValues.keys()].sort().map(v => h("option", { value: "raw:" + v, text: v }))));
  const bind = (id, k) => { $(id).onchange = e => setFilter({ [k]: e.target.value }); };
  bind("#fPhase", "phase"); bind("#fFinish", "finish"); bind("#fIssue", "issue"); bind("#fT31", "t31"); bind("#fFiles", "files"); bind("#fFlag", "flag");
  $("#btnClear").onclick = () => setFilter({ elev: "", phase: "", issue: "", t31: "", files: "", finish: "", flag: "" });
  $("#tabRec").onclick = () => setLeftTab("rec"); $("#tabDq").onclick = () => setLeftTab("dq");
  $("#tabProps").onclick = () => setRightTab("props"); $("#tabFab").onclick = () => setRightTab("fab");
  $("#navOverview").onclick = () => setPage("overview"); $("#navModel").onclick = () => setPage("model");
  $("#btnHelp").onclick = () => { renderHelp(); $("#helpDlg").showModal(); };
  $("#helpClose").onclick = () => $("#helpDlg").close();
  $("#btnImport").onclick = () => openImport("ifc");
  $("#impClose").onclick = () => $("#impDlg").close();
  for (const b of document.querySelectorAll("[data-imp]")) b.onclick = () => openImport(b.dataset.imp);
  $("#fullClose").onclick = () => $("#fullDlg").close();
  $("#fullDlg").addEventListener("close", () => fullView && fullView.clear());
  $("#stlClose").onclick = () => $("#stlDlg").close();
  $("#stlDlg").addEventListener("close", () => { if (stlView) { stlView.dispose(); stlView = null; } });
  $("#recMore").addEventListener("click", e => { if (e.target.closest("button")) { S.listLimit += 1000; renderList(); } });
  initSearch(); initImport();
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !document.querySelector("dialog[open]") && document.activeElement !== $("#q") && S.sel) clearSel(); });
  window.addEventListener("resize", () => { if (S.page === "overview") renderOverview(); });
}
function setPage(p){
  S.page = p;
  document.body.dataset.page = p;
  for (const [id, k] of [["#navOverview", "overview"], ["#navModel", "model"]]) { $(id).classList.toggle("act", p === k); $(id).setAttribute("aria-current", p === k ? "page" : "false"); }
  $("#overview").hidden = p !== "overview"; $("#workspace").hidden = p !== "model";
  if (p === "overview") renderOverview();
  if (p === "model" && V) { V.dirty = true; if (V.needFit && $("#gl").clientWidth) { V.needFit = false; V.fitTo(V.allStones, false, "home"); } }
}
function setLeftTab(t){ S.tab = t; for (const [id, k] of [["#tabRec", "rec"], ["#tabDq", "dq"]]) { $(id).classList.toggle("act", t === k); $(id).setAttribute("aria-selected", t === k); } $("#recWrap").hidden = t !== "rec"; $("#dqWrap").hidden = t !== "dq"; }
function setRightTab(t){ S.rtab = t; for (const [id, k] of [["#tabProps", "props"], ["#tabFab", "fab"]]) { $(id).classList.toggle("act", t === k); $(id).setAttribute("aria-selected", t === k); } $("#props").hidden = t !== "props"; $("#fab").hidden = t !== "fab"; if (t === "fab") renderFab(); }
function renderAll(){ renderKpis(); renderElevs(); renderList(); renderDq(); renderProps(); if (S.rtab === "fab") renderFab(); if (S.page === "overview") renderOverview(); renderSourceBadge(); }
function renderSourceBadge(){
  const b = $("#srcBadge"); if (!b) return;
  if (D.source && D.source.kind === "imported") { b.hidden = false; b.textContent = `Imported model (this session): ${D.source.name}`; }
  else b.hidden = true;
}

/* ---------------------------------------------------------------- metrics (shared by KPI strip and Overview) */
function metrics(els){
  const tk = new Set(els.map(e => e.key)), tickets = [...tk].map(k => D.tickets.get(k));
  const ok31 = els.filter(e => e.c31.s === "ok"), ok30 = els.filter(e => e.c30.s === "ok");
  const stlNeeded = tickets.filter(t => t.stlNeeded);
  return {
    elements: els.length, tickets: tk.size,
    withIssue: els.filter(e => typeof e.issue === "string" && e.issue.trim()).length,
    t31Stones: ok31.length, t31Holes: ok31.reduce((a, e) => a + e.c31.n, 0),
    t30Stones: ok30.length, t30Holes: ok30.reduce((a, e) => a + e.c30.n, 0),
    invalidCounts: els.filter(e => e.c31.s === "invalid" || e.c30.s === "invalid" || e.c31.s === "empty" || e.c30.s === "empty").length,
    pdfTickets: tickets.filter(t => t.pdf).length, noPdf: tickets.filter(t => !t.pdf),
    stlTickets: tickets.filter(t => t.stl).length, stlNeeded: stlNeeded.length, stlNeededFound: stlNeeded.filter(t => t.stl).length,
    stlMissing: stlNeeded.filter(t => !t.stl), stlExtra: tickets.filter(t => t.stl && !t.stlNeeded),
  };
}
const KPI_DEF = [
  { id: "elements", icon: "i-cube", label: "IFC elements", rule: "IfcBuildingElementProxy elements carrying a TICKET NUMBER property (one per physical stone) in the current filters. 3D ticket tags and model text are not counted." },
  { id: "tickets", icon: "i-tag", label: "Unique tickets", rule: "Distinct TICKET NUMBER values in the current filters. One ticket can cover many stones." },
  { id: "withIssue", icon: "i-flag", label: "With Issue Status", filter: { issue: "any" }, rule: "IFC elements whose 'Issue Status' property is present and not empty." },
  { id: "t31", icon: "i-drill", label: "T-31-Count, total holes", short: "T-31-Count holes", filter: { t31: "t31" }, rule: "Sum of the IFC 'T-31-Count' values (holes per stone) over the stones that have a whole-number value. The number of those stones is shown below. Missing values are not counted as zero." },
  { id: "t30", icon: "i-drill", label: "T-31(30mm.)-Count, total holes", short: "T-31(30mm.)-Count holes", filter: { t31: "t30" }, rule: "Sum of the IFC 'T-31(30mm.)-Count' values (holes per stone) over the stones that have a whole-number value. Counted separately from T-31-Count." },
  { id: "pdf", icon: "i-file", label: "Tickets with Fab Sheet", filter: { files: "nopdf" }, rule: "Tickets in the current filters that have fab-sheets/<TICKET>.pdf. Click to list tickets without one." },
  { id: "stl", icon: "i-box", label: "STL files for STL tickets", short: "STL files (STL status)", filter: { files: "stl-missing" }, rule: "Tickets whose IFC Issue Status asks for an STL file (project rule) that have stl/<TICKET>.stl, out of all such tickets. Click to list the missing ones." },
];
function kpiValues(mt){
  return {
    elements: [fmt(mt.elements)], tickets: [fmt(mt.tickets)], withIssue: [fmt(mt.withIssue)],
    t31: [fmt(mt.t31Holes), `/ ${fmt(mt.t31Stones)} stones`], t30: [fmt(mt.t30Holes), `/ ${fmt(mt.t30Stones)} stones`],
    pdf: [`${fmt(mt.pdfTickets)} / ${fmt(mt.tickets)}`], stl: [`${fmt(mt.stlNeededFound)} / ${fmt(mt.stlNeeded)}`],
  };
}
function renderKpis(){
  const mt = metrics(scoped()), vals = kpiValues(mt), box = $("#kpis"); box.replaceChildren();
  for (const k of KPI_DEF) {
    let cls = "kpi";
    if (k.id === "pdf") cls += mt.pdfTickets === mt.tickets ? " ok" : " warn";
    if (k.id === "stl") cls += mt.stlNeededFound === mt.stlNeeded ? " ok" : " warn";
    const fkey = k.filter && Object.keys(k.filter)[0];
    if (fkey && S[fkey] === k.filter[fkey]) cls += " act";
    const [v, sub] = vals[k.id];
    const el = h(k.filter ? "button" : "div", { class: cls, title: k.rule, type: k.filter ? "button" : null },
      h("span", { class: "ic" }, icon(k.icon)), h("span", { class: "tx" }, h("span", { class: "v" }, v, sub ? h("small", { text: " " + sub }) : null), h("span", { class: "l", text: k.short || k.label })));
    if (k.filter) el.onclick = () => setFilter(S[fkey] === k.filter[fkey] ? { [fkey]: "" } : { ...k.filter });
    box.append(el);
  }
  const parts = [S.elev ? `Elevation ${S.elev}` : "All elevations", S.phase ? `phase ${S.phase}` : "all phases"];
  for (const [k, sel] of [["issue", "#fIssue"], ["t31", "#fT31"], ["files", "#fFiles"], ["finish", "#fFinish"], ["flag", "#fFlag"]]) if (S[k]) parts.push($(sel).selectedOptions[0] ? $(sel).selectedOptions[0].text.toLowerCase() : S[k]);
  const all = metrics(D.stones);
  $("#scope").replaceChildren(...[
    h("span", null, "Summary for ", h("b", { text: parts.join(", ") })),
    anyFilter() ? h("button", { class: "linkbtn", type: "button", onclick: () => $("#btnClear").click() }, "Clear filters") : null,
    S.q ? h("span", { text: `· search “${S.q}” filters the record list only` }) : null,
    h("span", { style: "margin-left:auto" }, `Whole IFC model: ${fmt(all.elements)} elements · ${fmt(all.tickets)} tickets`),
    h("button", { class: "linkbtn", type: "button", onclick: () => { renderHelp(); $("#helpDlg").showModal(); } }, "Counting rules")].filter(Boolean));
}

/* ---------------------------------------------------------------- elevations */
function renderElevs(){
  const els = D.stones.filter(e => elInScope(e, "elev")), byE = countBy(els, e => e.elev || "");
  const max = Math.max(1, ...byE.values());
  const body = $("#elevBody"); body.replaceChildren();
  body.append(h("tr", { class: S.elev ? null : "act", onclick: () => setFilter({ elev: "" }) }, h("td", { text: "All elevations" }), h("td", { text: fmt(els.length) })));
  for (const e of D.elevs) {
    const n = byE.get(e) || 0;
    body.append(h("tr", { class: (S.elev === e ? "act" : "") + (n ? "" : " zero"), tabindex: 0, onclick: () => setFilter({ elev: S.elev === e ? "" : e }), onkeydown: ev => { if (ev.key === "Enter") setFilter({ elev: S.elev === e ? "" : e }); } },
      h("td", null, e || "(no elevation)", h("span", { class: "bar" }, h("u", { style: `width:${(n / max * 100).toFixed(1)}%` }))), h("td", { text: fmt(n) })));
  }
}
function stoneEids(fn){ return D.stones.filter(fn).map(x => x.eid); }

/* ---------------------------------------------------------------- records & data quality */
function recBadges(r){
  const els = r.eids.map(id => D.els[id]), cats = [...new Set(els.flatMap(e => e.cats))];
  return cats.map(c => h("span", { class: "tagc " + (ISSUE_CATS.find(k => k.id === c) || { cls: "c-other" }).cls, title: r.issueTxt, text: c === "t31_30" ? "T-31·30" : c === "t31" ? "T-31" : c === "stl" ? "STL" : c === "pin" ? "PIN" : "Other" }));
}
function t31Cell(r){
  const v = [...new Set(r.eids.map(id => { const e = D.els[id]; return [e.c31.s === "ok" ? e.c31.n : null, e.c30.s === "ok" ? e.c30.n + "·30" : null].filter(x => x != null).join(" ") || ""; }))].filter(Boolean);
  return v.length === 0 ? "–" : v.length === 1 ? v[0] : "mixed";
}
function renderList(){
  const rows = D.recList.filter(r => recInScope(r) && matchesQuery(r)), shown = rows.slice(0, S.listLimit);
  const frag = document.createDocumentFragment();
  for (const r of shown) {
    const act = S.sel && S.sel.key === r.key && S.sel.elev === r.elev && S.sel.origin === "record";
    const t = r.t, n = r.eids.filter(id => elInScope(D.els[id])).length;
    frag.append(h("tr", { class: act ? "act" : null, tabindex: 0, onclick: () => selectRecord(r.key, r.elev), onkeydown: e => { if (e.key === "Enter") selectRecord(r.key, r.elev); } },
      h("td", { class: "tk", text: t.name }), h("td", { text: r.elev }),
      h("td", { class: "n", text: n === r.eids.length ? fmt(n) : `${fmt(n)}/${fmt(r.eids.length)}`, title: "IFC elements" }),
      h("td", { class: "iss" }, recBadges(r)), h("td", { class: "n", text: t31Cell(r), title: `${P_T31} / ${P_T30} (·30)` }),
      h("td", { class: "files" }, fileDot(t.pdf, "PDF", false), fileDot(t.stl, "STL", t.stlNeeded))));
  }
  $("#recBody").replaceChildren(frag);
  $("#recMore").replaceChildren(rows.length > shown.length ? h("button", { class: "btn", type: "button", text: `Show ${fmt(Math.min(1000, rows.length - shown.length))} more of ${fmt(rows.length - shown.length)}` })
    : document.createTextNode(rows.length ? `${fmt(rows.length)} records (ticket × elevation)` : "No records match. Clear the search or the filters."));
  $("#nRec").textContent = fmt(rows.length);
}
function fileDot(f, label, needed){
  if (f) return h("span", { class: "fd ok", title: `${label} found${f.local ? " (this browser)" : ""}`, text: label });
  if (needed) return h("span", { class: "fd bad", title: `${label} expected (Issue Status) but not found`, text: label });
  return label === "PDF" ? h("span", { class: "fd bad", title: "No Fab Sheet PDF", text: label }) : h("span", { class: "fd none", title: "No STL (not required by Issue Status)", text: "" });
}
function renderDq(){
  const els = scoped(), tks = [...new Set(els.map(e => e.key))].map(k => D.tickets.get(k)), mt = metrics(els);
  const recOf = e => D.recs.get(e.key + "|" + (e.elev || ""));
  const sections = [
    ["Missing Fab Sheet", "No fab-sheets/<TICKET>.pdf for these tickets.", mt.noPdf.map(t => ({ t })), x => [x.t.name, "no PDF"]],
    ["STL file expected but missing", "The IFC Issue Status mentions an STL file (project rule: such stones are cut from <TICKET>.stl), but the STL library has no file.", mt.stlMissing.map(t => ({ t })), x => [x.t.name, [...x.t.issues].join(" / ").slice(0, 60)]],
    ["STL file without STL Issue Status", "An STL file exists, but no element of the ticket has an Issue Status that mentions STL. Check whether the Issue Status or the file is wrong.", mt.stlExtra.map(t => ({ t })), x => [x.t.name, x.t.issues.size ? [...x.t.issues].join(" / ").slice(0, 60) : "no Issue Status"]],
    ["Ticket with different Issue Status values", "Elements with the same ticket carry different Issue Status values in the IFC.", tks.filter(t => t.mixedIssue).map(t => ({ t })), x => [x.t.name, `${x.t.issues.size} values · ${x.t.eids.filter(id => !D.els[id].issue).length} elements without`]],
    ["Invalid or empty T-31 values", `${P_T31} or ${P_T30} is present but not a whole number. These are not counted.`, els.filter(e => ["invalid", "empty"].includes(e.c31.s) || ["invalid", "empty"].includes(e.c30.s)).map(e => ({ t: D.tickets.get(e.key), e })), x => [`${x.t.name}  ${x.e.elev}`, `${P_T31}: ${countText(x.e.c31)} · ${P_T30}: ${countText(x.e.c30)}`]],
    ["T-31 count without a T-31 Issue Status", "The element has a T-31 count, but its Issue Status does not mention T-31. Both values come from the IFC; check which one is intended.", els.filter(e => (e.c31.s === "ok" || e.c30.s === "ok") && !e.cats.some(c => c === "t31" || c === "t31_30")).map(e => ({ t: D.tickets.get(e.key), e })), x => [`${x.t.name}  ${x.e.elev}`, `${x.e.issue || "no Issue Status"}`.slice(0, 50)]],
    ["Suspect dimension values", `IFC Length/Width/Height/Thickness below ${SUSPECT_MM} mm (for example 0.008: a value converted from feet twice in the export).`, els.filter(e => e.suspect.length).map(e => ({ t: D.tickets.get(e.key), e })), x => [`${x.t.name}  ${x.e.elev}`, x.e.suspect.map(n => `${n} ${+x.e[DIMS.find(d => d[1] === n)[0]].toFixed(4)}`).join(", ")]],
    ["Placement repaired", "The IFC export wrote these stones' position inconsistently: either the ObjectPlacement is already inside the B-rep coordinates and was written again (drawn with it applied once), or the B-rep height has the placement height subtracted (height added back). Each repair is checked against the neighbouring stones.", els.filter(e => e.posFix).map(e => ({ t: D.tickets.get(e.key), e })), x => [`${x.t.name}  ${x.e.elev}`, `${/subtracted/.test(x.e.posFix.rule) ? "height added" : "applied once"} · moved ${x.e.posFix.moved_m} m · Revit ID ${x.e.revitId}`]],
    ["Isolated stones", "More than 3 m from any other stone. No placement rule explains their position, so they are drawn where the IFC puts them. Check them in Revit and in the IFC export.", els.filter(e => e.away).map(e => ({ t: D.tickets.get(e.key), e })), x => [`${x.t.name}  ${x.e.elev}`, `Revit ID ${x.e.revitId}`]],
  ];
  const wrap = $("#dqWrap"); wrap.replaceChildren();
  let total = 0;
  for (const [title, desc, list, fn] of sections) {
    total += list.length;
    wrap.append(h("h3", null, title, h("small", { text: fmt(list.length) })), h("p", { text: desc }));
    const ul = h("ul");
    for (const x of list.slice(0, 300)) { const [a, b] = fn(x); ul.append(h("li", null, h("button", { type: "button", onclick: () => x.e ? selectElements([x.e.eid], "list") : selectTicket(x.t.key) }, h("span", { text: a }), h("span", { text: b })))); }
    if (!list.length) ul.append(h("li", null, h("p", { text: "None in this scope." })));
    if (list.length > 300) ul.append(h("li", null, h("p", { text: `…and ${fmt(list.length - 300)} more. Narrow the filters to see them.` })));
    wrap.append(ul);
  }
  const notes = [];
  for (const kind of ["pdf", "stl"]) {
    const ix = D.idx[kind], name = kind === "pdf" ? "Fab Sheet PDF" : "STL";
    if (ix.missingIndex) notes.push(`data/${kind}_index.json is missing; ${name} files are looked up by name when opened.`);
    if (ix.unmatched && ix.unmatched.length) notes.push(`${ix.unmatched.length} ${name} file(s) do not match an IFC ticket: ${ix.unmatched.slice(0, 6).map(u => `${u.file} (${u.reason})`).join("; ")}`);
    if (ix.ignored && ix.ignored.length) notes.push(`${ix.ignored.length} file(s) in ${ix.base} ignored: ${ix.ignored.slice(0, 6).join(", ")}`);
  }
  const sk = D.manifest.skipped || {};
  notes.push(`Not drawn: ${Object.entries(sk).map(([k, v]) => `${fmt(v)} ${k === "tag3d" ? "3D ticket tags" : k === "IFCELEMENTASSEMBLY" ? "assemblies (no own geometry)" : k}`).join(", ") || "nothing"}.`);
  if (D.manifest.unsupported && Object.keys(D.manifest.unsupported).length) notes.push(`Unsupported IFC geometry (not drawn): ${JSON.stringify(D.manifest.unsupported)}.`);
  const p8 = D.stones.filter(e => e.workset && e.phase === "P8" && e.workset !== "P8").length;
  if (p8) notes.push(`Phase: Revit workset "P8-New" is counted as P8 (${fmt(D.stones.filter(e => e.workset === "P8").length)} P8 + ${fmt(p8)} P8-New elements). The original value is shown on each element.`);
  wrap.append(h("h3", null, "File and model notes", h("small", { text: fmt(notes.length) })));
  const ul = h("ul"); for (const n of notes) ul.append(h("li", null, h("p", { text: n }))); wrap.append(ul);
  $("#nDq").textContent = fmt(total);
}

/* ---------------------------------------------------------------- search */
function suggestions(q){
  const Q = q.trim().toUpperCase(); if (!Q) return [];
  const out = [];
  const eid = D.byGid.get(q.trim()) || D.byRevit.get(q.trim());
  if (eid) { const e = D.els[eid]; out.push({ kind: "el", eid, title: e.ticket || e.name || `#${eid}`, desc: `IFC element · GlobalId ${e.gid} · Revit ID ${e.revitId}${e.elev ? " · " + e.elev : ""}` }); }
  const K = normKey(Q), exact = D.tickets.get(K);
  if (exact) out.push({ kind: "t", key: K, title: exact.name, desc: ticketDesc(exact) });
  const pref = [], sub = [];
  for (const t of D.tickets.values()) { if (t === exact) continue; if (t.key.startsWith(K)) pref.push(t); else if (t.key.includes(K)) sub.push(t); }
  for (const t of [...pref, ...sub].slice(0, 7)) out.push({ kind: "t", key: t.key, title: t.name, desc: ticketDesc(t) });
  if (/^E?\d{4}T?$/.test(Q)) { const e = D.elevs.find(x => x.includes(Q.replace(/^E?/, "").replace(/T?$/, ""))); if (e) out.push({ kind: "f", patch: { elev: e }, title: e, desc: "Filter to this elevation" }); }
  for (const [v, n] of D.issueValues) if (Q.length >= 3 && v.toUpperCase().includes(Q)) out.push({ kind: "f", patch: { issue: "raw:" + v }, title: "Issue Status", desc: `${v} · ${fmt(n)} elements` });
  const m31 = Q.match(/^T-?31(?:\((30MM\.?)\)|-30)?\s*=\s*(\d+)$/);
  if (m31) out.push({ kind: "f", patch: { t31: (m31[1] || /-30/.test(Q) ? "t30:" : "t31:") + m31[2] }, title: Q, desc: "Filter stones with this T-31 count" });
  const n = D.recList.filter(r => matchesQuery(r)).length;
  if (n && out.length < 4) out.push({ kind: "q", title: `${fmt(n)} records`, desc: `matching “${q.trim()}” are listed on the left` });
  return out.slice(0, 10);
}
function ticketDesc(t){ return `${fmt(t.eids.length)} IFC element${t.eids.length === 1 ? "" : "s"} · ${t.recs.length} elevation${t.recs.length === 1 ? "" : "s"}${t.issues.size ? " · " + [...t.issues][0].slice(0, 28) : ""}${t.pdf ? "" : " · no Fab Sheet"}${t.stl ? " · STL" : ""}`; }
function initSearch(){
  const q = $("#q"), box = $("#sugg");
  let items = [], act = -1, timer;
  const close = () => { box.classList.remove("open"); act = -1; };
  const pick = it => {
    close();
    if (it.kind === "t") { setPage("model"); selectTicket(it.key); }
    else if (it.kind === "el") { setPage("model"); selectElements([it.eid], "search"); }
    else if (it.kind === "f") { q.value = ""; S.q = ""; setFilter(it.patch, "model"); }
    else { setPage("model"); setLeftTab("rec"); }
  };
  const draw = () => {
    box.replaceChildren(...items.map((it, i) => h("button", { type: "button", role: "option", class: i === act ? "act" : null, onmousedown: e => { e.preventDefault(); pick(it); } },
      h("span", { class: "t", text: it.title }), h("span", { class: "d", text: it.desc }))));
    box.classList.toggle("open", items.length > 0);
  };
  q.addEventListener("input", () => {
    S.q = q.value.trim(); items = suggestions(q.value); act = items.length ? 0 : -1; draw();
    clearTimeout(timer); timer = setTimeout(() => { S.listLimit = 400; renderList(); renderKpis(); }, 120);
  });
  q.addEventListener("keydown", e => {
    if (e.key === "ArrowDown") { act = Math.min(items.length - 1, act + 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { act = Math.max(0, act - 1); draw(); e.preventDefault(); }
    else if (e.key === "Enter") { if (items[act]) pick(items[act]); else { close(); setPage("model"); } }
    else if (e.key === "Escape") close();
  });
  q.addEventListener("blur", () => setTimeout(close, 120));
  q.addEventListener("focus", () => { if (q.value) { items = suggestions(q.value); draw(); } });
}

/* ---------------------------------------------------------------- selection */
function selectTicket(key, fit = true){ const t = D.tickets.get(key); if (!t) return; setSel({ eids: t.eids.slice(), key, elev: t.recs.length === 1 ? t.recs[0].elev : null, origin: "ticket" }, fit); }
function selectRecord(key, elev, fit = true){ const r = D.recs.get(key + "|" + elev); if (!r) return; setSel({ eids: r.eids.slice(), key, elev, origin: "record" }, fit); }
function selectElements(eids, origin, add = false, fit = true){
  let ids = eids.filter(id => D.els[id]);
  if (add && S.sel) { const cur = new Set(S.sel.eids); for (const id of ids) cur.has(id) ? cur.delete(id) : cur.add(id); ids = [...cur]; }
  if (!ids.length) return clearSel();
  const st = ids.map(id => D.els[id]).filter(e => e.kind === "stone");
  const keys = new Set(st.map(e => e.key)), elevs = new Set(st.map(e => e.elev));
  setSel({ eids: ids, key: keys.size === 1 && st.length === ids.length ? [...keys][0] : null, elev: elevs.size === 1 ? [...elevs][0] : null, origin }, fit && !add);
}
function clearSel(){ S.sel = null; renderList(); renderProps(); if (S.rtab === "fab") renderFab(); applyView(); }
function setSel(sel, fit){
  S.sel = sel;
  if (S.page !== "model") setPage("model");
  renderList(); renderProps(); if (S.rtab === "fab") renderFab(); applyView();
  const row = document.querySelector("#recBody tr.act"); if (row) row.scrollIntoView({ block: "nearest" });
  if (fit && V && sel.eids.length) V.fitTo(sel.eids, true, sel.eids.length === 1 ? "outside" : "keep");
}
let msgTimer;
function msg(text){ const m = $("#vmsg"); m.textContent = text; m.classList.add("show"); clearTimeout(msgTimer); msgTimer = setTimeout(() => m.classList.remove("show"), 5000); }
function toast(text){ const t = $("#toast"); t.textContent = text; t.classList.add("show"); clearTimeout(toast.tm); toast.tm = setTimeout(() => t.classList.remove("show"), 6000); }

/* ---------------------------------------------------------------- properties panel */
function qtyRow(k, sub, v, hl){ return [h("div", { class: "k" + (hl ? " hl" : "") }, h("b", { text: k }), sub ? h("span", { text: sub }) : null), h("div", { class: "v" + (hl ? " hl" : "") }, v)]; }
function projMm(e){ const o = D.manifest.origin_mm, b = e.bb; return [0, 1, 2].map(i => o[i] + (b[i] + b[i + 3]) / 2 * 1000); }
function ifcMm(p){ const M = D.manifest.coords && D.manifest.coords.siteMatrix; if (!M) return p; return [0, 1, 2].map(i => M[i][0] * p[0] + M[i][1] * p[1] + M[i][2] * p[2] + M[i][3]); }
const fmtXYZ = p => p.map(v => Math.round(v).toLocaleString("en-US")).join(", ");
function distText(els, fn){ const m = countBy(els, fn); return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => m.size > 1 ? `${v} (${fmt(n)})` : v).join(", "); }

function renderProps(){
  const box = $("#props"); box.replaceChildren();
  if (!S.sel) {
    box.append(h("div", { class: "empty" }, icon("i-cube"), h("b", { text: "Nothing selected" }),
      "Click a stone in the model, search for a ticket, or pick a record on the left. Ctrl- or Shift-click adds stones to the selection."));
    return;
  }
  const sel = S.sel, n = sel.eids.length, t = sel.key ? D.tickets.get(sel.key) : null;
  const one = n === 1 ? D.els[sel.eids[0]] : null;
  const els = sel.eids.map(id => D.els[id]).filter(e => e.kind === "stone");
  // header
  const head = h("div", { class: "sel-h" });
  if (t) {
    head.append(h("div", { class: "t" }, h("b", { text: t.name }), ...[...new Set(els.flatMap(e => e.cats))].map(c => h("span", { class: "badge " + ((ISSUE_CATS.find(k => k.id === c) || { cls: "c-other" }).cls), text: catLabel(c) }))));
    head.append(h("div", { class: "sub", text: one ? `IFC element · ${one.elev || "no elevation"} · ${one.phase || "no phase"}` : `${fmt(n)} IFC elements selected${sel.elev ? " on " + sel.elev : ""}` }));
    head.append(h("div", { class: "chips" },
      h("button", { class: "chip" + (sel.origin === "ticket" ? " act" : ""), type: "button", onclick: () => selectTicket(t.key), title: "Select every IFC element with this ticket" }, `All ${t.eids.length}`),
      t.recs.slice().sort((a, b) => byNum(a.elev, b.elev)).map(r => h("button", { class: "chip" + (sel.origin === "record" && sel.elev === r.elev ? " act" : ""), type: "button", onclick: () => selectRecord(t.key, r.elev) }, `${r.elev} · ${r.eids.length}`))));
    const tIdx = one ? t.eids.indexOf(one.eid) : -1;
    const stlBtn = t.stl ? h("button", { class: "btn", type: "button", onclick: () => openStl(t) }, icon("i-box"), "Preview STL")
      : h("button", { class: "btn", type: "button", disabled: true, title: t.stlNeeded ? "The Issue Status asks for an STL file, but none was found" : "No STL file for this ticket" }, icon("i-box"), "No STL");
    head.append(h("div", { class: "acts" },
      h("button", { class: "btn primary", type: "button", onclick: () => setRightTab("fab") }, icon("i-file"), "Preview Fab Sheet"), stlBtn,
      t.eids.length > 1 ? h("span", { class: "steps" },
        h("button", { class: "btn icon", type: "button", "aria-label": "Previous stone of this ticket", onclick: () => stepEl(-1) }, "‹"),
        h("span", { text: tIdx >= 0 ? `stone ${tIdx + 1} of ${t.eids.length}` : `${t.eids.length} stones` }),
        h("button", { class: "btn icon", type: "button", "aria-label": "Next stone of this ticket", onclick: () => stepEl(1) }, "›")) : null));
  } else {
    const keys = [...new Set(els.map(e => e.ticket))];
    head.append(h("div", { class: "t" }, h("b", { text: one ? (one.name || "Element") : `${fmt(n)} elements` })));
    head.append(h("div", { class: "sub", text: keys.length ? `${keys.length} tickets: ${keys.slice(0, 8).join(", ")}${keys.length > 8 ? "…" : ""}` : one ? "Context element (not a stone)" : "" }));
  }
  box.append(head);
  // notes
  const fixed = sel.eids.filter(id => D.els[id].posFix);
  if (fixed.length) box.append(h("div", { class: "note info" }, icon("i-alert"), h("span", { text: `${one ? "Placement repaired" : fixed.length + " of these have a repaired placement"}: ${/subtracted/.test(D.els[fixed[0]].posFix.rule) ? "the IFC export subtracted the placement height from the geometry; it is added back here" : "the IFC export applied the ObjectPlacement twice; it is applied once here"} (otherwise ${D.els[fixed[0]].posFix.moved_m} m away).` })));
  const away = sel.eids.filter(id => D.els[id].away);
  if (away.length) box.append(h("div", { class: "note warn" }, icon("i-alert"), h("span", { text: `${n === 1 ? "This stone is" : `${away.length} of these ${n} stones ${away.length === 1 ? "is" : "are"}`} isolated in the IFC model (more than 3 m from any other stone). Check the position in Revit.` })));
  if (t && t.stlNeeded && !t.stl) box.append(h("div", { class: "note bad" }, icon("i-alert"), h("span", { text: `The Issue Status asks for an STL file, but stl/${t.key}.stl was not found.` })));
  if (t && t.mixedIssue) box.append(h("div", { class: "note warn" }, icon("i-alert"), h("span", { text: `Elements of ${t.name} carry different Issue Status values in the IFC.` })));
  if (!els.length && !one) return;
  // manufacturing parameters (IFC only)
  if (els.length) {
    const mf = h("div", { class: "mfg" });
    const issueVals = els.map(e => typeof e.issue === "string" && e.issue.trim() ? e.issue : e.issue === undefined ? "∅" : "(empty)");
    const issueTxt = one ? (typeof one.issue === "string" && one.issue.trim() ? one.issue : one.issue === undefined ? "No Issue Status in the IFC for this element" : "Issue Status is empty") : distText(issueVals, v => v === "∅" ? "no Issue Status" : v);
    mf.append(h("div", { class: "row big" }, h("span", { class: "k" }, P_ISSUE, h("small", { text: "IFC · Text" })), h("span", { class: "v", text: issueTxt })));
    for (const [pname, key] of [[P_T31, "c31"], [P_T30, "c30"]]) {
      let val;
      if (one) { const c = one[key]; val = c.s === "ok" ? h("b", { class: "num", text: `${c.n}` }, h("small", { text: c.n === 1 ? " hole per stone" : " holes per stone" })) : h("span", { class: c.s === "invalid" ? "bad" : "muted", text: countText(c) }); }
      else {
        const ok = els.filter(e => e[key].s === "ok");
        val = ok.length ? h("span", null, h("b", { class: "num", text: fmt(ok.reduce((a, e) => a + e[key].n, 0)) }), h("small", { text: ` holes on ${fmt(ok.length)} of ${fmt(els.length)} stones · per stone: ${distText(ok, e => e[key].n)}` })) : h("span", { class: "muted", text: "not set on these stones" });
      }
      mf.append(h("div", { class: "row" }, h("span", { class: "k" }, pname, h("small", { text: "IFC · Text" })), h("span", { class: "v" }, val)));
    }
    if (t) mf.append(h("div", { class: "row" }, h("span", { class: "k" }, "Files", h("small", { text: "linked by ticket number" })), h("span", { class: "v" },
      h("span", { class: "fd " + (t.pdf ? "ok" : "bad"), text: "PDF" }), " ", t.pdf ? (t.pdf.local ? "imported in this browser" : t.pdf.path) : "no Fab Sheet", h("br"),
      h("span", { class: "fd " + (t.stl ? "ok" : t.stlNeeded ? "bad" : "none"), text: "STL" }), " ", t.stl ? (t.stl.local ? "imported in this browser" : `${t.stl.path} · ${(t.stl.bytes / 1e6).toFixed(1)} MB`) : t.stlNeeded ? "expected but missing" : "not required by the Issue Status")));
    box.append(h("div", { class: "sect" }, h("h3", null, "Manufacturing", h("small", { text: "values exactly as in the IFC" })), mf));
  }
  // quantities
  const q = h("div", { class: "qty" });
  q.append(...qtyRow("Selected IFC elements", "selected / highlighted", `${fmt(n)} / ${fmt(n)}`, true));
  if (t) {
    q.append(...qtyRow(`Ticket ${t.name}`, "IFC elements with this ticket, all elevations", fmt(t.eids.length)));
    if (sel.elev) { const r = D.recs.get(t.key + "|" + sel.elev); if (r) q.append(...qtyRow(`${t.name} on ${sel.elev}`, "IFC elements", fmt(r.eids.length))); }
  } else if (n > 1) q.append(...qtyRow("Unique tickets in selection", null, fmt(new Set(els.map(e => e.key)).size)));
  const ev = sel.elev || (one && one.elev);
  if (ev) q.append(...qtyRow(`Elevation ${ev} total`, "all IFC elements on this elevation", fmt(D.stones.filter(e => e.elev === ev).length)));
  q.append(...qtyRow("IFC model total", `${fmt(D.tickets.size)} unique tickets`, fmt(D.stones.length)));
  box.append(h("div", { class: "sect" }, h("h3", null, "Quantities", h("small", { text: "counted from the IFC" })), q));
  // dimensions
  if (els.length) {
    const tbl = h("table", { class: "cmp" }, h("thead", null, h("tr", null, h("th", { text: "Dimension" }), h("th", { class: "n", text: one ? "IFC value (mm)" : "IFC values (mm, stones)" }))));
    const tb = h("tbody");
    for (const [k, name, prop] of DIMS) {
      const vals = els.map(e => e[k] == null ? "–" : String(+(+e[k]).toFixed(3)));
      const sus = els.some(e => e.suspect.includes(name));
      tb.append(h("tr", { class: sus ? "conf" : null, title: sus ? "Below 1 mm: probably converted from feet twice in the IFC export" : null }, h("td", { text: `${name} (Dimensions.${prop})` }), h("td", { class: "n", text: one ? vals[0] : distText(vals, v => v) })));
    }
    tbl.append(tb);
    box.append(h("div", { class: "sect" }, h("h3", null, "Dimensions", h("small", { text: "IFC 'Dimensions' property set" })), tbl));
  }
  // element
  if (one) {
    const kv = h("table", { class: "kv" });
    const row = (k, v, src) => { if (v == null || v === "") return; kv.append(h("tr", null, h("th", { text: k }), h("td", null, String(v), src ? h("span", { class: "src", text: src }) : null))); };
    row("Ticket number", one.ticket, "IFC Text.TICKET NUMBER"); row("GlobalId", one.gid); row("Revit element ID", one.revitId, "not the same as the GlobalId");
    row("IFC entity", `#${one.step} ${one.cls}`); row("Elevation", one.elev, "IFC Text.Architect");
    row("Phase", one.phase, one.workset && one.workset !== one.phase ? `Revit workset "${one.workset}" counted as ${one.phase}` : "Revit workset");
    row("Finish", one.finish); row("Detail", one.detail); row("Revision Number", one.rev); row("Release date", one.release); row("Status", one.status); row("Tolerance", one.tolerance);
    row("Assembly", one.asm || one.assembly); row("Wait to confirm model", one.confirm);
    if (one.bb) { const p = projMm(one); row("Centre, project coords", fmtXYZ(p) + " mm", "Revit internal / project north"); row("Centre, IFC coords", fmtXYZ(ifcMm(p)) + " mm", `shared coordinates (IfcSite rotated ${D.manifest.coords ? D.manifest.coords.siteRotationDeg.toFixed(2) : "?"}°)`); }
    if (one.posFix) row("Placement repair", `IFC placement ${one.posFix.ifcOffset_mm.map(Math.round).join(", ")} mm · moved ${one.posFix.moved_m} m`, "rule: " + one.posFix.rule);
    box.append(h("div", { class: "sect" }, h("h3", null, "IFC element"), kv));
    if (one.ps) {
      const det = h("details", { class: "allps" }, h("summary", null, "All IFC properties ", h("small", { text: `${Object.keys(one.ps).length} property sets` })));
      for (const [ps, props] of Object.entries(one.ps)) {
        const keys = Object.keys(props); if (!keys.length) continue;
        const tbl = h("table", { class: "kv" });
        for (const k of keys) tbl.append(h("tr", null, h("th", { text: k }), h("td", { text: props[k] === "" ? "(empty)" : String(props[k]) })));
        det.append(h("h4", { text: ps }), tbl);
      }
      box.append(h("div", { class: "sect" }, det));
    }
  }
}
function stepEl(d){ const t = D.tickets.get(S.sel.key); if (!t || !t.eids.length) return; const cur = S.sel.eids.length === 1 ? t.eids.indexOf(S.sel.eids[0]) : -1; selectElements([t.eids[(cur + d + t.eids.length) % t.eids.length]], "step"); }

/* ---------------------------------------------------------------- PDF / STL lookup
   Order: 1) copy imported in this browser  2) index entry  3) <folder>/<TICKET>.<ext> by convention */
const fileCache = new Map();
async function resolveFile(kind, t, sheetPath){
  const ck = kind + "|" + t.key + "|" + (sheetPath || "");
  if (fileCache.has(ck)) return fileCache.get(ck);
  const tried = []; let res = null;
  const loc = t[kind] && t[kind].local && !sheetPath;
  if (loc) {
    const rec = await idbGet(kind, t.key);
    if (rec) res = { data: new Uint8Array(rec.data), name: rec.name, source: `Imported in this browser ${new Date(rec.time).toLocaleString()}`, sheets: [] };
    else tried.push(["browser copy", "no longer stored"]);
  }
  if (!res) {
    const ix = D.idx[kind], base = ix.base || (kind === "pdf" ? "fab-sheets/" : "stl/"), ent = ix.files[t.key], cand = [];
    if (sheetPath) cand.push(sheetPath); else if (ent) cand.push(ent.path);
    cand.push(`${t.key}.${kind}`);
    for (const p of [...new Set(cand)]) {
      const url = base + encPath(p) + (ent && ent.mtime && p === ent.path ? "?v=" + encodeURIComponent(ent.mtime) : "");
      let status;
      try { const r = await fetch(url, { method: "HEAD", cache: "no-cache" }); status = r.status; if (r.ok) { res = { url, name: p, bytes: ent && ent.bytes, source: ent && ent.imported ? `Imported ${ent.imported.replace("T", " ")}${ent.replaced ? ", replaced the earlier version" : ""}` : base + p, sheets: ent && ent.sheets || [] }; break; } }
      catch (e) { status = e.message; }
      tried.push([base + p, `HTTP ${status}`]);
    }
  }
  if (!res) res = { error: true, tried };
  fileCache.set(ck, res);
  return res;
}
function missingDiag(kind, t, tried){
  const label = kind === "pdf" ? "Fab Sheet" : "STL file";
  const raw = [...new Set(t.eids.map(id => D.els[id].ticket))].map(v => JSON.stringify(v)).join(", ");
  return h("div", { class: "msg" }, h("div", { class: "box" },
    h("b", { text: `No ${label} found for ${t.name}` }),
    h("div", null, "Ticket in IFC: ", raw || "–", " · lookup key ", h("code", { text: t.key })),
    h("ul", null, tried.map(([p, st]) => h("li", null, h("code", { text: p }), " → ", st))),
    D.idx[kind].files[t.key] ? h("p", { text: "The index lists this file but the web server did not return it: the file was probably not uploaded." }) : h("p", { text: `The ${label} index has no file for this ticket.` }),
    h("p", null, "Fix: add ", h("code", { text: `${kind === "pdf" ? "fab-sheets" : "stl"}/${t.key}.${kind}` }), " (the Import button renames files for you).")));
}

class PdfView {
  constructor(body, tools){ this.body = body; this.tools = tools; this.task = null; this.scale = 1; this.fit = true; this.gen = 0; this.url = null; this.rendered = 0; }
  clear(){ this.gen++; if (this.task) { this.task.destroy(); this.task = null; } if (this.url) { URL.revokeObjectURL(this.url); this.url = null; } this.body.replaceChildren(); this.rendered = 0; }
  async show(res){
    this.clear();
    const gen = this.gen, native = PdfView.mode === "native" && !res.data;
    this.tools.replaceChildren(...(native ? [] : [
      h("span", { class: "fs-tools" }, h("button", { class: "btn icon", type: "button", "aria-label": "Zoom out", onclick: () => this.zoom(0.8) }, "−"), this.zl = h("span", { text: "" }), h("button", { class: "btn icon", type: "button", "aria-label": "Zoom in", onclick: () => this.zoom(1.25) }, "+"), h("button", { class: "btn", type: "button", onclick: () => { this.fit = true; this.render(); } }, "Fit"))]));
    if (native) { this.body.append(h("iframe", { title: "Fab Sheet", src: res.url + "#view=FitH" })); this.rendered = 1; return; }
    const wrap = this.pj = h("div", { class: "pj" }, h("p", { style: "color:#fff", text: "Rendering drawing…" }));
    this.body.append(wrap);
    try {
      if (!PdfView.lib) { await import("../vendor/pdfjs/polyfill.mjs"); PdfView.lib = await import("../vendor/pdfjs/pdf.min.mjs"); PdfView.lib.GlobalWorkerOptions.workerSrc = new URL("vendor/pdfjs/worker.mjs", location.href).href; }
      const task = this.task = PdfView.lib.getDocument({ ...(res.data ? { data: res.data.slice() } : { url: new URL(res.url, location.href).href }), isEvalSupported: false, enableXfa: false });
      this.doc = await task.promise;
      if (gen !== this.gen) return;
      this.fit = true; await this.render();
    } catch (e) { if (gen === this.gen) wrap.replaceChildren(h("p", { style: "color:#fff", text: `The drawing could not be displayed (${e.message}). Use Open in new tab.` })); }
  }
  async render(){
    const doc = this.doc, wrap = this.pj; if (!doc || !wrap) return;
    const gen = ++this.gen, first = await doc.getPage(1), base = first.getViewport({ scale: 1 });
    if (this.fit) this.scale = Math.max(0.05, (wrap.clientWidth - 24) / base.width);
    if (this.zl) this.zl.textContent = Math.round(this.scale * 100) + "%";
    const dpr = Math.min(window.devicePixelRatio || 1, 2), out = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = i === 1 ? first : await doc.getPage(i), vp = page.getViewport({ scale: this.scale * dpr });
      const c = h("canvas", { "aria-label": `Page ${i}` }); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      c.style.width = Math.floor(vp.width / dpr) + "px"; c.style.height = Math.floor(vp.height / dpr) + "px";
      await page.render({ canvasContext: c.getContext("2d"), canvas: c, viewport: vp }).promise;
      if (gen !== this.gen) return;
      out.push(c);
    }
    wrap.replaceChildren(...out); this.rendered = out.length;
  }
  zoom(f){ this.fit = false; this.scale = Math.min(8, Math.max(0.05, this.scale * f)); this.render(); }
}
PdfView.mode = navigator.pdfViewerEnabled === true ? "native" : "pdfjs";
PdfView.lib = null;
let fabView = null, fullView = null, stlView = null;

async function renderFab(){
  const box = $("#fab");
  if (!fabView) {
    box.replaceChildren(h("div", { class: "fs-h", id: "fsHead" }), h("div", { class: "fs-body", id: "fsBody" }));
    fabView = new PdfView($("#fsBody"), h("span"));
    fullView = new PdfView($("#fullBody"), $("#fullTools"));
  }
  const head = $("#fsHead"), t = S.sel && S.sel.key ? D.tickets.get(S.sel.key) : null;
  if (!t) {
    fabView.clear(); head.replaceChildren(h("span", { class: "name", text: "Fab Sheet" }));
    $("#fsBody").replaceChildren(h("div", { class: "msg" }, h("div", { class: "box" }, h("b", { text: S.sel ? "Several tickets are selected" : "Nothing selected" }), "Select one ticket or stone to see its fabrication drawing.")));
    return;
  }
  if (fabView.ticket === t.key && fabView.sheet === fabView.wanted && fabView.rendered) return;
  fabView.ticket = t.key;
  head.replaceChildren(h("span", { class: "name", text: t.name }), h("span", { class: "meta", text: "Looking up the Fab Sheet…" }));
  fabView.clear();
  const res = await resolveFile("pdf", t, fabView.wanted && fabView.wantedFor === t.key ? fabView.wanted : null);
  if (!S.sel || S.sel.key !== t.key) return;
  if (res.error) { head.replaceChildren(h("span", { class: "name", text: t.name }), h("span", { class: "meta", text: "No Fab Sheet" })); $("#fsBody").replaceChildren(missingDiag("pdf", t, res.tried)); return; }
  const openUrl = res.url || (fabView.url = URL.createObjectURL(new Blob([res.data], { type: "application/pdf" })));
  head.replaceChildren(...[
    h("span", { class: "name", text: res.name }), fabView.tools,
    res.sheets && res.sheets.length > 1 ? h("select", { onchange: e => { fabView.wanted = e.target.value; fabView.wantedFor = t.key; fabView.rendered = 0; renderFab(); } }, res.sheets.map(x => h("option", { value: x, text: x, selected: x === res.name }))) : null,
    h("button", { class: "btn icon", type: "button", title: "Full screen", "aria-label": "Full screen", onclick: () => { $("#fullTitle").textContent = `Fab Sheet ${t.name}`; $("#fullDlg").showModal(); fullView.show(res); } }, icon("i-expand")),
    h("a", { class: "btn icon", href: openUrl, target: "_blank", rel: "noopener", title: "Open in new tab", "aria-label": "Open in new tab" }, icon("i-ext")),
    h("button", { class: "btn", type: "button", title: "Switch between the browser's PDF viewer and the dashboard's viewer", onclick: () => { PdfView.mode = PdfView.mode === "native" ? "pdfjs" : "native"; fabView.rendered = 0; renderFab(); } }, PdfView.mode === "native" ? "Browser viewer" : "Dashboard viewer"),
    h("span", { class: "meta", text: res.source })].filter(Boolean));
  await fabView.show(res);
}

/* STL preview (separate dialog and viewer; the IFC selection and filters are kept) */
async function openStl(t){
  const dlg = $("#stlDlg"), body = $("#stlBody"), info = $("#stlInfo");
  $("#stlTitle").textContent = `STL ${t.name}`;
  info.textContent = "Looking up the STL file…";
  body.replaceChildren(h("div", { class: "msg" }, h("div", { class: "box" }, "Loading…")));
  dlg.showModal();
  window.__stl = { ticket: t.key, state: "loading" };
  const res = await resolveFile("stl", t);
  if (res.error) { info.textContent = "Not found"; body.replaceChildren(missingDiag("stl", t, res.tried)); window.__stl.state = "missing"; return; }
  try {
    let buf;
    if (res.data) buf = res.data.slice().buffer;
    else {
      const r = await fetch(res.url); if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const total = +r.headers.get("Content-Length") || res.bytes || 0, rd = r.body.getReader(), parts = []; let got = 0;
      for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; info.textContent = `Downloading ${res.name}: ${(got / 1e6).toFixed(1)}${total ? ` of ${(total / 1e6).toFixed(1)}` : ""} MB`; }
      const all = new Uint8Array(got); let p = 0; for (const x of parts) { all.set(x, p); p += x.length; } buf = all.buffer;
    }
    info.textContent = "Reading the STL…";
    const stl = parseStl(buf);
    const canvas = h("canvas", { class: "stlc", "aria-label": `3D preview of ${res.name}` });
    body.replaceChildren(canvas,
      h("div", { class: "stl-tools" },
        h("div", { class: "seg" }, ...["iso", "front", "top", "right"].map(v => h("button", { class: "btn", type: "button", onclick: () => stlView.view(v) }, v === "iso" ? "3D" : v[0].toUpperCase() + v.slice(1))),
          h("button", { class: "btn", type: "button", onclick: () => stlView.view() }, icon("i-target"), "Fit"))),
      h("div", { class: "stl-note", text: "Shown on its own: the STL is not placed or aligned with the IFC model." }));
    if (stlView) stlView.dispose();
    stlView = new StlViewer(canvas); stlView.load(stl);
    const dims = stl.size.map(v => (Math.round(v * 10) / 10).toLocaleString("en-US")).join(" × ");
    info.replaceChildren(h("b", { text: res.name }), ` · ${fmt(stl.count)} triangles · ${stl.format} STL · size ${dims} (file units, normally mm) · ${res.source}`);
    window.__stl = { ticket: t.key, state: "shown", triangles: stl.count, size: stl.size, format: stl.format, name: res.name };
  } catch (e) {
    info.textContent = "The STL could not be shown";
    body.replaceChildren(h("div", { class: "msg" }, h("div", { class: "box" }, h("b", { text: `${res.name} could not be shown` }), e.message)));
    window.__stl = { ticket: t.key, state: "error", error: e.message };
  }
}

/* ---------------------------------------------------------------- Overview page */
// one fixed colour per phase (P1..P8 -> categorical slots 1..8, validated with the dataviz palette checker)
const PHASE_COL = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const phaseColor = k => { const m = /^P(\d+)$/.exec(k); return m && +m[1] >= 1 && +m[1] <= 8 ? PHASE_COL[+m[1] - 1] : "#898781"; };
const C_BAR = "#2a78d6", C_GOOD = "#0ca30c", C_BAD = "#d03b3b", C_MUTED = "#c3c2b7";
let tipEl = null;
function tip(e, html){ if (!tipEl) { tipEl = h("div", { class: "ctip", role: "tooltip" }); document.body.append(tipEl); } if (!html) { tipEl.style.display = "none"; return; } tipEl.replaceChildren(...html); tipEl.style.display = "block"; const r = tipEl.getBoundingClientRect(); tipEl.style.left = Math.min(window.innerWidth - r.width - 8, e.clientX + 12) + "px"; tipEl.style.top = Math.max(8, e.clientY - r.height - 10) + "px"; }
const niceStep = v => { const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; };
const niceMax = v => { if (v <= 0) return 4; const st = niceStep(v / 4); return st * Math.ceil(v / st - 1e-9); };
const compact = v => v >= 10000 ? (v / 1000).toFixed(0) + "K" : v >= 1000 ? (v / 1000).toFixed(1).replace(/\.0$/, "") + "K" : String(v);
// vertical column chart; data: [{label, value, title, onClick, color}]
function columnChart(data, { height = 210, unit = "elements" } = {}){
  const W = 640, H = height, L = 40, R = 8, T = 18, B = 34, n = data.length, max = niceMax(Math.max(1, ...data.map(d => d.value)));
  const band = (W - L - R) / Math.max(1, n), bw = Math.min(24, band * 0.7);
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img" });
  const step = niceStep(Math.max(1, ...data.map(d => d.value)) / 4), nT = Math.round(max / step);
  for (let i = 0; i <= nT; i++) { const v = step * i, y = T + (H - T - B) * (1 - i / nT); svg.append(s("line", { x1: L, x2: W - R, y1: y, y2: y, class: i ? "grid" : "base" }), s("text", { x: L - 6, y: y + 3, class: "tick", "text-anchor": "end" }, compact(v))); }
  const rot = n > 14;
  data.forEach((d, i) => {
    const x = L + band * i + (band - bw) / 2, hgt = (H - T - B) * d.value / max, y = H - B - hgt;
    const g = s("g", { class: "bar" + (d.onClick ? " link" : ""), tabindex: d.onClick ? 0 : null });
    g.append(s("rect", { x: L + band * i, y: T, width: band, height: H - T - B, class: "hit" }));
    if (d.value > 0) g.append(s("path", { d: roundTop(x, y, bw, hgt, Math.min(4, hgt)), fill: d.color || C_BAR }));
    if (!rot || n <= 40) g.append(s("text", { x: x + bw / 2, y: H - B + (rot ? 8 : 14), class: "lab", "text-anchor": rot ? "end" : "middle", transform: rot ? `rotate(-55 ${x + bw / 2} ${H - B + 8})` : null }, d.label));
    if (n <= 14 && d.value > 0) g.append(s("text", { x: x + bw / 2, y: y - 4, class: "val", "text-anchor": "middle" }, fmt(d.value)));
    g.addEventListener("mousemove", e => tip(e, [h("b", { text: d.label }), h("div", { text: `${fmt(d.value)} ${unit}` }), d.title ? h("div", { class: "s", text: d.title }) : null, d.onClick ? h("div", { class: "s", text: "Click to open in the model view" }) : null].filter(Boolean)));
    g.addEventListener("mouseleave", () => tip(null));
    if (d.onClick) { g.addEventListener("click", () => { tip(null); d.onClick(); }); g.addEventListener("keydown", e => { if (e.key === "Enter") d.onClick(); }); }
    svg.append(g);
  });
  return svg;
}
// horizontal bar chart (long labels)
function barChart(data, { unit = "elements", labelW = 230 } = {}){
  const rowH = 26, W = 640, L = labelW, R = 56, n = data.length, H = n * rowH + 6, max = Math.max(1, ...data.map(d => d.value));
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img" });
  data.forEach((d, i) => {
    const y = 3 + i * rowH, bw = (W - L - R) * d.value / max, g = s("g", { class: "bar" + (d.onClick ? " link" : ""), tabindex: d.onClick ? 0 : null });
    g.append(s("rect", { x: 0, y, width: W, height: rowH, class: "hit" }));
    const lab = d.label.length > 34 ? d.label.slice(0, 33) + "…" : d.label;
    g.append(s("text", { x: L - 8, y: y + rowH / 2 + 4, class: "lab", "text-anchor": "end" }, lab));
    if (d.value > 0) g.append(s("path", { d: roundRight(L, y + (rowH - 14) / 2, Math.max(1, bw), 14, Math.min(4, bw)), fill: d.color || C_BAR }));
    g.append(s("text", { x: L + bw + 6, y: y + rowH / 2 + 4, class: "val" }, fmt(d.value)));
    g.addEventListener("mousemove", e => tip(e, [h("b", { text: d.label }), h("div", { text: `${fmt(d.value)} ${unit}` }), d.title ? h("div", { class: "s", text: d.title }) : null, d.onClick ? h("div", { class: "s", text: "Click to open in the model view" }) : null].filter(Boolean)));
    g.addEventListener("mouseleave", () => tip(null));
    if (d.onClick) { g.addEventListener("click", () => { tip(null); d.onClick(); }); g.addEventListener("keydown", e => { if (e.key === "Enter") d.onClick(); }); }
    svg.append(g);
  });
  return svg;
}
function roundTop(x, y, w, hh, r){ return `M${x},${y + hh}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hh}Z`; }
function roundRight(x, y, w, hh, r){ return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hh - r}Q${x + w},${y + hh} ${x + w - r},${y + hh}H${x}Z`; }
function meter(found, total, labelOk, labelBad, onBad){
  const pct = total ? found / total : 1;
  return h("div", { class: "meter" },
    h("div", { class: "track" }, h("i", { style: `width:${(pct * 100).toFixed(2)}%;background:${C_GOOD}` }), total - found ? h("i", { style: `width:${((1 - pct) * 100).toFixed(2)}%;background:${C_BAD}` }) : null),
    h("div", { class: "legend" },
      h("span", null, h("span", { class: "sw", style: `background:${C_GOOD}` }), icon("i-check"), `${fmt(found)} ${found === 1 ? "ticket" : "tickets"} ${labelOk}`),
      h(onBad && total - found ? "button" : "span", { class: onBad && total - found ? "linkbtn" : null, type: onBad ? "button" : null, onclick: onBad && total - found ? onBad : null }, h("span", { class: "sw", style: `background:${total - found ? C_BAD : C_MUTED}` }), icon("i-alert"), `${fmt(total - found)} ${total - found === 1 ? "ticket" : "tickets"} ${labelBad}`)));
}
function card(title, sub, ...body){ return h("section", { class: "ocard" }, h("header", null, h("h3", { text: title }), sub ? h("p", { text: sub }) : null), ...body); }
function renderOverview(){
  const box = $("#ovBody"); if (!D.stones) return;
  const els = D.stones, mt = metrics(els), go = patch => setFilter({ elev: "", phase: "", issue: "", t31: "", files: "", finish: "", flag: "", ...patch }, "model");
  const kpis = h("div", { class: "okpis" }, ...[
    ["IFC elements", fmt(mt.elements), "stones (IfcBuildingElementProxy with TICKET NUMBER)"],
    ["Unique tickets", fmt(mt.tickets), "distinct TICKET NUMBER values"],
    ["With Issue Status", fmt(mt.withIssue), `elements · ${fmt(D.issueValues.size)} distinct values`, { issue: "any" }],
    [P_T31, fmt(mt.t31Holes), `holes in total on ${fmt(mt.t31Stones)} stones`, { t31: "t31" }],
    [P_T30, fmt(mt.t30Holes), `holes in total on ${fmt(mt.t30Stones)} stones`, { t31: "t30" }],
    ["STL files", fmt(Object.keys(D.idx.stl.files).length + [...D.local.stl.keys()].filter(k => !D.idx.stl.files[k]).length), `${fmt(mt.stlTickets)} tickets have one · ${fmt(mt.stlNeededFound)} of ${fmt(mt.stlNeeded)} STL-status tickets`, { files: "stl" }],
    ["Tickets with Fab Sheet", `${fmt(mt.pdfTickets)} / ${fmt(mt.tickets)}`, "fab-sheets/<TICKET>.pdf found", { files: "nopdf" }],
    ["Missing or unmatched files", fmt(mt.noPdf.length + mt.stlMissing.length + mt.stlExtra.length + (D.idx.pdf.unmatched || []).length + (D.idx.stl.unmatched || []).length),
      `${fmt(mt.noPdf.length)} PDF missing · ${fmt(mt.stlMissing.length)} STL missing · ${fmt(mt.stlExtra.length)} STL without STL status · ${fmt((D.idx.pdf.unmatched || []).length + (D.idx.stl.unmatched || []).length)} files without ticket`, mt.stlMissing.length ? { files: "stl-missing" } : null],
  ].map(([l, v, sub, patch]) => h(patch ? "button" : "div", { class: "okpi" + (patch ? " link" : ""), type: patch ? "button" : null, onclick: patch ? () => go(patch) : null }, h("span", { class: "l", text: l }), h("span", { class: "v", text: v }), h("span", { class: "s", text: sub }))));
  const byElev = countBy(els, e => e.elev || "(none)"), byPhase = countBy(els, e => e.phase || "(none)");
  const elevChart = columnChart([...byElev.entries()].sort((a, b) => byNum(a[0], b[0])).map(([k, v]) => ({ label: k.replace(/^E/, ""), value: v, title: `Elevation ${k}`, onClick: () => go({ elev: k }) })), { height: 230 });
  const p8 = els.filter(e => e.phase === "P8" && e.workset !== "P8").length;
  const phaseChart = columnChart([...byPhase.entries()].sort((a, b) => byNum(a[0], b[0])).map(([k, v]) => ({ label: k, value: v, color: phaseColor(k), title: k === "P8" && p8 ? `includes ${fmt(p8)} elements with workset "P8-New"` : null, onClick: () => go({ phase: k }) })));
  const issueRows = [...D.issueValues.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => ({ label: v, value: n, title: v, onClick: () => go({ issue: "raw:" + v }) }));
  const noIssue = els.length - mt.withIssue;
  const t31Dist = (key, p) => { const m = countBy(els.filter(e => e[key].s === "ok"), e => e[key].n); return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => ({ label: String(k), value: v, title: `${k} hole${k === 1 ? "" : "s"} per stone · ${fmt(k * v)} holes`, onClick: () => go({ t31: `${p}:${k}` }) })); };
  const t31card = (pname, key, p, holes, stones) => card(pname, `Stones by number of holes per stone. ${fmt(holes)} holes on ${fmt(stones)} stones.`, columnChart(t31Dist(key, p), { height: 190, unit: "stones" }),
    h("p", { class: "foot", text: `${fmt(els.filter(e => e[key].s === "absent").length)} stones have no ${pname} property · ${fmt(els.filter(e => e[key].s === "invalid" || e[key].s === "empty").length)} invalid or empty` }));
  const stlTickets = [...D.tickets.values()].filter(t => t.stlNeeded);
  const params = [[P_ISSUE, e => e.issue], [P_T31, e => e.t31], [P_T30, e => e.t31_30], ["TICKET NUMBER", e => e.ticket], ["Architect (elevation)", e => e.elev], ["Workset (phase)", e => e.workset], ["FINISH", e => e.finish], ["LENGTH", e => e.L], ["WIDTH", e => e.W], ["HEIGHT", e => e.H], ["THICKNESS", e => e.T]];
  const ptab = h("table", { class: "ptab" }, h("thead", null, h("tr", null, h("th", { text: "IFC property" }), h("th", { class: "n", text: "Elements with a value" }), h("th", { class: "n", text: "Without" }))),
    h("tbody", null, params.map(([n, f]) => { const c = els.filter(e => { const v = f(e); return v !== undefined && v !== null && v !== ""; }).length; return h("tr", null, h("td", { text: n }), h("td", { class: "n", text: fmt(c) }), h("td", { class: "n", text: fmt(els.length - c) })); })));
  box.replaceChildren(
    h("div", { class: "ohead" }, h("div", null, h("h2", { text: "Project overview" }), h("p", { text: `All figures are calculated from the loaded IFC model (${D.manifest.source}) and the PDF / STL files found for its tickets.` })),
      h("button", { class: "btn primary", type: "button", onclick: () => setPage("model") }, icon("i-cube"), "Open model view")),
    kpis,
    h("div", { class: "ogrid" },
      card("Elements by elevation", "IFC 'Architect' value. Click a column to filter the model.", elevChart),
      card("Elements by phase", `Revit workset; "P8-New" is counted as P8${p8 ? ` (${fmt(p8)} elements)` : ""}.`, phaseChart),
      card("Issue Status", `IFC values exactly as written. ${fmt(noIssue)} of ${fmt(els.length)} elements have no Issue Status.`, barChart(issueRows, { labelW: 260 })),
      t31card(P_T31, "c31", "t31", mt.t31Holes, mt.t31Stones),
      t31card(P_T30, "c30", "t30", mt.t30Holes, mt.t30Stones),
      card("STL files for STL tickets", "Project rule: a ticket whose Issue Status asks for an STL file is cut from stl/<TICKET>.stl.",
        meter(mt.stlNeededFound, mt.stlNeeded, "with an STL file", "missing it", () => go({ files: "stl-missing" })),
        h("p", { class: "foot" }, `${fmt(stlTickets.length)} tickets ask for an STL. `, mt.stlMissing.length ? `Missing: ${mt.stlMissing.map(t => t.name).join(", ")}. ` : "", mt.stlExtra.length ? h("button", { class: "linkbtn", type: "button", onclick: () => go({ files: "stl-extra" }) }, `${fmt(mt.stlExtra.length)} STL files belong to tickets without an STL Issue Status (${mt.stlExtra.map(t => t.name).join(", ")}).`) : "")),
      card("Fab Sheet PDFs", "fab-sheets/<TICKET>.pdf for every ticket in the IFC.", meter(mt.pdfTickets, mt.tickets, "with a Fab Sheet", "without", () => go({ files: "nopdf" })),
        h("p", { class: "foot", text: `${fmt(Object.keys(D.idx.pdf.files).length)} indexed PDF files · ${fmt((D.idx.pdf.unmatched || []).length)} files that match no IFC ticket.` })),
      card("IFC parameter availability", "How many stones carry each property in this IFC. A missing property is reported, never filled in.", ptab)));
}

/* ---------------------------------------------------------------- help */
function renderHelp(){
  const b = $("#helpBody"); b.replaceChildren();
  const dl = h("dl");
  for (const k of KPI_DEF) dl.append(h("dt", { text: k.label }), h("dd", { text: k.rule }));
  dl.append(h("dt", { text: "Source of the data" }), h("dd", { text: `Everything is read from the IFC model (${D.manifest ? D.manifest.source : "–"}). The Excel workbook is not used by the dashboard. Fab Sheet PDFs and STL files are only linked by ticket number and never change an IFC value.` }));
  dl.append(h("dt", { text: "Issue Status" }), h("dd", { text: "Shown exactly as written in the IFC. The groups STL file / Pin & glued / T-31 / T-31 (30 mm stone) / Other are derived from the text for filtering and badges only." }));
  dl.append(h("dt", { text: "T-31 counts" }), h("dd", { text: `${P_T31} and ${P_T30} are the number of drill holes per stone, read from the IFC. Totals add whole-number values only. A stone without the property is "not in IFC", never 0; a value that is not a whole number is reported as invalid.` }));
  dl.append(h("dt", { text: "Selected IFC elements" }), h("dd", { text: "Elements currently selected and highlighted. One clicked stone gives 1 / 1; Ctrl/Shift-click adds or removes stones." }));
  dl.append(h("dt", { text: "Phase" }), h("dd", { text: "Revit workset P1–P8. 'P8-New' is counted as P8; the original value is shown on each element." }));
  dl.append(h("dt", { text: "Coordinates" }), h("dd", { text: `Shown in Revit project coordinates: the IfcSite rotation (${D.manifest && D.manifest.coords ? D.manifest.coords.siteRotationDeg.toFixed(2) : "?"}°) is removed from the whole model as one transform.` }));
  b.append(dl);
}

/* ---------------------------------------------------------------- IndexedDB (browser-only imports) */
function idb(){ return new Promise((res, rej) => { const r = indexedDB.open("facade-dashboard-files", 1); r.onupgradeneeded = () => { r.result.createObjectStore("pdf", { keyPath: "key" }); r.result.createObjectStore("stl", { keyPath: "key" }); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function idbTx(store, mode, fn){ const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction(store, mode), out = fn(tx.objectStore(store)); tx.oncomplete = () => res(out && out.result !== undefined ? out.result : out); tx.onerror = () => rej(tx.error); }); }
async function idbAll(store){ const all = await idbTx(store, "readonly", st => st.getAll()); const m = new Map(); for (const r of all || []) m.set(r.key, { name: r.name, time: r.time, bytes: r.bytes }); return m; }
const idbGet = (store, k) => idbTx(store, "readonly", st => st.get(k));
const idbPut = (store, v) => idbTx(store, "readwrite", st => st.put(v));
const idbDel = (store, k) => idbTx(store, "readwrite", st => st.delete(k));

/* ---------------------------------------------------------------- ZIP read / write */
async function unzip(file){
  const buf = new Uint8Array(await file.arrayBuffer()), dv = new DataView(buf.buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a ZIP file");
  const n = dv.getUint16(eocd + 10, true), cdOff = dv.getUint32(eocd + 16, true);
  if (cdOff === 0xffffffff) throw new Error("ZIP64 archives are not supported here; import the files directly");
  const out = []; let p = cdOff;
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("corrupt ZIP directory");
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), loff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue;
    const start = loff + 30 + dv.getUint16(loff + 26, true) + dv.getUint16(loff + 28, true);
    out.push({ name, method, data: buf.subarray(start, start + csize), encrypted: !!(flags & 1) });
  }
  return out;
}
async function inflate(en){
  if (en.encrypted) throw new Error("encrypted ZIP entry");
  if (en.method === 0) return en.data;
  if (en.method !== 8) throw new Error("unsupported compression");
  return new Uint8Array(await new Response(new Blob([en.data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
}
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(d){ let c = 0xffffffff; for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zipStore(files){ // [{name, data}] -> Blob (stored, no compression)
  const parts = [], cd = []; let off = 0;
  for (const f of files) {
    const nm = new TextEncoder().encode(f.name), crc = crc32(f.data), lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x800, true); lh.setUint32(14, crc, true); lh.setUint32(18, f.data.length, true); lh.setUint32(22, f.data.length, true); lh.setUint16(26, nm.length, true);
    parts.push(lh.buffer, nm, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true); c.setUint32(16, crc, true); c.setUint32(20, f.data.length, true); c.setUint32(24, f.data.length, true); c.setUint16(28, nm.length, true); c.setUint32(42, off, true);
    cd.push(c.buffer, nm);
    off += 30 + nm.length + f.data.length;
  }
  const cdSize = cd.reduce((a, b) => a + b.byteLength, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...cd, e.buffer], { type: "application/zip" });
}
function download(blob, name){ const a = h("a", { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); }

/* ---------------------------------------------------------------- Import: section switch + persistence notes */
const canSave = () => !!(D.server && D.server.import);
function openImport(kind){
  for (const b of document.querySelectorAll("[data-imp]")) { b.classList.toggle("act", b.dataset.imp === kind); b.setAttribute("aria-selected", b.dataset.imp === kind); }
  for (const k of ["ifc", "stl", "pdf"]) $("#imp-" + k).hidden = k !== kind;
  const where = canSave()
    ? "This dashboard runs on server.py: imported files are saved on that computer, so everyone using this server sees them. Replaced files are archived, not deleted."
    : D.server ? "This server only accepts imports from the computer it runs on. Imports here stay in this browser."
      : "This site is read-only (for example GitHub Pages). Imports are used in this browser only. To publish them for everyone, download the prepared files after importing and upload them to the repository.";
  $("#impMode").replaceChildren(icon("i-alert"), h("span", { text: where }));
  if (!$("#impDlg").open) $("#impDlg").showModal();
  if (kind !== "ifc") renderLocalList(kind);
}
function renderLocalList(kind){
  const box = $(`#imp-${kind} .local`); if (!box) return; box.replaceChildren();
  const m = D.local[kind]; if (!m || !m.size) return;
  const ul = h("ul", { class: "loclist" });
  for (const [k, v] of m) ul.append(h("li", null, h("span", { text: `${k} · ${v.name} · ${new Date(v.time).toLocaleString()}` }),
    h("button", { class: "btn", type: "button", onclick: async () => { await idbDel(kind, k); m.delete(k); refreshFiles(); renderAll(); renderLocalList(kind); } }, "Remove")));
  box.append(h("h4", { text: `Stored in this browser (${m.size})` }), ul);
}
function initImport(){
  const dz = (drop, inp, fn) => {
    inp.onchange = () => { if (inp.files.length) fn([...inp.files]); inp.value = ""; };
    drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); fn([...e.dataTransfer.files]); });
  };
  dz($("#dropIfc"), $("#fileIfc"), f => importIfc(f[0]));
  dz($("#dropStl"), $("#fileStl"), f => importLibrary("stl", f));
  dz($("#dropPdf"), $("#filePdf"), f => importLibrary("pdf", f));
}

/* ---------------------------------------------------------------- Import PDF / STL */
function parseName(kind, name){
  const ext = "." + kind;
  let stem = name.split(/[\\/]/).pop();
  if (!stem.toLowerCase().endsWith(ext)) return { error: `not a ${ext} file name` };
  stem = stem.slice(0, -ext.length);
  let sheet = 1;
  if (kind === "pdf") { const m = stem.match(/^(.*?)(?:__(\d+)|\s*\((\d+)\))$/); if (m && (m[2] || m[3])) { stem = m[1]; sheet = Number(m[2] || m[3]); } }
  const parts = stem.trim().split(/\s+-\s+/).filter(Boolean);
  let key;
  if (parts.length === 2 && normKey(parts[0]) === normKey(parts[1])) key = normKey(parts[0]);
  else if (parts.length === 1) key = normKey(parts[0]);
  else return { error: `name is not 'TICKET${ext}' or 'TICKET - TICKET${ext}'` };
  if (D.tickets.has(key)) return { key, sheet };
  const unpad = k => k.replace(/(?<=-)0+(?=\d)/g, "");
  const c = [...D.tickets.keys()].filter(k => unpad(k) === unpad(key));
  if (c.length === 1) return { key: c[0], sheet, note: `'${key}' matched to ${c[0]} (leading zeros)` };
  return { error: `ticket '${key}' is not in the loaded IFC model` };
}
const stdName = (kind, key, sheet) => sheet === 1 ? `${key}.${kind}` : `${key}__${sheet}.${kind}`;
function checkContent(kind, data){
  if (kind === "pdf") return data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46 ? null : "not a PDF file";
  try { const st = parseStl(data.slice().buffer); return st.count ? null : "STL has no triangles"; } catch (e) { return e.message; }
}
async function importLibrary(kind, files){
  const sec = $("#imp-" + kind), prog = sec.querySelector(".prog"), resBox = sec.querySelector(".res"), extra = sec.querySelector(".extra");
  const ext = "." + kind, rows = [], items = [], ready = [];
  prog.textContent = "Reading files…";
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      try {
        for (const en of await unzip(f)) {
          const base = en.name.split("/").pop();
          if (en.name.split("/").includes("..") || en.name.startsWith("/")) { rows.push([en.name, "", "rejected", "unsafe path in ZIP"]); continue; }
          if (!base.toLowerCase().endsWith(ext)) { if (!/^(thumbs\.db|\.ds_store)$/i.test(base)) rows.push([en.name, "", "rejected", `not a ${ext} file`]); continue; }
          items.push({ name: base, get: () => inflate(en) });
        }
      } catch (e) { rows.push([f.name, "", "rejected", "could not read ZIP: " + e.message]); }
    } else items.push({ name: f.name, get: async () => new Uint8Array(await f.arrayBuffer()) });
  }
  const seen = new Map(); let done = 0;
  for (const it of items) {
    done++; prog.textContent = `Importing ${done} of ${items.length}: ${it.name}`;
    const pn = parseName(kind, it.name);
    if (pn.error) { rows.push([it.name, "", "rejected", pn.error]); continue; }
    const sk = pn.key + "#" + pn.sheet;
    if (seen.has(sk)) { rows.push([it.name, pn.key, "rejected", `same ticket as ${seen.get(sk)} in this import`]); continue; }
    seen.set(sk, it.name);
    let data;
    try { data = await it.get(); } catch (e) { rows.push([it.name, pn.key, "rejected", e.message]); continue; }
    const bad = checkContent(kind, data);
    if (bad) { rows.push([it.name, pn.key, "rejected", bad]); continue; }
    const had = !!D.tickets.get(pn.key)[kind];
    try {
      if (canSave()) {
        const r = await fetch(`api/library?kind=${kind}&name=` + encodeURIComponent(it.name), { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: data });
        const j = await r.json().catch(() => ({ status: "rejected", reason: `HTTP ${r.status}` }));
        rows.push([it.name, pn.key, j.status, j.status === "rejected" ? j.reason : j.status === "replaced" ? `saved as ${j.path}; old file in ${j.archivedTo}` : j.status === "unchanged" ? "identical to the current file" : `saved as ${j.path}`]);
      } else {
        const time = Date.now();
        if (pn.sheet === 1) { await idbPut(kind, { key: pn.key, name: it.name, time, bytes: data.length, data: data.slice().buffer }); D.local[kind].set(pn.key, { name: it.name, time, bytes: data.length }); }
        ready.push({ name: stdName(kind, pn.key, pn.sheet), data });
        rows.push([it.name, pn.key, had ? "replaced" : "added", `in this browser · upload as ${kind === "pdf" ? "fab-sheets" : "stl"}/${stdName(kind, pn.key, pn.sheet)}${pn.note ? " · " + pn.note : ""}`]);
      }
    } catch (e) { rows.push([it.name, pn.key, "rejected", e.message]); }
  }
  if (canSave()) D.idx[kind] = await getJSON(`data/${kind}_index.json`).catch(() => D.idx[kind]);
  refreshFiles(); if (fabView) fabView.rendered = 0; renderAll();
  const c = st => rows.filter(r => r[2] === st).length;
  prog.textContent = `Finished: ${c("added")} added, ${c("replaced")} replaced, ${c("unchanged")} unchanged, ${c("rejected")} rejected.`;
  resBox.replaceChildren(resultTable(rows));
  extra.replaceChildren();
  if (ready.length) extra.append(h("button", { class: "btn primary", type: "button", onclick: () => download(zipStore(ready), `${kind === "pdf" ? "fab-sheets" : "stl"}-for-upload.zip`) }, icon("i-upload"), `Download for upload (${ready.length} file${ready.length === 1 ? "" : "s"}, already renamed)`));
  renderLocalList(kind);
  if (c("added") + c("replaced")) toast(`${kind === "pdf" ? "Fab Sheets" : "STL files"}: ${c("added")} added, ${c("replaced")} replaced.`);
}
function resultTable(rows){
  const tbl = h("table", null, h("thead", null, h("tr", null, h("th", { text: "File" }), h("th", { text: "Ticket" }), h("th", { text: "Result" }), h("th", { text: "Details" }))));
  const tb = h("tbody"); for (const r of rows) tb.append(h("tr", null, h("td", { text: r[0] }), h("td", { text: r[1] }), h("td", { class: "st-" + r[2], text: r[2] }), h("td", { text: r[3] })));
  tbl.append(tb); return tbl;
}

/* ---------------------------------------------------------------- Import IFC model */
let ifcJob = null;
function importIfc(file){
  const sec = $("#imp-ifc"), prog = sec.querySelector(".prog"), bar = sec.querySelector(".track i"), resBox = sec.querySelector(".res"), extra = sec.querySelector(".extra");
  if (!file) return;
  if (!/\.(ifc|zip)$/i.test(file.name)) { prog.textContent = "Choose an .ifc file or a .zip that contains one."; return; }
  if (ifcJob) ifcJob.terminate();
  resBox.replaceChildren(); extra.replaceChildren();
  sec.querySelector(".pbar").hidden = false;
  prog.textContent = `Starting conversion of ${file.name} (${(file.size / 1e6).toFixed(0)} MB). The current model stays loaded until you choose Replace.`;
  const t0 = performance.now();
  const w = ifcJob = new Worker(new URL("assets/ifc-worker.js", location.href), { type: "module" });
  window.__ifcImport = { state: "running" };
  w.onmessage = ev => {
    const m = ev.data;
    if (m.type === "progress") { prog.textContent = m.text; bar.style.width = Math.round(m.frac * 100) + "%"; return; }
    w.terminate(); ifcJob = null;
    if (m.type === "invalid" || m.type === "error") {
      sec.querySelector(".pbar").hidden = true;
      const problems = m.type === "invalid" ? m.validation.problems : [m.message];
      prog.textContent = "The file was not imported. The current model is unchanged.";
      resBox.replaceChildren(h("div", { class: "note bad" }, icon("i-alert"), h("div", null, h("b", { text: "Validation failed" }), h("ul", null, problems.map(p => h("li", { text: p }))))));
      window.__ifcImport = { state: "rejected", problems };
      return;
    }
    // done
    bar.style.width = "100%";
    const manifest = JSON.parse(new TextDecoder().decode(m.json));
    const secs = ((performance.now() - t0) / 1000).toFixed(0);
    prog.textContent = `Converted in ${secs} s. Review the summary, then replace the model.`;
    const sum = compareModels(D.manifest, manifest);
    resBox.replaceChildren(importSummary(manifest, m.validation, sum));
    extra.replaceChildren(
      h("button", { class: "btn primary", type: "button", onclick: () => { useImportedModel(file.name, manifest, m.chunks); extra.querySelector(".btn.primary").disabled = true; } }, icon("i-check"), "Replace the current model"),
      canSave() ? h("button", { class: "btn", type: "button", onclick: e => saveModelToServer(manifest, m.chunks, e.currentTarget) }, icon("i-upload"), "Save on the server for everyone")
        : h("button", { class: "btn", type: "button", onclick: () => download(zipStore([{ name: "data/elements.json", data: new TextEncoder().encode(JSON.stringify(manifest)) }, ...m.chunks.map(c => ({ name: c.file, data: c.data }))]), "model-update-for-upload.zip") }, icon("i-upload"), "Download the model update (for GitHub)"),
      h("span", { class: "hint", text: canSave() ? "" : "Replace uses the new model in this browser only. To publish it, upload the downloaded data/ and geom/ files to the repository (they replace the old ones)." }));
    window.__ifcImport = { state: "converted", seconds: +secs, summary: sum, elements: manifest.elements.length };
  };
  w.onerror = e => { prog.textContent = `The converter stopped: ${e.message || "unknown error"}. The current model is unchanged.`; window.__ifcImport = { state: "error", error: e.message }; };
  w.postMessage({ file });
}
function compareModels(a, b){
  const st = m => m.elements.filter(e => e.kind === "stone");
  const A = st(a), B = st(b), ga = new Set(A.map(e => e.gid)), gb = new Set(B.map(e => e.gid));
  const ta = countBy(A, e => normKey(e.ticket)), tb = countBy(B, e => normKey(e.ticket));
  const changed = [...new Set([...ta.keys(), ...tb.keys()])].filter(k => (ta.get(k) || 0) !== (tb.get(k) || 0)).sort(byNum);
  const byG = new Map(A.map(e => [e.gid, e]));
  const propChanged = B.filter(e => { const o = byG.get(e.gid); return o && (o.issue !== e.issue || o.t31 !== e.t31 || o.t31_30 !== e.t31_30 || o.elev !== e.elev); }).length;
  return { before: A.length, after: B.length, added: B.filter(e => !ga.has(e.gid)).length, removed: A.filter(e => !gb.has(e.gid)).length,
    ticketsBefore: ta.size, ticketsAfter: tb.size, newTickets: [...tb.keys()].filter(k => !ta.has(k)).sort(byNum), goneTickets: [...ta.keys()].filter(k => !tb.has(k)).sort(byNum),
    countChanged: changed.map(k => `${k} ${ta.get(k) || 0}→${tb.get(k) || 0}`), propChanged };
}
function importSummary(m, v, s){
  const li = (k, val) => h("tr", null, h("th", { text: k }), h("td", { text: val }));
  return h("div", null, h("h4", { text: `Import summary: ${m.source}` }), h("table", { class: "kv" },
    li("IFC schema", `${m.schema} · ${fmt(v.lines)} lines`),
    li("Stones (IFC elements)", `${fmt(s.before)} now → ${fmt(s.after)} in the new file (${fmt(s.added)} new GlobalIds, ${fmt(s.removed)} removed)`),
    li("Unique tickets", `${fmt(s.ticketsBefore)} → ${fmt(s.ticketsAfter)}${s.newTickets.length ? ` · new: ${s.newTickets.slice(0, 10).join(", ")}` : ""}${s.goneTickets.length ? ` · gone: ${s.goneTickets.slice(0, 10).join(", ")}` : ""}`),
    li("Element count changed", s.countChanged.length ? s.countChanged.slice(0, 12).join(", ") + (s.countChanged.length > 12 ? "…" : "") : "none"),
    li("Elevation / Issue Status / T-31 changed", `${fmt(s.propChanged)} elements`),
    li("Geometry", `${fmt(m.chunks.length)} files, ${fmt(m.chunks.reduce((a, c) => a + c.tris, 0))} triangles · ${fmt(m.positionFixes)} placement repairs · unsupported: ${Object.keys(m.unsupported || {}).length ? JSON.stringify(m.unsupported) : "none"}`),
    li("Elements without elevation", fmt(v.noElevation))));
}
async function useImportedModel(name, manifest, chunks){
  const map = new Map(chunks.map(c => [c.file, c.data]));
  D.source = { kind: "imported", name, chunk: async c => { const d = map.get(c.file); if (!d) throw new Error("missing " + c.file); return d.slice().buffer; } };
  S.sel = null; Object.assign(S, { elev: "", phase: "", issue: "", t31: "", files: "", finish: "", flag: "" });
  buildModel(manifest);
  initUI();
  renderAll();
  await startViewer(true);
  toast(`Model replaced in this browser: ${name}. ${fmt(D.stones.length)} stones, ${fmt(D.tickets.size)} tickets.`);
  window.__ifcImport = { ...(window.__ifcImport || {}), state: "replaced" };
}
async function saveModelToServer(manifest, chunks, btn){
  btn.disabled = true; const old = btn.textContent; btn.textContent = "Saving…";
  try {
    const b = await (await fetch("api/model/begin", { method: "POST" })).json();
    if (!b.token) throw new Error(b.reason || "the server refused the upload");
    const files = [{ path: "data/elements.json", data: new TextEncoder().encode(JSON.stringify(manifest)) }, ...chunks.map(c => ({ path: c.file, data: c.data }))];
    let i = 0;
    for (const f of files) {
      btn.textContent = `Saving ${++i} of ${files.length}…`;
      const r = await fetch(`api/model/file?token=${b.token}&path=${encodeURIComponent(f.path)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: f.data });
      const j = await r.json(); if (!j.ok) throw new Error(j.reason || `HTTP ${r.status}`);
    }
    const c = await (await fetch(`api/model/commit?token=${b.token}`, { method: "POST" })).json();
    if (!c.ok) throw new Error(c.reason || "commit failed");
    btn.textContent = "Saved for everyone";
    toast(`The new model is saved on the server. The previous model was archived in ${c.archivedTo}.`);
    window.__ifcImport = { ...(window.__ifcImport || {}), state: "saved", archivedTo: c.archivedTo };
  } catch (e) { btn.disabled = false; btn.textContent = old; toast(`Saving failed: ${e.message}. The server still has the previous model.`); }
}

/* ---------------------------------------------------------------- viewer glue */
const COL = { sand: [203, 187, 152], ctx: [178, 186, 194], sel: [29, 99, 216], selSoft: [142, 177, 242], ghost: [150, 158, 166] };
function jit(i){ let x = (i * 2654435761) >>> 0; x ^= x >>> 15; return ((x % 1000) / 1000 - 0.5) * 0.08; }
function applyView(){
  if (!V) return;
  const st = new Uint8Array(V.state.length);
  const strong = new Set(S.sel ? S.sel.eids : []);
  const soft = new Set(S.sel && S.sel.key ? D.tickets.get(S.sel.key).eids : []);
  const hasSel = strong.size > 0, sc = anyFilter();
  let ghost = false;
  for (const e of D.manifest.elements) {
    const o = e.eid * 4; let col, a = 255;
    if (e.kind === "stone") {
      const j = 1 + jit(e.eid); col = COL.sand.map(v => Math.min(255, v * j));
      const inScope = !sc || elInScope(e);
      if (strong.has(e.eid)) col = COL.sel;
      else if (soft.has(e.eid)) col = COL.selSoft;
      else if (!inScope || hasSel) {
        if (S.others === "hide") a = 0;
        else if (S.others === "ghost") { a = 128; col = COL.ghost; }
        else if (!inScope) col = col.map(v => v * 0.5 + 236 * 0.5);
      }
    } else {
      col = strong.has(e.eid) ? COL.sel : COL.ctx;
      if (!S.ctx && !strong.has(e.eid)) a = 0;
      else if ((hasSel || sc) && !strong.has(e.eid)) { if (S.others === "hide") a = 0; else if (S.others === "ghost") { a = 128; col = COL.ghost; } }
    }
    if (a === 128) ghost = true;
    st[o] = col[0]; st[o + 1] = col[1]; st[o + 2] = col[2]; st[o + 3] = a;
  }
  V.hasGhost = ghost;
  const keep = new Set([...strong, ...soft].map(id => D.els[id].elev).filter(Boolean));
  const scopeElevs = sc ? new Set(D.stones.filter(e => elInScope(e)).map(e => e.elev)) : null;
  for (const ch of V.chunks) {
    if (ch.name === "CONTEXT") ch.visible = S.ctx || [...strong].some(id => D.els[id].kind !== "stone");
    else ch.visible = !(S.others === "hide" && (sc || hasSel)) || keep.has(ch.name) || (scopeElevs && scopeElevs.has(ch.name));
  }
  V.setState(st);
}
function drawAxes(cam){
  const svg = $("#axes"), r = 22, ca = Math.cos(cam.az), sa = Math.sin(cam.az), se = Math.sin(cam.el);
  const P = v => { const right = [-sa, ca, 0], up = [-se * ca, -se * sa, Math.cos(cam.el)]; return [V3.dot(v, right) * r, -V3.dot(v, up) * r]; };
  svg.replaceChildren();
  for (const [n, v, c] of [["X", [1, 0, 0], "#BE3A2B"], ["Y", [0, 1, 0], "#1C7C54"], ["Z", [0, 0, 1], "#1D63D8"]]) {
    const [x, y] = P(v);
    svg.append(s("line", { x1: 0, y1: 0, x2: x, y2: y, stroke: c, "stroke-width": 2 }), s("text", { x: x * 1.25, y: y * 1.25 + 3, "font-size": 9, "text-anchor": "middle", fill: c, "font-weight": 700 }, n === "Y" ? "N" : n));
  }
}
let viewerBound = false;
async function startViewer(reload){
  if (!V) {
    try { V = new Viewer($("#gl"), D.manifest.elements.length, id => D.els[id] && D.els[id].bb); }
    catch (e) { fatal("The 3D viewer could not start", `${e.message}.`, "Use a current Chrome, Edge or Firefox with hardware acceleration enabled. Search, properties, Fab Sheets and STL previews still work."); perf.ready = true; return; }
    V.noRender = new URLSearchParams(location.search).has("norender"); // test hook: measure loading without drawing
  } else if (reload) V.reset(D.manifest.elements.length);
  V.allStones = stoneEids(x => !x.away);
  const bb = V.bbox(V.allStones); if (bb) V.modelCentre = V3.sc(V3.add(bb[0], bb[1]), 0.5);
  // a hidden canvas (Overview page open) has no size: fit when the Model page is first shown
  if ($("#gl").clientWidth) V.fitTo(V.allStones, false, "home"); else V.needFit = true;
  V.onCamera = drawAxes; drawAxes(V.cam);
  V.onPick = (eid, o) => {
    if (!eid) { if (S.sel && !o.add) clearSel(); return; }
    if (o.dbl) { const b = D.els[eid].bb; V.goTo({ ...V.cam, t: [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2] }, 400); return; }
    selectElements([eid], "click", o.add, false);
  };
  if (!viewerBound) {
    viewerBound = true;
    for (const b of document.querySelectorAll("[data-view]")) b.onclick = () => { const sel = S.sel && S.sel.eids.length ? S.sel.eids : V.allStones; V.fitTo(b.dataset.view === "home" && !(S.sel && S.sel.eids.length) ? V.allStones : sel, true, b.dataset.view); };
    $("#vFitSel").onclick = () => { if (S.sel && S.sel.eids.length) V.fitTo(S.sel.eids, true, "keep"); else if (S.elev) V.fitTo(stoneEids(x => x.elev === S.elev), true, "keep"); else msg("Nothing is selected."); };
    $("#vCtx").onclick = e => { S.ctx = !S.ctx; e.currentTarget.classList.toggle("on", S.ctx); e.currentTarget.setAttribute("aria-pressed", S.ctx); applyView(); };
    $("#vOrtho").onclick = e => { V.cam.ortho = !V.cam.ortho; e.currentTarget.classList.toggle("on", V.cam.ortho); e.currentTarget.setAttribute("aria-pressed", V.cam.ortho); e.currentTarget.textContent = V.cam.ortho ? "Ortho" : "Perspective"; V.dirty = true; };
    for (const b of document.querySelectorAll("[data-others]")) b.onclick = () => { S.others = b.dataset.others; for (const x of document.querySelectorAll("[data-others]")) x.classList.toggle("on", x === b); applyView(); };
  }
  applyView();
  const only = (new URLSearchParams(location.search).get("elev") || "").toUpperCase().split(",").filter(Boolean);
  const chunks = D.manifest.chunks.filter(c => !only.length || only.includes(c.name)).sort((a, b) => (a.name === "CONTEXT") - (b.name === "CONTEXT"));
  if (only.length) msg(`Only ${only.join(", ")} loaded (from the page address). Remove ?elev=… to load the whole model.`);
  const total = chunks.reduce((a, c) => a + c.bytes, 0), failed = [], t0 = performance.now();
  let got = 0;
  perf.ready = false;
  for (const [i, ch] of chunks.entries()) {
    loading(`Loading IFC geometry · ${ch.name} (${i + 1} of ${chunks.length}) · ${Math.round(got / 1e6)} of ${Math.round(total / 1e6)} MB`, got / total);
    try { V.addChunk(ch.name, await D.source.chunk(ch)); }
    catch (e) { failed.push(`${ch.name}: ${e.message}`); }
    got += ch.bytes; applyView();
  }
  perf.geomMs = performance.now() - t0;
  if (failed.length) loading(`Some geometry could not be loaded: ${failed.join("; ")}. Check that the geom/ folder was uploaded completely.`, 1);
  else $("#loading").hidden = true;
  $("#vinfo").textContent = `${fmt(Math.round(V.tris))} triangles · ${V.chunks.length}/${D.manifest.chunks.length} files`;
  perf.ready = true;
}

boot();

/* IFC -> dashboard model converter (JavaScript port of tools/*.py).

   Used by the "Import IFC Model" button (inside a Web Worker) and by
   tools/ifc-convert.mjs (Node) for testing. It reads the IFC as a stream, so
   files larger than 1 GB are processed without loading the whole text.

   Output, identical in schema to tools/export_geom.py:
     manifest  -> data/elements.json  (elements, chunks, coords, ...)
     chunks    -> geom/<ELEVATION>.bin ('FBG1' format, see export_geom.py)

   Supported IFC geometry (the subset Revit uses for this model): IfcFacetedBrep,
   IfcFaceBasedSurfaceModel, IfcExtrudedAreaSolid (rectangle, circle, arbitrary
   closed and with voids; polyline / composite curve / trimmed circle), IfcMappedItem,
   IfcLocalPlacement chains. Anything else is counted under "unsupported". */

const DEG = Math.PI / 180, CIRCLE_SEG = 24;

/* ------------------------------------------------------------------ STEP values */
// Ref -> {$: id}; Enum -> {e: "T"}; typed value -> {t: "IFCTEXT", a: [...]}; $ -> null; * -> DER
export const DER = { der: true };
const isRef = v => v !== null && typeof v === "object" && v.$ !== undefined;
const isTyped = v => v !== null && typeof v === "object" && v.t !== undefined;
function pval(v){ if (isTyped(v)) return v.a.length ? unwrap(v.a[0]) : null; return unwrap(v); }
function unwrap(v){ if (v !== null && typeof v === "object" && v.e !== undefined) return v.e; return v; }

function decodeStr(s){
  if (s.indexOf("\\") < 0) return s;
  s = s.replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, (m, h) => { let o = ""; for (let i = 0; i < h.length; i += 4) o += String.fromCharCode(parseInt(h.substr(i, 4), 16)); return o; });
  s = s.replace(/\\X\\([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/\\S\\(.)/g, (m, c) => String.fromCharCode(c.charCodeAt(0) + 128));
  return s.replace(/\\\\/g, "\\");
}

// parse a parenthesised list starting at s[i] === "("; returns [list, nextIndex]
function parseArgs(s, i){
  i++;
  const out = [], n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === ")") return [out, i + 1];
    if (c === "," || c === " ") { i++; continue; }
    if (c === "(") { const [v, j] = parseArgs(s, i); out.push(v); i = j; }
    else if (c === "'") {
      let j = i + 1, buf = "";
      for (;;) {
        const k = s.indexOf("'", j);
        if (k < 0) throw new Error("unterminated string");
        buf += s.slice(j, k);
        if (s[k + 1] === "'") { buf += "'"; j = k + 2; } else { i = k + 1; break; }
      }
      out.push(decodeStr(buf));
    } else if (c === "#") {
      let j = i + 1; while (j < n && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
      out.push({ $: +s.slice(i + 1, j) }); i = j;
    } else if (c === "$") { out.push(null); i++; }
    else if (c === "*") { out.push(DER); i++; }
    else if (c === ".") { const j = s.indexOf(".", i + 1); out.push({ e: s.slice(i + 1, j) }); i = j + 1; }
    else if (/[A-Za-z]/.test(c)) {
      let j = i; while (s[j] !== "(") j++;
      const name = s.slice(i, j); const [v, k] = parseArgs(s, j); out.push({ t: name, a: v }); i = k;
    } else {
      let j = i; while (j < n && s[j] !== "," && s[j] !== ")") j++;
      out.push(Number(s.slice(i, j))); i = j;
    }
  }
  throw new Error("unterminated list");
}

/* ------------------------------------------------------------------ growable typed arrays */
class Grow {
  constructor(T, cap){ this.T = T; this.a = new T(cap); this.n = 0; }
  push(v){ if (this.n === this.a.length) this.grow(); this.a[this.n++] = v; }
  grow(min){ const b = new this.T(Math.max(this.a.length * 2, min || 0)); b.set(this.a); this.a = b; }
  get view(){ return this.a.subarray(0, this.n); }
}

const T_PT = 1, T_LOOP = 2, T_BOUND = 3, T_FACE = 4, T_SHELL = 5;
const KEEP = new Set([
  // semantic (tools/ifc_pass1.py)
  "IFCPROJECT", "IFCSITE", "IFCBUILDING", "IFCBUILDINGSTOREY", "IFCBUILDINGELEMENTPROXY", "IFCELEMENTASSEMBLY", "IFCWINDOW", "IFCSLAB",
  "IFCBUILDINGELEMENTPROXYTYPE", "IFCTYPEPRODUCT", "IFCWINDOWSTYLE", "IFCSLABTYPE", "IFCPROPERTYSET", "IFCPROPERTYSINGLEVALUE",
  "IFCRELDEFINESBYPROPERTIES", "IFCRELDEFINESBYTYPE", "IFCRELAGGREGATES", "IFCRELCONTAINEDINSPATIALSTRUCTURE", "IFCGROUP",
  "IFCRELASSIGNSTOGROUP", "IFCPRESENTATIONLAYERASSIGNMENT", "IFCSIUNIT", "IFCUNITASSIGNMENT", "IFCCONVERSIONBASEDUNIT",
  "IFCPRODUCTDEFINITIONSHAPE", "IFCSHAPEREPRESENTATION",
  // geometry (tools/geom_load.py GENERIC)
  "IFCDIRECTION", "IFCAXIS2PLACEMENT3D", "IFCAXIS2PLACEMENT2D", "IFCLOCALPLACEMENT", "IFCFACETEDBREP", "IFCFACEBASEDSURFACEMODEL",
  "IFCEXTRUDEDAREASOLID", "IFCRECTANGLEPROFILEDEF", "IFCARBITRARYCLOSEDPROFILEDEF", "IFCARBITRARYPROFILEDEFWITHVOIDS",
  "IFCCIRCLEPROFILEDEF", "IFCPOLYLINE", "IFCCOMPOSITECURVE", "IFCCOMPOSITECURVESEGMENT", "IFCTRIMMEDCURVE", "IFCCIRCLE",
  "IFCMAPPEDITEM", "IFCREPRESENTATIONMAP", "IFCCARTESIANTRANSFORMATIONOPERATOR3D",
  "IFCGEOMETRICREPRESENTATIONCONTEXT", "IFCGEOMETRICREPRESENTATIONSUBCONTEXT",
]);

/* ------------------------------------------------------------------ pass: stream -> store */
export class IfcStore {
  constructor(){
    this.tcode = new Uint8Array(1 << 25); this.tidx = new Int32Array(1 << 25);
    this.pts = new Grow(Float64Array, 1 << 22);
    this.loopIds = new Grow(Int32Array, 1 << 24); this.loopOff = new Grow(Int32Array, 1 << 22); this.loopOff.push(0);
    this.bndLoop = new Grow(Int32Array, 1 << 22); this.bndFlag = new Grow(Uint8Array, 1 << 22);
    this.faceIds = new Grow(Int32Array, 1 << 22); this.faceOff = new Grow(Int32Array, 1 << 22); this.faceOff.push(0);
    this.shellIds = new Grow(Int32Array, 1 << 20); this.shellOff = new Grow(Int32Array, 1 << 14); this.shellOff.push(0);
    this.G = new Map();
    this.header = ""; this.schema = null; this.lines = 0; this.inData = false;
  }
  ensureId(id){
    if (id >= this.tcode.length) {
      let cap = this.tcode.length; while (cap <= id) cap *= 2;
      const a = new Uint8Array(cap); a.set(this.tcode); this.tcode = a;
      const b = new Int32Array(cap); b.set(this.tidx); this.tidx = b;
    }
  }
  refs(line, from, out){ // push every #id after index `from`
    const n = line.length;
    for (let i = from; i < n; i++) {
      if (line.charCodeAt(i) === 35) { let v = 0, j = i + 1, c; while (j < n && (c = line.charCodeAt(j)) >= 48 && c <= 57) { v = v * 10 + (c - 48); j++; } out.push(v); i = j - 1; }
    }
  }
  line(L){
    this.lines++;
    if (L.charCodeAt(0) !== 35) {
      if (!this.inData) { this.header += L + "\n"; if (L.startsWith("DATA;")) this.inData = true; const m = L.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i); if (m) this.schema = m[1].toUpperCase(); }
      return;
    }
    const eq = L.indexOf("="), p = L.indexOf("(", eq);
    if (eq < 0 || p < 0) return;
    const id = +L.slice(1, eq), t = L.slice(eq + 1, p).trim();
    this.ensureId(id);
    switch (t) {
      case "IFCPOLYLOOP": this.tcode[id] = T_LOOP; this.tidx[id] = this.loopOff.n - 1; this.refs(L, p, this.loopIds); this.loopOff.push(this.loopIds.n); return;
      case "IFCFACE": this.tcode[id] = T_FACE; this.tidx[id] = this.faceOff.n - 1; this.refs(L, p, this.faceIds); this.faceOff.push(this.faceIds.n); return;
      case "IFCFACEOUTERBOUND": case "IFCFACEBOUND": {
        this.tcode[id] = T_BOUND; this.tidx[id] = this.bndLoop.n;
        const h = L.indexOf("#", p); let v = 0, j = h + 1, c; while ((c = L.charCodeAt(j)) >= 48 && c <= 57) { v = v * 10 + (c - 48); j++; }
        this.bndLoop.push(v); this.bndFlag.push((L.indexOf(".F.", j) >= 0 ? 0 : 1) | (t === "IFCFACEOUTERBOUND" ? 2 : 0)); return;
      }
      case "IFCCARTESIANPOINT": {
        this.tcode[id] = T_PT; this.tidx[id] = this.pts.n / 3;
        const a = L.indexOf("(", p + 1), b = L.indexOf(")", a);
        const v = L.slice(a + 1, b).split(",");
        this.pts.push(+v[0]); this.pts.push(+v[1]); this.pts.push(v.length > 2 ? +v[2] : 0); return;
      }
      case "IFCCLOSEDSHELL": case "IFCCONNECTEDFACESET": case "IFCOPENSHELL":
        this.tcode[id] = T_SHELL; this.tidx[id] = this.shellOff.n - 1; this.refs(L, p, this.shellIds); this.shellOff.push(this.shellIds.n); return;
      default:
        if (KEEP.has(t)) { const [args] = parseArgs(L, p); this.G.set(id, [t, args]); }
    }
  }
  async read(chunks, onProgress){
    const dec = new TextDecoder("utf-8");
    let rest = "", pend = "", bytes = 0, lastP = 0;
    const feed = L => {
      if (pend) { pend += L; if (!/;\s*$/.test(pend)) return; L = pend; pend = ""; }
      else if (L.charCodeAt(0) === 35 && !/;\s*$/.test(L)) { pend = L; return; }
      this.line(L.replace(/\r$/, ""));
    };
    for await (const chunk of chunks) {
      bytes += chunk.byteLength;
      const s = rest + dec.decode(chunk, { stream: true });
      const parts = s.split("\n"); rest = parts.pop();
      for (const L of parts) if (L) feed(L);
      if (onProgress && bytes - lastP > 8e6) { lastP = bytes; onProgress(bytes); }
    }
    rest += dec.decode();
    if (rest) feed(rest);
    if (pend) this.line(pend);
    if (onProgress) onProgress(bytes);
    this.bytes = bytes;
    this.pts.a = this.pts.view; this.loopIds.a = this.loopIds.view; this.loopOff.a = this.loopOff.view;
  }
}

/* ------------------------------------------------------------------ properties (tools/ifc_props.py) */
const PRODUCTS = new Set(["IFCBUILDINGELEMENTPROXY", "IFCELEMENTASSEMBLY", "IFCWINDOW", "IFCSLAB"]);
export function resolveProducts(st){
  const G = st.G;
  const psetProps = id => { const [, a] = G.get(id); const props = {}; for (const r of a[4]) { const e = G.get(r.$); if (e && e[0] === "IFCPROPERTYSINGLEVALUE") props[e[1][0]] = pval(e[1][2]); } return [a[2], props]; };
  const inst = new Map(), typeof_ = new Map(), typeps = new Map(), parent = new Map();
  for (const [id, [t, a]] of G) {
    if (t === "IFCRELDEFINESBYPROPERTIES") {
      const ps = G.get(a[5] && a[5].$); if (!ps || ps[0] !== "IFCPROPERTYSET") continue;
      const [n, p] = psetProps(a[5].$);
      for (const o of a[4]) { let m = inst.get(o.$); if (!m) inst.set(o.$, m = {}); m[n] = p; }
    } else if (t === "IFCRELDEFINESBYTYPE") { for (const o of a[4]) typeof_.set(o.$, a[5].$); }
    else if (t === "IFCRELAGGREGATES") { for (const o of a[5]) parent.set(o.$, a[4].$); }
  }
  for (const [id, [t, a]] of G) {
    if ((t.endsWith("TYPE") && !t.startsWith("IFCREL")) || t === "IFCTYPEPRODUCT" || t === "IFCWINDOWSTYLE") typeps.set(id, a[2]);
  }
  const products = new Map();
  for (const [id, [t, a]] of G) {
    if (!PRODUCTS.has(t)) continue;
    const tid = typeof_.get(id);
    products.set(id, { id, cls: t, gid: a[0], name: a[2], placement: a[5] ? a[5].$ : null, rep: a[6] ? a[6].$ : null, tag: a[7],
      inst: inst.get(id) || {}, type_name: tid !== undefined ? typeps.get(tid) : null, parent: parent.has(id) ? parent.get(id) : null });
  }
  return products;
}

/* ------------------------------------------------------------------ small linear algebra (row-major 4x4 / 3x3) */
const eye4 = () => { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
function mul4(A, B){ const C = new Float64Array(16); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { let s = 0; for (let k = 0; k < 4; k++) s += A[r * 4 + k] * B[k * 4 + c]; C[r * 4 + c] = s; } return C; }
function inv4(M){
  const a = Array.from(M), b = Array.from(eye4());
  for (let c = 0; c < 4; c++) {
    let p = c; for (let r = c + 1; r < 4; r++) if (Math.abs(a[r * 4 + c]) > Math.abs(a[p * 4 + c])) p = r;
    for (let k = 0; k < 4; k++) { [a[c * 4 + k], a[p * 4 + k]] = [a[p * 4 + k], a[c * 4 + k]]; [b[c * 4 + k], b[p * 4 + k]] = [b[p * 4 + k], b[c * 4 + k]]; }
    const d = a[c * 4 + c];
    for (let k = 0; k < 4; k++) { a[c * 4 + k] /= d; b[c * 4 + k] /= d; }
    for (let r = 0; r < 4; r++) if (r !== c) { const f = a[r * 4 + c]; for (let k = 0; k < 4; k++) { a[r * 4 + k] -= f * a[c * 4 + k]; b[r * 4 + k] -= f * b[c * 4 + k]; } }
  }
  return Float64Array.from(b);
}
function applyM(M, V){ // V: Float64Array xyz...
  const o = new Float64Array(V.length);
  for (let i = 0; i < V.length; i += 3) { const x = V[i], y = V[i + 1], z = V[i + 2];
    o[i] = M[0] * x + M[1] * y + M[2] * z + M[3]; o[i + 1] = M[4] * x + M[5] * y + M[6] * z + M[7]; o[i + 2] = M[8] * x + M[9] * y + M[10] * z + M[11]; }
  return o;
}
const isEye = M => { const I = eye4(); for (let i = 0; i < 16; i++) if (Math.abs(M[i] - I[i]) > 1e-8 + 1e-5 * Math.abs(I[i])) return false; return true; };
const norm3 = v => Math.hypot(v[0], v[1], v[2]);
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function mul3(A, B){ const C = new Float64Array(9); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) { let s = 0; for (let k = 0; k < 3; k++) s += A[r * 3 + k] * B[k * 3 + c]; C[r * 3 + c] = s; } return C; }
function inv3(m){
  const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  return Float64Array.from([A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det]);
}
const ap3 = (M, x, y) => [M[0] * x + M[1] * y + M[2], M[3] * x + M[4] * y + M[5]];

/* ------------------------------------------------------------------ geometry (tools/geom_build.py) */
export class Geo {
  constructor(st){ this.st = st; this.G = st.G; this.pl = new Map(); this.unsupported = {}; }
  uns(t){ this.unsupported[t] = (this.unsupported[t] || 0) + 1; }
  pt(r){ const i = this.st.tidx[r] * 3, p = this.st.pts.a; return [p[i], p[i + 1], p[i + 2]]; }
  dirv(r, def){ if (r == null) return def.slice(); const v = this.G.get(r.$ !== undefined ? r.$ : r)[1][0]; return [v[0] || 0, v[1] || 0, v.length > 2 ? v[2] : 0]; }
  a2p3(r){
    const a = this.G.get(r)[1], o = this.pt(a[0].$);
    let z = this.dirv(a[1], [0, 0, 1]); const zl = norm3(z); z = z.map(v => v / zl);
    let x = this.dirv(a.length > 2 ? a[2] : null, [1, 0, 0]);
    let dt = x[0] * z[0] + x[1] * z[1] + x[2] * z[2]; x = [x[0] - dt * z[0], x[1] - dt * z[1], x[2] - dt * z[2]];
    let nx = norm3(x);
    if (nx < 1e-9) { x = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; dt = x[0] * z[0] + x[1] * z[1] + x[2] * z[2]; x = [x[0] - dt * z[0], x[1] - dt * z[1], x[2] - dt * z[2]]; nx = norm3(x); }
    x = x.map(v => v / nx);
    const y = cross3(z, x), M = eye4();
    for (let r = 0; r < 3; r++) { M[r * 4] = x[r]; M[r * 4 + 1] = y[r]; M[r * 4 + 2] = z[r]; M[r * 4 + 3] = o[r]; }
    return M;
  }
  a2p2(r){
    const a = this.G.get(r)[1], o = this.pt(a[0].$);
    let x = this.dirv(a[1], [1, 0, 0]); const l = Math.hypot(x[0], x[1]); x = [x[0] / l, x[1] / l];
    return Float64Array.from([x[0], -x[1], o[0], x[1], x[0], o[1], 0, 0, 1]);
  }
  placement(r){
    if (r == null) return eye4();
    if (this.pl.has(r)) return this.pl.get(r);
    const a = this.G.get(r)[1];
    const rel = a[0] ? this.placement(a[0].$) : eye4();
    const M = mul4(rel, this.a2p3(a[1].$));
    this.pl.set(r, M); return M;
  }
  cto3(r){
    const a = this.G.get(r)[1];
    const sc = typeof a[3] === "number" ? a[3] : 1;
    let x = this.dirv(a[0], [1, 0, 0]); const xl = norm3(x); x = x.map(v => v / xl);
    const zz = this.dirv(a.length > 4 ? a[4] : null, [0, 0, 1]);
    let y = this.dirv(a[1], cross3(zz, x));
    const d = y[0] * x[0] + y[1] * x[1] + y[2] * x[2]; y = [y[0] - d * x[0], y[1] - d * x[1], y[2] - d * x[2]]; const yl = norm3(y); y = y.map(v => v / yl);
    const z = cross3(x, y), o = this.pt(a[2].$), M = eye4();
    for (let k = 0; k < 3; k++) { M[k * 4] = x[k] * sc; M[k * 4 + 1] = y[k] * sc; M[k * 4 + 2] = z[k] * sc; M[k * 4 + 3] = o[k]; }
    return M;
  }
  curve2d(r){
    const [t, a] = this.G.get(r);
    if (t === "IFCPOLYLINE") return a[0].map(p => { const q = this.pt(p.$); return [q[0], q[1]]; });
    if (t === "IFCCOMPOSITECURVE") {
      let out = [];
      for (const s of a[0]) {
        const sa = this.G.get(s.$)[1];
        let c = this.curve2d(sa[2].$);
        if (unwrap(sa[1]) === "F") c = c.reverse();
        if (out.length && c.length && Math.hypot(out[out.length - 1][0] - c[0][0], out[out.length - 1][1] - c[0][1]) < 1e-6) c = c.slice(1);
        out = out.concat(c);
      }
      return out;
    }
    if (t === "IFCTRIMMEDCURVE") {
      const [bt, ba] = this.G.get(a[0].$);
      if (bt !== "IFCCIRCLE") { this.uns(bt); return []; }
      const M = this.a2p2(ba[0].$), R = ba[1];
      const ang = trim => {
        for (const v of trim) if (isTyped(v) && v.t === "IFCPARAMETERVALUE") return v.a[0] * DEG;
        for (const v of trim) if (isRef(v)) { const p = this.pt(v.$), Mi = inv3(M); const lx = Mi[0] * p[0] + Mi[1] * p[1] + Mi[2], ly = Mi[3] * p[0] + Mi[4] * p[1] + Mi[5]; return Math.atan2(ly, lx); }
        return 0;
      };
      let a1 = ang(a[1]), a2 = ang(a[2]);
      const sense = unwrap(a[3]) !== "F";
      if (sense) { while (a2 <= a1) a2 += 2 * Math.PI; } else { while (a2 >= a1) a2 -= 2 * Math.PI; }
      const n = Math.max(2, Math.ceil(Math.abs(a2 - a1) / (2 * Math.PI) * CIRCLE_SEG) + 1), out = [];
      for (let k = 0; k < n; k++) { const th = a1 + (a2 - a1) * k / (n - 1); out.push(ap3(M, R * Math.cos(th), R * Math.sin(th))); }
      return out;
    }
    if (t === "IFCCIRCLE") { const M = this.a2p2(a[0].$), R = a[1], out = []; for (let k = 0; k < CIRCLE_SEG; k++) out.push(ap3(M, R * Math.cos(2 * Math.PI * k / CIRCLE_SEG), R * Math.sin(2 * Math.PI * k / CIRCLE_SEG))); return out; }
    this.uns(t); return [];
  }
  profile(r){
    const [t, a] = this.G.get(r);
    if (t === "IFCRECTANGLEPROFILEDEF") {
      const M = a[2] ? this.a2p2(a[2].$) : Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]), hx = a[3] / 2, hy = a[4] / 2;
      return [[[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].map(([x, y]) => ap3(M, x, y))];
    }
    if (t === "IFCCIRCLEPROFILEDEF") {
      const M = a[2] ? this.a2p2(a[2].$) : Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]), R = a[3], out = [];
      for (let k = 0; k < CIRCLE_SEG; k++) out.push(ap3(M, R * Math.cos(2 * Math.PI * k / CIRCLE_SEG), R * Math.sin(2 * Math.PI * k / CIRCLE_SEG)));
      return [out];
    }
    if (t === "IFCARBITRARYCLOSEDPROFILEDEF") return [this.curve2d(a[2].$)];
    if (t === "IFCARBITRARYPROFILEDEFWITHVOIDS") return [this.curve2d(a[2].$), ...a[3].map(c => this.curve2d(c.$))];
    this.uns(t); return [];
  }
  extrusion(a){
    let loops = this.profile(a[0].$).map(cleanLoop).filter(l => l.length >= 3);
    if (!loops.length) return null;
    const P = a[1] ? this.a2p3(a[1].$) : eye4();
    let d = this.dirv(a[2], [0, 0, 1]); const dl = norm3(d); d = d.map(v => v / dl * a[3]);
    loops = loops.map((l, i) => (area2(l) > 0) === (i === 0) ? l : l.slice().reverse());
    const [tris, flat] = triangulateWithHoles(loops);
    const n = flat.length, V = new Float64Array(n * 6), F = [];
    for (let i = 0; i < n; i++) { V[i * 3] = flat[i][0]; V[i * 3 + 1] = flat[i][1]; V[i * 3 + 2] = 0; V[(n + i) * 3] = flat[i][0] + d[0]; V[(n + i) * 3 + 1] = flat[i][1] + d[1]; V[(n + i) * 3 + 2] = d[2]; }
    for (const [i, j, k] of tris) { F.push(i, k, j); F.push(i + n, j + n, k + n); }
    let base = 0;
    for (const l of loops) { const m = l.length; for (let q = 0; q < m; q++) { const i0 = base + q, i1 = base + (q + 1) % m; F.push(i0, i1, i1 + n); F.push(i0, i1 + n, i0 + n); } base += m; }
    if (d[2] < 0) for (let i = 0; i < F.length; i += 3) { const t = F[i + 1]; F[i + 1] = F[i + 2]; F[i + 2] = t; }
    return [applyM(P, V), F];
  }
  shellFaces(shellRef, Vmap, Vlist, F){
    const st = this.st, s = st.tidx[shellRef];
    const sIds = st.shellIds.a, sOff = st.shellOff.a, fIds = st.faceIds.a, fOff = st.faceOff.a, bL = st.bndLoop.a, bF = st.bndFlag.a, lIds = st.loopIds.a, lOff = st.loopOff.a;
    for (let q = sOff[s]; q < sOff[s + 1]; q++) {
      const fi = st.tidx[sIds[q]], loops = [];
      for (let w = fOff[fi]; w < fOff[fi + 1]; w++) {
        const bi = st.tidx[fIds[w]], li = st.tidx[bL[bi]];
        let ids = Array.from(lIds.subarray(lOff[li], lOff[li + 1]));
        if (!(bF[bi] & 1)) ids.reverse();
        if (bF[bi] & 2) loops.unshift(ids); else loops.push(ids);
      }
      const local = [];
      for (const ids of loops) {
        const ll = [];
        for (const pid of ids) {
          let k = Vmap.get(pid);
          if (k === undefined) { k = Vlist.length; Vmap.set(pid, k); Vlist.push(pid); }
          if (!ll.length || ll[ll.length - 1] !== k) ll.push(k);
        }
        if (ll.length > 1 && ll[0] === ll[ll.length - 1]) ll.pop();
        if (ll.length >= 3) local.push(ll);
      }
      if (!local.length) continue;
      if (local.length === 1 && local[0].length === 3) { F.push(local[0][0], local[0][1], local[0][2]); continue; }
      const P3 = local.map(ll => ll.map(k => this.pt(Vlist[k])));
      for (const t of triangulate3d(P3, local)) F.push(t[0], t[1], t[2]);
    }
  }
  item(r){
    const [t, a] = this.G.get(r);
    if (t === "IFCEXTRUDEDAREASOLID") return [this.extrusion(a)];
    if (t === "IFCFACETEDBREP" || t === "IFCFACEBASEDSURFACEMODEL") {
      const shells = t === "IFCFACETEDBREP" ? [a[0]] : a[0], Vmap = new Map(), Vlist = [], F = [];
      for (const s of shells) this.shellFaces(s.$, Vmap, Vlist, F);
      if (!F.length) return [null];
      const V = new Float64Array(Vlist.length * 3);
      Vlist.forEach((pid, i) => { const p = this.pt(pid); V[i * 3] = p[0]; V[i * 3 + 1] = p[1]; V[i * 3 + 2] = p[2]; });
      return [[V, F]];
    }
    if (t === "IFCMAPPEDITEM") {
      const ma = this.G.get(a[0].$)[1];
      const O = this.G.get(ma[0].$)[0] === "IFCAXIS2PLACEMENT3D" ? this.a2p3(ma[0].$) : eye4();
      const M = mul4(this.cto3(a[1].$), O), out = [];
      for (const it of this.G.get(ma[1].$)[1][3]) for (const m of this.item(it.$)) if (m) out.push([applyM(M, m[0]), m[1]]);
      return out;
    }
    this.uns(t); return [null];
  }
  productMesh(placement, rep){
    if (rep == null) return null;
    const M = this.placement(placement);
    const Vs = [], Fs = []; let off = 0, nv = 0;
    for (const sr of this.G.get(rep)[1][2]) {
      const sa = this.G.get(sr.$)[1];
      if (sa[1] !== "Body") continue;
      for (const it of sa[3]) for (const m of this.item(it.$)) { if (!m) continue; Vs.push(m[0]); Fs.push(m[1].map(x => x + off)); off += m[0].length / 3; nv += m[0].length; }
    }
    if (!Vs.length) return null;
    const V = new Float64Array(nv); let p = 0; for (const v of Vs) { V.set(v, p); p += v.length; }
    return [applyM(M, V), new Uint32Array(Fs.flat())];
  }
}

/* polygon helpers */
function area2(l){ let s = 0; for (let i = 0; i < l.length; i++) { const [x1, y1] = l[i], [x2, y2] = l[(i + 1) % l.length]; s += x1 * y2 - x2 * y1; } return s; }
function cleanLoop(l){
  const out = [];
  for (const p of l) if (!out.length || Math.abs(out[out.length - 1][0] - p[0]) + Math.abs(out[out.length - 1][1] - p[1]) > 1e-6) out.push(p);
  if (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) + Math.abs(out[0][1] - out[out.length - 1][1]) < 1e-6) out.pop();
  return out;
}
const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
function earClip(poly){
  const n = poly.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];
  const idx = [...Array(n).keys()], tris = [];
  let guard = 0;
  while (idx.length > 3 && guard < 5 * n * n) {
    const m = idx.length; let found = false;
    for (let k = 0; k < m; k++) {
      const i0 = idx[(k - 1 + m) % m], i1 = idx[k], i2 = idx[(k + 1) % m], a = poly[i0], b = poly[i1], c = poly[i2];
      if (cr(a, b, c) <= 1e-12) continue;
      let ok = true;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        const p = poly[j];
        if ((p[0] === a[0] && p[1] === a[1]) || (p[0] === b[0] && p[1] === b[1]) || (p[0] === c[0] && p[1] === c[1])) continue;
        if (cr(a, b, p) >= 0 && cr(b, c, p) >= 0 && cr(c, a, p) >= 0) { ok = false; break; }
      }
      if (ok) { tris.push([i0, i1, i2]); idx.splice(k, 1); found = true; break; }
      guard++;
    }
    if (!found) { for (let k = 1; k < idx.length - 1; k++) tris.push([idx[0], idx[k], idx[k + 1]]); return tris; }
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}
function bridgeHoles(loops){
  const flat = [], idxloops = [];
  for (const l of loops) { idxloops.push(l.map((_, i) => flat.length + i)); flat.push(...l); }
  let outer = idxloops[0];
  const maxx = h => Math.max(...h.map(i => flat[i][0]));
  const holes = idxloops.slice(1).map((h, i) => [h, i]).sort((A, B) => (maxx(B[0]) - maxx(A[0])) || (A[1] - B[1])).map(x => x[0]); // stable, like Python sorted
  for (const h of holes) {
    let hi = h[0]; for (const i of h) if (flat[i][0] > flat[hi][0]) hi = i;
    const hp = flat[hi];
    let best = null, bd = null;
    for (const oi of outer) { const op = flat[oi]; if (op[0] < hp[0] - 1e-9) continue; const d = (op[0] - hp[0]) ** 2 + (op[1] - hp[1]) ** 2; if (bd === null || d < bd) { best = oi; bd = d; } }
    if (best === null) { let bb = Infinity; for (const oi of outer) { const d = (flat[oi][0] - hp[0]) ** 2 + (flat[oi][1] - hp[1]) ** 2; if (d < bb) { bb = d; best = oi; } } }
    const k = outer.indexOf(best), j = h.indexOf(hi), hseq = [...h.slice(j), ...h.slice(0, j)];
    outer = [...outer.slice(0, k + 1), ...hseq, hseq[0], best, ...outer.slice(k + 1)];
  }
  return [outer, flat];
}
function triangulateWithHoles(loops){
  if (loops.length === 1) return [earClip(loops[0]), loops[0]];
  const [merged, flat] = bridgeHoles(loops);
  const tris = earClip(merged.map(i => flat[i]));
  return [tris.map(([a, b, c]) => [merged[a], merged[b], merged[c]]), flat];
}
function triangulate3d(P3, local){
  const outer = P3[0]; const nrm = [0, 0, 0];
  for (let i = 0; i < outer.length; i++) { const a = outer[i], b = outer[(i + 1) % outer.length];
    nrm[0] += (a[1] - b[1]) * (a[2] + b[2]); nrm[1] += (a[2] - b[2]) * (a[0] + b[0]); nrm[2] += (a[0] - b[0]) * (a[1] + b[1]); }
  const ln = norm3(nrm); if (ln < 1e-12) return [];
  const nn = nrm.map(v => v / ln);
  let ax = 0; if (Math.abs(nn[1]) > Math.abs(nn[ax])) ax = 1; if (Math.abs(nn[2]) > Math.abs(nn[ax])) ax = 2;
  const [u, v] = [[1, 2], [2, 0], [0, 1]][ax], sign = nn[ax] > 0 ? 1 : -1;
  let loops2 = P3.map(L => L.map(p => [p[u], p[v] * sign]));
  if (loops2.length === 1 && loops2[0].length === 4) {
    const q = loops2[0];
    if ([0, 1, 2, 3].every(i => cr(q[i], q[(i + 1) % 4], q[(i + 2) % 4]) > 0)) { const L = local[0]; return [[L[0], L[1], L[2]], [L[0], L[2], L[3]]]; }
  }
  const rev = loops2.map((l, i) => (area2(l) > 0) !== (i === 0));
  loops2 = loops2.map((l, i) => rev[i] ? l.slice().reverse() : l);
  const loc = local.map((ll, i) => rev[i] ? ll.slice().reverse() : ll);
  const flatidx = loc.flat();
  const [tris] = triangulateWithHoles(loops2);
  let out = tris.map(([a, b, c]) => [flatidx[a], flatidx[b], flatidx[c]]);
  if (rev[0]) out = out.map(([a, b, c]) => [a, c, b]);
  return out;
}

/* ------------------------------------------------------------------ export (tools/export_geom.py) */
const txt = (p, ps, k) => { const v = (p.inst[ps] || {})[k]; return typeof v === "string" ? v.trim() : v; };
export const canonPhase = v => { if (typeof v !== "string") return v; const m = v.match(/^\s*P\s*(\d+)(?:[\s_\-]*NEW)?\s*$/i); return m ? "P" + Number(m[1]) : v.trim(); };
function raw(p, name){ for (const d of Object.values(p.inst)) if (name in d) return d[name]; return null; }
function kind(p){
  const t = p.inst.Text || {};
  if (p.cls === "IFCBUILDINGELEMENTPROXY") return "TICKET NUMBER" in t ? "stone" : "Ticket Number" in t ? "tag3d" : "other";
  return p.cls;
}
const r3 = x => Math.round(x * 1000) / 1000;
function bbox(V){ const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < V.length; i += 3) for (let k = 0; k < 3; k++) { const v = V[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; } return [mn, mx]; }

export function buildModel(st, products, { sourceName = "model.ifc", onProgress } = {}){
  const g = new Geo(st);
  const stones = [], context = [], skipped = {};
  for (const p of products.values()) { const k = kind(p); if (k === "stone") stones.push(p); else if (k === "other" || k === "IFCWINDOW" || k === "IFCSLAB") context.push(p); else skipped[k] = (skipped[k] || 0) + 1; }
  const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  stones.sort((a, b) => cmp(txt(a, "Text", "Architect") || "", txt(b, "Text", "Architect") || "") || cmp(txt(a, "Text", "TICKET NUMBER") || "", txt(b, "Text", "TICKET NUMBER") || "") || a.id - b.id);
  context.sort((a, b) => a.id - b.id);
  const ordered = stones.concat(context);
  // display transform: remove the IfcSite placement (shared -> project coordinates)
  let SITE = eye4();
  for (const [, [t, a]] of st.G) if (t === "IFCSITE") { if (a[5]) SITE = g.placement(a[5].$); break; }
  const SITE_INV = inv4(SITE), siteRot = Math.atan2(SITE[4], SITE[0]) / DEG;
  const posFix = new Map();
  const meshFor = p => {
    const pl = p.placement;
    if (pl == null || p.rep == null) return g.productMesh(pl, p.rep);
    const a = st.G.get(pl)[1], own = g.a2p3(a[1].$);
    if (!isEye(own)) {
      const rawm = g.productMesh(null, p.rep);
      if (rawm) {
        const [mn, mx] = bbox(rawm[0]), o = [own[3], own[7], own[11]];
        const c = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
        if ([0, 1, 2].every(k => o[k] > mn[k] - 50 && o[k] < mx[k] + 50) && norm3(c) > 5000) {
          const fixed = g.productMesh(a[0] ? a[0].$ : null, p.rep), wrong = g.productMesh(pl, p.rep);
          const [w0, w1] = bbox(wrong[0]), [f0, f1] = bbox(fixed[0]);
          const c1 = [0, 1, 2].map(k => (w0[k] + w1[k]) / 2), c2 = [0, 1, 2].map(k => (f0[k] + f1[k]) / 2);
          posFix.set(p.id, { rule: "ObjectPlacement already contained in the B-rep coordinates (applied twice by the IFC export)",
            ifcOffset_mm: o.map(v => Math.round(v * 10) / 10), moved_m: Math.round(norm3([c1[0] - c2[0], c1[1] - c2[1], c1[2] - c2[2]]) / 1000 * 10) / 10 });
          return fixed;
        }
        // Rule 2 (mirror case): B-rep local in x/y but its z already has the placement
        // height subtracted; add the height back along the element's local z axis.
        const oz = o[2];
        if (Math.abs(oz) > 5000 && Math.abs(c[0]) < 5000 && Math.abs(c[1]) < 5000 && mn[2] - 500 < -oz && -oz < mx[2] + 500) {
          const wrong = g.productMesh(pl, p.rep), M = g.placement(pl), d = [M[2] * oz, M[6] * oz, M[10] * oz];
          const V = Float64Array.from(wrong[0]);
          for (let i = 0; i < V.length; i += 3) { V[i] += d[0]; V[i + 1] += d[1]; V[i + 2] += d[2]; }
          posFix.set(p.id, { rule: "B-rep z already offset by minus the ObjectPlacement height (subtracted by the IFC export); height added back",
            ifcOffset_mm: o.map(v => Math.round(v * 10) / 10), moved_m: Math.round(norm3(d) / 1000 * 10) / 10 });
          return [V, wrong[1]];
        }
      }
    }
    return g.productMesh(pl, p.rep);
  };
  const meshes = new Map();
  ordered.forEach((p, n) => {
    const m = meshFor(p);
    meshes.set(p.id, m ? [applyM(SITE_INV, m[0]), m[1]] : null);
    if (onProgress && n % 500 === 0) onProgress(n, ordered.length);
  });
  // validate repairs; isolated stones; origin
  const st2 = stones.filter(p => meshes.get(p.id));
  const B = st2.map(p => { const [mn, mx] = bbox(meshes.get(p.id)[0]); return [...mn, ...mx]; });
  const C = B.map(b => [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2]);
  const vol = b => (b[3] - b[0]) * (b[4] - b[1]) * (b[5] - b[2]);
  const nearest = (k, CC) => { let best = Infinity; for (let j = 0; j < CC.length; j++) if (j !== k) { const d = Math.hypot(CC[j][0] - CC[k][0], CC[j][1] - CC[k][1], CC[j][2] - CC[k][2]); if (d < best) best = d; } return best; };
  st2.forEach((p, k) => {
    const f = posFix.get(p.id); if (!f) return;
    const b = B[k]; let iou = 0;
    for (let j = 0; j < B.length; j++) { if (j === k) continue; const o = B[j]; const ix = Math.max(0, Math.min(b[3], o[3]) - Math.max(b[0], o[0])), iy = Math.max(0, Math.min(b[4], o[4]) - Math.max(b[1], o[1])), iz = Math.max(0, Math.min(b[5], o[5]) - Math.max(b[2], o[2])); const inter = ix * iy * iz; const u = inter / Math.max(vol(b) + vol(o) - inter, 1e-9); if (u > iou) iou = u; }
    const d = nearest(k, C);
    f.check = { maxOverlapIoU: Math.round(iou * 1000) / 1000, nearestStone_m: Math.round(d / 1000 * 100) / 100, ok: iou < 0.5 && d < 2000 };
  });
  const keep = st2.filter((p, k) => !(nearest(k, C) > 3000));
  const amn = [Infinity, Infinity, Infinity], amx = [-Infinity, -Infinity, -Infinity];
  for (const p of keep) { const [mn, mx] = bbox(meshes.get(p.id)[0]); for (let k = 0; k < 3; k++) { amn[k] = Math.min(amn[k], mn[k]); amx[k] = Math.max(amx[k], mx[k]); } }
  const origin = [0, 1, 2].map(k => (amn[k] + amx[k]) / 2);
  // elements + chunk parts
  const elements = [], chunkParts = new Map();
  ordered.forEach((p, i) => {
    const eid = i + 1, m = meshes.get(p.id), isStone = kind(p) === "stone";
    let rec = { eid, step: p.id, gid: p.gid, cls: p.cls, kind: isStone ? "stone" : "context", revitId: p.tag };
    if (isStone) {
      const d = p.inst.Dimensions || {};
      const full = { ticket: txt(p, "Text", "TICKET NUMBER"), elev: txt(p, "Text", "Architect"), workset: txt(p, "Identity Data", "Workset"),
        phase: canonPhase(txt(p, "Identity Data", "Workset")), assembly: txt(p, "Identity Data", "Assembly Name"), finish: txt(p, "Text", "FINISH"),
        detail: txt(p, "Text", "Detail"), rev: txt(p, "Text", "Revision Number"), release: txt(p, "Text", "Release date"), status: txt(p, "Text", "STATUS"),
        tolerance: txt(p, "Text", "TOLERANCE"), count: txt(p, "Text", "Count"), confirm: txt(p, "Text", "Wait to confirm model"),
        L: d.LENGTH, W: d.WIDTH, H: d.HEIGHT, T: d.THICKNESS, area: d.Area, volume: d.Volume,
        asm: p.parent != null && products.has(p.parent) ? products.get(p.parent).name : null, posFix: posFix.get(p.id) || null,
        issue: raw(p, "Issue Status"), t31: raw(p, "T-31-Count"), t31_30: raw(p, "T-31(30mm.)-Count"), ps: p.inst };
      for (const [k, v] of Object.entries(full)) if (v !== null && v !== undefined && (v !== "" || k === "issue" || k === "t31" || k === "t31_30")) rec[k] = v;
    } else {
      const o = p.inst.Other || {};
      rec.name = o["Family and Type"] || p.type_name || p.name;
    }
    if (!m) rec.noGeom = true;
    else {
      const V = new Float64Array(m[0].length);
      for (let q = 0; q < V.length; q += 3) for (let k = 0; k < 3; k++) V[q + k] = (m[0][q + k] - origin[k]) / 1000;
      const [mn, mx] = bbox(V);
      rec.bb = [...mn, ...mx].map(r3);
      const name = isStone ? (rec.elev || "CONTEXT") : "CONTEXT";
      if (!chunkParts.has(name)) chunkParts.set(name, []);
      for (const part of splitParts(V, m[1])) chunkParts.get(name).push([eid, part[0], part[1]]);
    }
    elements.push(rec);
  });
  // isolated stones (> 3 m from any other stone), from the rounded boxes like the Python export
  const stEl = elements.filter(r => r.kind === "stone" && r.bb), CC = stEl.map(r => [(r.bb[0] + r.bb[3]) / 2, (r.bb[1] + r.bb[4]) / 2, (r.bb[2] + r.bb[5]) / 2]);
  stEl.forEach((r, j) => { if (nearest(j, CC) > 3.0) r.away = true; });
  // binary chunks
  const chunks = [], manifestChunks = [];
  for (const name of [...chunkParts.keys()].sort()) {
    const blob = encodeChunk(chunkParts.get(name));
    chunks.push({ name, file: `geom/${name}.bin`, data: blob.data });
    manifestChunks.push({ name, file: `geom/${name}.bin`, bytes: blob.data.length, elements: chunkParts.get(name).length, verts: blob.nV, tris: blob.nI / 3 });
  }
  const manifest = {
    source: sourceName, schema: st.schema || "unknown", lengthUnit: "mm (IFC) -> viewer uses metres", origin_mm: origin,
    chunks: manifestChunks, skipped, unsupported: g.unsupported, positionFixes: posFix.size,
    coords: { display: "Revit project coordinates: IFC coordinates with the IfcSite placement removed, minus origin_mm, in metres",
      siteRotationDeg: Math.round(siteRot * 1e4) / 1e4, siteMatrix: [0, 1, 2, 3].map(r => [0, 1, 2, 3].map(c => Math.round(SITE[r * 4 + c] * 1e9) / 1e9)) },
    converter: "browser (assets/ifc-core.js)",
    elements,
  };
  return { manifest, chunks };
}

function splitParts(V, F, limit = 65535){
  const nv = V.length / 3;
  if (nv <= limit) return [[V, F]];
  const parts = [], step = Math.max(1, Math.floor(limit / 3)) * 3;
  for (let s = 0; s < F.length; s += step) {
    const f = F.subarray ? F.subarray(s, s + step) : F.slice(s, s + step);
    const u = [...new Set(f)].sort((a, b) => a - b), map = new Map(u.map((v, i) => [v, i]));
    const Vp = new Float64Array(u.length * 3); u.forEach((v, i) => { Vp[i * 3] = V[v * 3]; Vp[i * 3 + 1] = V[v * 3 + 1]; Vp[i * 3 + 2] = V[v * 3 + 2]; });
    parts.push([Vp, Uint32Array.from(f, v => map.get(v))]);
  }
  return parts;
}

function encodeChunk(items){
  const nV = items.reduce((a, [, V]) => a + V.length / 3, 0), nI = items.reduce((a, [, , F]) => a + F.length, 0);
  const head = 20, table = items.length * 44, vb = nV * 6, pad = (4 - (head + table + vb) % 4) % 4, total = head + table + vb + pad + nI * 2;
  const buf = new ArrayBuffer(total), dv = new DataView(buf), u16 = new Uint16Array(buf, head + table, nV * 3);
  dv.setUint8(0, 70); dv.setUint8(1, 66); dv.setUint8(2, 71); dv.setUint8(3, 49); // 'FBG1'
  dv.setUint32(4, 1, true); dv.setUint32(8, items.length, true); dv.setUint32(12, nV, true); dv.setUint32(16, nI, true);
  const idx = new Uint16Array(buf, head + table + vb + pad, nI);
  let vs = 0, is = 0, p = head;
  const f32 = new Float32Array(1);
  for (const [eid, V, F] of items) {
    const n = V.length / 3, [mn, mx] = bbox(V), size = [0, 1, 2].map(k => { const s = mx[k] - mn[k]; return s < 1e-9 ? 1e-9 : s; });
    if (n > 65535) throw new Error(`element ${eid} has ${n} vertices > 65535`);
    dv.setUint32(p, eid, true); dv.setUint32(p + 4, vs, true); dv.setUint32(p + 8, n, true); dv.setUint32(p + 12, is, true); dv.setUint32(p + 16, F.length, true);
    for (let k = 0; k < 3; k++) { dv.setFloat32(p + 20 + k * 4, mn[k], true); dv.setFloat32(p + 32 + k * 4, size[k], true); }
    for (let q = 0; q < n; q++) for (let k = 0; k < 3; k++) { const x = (V[q * 3 + k] - mn[k]) / size[k] * 65535; u16[(vs + q) * 3 + k] = roundHalfEven(x); }
    for (let q = 0; q < F.length; q++) idx[is + q] = F[q];
    vs += n; is += F.length; p += 44;
  }
  return { data: new Uint8Array(buf), nV, nI };
}
function roundHalfEven(x){ const r = Math.round(x); return (Math.abs(x % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r; }

/* ------------------------------------------------------------------ ZIP: stream one .ifc entry */
export async function* zipEntryStream(file, pick = n => /\.ifc$/i.test(n)){
  const size = file.size, tailLen = Math.min(size, 65557 + 22);
  const tail = new DataView(await file.slice(size - tailLen).arrayBuffer());
  let eocd = -1; for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a ZIP file");
  let n = tail.getUint16(eocd + 10, true), cdSize = tail.getUint32(eocd + 12, true), cdOff = tail.getUint32(eocd + 16, true);
  if (cdOff === 0xffffffff || n === 0xffff) { // ZIP64 end of central directory
    const loc = eocd - 20; if (loc < 0 || tail.getUint32(loc, true) !== 0x07064b50) throw new Error("ZIP64 directory not found");
    const z64 = Number(tail.getBigUint64(loc + 8, true)), r = new DataView(await file.slice(z64, z64 + 56).arrayBuffer());
    n = Number(r.getBigUint64(32, true)); cdSize = Number(r.getBigUint64(40, true)); cdOff = Number(r.getBigUint64(48, true));
  }
  const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
  let p = 0, found = null;
  for (let i = 0; i < n; i++) {
    const method = cd.getUint16(p + 10, true), nlen = cd.getUint16(p + 28, true), xlen = cd.getUint16(p + 30, true), clen = cd.getUint16(p + 32, true);
    let csize = cd.getUint32(p + 20, true), usize = cd.getUint32(p + 24, true), loff = cd.getUint32(p + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nlen));
    // ZIP64 extra field
    let x = p + 46 + nlen; const xe = x + xlen;
    while (x + 4 <= xe) { const id = cd.getUint16(x, true), sz = cd.getUint16(x + 2, true); if (id === 1) { let q = x + 4; if (usize === 0xffffffff) { usize = Number(cd.getBigUint64(q, true)); q += 8; } if (csize === 0xffffffff) { csize = Number(cd.getBigUint64(q, true)); q += 8; } if (loff === 0xffffffff) { loff = Number(cd.getBigUint64(q, true)); } } x += 4 + sz; }
    if (!found && !name.endsWith("/") && pick(name)) found = { name, method, csize, usize, loff };
    p += 46 + nlen + xlen + clen;
  }
  if (!found) throw new Error("the ZIP contains no .ifc file");
  const lh = new DataView(await file.slice(found.loff, found.loff + 30).arrayBuffer());
  const start = found.loff + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
  let stream = file.slice(start, start + found.csize).stream();
  if (found.method === 8) stream = stream.pipeThrough(new DecompressionStream("deflate-raw"));
  else if (found.method !== 0) throw new Error("unsupported ZIP compression method " + found.method);
  yield { entry: found };
  const reader = stream.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; yield value; }
}

/* ------------------------------------------------------------------ validation */
export function validate(st, products){
  const problems = [];
  if (!/ISO-10303-21/.test(st.header)) problems.push("The file does not start with an ISO-10303-21 (STEP) header.");
  if (!st.schema) problems.push("FILE_SCHEMA is missing.");
  else if (!/^IFC/.test(st.schema)) problems.push(`FILE_SCHEMA is ${st.schema}, not an IFC schema.`);
  const stones = [...products.values()].filter(p => kind(p) === "stone");
  if (!stones.length) problems.push("No IfcBuildingElementProxy with a 'TICKET NUMBER' property was found, so the file has no stones for this dashboard.");
  const noElev = stones.filter(p => !txt(p, "Text", "Architect")).length;
  return { ok: problems.length === 0, problems, stones: stones.length, noElevation: noElev, schema: st.schema, lines: st.lines };
}

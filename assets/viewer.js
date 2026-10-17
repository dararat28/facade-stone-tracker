/* Façade Stone Tracker — WebGL2 viewer for the pre-tessellated IFC geometry (geom/*.bin).
   One rigid display transform is applied to the whole model at export time (IfcSite
   placement removed, recentred), so geometry, bounding boxes, picking and highlighting
   all use the same coordinates. */
"use strict";

const VS = `#version 300 es
precision highp float;
precision highp int;
in vec3 a_pos; in uint a_eid;
uniform mat4 u_vp; uniform highp sampler2D u_state; uniform int u_pass;
out vec3 v_pos; flat out vec4 v_col; flat out uint v_eid;
void main(){
  int e = int(a_eid);
  vec4 s = texelFetch(u_state, ivec2(e & 255, e >> 8), 0);
  bool ghost = s.a > 0.25 && s.a < 0.75;
  bool solid = s.a >= 0.75;
  bool draw = (u_pass == 1) ? ghost : solid;
  if (!draw) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  v_pos = a_pos; v_col = s; v_eid = a_eid;
  gl_Position = u_vp * vec4(a_pos, 1.0);
}`;
const FS = `#version 300 es
precision highp float;
precision highp int;
in vec3 v_pos; flat in vec4 v_col; flat in uint v_eid;
uniform vec3 u_eye; uniform vec3 u_viewdir; uniform int u_pass; uniform int u_ortho;
out vec4 o;
void main(){
  if (u_pass == 2) { o = vec4(float(v_eid & 255u) / 255.0, float((v_eid >> 8) & 255u) / 255.0, float((v_eid >> 16) & 255u) / 255.0, 1.0); return; }
  vec3 n = normalize(cross(dFdx(v_pos), dFdy(v_pos)));
  vec3 toEye = u_ortho == 1 ? -u_viewdir : (u_eye - v_pos);
  if (dot(n, toEye) < 0.0) n = -n;
  vec3 L = normalize(vec3(0.35, -0.6, 0.72));
  float d = max(dot(n, L), 0.0);
  float hemi = 0.5 + 0.5 * n.z;
  float head = max(dot(n, normalize(toEye)), 0.0);
  vec3 c = v_col.rgb * (0.48 + 0.10 * hemi + 0.30 * d + 0.20 * head);
  if (u_pass == 1) { o = vec4(c, 0.07); return; }
  o = vec4(c, 1.0);
}`;

const V3 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sc: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};
const M4 = {
  persp(fov, a, n, f){ const t = 1 / Math.tan(fov / 2), r = 1 / (n - f); return [t / a,0,0,0, 0,t,0,0, 0,0,(n + f) * r,-1, 0,0,2 * n * f * r,0]; },
  ortho(hw, hh, n, f){ return [1 / hw,0,0,0, 0,1 / hh,0,0, 0,0,-2 / (f - n),0, 0,0,-(f + n) / (f - n),1]; },
  look(e, c, u){
    const z = V3.norm(V3.sub(e, c)); let x = V3.norm(V3.cross(u, z)); if (!isFinite(x[0])) x = [1, 0, 0]; const y = V3.cross(z, x);
    return [x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0, -V3.dot(x,e),-V3.dot(y,e),-V3.dot(z,e),1];
  },
  mul(a, b){ const o = new Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k]; o[i * 4 + j] = s; } return o; },
};

// Named views in Revit project coordinates (+Y = Project North). Home = Revit's default {3D}: from front-right-top.
const VIEWS = {
  home:  { az: -Math.PI / 4, el: 0.52 },
  top:   { az: -Math.PI / 2, el: 1.5707 },
  front: { az: -Math.PI / 2, el: 0.0001 },  // looking north (from the south side)
  back:  { az: Math.PI / 2, el: 0.0001 },
  left:  { az: Math.PI, el: 0.0001 },
  right: { az: 0, el: 0.0001 },
};

class Viewer {
  constructor(canvas, nEl, bboxOf){
    this.c = canvas;
    this.bboxOf = bboxOf;
    const gl = this.gl = canvas.getContext("webgl2", { antialias: true, powerPreference: "high-performance" });
    if (!gl) throw new Error("WebGL2 is not available in this browser");
    this.prog = this.program(VS, FS);
    const U = n => gl.getUniformLocation(this.prog, n);
    this.loc = { pos: gl.getAttribLocation(this.prog, "a_pos"), eid: gl.getAttribLocation(this.prog, "a_eid"),
      vp: U("u_vp"), state: U("u_state"), pass: U("u_pass"), eye: U("u_eye"), viewdir: U("u_viewdir"), ortho: U("u_ortho") };
    this.texH = Math.ceil((nEl + 1) / 256);
    this.state = new Uint8Array(256 * this.texH * 4);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, this.texH, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.state);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.chunks = [];
    this.cam = { t: [0, 0, 0], d: 150, az: VIEWS.home.az, el: VIEWS.home.el, fov: 40 * Math.PI / 180, ortho: true };
    this.tris = 0; this.dirty = true; this.anim = null; this.frameMs = 0; this.hasGhost = false; this.noRender = false;
    this.onCamera = null; this.onPick = null;
    this.bindInput();
    new ResizeObserver(() => { this.dirty = true; }).observe(canvas);
    const loop = () => { this.tick(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  program(vs, fs){
    const gl = this.gl;
    const mk = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }
  addChunk(name, buf){
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x31474246) throw new Error(`${name}: not an FBG1 geometry file`);
    const nE = dv.getUint32(8, true), nV = dv.getUint32(12, true), nI = dv.getUint32(16, true);
    const pos = new Float32Array(nV * 3), eids = new Uint32Array(nV), idx = new Uint32Array(nI);
    const vOff = 20 + nE * 44;
    const q = new Uint16Array(buf, vOff, nV * 3);
    let iOff = vOff + nV * 6; iOff += (4 - iOff % 4) % 4;
    const qi = new Uint16Array(buf, iOff, nI);
    for (let k = 0, p = 20; k < nE; k++, p += 44) {
      const eid = dv.getUint32(p, true), vs = dv.getUint32(p + 4, true), vc = dv.getUint32(p + 8, true), is = dv.getUint32(p + 12, true), ic = dv.getUint32(p + 16, true);
      const mx = dv.getFloat32(p + 20, true), my = dv.getFloat32(p + 24, true), mz = dv.getFloat32(p + 28, true);
      const sx = dv.getFloat32(p + 32, true) / 65535, sy = dv.getFloat32(p + 36, true) / 65535, sz = dv.getFloat32(p + 40, true) / 65535;
      for (let v = vs, e = vs + vc; v < e; v++) { pos[v * 3] = mx + q[v * 3] * sx; pos[v * 3 + 1] = my + q[v * 3 + 1] * sy; pos[v * 3 + 2] = mz + q[v * 3 + 2] * sz; eids[v] = eid; }
      for (let i = is, e = is + ic; i < e; i++) idx[i] = qi[i] + vs;
    }
    const gl = this.gl;
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const b1 = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b1); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.loc.pos); gl.vertexAttribPointer(this.loc.pos, 3, gl.FLOAT, false, 0, 0);
    const b2 = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b2); gl.bufferData(gl.ARRAY_BUFFER, eids, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.loc.eid); gl.vertexAttribIPointer(this.loc.eid, 1, gl.UNSIGNED_INT, 0, 0);
    const b3 = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b3); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.chunks.push({ name, vao, bufs: [b1, b2, b3], n: nI, visible: true });
    this.tris += nI / 3; this.dirty = true;
  }
  reset(nEl){ // drop all geometry and resize the element state texture (used after an IFC import)
    const gl = this.gl;
    for (const c of this.chunks) { gl.deleteVertexArray(c.vao); for (const b of c.bufs || []) gl.deleteBuffer(b); }
    this.chunks = []; this.tris = 0;
    this.texH = Math.ceil((nEl + 1) / 256);
    this.state = new Uint8Array(256 * this.texH * 4);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, this.texH, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.state);
    this.dirty = true;
  }
  setState(arr){ this.state.set(arr); const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, this.tex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, this.texH, gl.RGBA, gl.UNSIGNED_BYTE, this.state); this.dirty = true; }
  dir(){ const c = this.cam; return [Math.cos(c.el) * Math.cos(c.az), Math.cos(c.el) * Math.sin(c.az), Math.sin(c.el)]; }
  eye(){ return V3.add(this.cam.t, V3.sc(this.dir(), this.cam.d)); }
  vp(w, h){
    const c = this.cam, e = this.eye();
    const up = Math.abs(c.el) > 1.55 ? [-Math.cos(c.az), -Math.sin(c.az), 0] : [0, 0, 1];
    const view = M4.look(e, c.t, up);
    if (c.ortho) {
      const hh = c.d * Math.tan(c.fov / 2), far = c.d + 600;
      return M4.mul(M4.ortho(hh * w / h, hh, -far, far), view);
    }
    return M4.mul(M4.persp(c.fov, w / h, Math.max(0.02, c.d * 0.004), c.d * 4 + 400), view);
  }
  size(){
    const dpr = Math.min(window.devicePixelRatio || 1, 2), w = Math.max(1, Math.round(this.c.clientWidth * dpr)), h = Math.max(1, Math.round(this.c.clientHeight * dpr));
    if (this.c.width !== w || this.c.height !== h) { this.c.width = w; this.c.height = h; }
    return [w, h];
  }
  tick(){
    if (this.anim) {
      const a = this.anim, k = Math.min(1, (performance.now() - a.t0) / a.ms), s = k * k * (3 - 2 * k), lerp = (x, y) => x + (y - x) * s;
      this.cam.t = [0, 1, 2].map(i => lerp(a.from.t[i], a.to.t[i]));
      this.cam.d = Math.exp(lerp(Math.log(a.from.d), Math.log(a.to.d)));
      this.cam.az = lerp(a.from.az, a.to.az); this.cam.el = lerp(a.from.el, a.to.el);
      if (k >= 1) this.anim = null;
      this.dirty = true;
    }
    if (!this.dirty || this.noRender || !this.c.clientWidth) return;   // nothing to draw while hidden (Overview page)
    this.dirty = false;
    const t0 = performance.now();
    this.draw(null);
    this.frameMs = performance.now() - t0;
    if (this.onCamera) this.onCamera(this.cam);
  }
  drawPass(pass){
    const gl = this.gl;
    gl.uniform1i(this.loc.pass, pass);
    for (const ch of this.chunks) if (ch.visible) { gl.bindVertexArray(ch.vao); gl.drawElements(gl.TRIANGLES, ch.n, gl.UNSIGNED_INT, 0); }
    gl.bindVertexArray(null);
  }
  draw(fbo){
    const gl = this.gl, [w, h] = this.size();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.loc.vp, false, this.vp(w, h));
    gl.uniform3fv(this.loc.eye, this.eye());
    gl.uniform3fv(this.loc.viewdir, V3.sc(this.dir(), -1));
    gl.uniform1i(this.loc.ortho, this.cam.ortho ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex); gl.uniform1i(this.loc.state, 0);
    gl.disable(gl.BLEND); gl.depthMask(true);
    if (fbo) { this.drawPass(2); return; }
    this.drawPass(0);
    if (this.hasGhost) { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false); this.drawPass(1); gl.depthMask(true); gl.disable(gl.BLEND); }
  }
  pick(px, py){
    const gl = this.gl, [w, h] = this.size();
    if (!this.fbo || this.fboW !== w || this.fboH !== h) {
      if (this.fbo) { gl.deleteFramebuffer(this.fbo); gl.deleteTexture(this.fboTex); gl.deleteRenderbuffer(this.fboDepth); }
      this.fbo = gl.createFramebuffer(); this.fboTex = gl.createTexture(); this.fboDepth = gl.createRenderbuffer();
      gl.bindTexture(gl.TEXTURE_2D, this.fboTex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.fboDepth); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.fboDepth);
      this.fboW = w; this.fboH = h;
    }
    const dpr = w / this.c.clientWidth;
    this.draw(this.fbo);
    const out = new Uint8Array(4);
    gl.readPixels(Math.round(px * dpr), Math.round(h - py * dpr - 1), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.dirty = true;
    return out[3] ? out[0] + out[1] * 256 + out[2] * 65536 : 0;
  }
  bindInput(){
    const c = this.c, ptrs = new Map();
    let down = null, moved = false, lastPinch = null;
    c.addEventListener("contextmenu", e => e.preventDefault());
    c.addEventListener("pointerdown", e => {
      c.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      down = { x: e.clientX, y: e.clientY, b: e.button, shift: e.shiftKey }; moved = false; this.anim = null;
    });
    c.addEventListener("pointermove", e => {
      if (!ptrs.has(e.pointerId)) return;
      const prev = ptrs.get(e.pointerId), dx = e.clientX - prev[0], dy = e.clientY - prev[1];
      ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      if (Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > 4) { moved = true; c.classList.add("drag"); }
      if (!moved) return;
      if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()], dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (lastPinch) this.cam.d *= lastPinch / dist;
        lastPinch = dist; this.pan(dx / 2, dy / 2); this.dirty = true; return;
      }
      if (down.b === 2 || down.b === 1 || down.shift) this.pan(dx, dy);
      else { this.cam.az -= dx * 0.006; this.cam.el = Math.max(-1.5, Math.min(1.5707, this.cam.el + dy * 0.006)); }
      this.dirty = true;
    });
    const up = e => {
      ptrs.delete(e.pointerId); if (ptrs.size < 2) lastPinch = null; c.classList.remove("drag");
      if (down && !moved && e.type === "pointerup" && down.b === 0 && this.onPick) {
        const r = c.getBoundingClientRect();
        this.onPick(this.pick(e.clientX - r.left, e.clientY - r.top), { add: e.ctrlKey || e.metaKey || e.shiftKey, dbl: false });
      }
      if (!ptrs.size) down = null;
    };
    c.addEventListener("pointerup", up); c.addEventListener("pointercancel", up);
    c.addEventListener("dblclick", e => { const r = c.getBoundingClientRect(); const id = this.pick(e.clientX - r.left, e.clientY - r.top); if (id && this.onPick) this.onPick(id, { dbl: true }); });
    c.addEventListener("wheel", e => { e.preventDefault(); this.anim = null; this.cam.d = Math.max(0.3, Math.min(3000, this.cam.d * Math.exp(e.deltaY * (e.deltaMode ? 0.05 : 0.0012)))); this.dirty = true; }, { passive: false });
  }
  pan(dx, dy){
    const c = this.cam, f = V3.sc(this.dir(), -1);
    const r = Math.abs(c.el) > 1.55 ? [Math.sin(c.az), -Math.cos(c.az), 0] : V3.norm(V3.cross(f, [0, 0, 1]));
    const u = V3.cross(r, f);
    const s = 2 * c.d * Math.tan(c.fov / 2) / Math.max(1, this.c.clientHeight);
    c.t = V3.add(c.t, V3.add(V3.sc(r, -dx * s), V3.sc(u, dy * s)));
  }
  goTo(to, ms){
    const from = { t: this.cam.t.slice(), d: this.cam.d, az: this.cam.az, el: this.cam.el };
    let az = to.az; while (az - from.az > Math.PI) az -= 2 * Math.PI; while (az - from.az < -Math.PI) az += 2 * Math.PI;
    to = { ...to, az };
    if (!ms || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { Object.assign(this.cam, to); this.dirty = true; return; }
    this.anim = { from, to, t0: performance.now(), ms };
  }
  bbox(eids){
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const id of eids) { const b = this.bboxOf(id); if (!b) continue; for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], b[i]); mx[i] = Math.max(mx[i], b[i + 3]); } }
    return isFinite(mn[0]) ? [mn, mx] : null;
  }
  // view: a VIEWS key, "keep" (current angle) or "outside" (look at the selection from outside the building)
  fitTo(eids, animate, view){
    const bb = this.bbox(eids); if (!bb) return false;
    const [mn, mx] = bb, ctr = V3.sc(V3.add(mn, mx), 0.5);
    const rad = Math.max(0.6, Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2);
    const asp = this.c.clientWidth / Math.max(1, this.c.clientHeight);
    const fovMin = Math.min(this.cam.fov, 2 * Math.atan(Math.tan(this.cam.fov / 2) * asp));
    const d = Math.max(rad / Math.sin(fovMin / 2) * (eids.length > 50 ? 0.85 : 1.1), view === "keep" ? 0 : 6);
    let { az, el } = this.cam;
    if (VIEWS[view]) ({ az, el } = VIEWS[view]);
    else if (view === "outside") {
      const mc = this.modelCentre || [0, 0, 0], dir = [ctr[0] - mc[0], ctr[1] - mc[1]];
      if (Math.hypot(dir[0], dir[1]) > 3 && rad < 25) { az = Math.atan2(dir[1], dir[0]); el = 0.3; }
    }
    this.goTo({ t: ctr, d, az, el }, animate ? 600 : 0);
    return true;
  }
}

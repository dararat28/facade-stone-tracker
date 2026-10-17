/* STL preview: a small, separate WebGL2 viewer for one STL file at a time.
   Reads binary and ASCII STL. The geometry is only re-centred for the camera;
   coordinates are not changed. Nothing here is aligned with the IFC model. */
"use strict";

function parseStl(buf){
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  let tris = null, format;
  if (buf.byteLength >= 84) {
    const n = dv.getUint32(80, true);
    if (n > 0 && 84 + 50 * n === buf.byteLength) {
      format = "binary"; tris = new Float32Array(n * 9);
      for (let i = 0, p = 84; i < n; i++, p += 50) for (let k = 0; k < 9; k++) tris[i * 9 + k] = dv.getFloat32(p + 12 + k * 4, true);
    }
  }
  if (!tris) {
    const head = new TextDecoder("latin1").decode(u8.subarray(0, Math.min(u8.length, 512))).trimStart().toLowerCase();
    if (!head.startsWith("solid")) throw new Error("not an STL file (neither binary nor ASCII STL)");
    const txt = new TextDecoder("latin1").decode(u8);
    const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g, out = [];
    let m; while ((m = re.exec(txt))) out.push(+m[1], +m[2], +m[3]);
    if (!out.length || out.length % 9) throw new Error("ASCII STL without complete facets");
    format = "ascii"; tris = Float32Array.from(out);
  }
  for (let i = 0; i < tris.length; i++) if (!Number.isFinite(tris[i])) throw new Error("STL contains invalid numbers");
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) for (let k = 0; k < 3; k++) { const v = tris[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
  return { tris, format, count: tris.length / 9, min: mn, max: mx, size: [0, 1, 2].map(k => mx[k] - mn[k]) };
}

const STL_VS = `#version 300 es
precision highp float;
in vec3 a_pos; uniform mat4 u_vp; out vec3 v_pos;
void main(){ v_pos = a_pos; gl_Position = u_vp * vec4(a_pos, 1.0); }`;
const STL_FS = `#version 300 es
precision highp float;
in vec3 v_pos; uniform vec3 u_eye; uniform vec3 u_col; out vec4 o;
void main(){
  vec3 n = normalize(cross(dFdx(v_pos), dFdy(v_pos)));
  vec3 toEye = normalize(u_eye - v_pos);
  if (dot(n, toEye) < 0.0) n = -n;
  float key = max(dot(n, normalize(vec3(0.35, -0.55, 0.75))), 0.0);
  float fill = max(dot(n, normalize(vec3(-0.6, 0.4, 0.3))), 0.0);
  float head = max(dot(n, toEye), 0.0);
  vec3 c = u_col * (0.30 + 0.45 * key + 0.15 * fill + 0.22 * head);
  o = vec4(c, 1.0);
}`;

class StlViewer {
  constructor(canvas){
    this.c = canvas;
    const gl = this.gl = canvas.getContext("webgl2", { antialias: true });
    if (!gl) throw new Error("WebGL2 is not available in this browser");
    const mk = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); return sh; };
    const p = this.prog = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, STL_VS)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, STL_FS)); gl.linkProgram(p);
    this.loc = { pos: gl.getAttribLocation(p, "a_pos"), vp: gl.getUniformLocation(p, "u_vp"), eye: gl.getUniformLocation(p, "u_eye"), col: gl.getUniformLocation(p, "u_col") };
    this.cam = { t: [0, 0, 0], d: 1, az: -Math.PI / 4, el: 0.45, fov: 35 * Math.PI / 180 };
    this.n = 0; this.dirty = true; this.alive = true; this.radius = 1;
    this.bind();
    this.ro = new ResizeObserver(() => { this.dirty = true; }); this.ro.observe(canvas);
    const loop = () => { if (!this.alive) return; if (this.dirty) { this.dirty = false; this.draw(); } requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  load(stl){
    const gl = this.gl, ctr = [0, 1, 2].map(k => (stl.min[k] + stl.max[k]) / 2);
    const pos = new Float32Array(stl.tris.length);
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) pos[i + k] = stl.tris[i + k] - ctr[k];
    if (this.vao) { gl.deleteVertexArray(this.vao); gl.deleteBuffer(this.buf); }
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    this.buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.buf); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(this.loc.pos); gl.vertexAttribPointer(this.loc.pos, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.n = pos.length / 3;
    this.radius = Math.max(1e-6, Math.hypot(...stl.size) / 2);
    this.view("iso");
  }
  view(v){
    const V = { iso: [-Math.PI / 4, 0.45], front: [-Math.PI / 2, 0], top: [-Math.PI / 2, 1.5707], right: [0, 0], back: [Math.PI / 2, 0] }[v] || [this.cam.az, this.cam.el];
    this.cam.az = V[0]; this.cam.el = V[1]; this.cam.t = [0, 0, 0];
    const asp = this.c.clientWidth / Math.max(1, this.c.clientHeight), f = Math.min(this.cam.fov, 2 * Math.atan(Math.tan(this.cam.fov / 2) * asp));
    this.cam.d = this.radius / Math.sin(f / 2) * 1.05; this.dirty = true;
  }
  eye(){ const c = this.cam; return [c.t[0] + c.d * Math.cos(c.el) * Math.cos(c.az), c.t[1] + c.d * Math.cos(c.el) * Math.sin(c.az), c.t[2] + c.d * Math.sin(c.el)]; }
  draw(){
    const gl = this.gl, dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.c.clientWidth * dpr)), h = Math.max(1, Math.round(this.c.clientHeight * dpr));
    if (this.c.width !== w || this.c.height !== h) { this.c.width = w; this.c.height = h; }
    gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.n) return;
    gl.enable(gl.DEPTH_TEST); gl.useProgram(this.prog);
    const c = this.cam, e = this.eye(), up = Math.abs(c.el) > 1.55 ? [-Math.cos(c.az), -Math.sin(c.az), 0] : [0, 0, 1];
    const near = Math.max(c.d - this.radius * 3, c.d * 0.01), far = c.d + this.radius * 3;
    gl.uniformMatrix4fv(this.loc.vp, false, M4.mul(M4.persp(c.fov, w / h, near, far), M4.look(e, c.t, up)));
    gl.uniform3fv(this.loc.eye, e); gl.uniform3fv(this.loc.col, [0.80, 0.76, 0.68]);
    gl.bindVertexArray(this.vao); gl.drawArrays(gl.TRIANGLES, 0, this.n); gl.bindVertexArray(null);
  }
  bind(){
    const c = this.c, ptr = new Map(); let mode = null, pinch = null;
    c.addEventListener("contextmenu", e => e.preventDefault());
    c.addEventListener("pointerdown", e => { c.setPointerCapture(e.pointerId); ptr.set(e.pointerId, [e.clientX, e.clientY]); mode = e.button === 2 || e.button === 1 || e.shiftKey ? "pan" : "orbit"; });
    c.addEventListener("pointermove", e => {
      if (!ptr.has(e.pointerId)) return;
      const [x0, y0] = ptr.get(e.pointerId), dx = e.clientX - x0, dy = e.clientY - y0; ptr.set(e.pointerId, [e.clientX, e.clientY]);
      if (ptr.size === 2) { const [a, b] = [...ptr.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch) this.cam.d *= pinch / d; pinch = d; this.dirty = true; return; }
      if (mode === "pan") {
        const c2 = this.cam, s = 2 * c2.d * Math.tan(c2.fov / 2) / Math.max(1, c.clientHeight);
        const r = [-Math.sin(c2.az), Math.cos(c2.az), 0], u = [-Math.sin(c2.el) * Math.cos(c2.az), -Math.sin(c2.el) * Math.sin(c2.az), Math.cos(c2.el)];
        for (let k = 0; k < 3; k++) c2.t[k] += -dx * s * r[k] + dy * s * u[k];
      } else { this.cam.az -= dx * 0.008; this.cam.el = Math.max(-1.5707, Math.min(1.5707, this.cam.el + dy * 0.008)); }
      this.dirty = true;
    });
    const up = e => { ptr.delete(e.pointerId); if (ptr.size < 2) pinch = null; };
    c.addEventListener("pointerup", up); c.addEventListener("pointercancel", up);
    c.addEventListener("wheel", e => { e.preventDefault(); this.cam.d = Math.max(this.radius * 0.05, Math.min(this.radius * 50, this.cam.d * Math.exp(e.deltaY * 0.0012))); this.dirty = true; }, { passive: false });
    c.addEventListener("dblclick", () => this.view());
  }
  dispose(){
    this.alive = false; this.ro.disconnect();
    const gl = this.gl; if (this.vao) { gl.deleteVertexArray(this.vao); gl.deleteBuffer(this.buf); }
    const ext = gl.getExtension("WEBGL_lose_context"); if (ext) ext.loseContext();
  }
}

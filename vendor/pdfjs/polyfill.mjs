// Small polyfills for features pdf.js 6 uses that older browsers lack.
for (const C of [Map, WeakMap]) {
  if (!C.prototype.getOrInsertComputed) {
    Object.defineProperty(C.prototype, "getOrInsertComputed", { configurable: true, writable: true,
      value(k, f) { if (this.has(k)) return this.get(k); const v = f(k); this.set(k, v); return v; } });
  }
  if (!C.prototype.getOrInsert) {
    Object.defineProperty(C.prototype, "getOrInsert", { configurable: true, writable: true,
      value(k, v) { if (!this.has(k)) this.set(k, v); return this.get(k); } });
  }
}
if (!Promise.withResolvers) {
  Promise.withResolvers = function () { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
}
if (!Math.sumPrecise) {
  Math.sumPrecise = function (it) { let s = 0; for (const v of it) s += v; return s; };
}
if (!Uint8Array.fromBase64) {
  Uint8Array.fromBase64 = function (b64) { const s = atob(b64); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; };
}
if (!Uint8Array.prototype.toHex) {
  Object.defineProperty(Uint8Array.prototype, "toHex", { configurable: true, writable: true,
    value() { let s = ""; for (const b of this) s += b.toString(16).padStart(2, "0"); return s; } });
}
export {};

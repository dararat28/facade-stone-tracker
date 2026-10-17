/* Web Worker for "Import IFC Model": converts an .ifc (or a .zip holding one)
   into the dashboard model without blocking the page. */
import { IfcStore, resolveProducts, buildModel, validate, zipEntryStream } from "./ifc-core.js";

self.onmessage = async ev => {
  const { file } = ev.data;
  const t0 = performance.now();
  const post = (type, extra) => self.postMessage({ type, ...extra });
  try {
    let chunks, name = file.name, total = file.size, unit = "file";
    if (/\.zip$/i.test(file.name)) {
      const it = zipEntryStream(file);
      const first = await it.next();
      name = first.value.entry.name.split("/").pop(); total = first.value.entry.usize; unit = "unzipped IFC";
      chunks = it;
    } else if (/\.ifc$/i.test(file.name)) {
      const reader = file.stream().getReader();
      chunks = (async function* () { for (;;) { const { done, value } = await reader.read(); if (done) return; yield value; } })();
    } else throw new Error("Choose an .ifc file, or a .zip that contains one.");
    post("progress", { stage: "read", text: `Reading ${name}`, frac: 0 });
    const st = new IfcStore();
    await st.read(chunks, b => post("progress", { stage: "read", text: `Reading ${name}: ${Math.round(b / 1e6)} of ${Math.round(total / 1e6)} MB (${unit})`, frac: Math.min(1, b / total) * 0.7 }));
    post("progress", { stage: "props", text: "Reading IFC properties", frac: 0.71 });
    const products = resolveProducts(st);
    const v = validate(st, products);
    if (!v.ok) { post("invalid", { validation: v }); return; }
    const { manifest, chunks: bins } = buildModel(st, products, { sourceName: name,
      onProgress: (n, t) => post("progress", { stage: "geom", text: `Building geometry: ${n} of ${t} elements`, frac: 0.72 + 0.27 * n / t }) });
    manifest.convertedAt = new Date().toISOString();
    manifest.convertSeconds = Math.round((performance.now() - t0) / 100) / 10;
    const json = new TextEncoder().encode(JSON.stringify(manifest));
    self.postMessage({ type: "done", validation: v, json, chunks: bins.map(c => ({ name: c.name, file: c.file, data: c.data })) },
      [json.buffer, ...bins.map(c => c.data.buffer)]);
  } catch (e) {
    post("error", { message: e && e.message ? e.message : String(e) });
  }
};

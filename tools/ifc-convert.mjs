#!/usr/bin/env node
// Convert an IFC (or a ZIP containing one) with the same code the dashboard's
// "Import IFC Model" button uses (assets/ifc-core.js).
//   node --max-old-space-size=6144 tools/ifc-convert.mjs <model.ifc|model.zip> <output folder>
// Writes <out>/data/elements.json and <out>/geom/*.bin.
import fs from "node:fs";
import path from "node:path";
import { IfcStore, resolveProducts, buildModel, validate, zipEntryStream } from "../assets/ifc-core.js";

const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error("usage: ifc-convert.mjs <model.ifc|model.zip> <output folder>"); process.exit(2); }
const t0 = Date.now();
const mb = () => Math.round(process.memoryUsage().rss / 1e6) + " MB";
const st = new IfcStore();
let name = path.basename(src), chunks;
if (/\.zip$/i.test(src)) {
  const blob = await fs.openAsBlob(src);
  const it = zipEntryStream(blob);
  const first = await it.next(); name = first.value.entry.name.split("/").pop();
  chunks = it;
} else chunks = fs.createReadStream(src, { highWaterMark: 8 << 20 });
await st.read(chunks, b => process.stdout.write(`\rread ${Math.round(b / 1e6)} MB, ${mb()}   `));
console.log(`\nparsed ${st.lines} lines in ${((Date.now() - t0) / 1000).toFixed(1)} s, schema ${st.schema}, ${mb()}`);
const products = resolveProducts(st);
const v = validate(st, products);
console.log("validation", JSON.stringify(v));
if (!v.ok) process.exit(1);
const t1 = Date.now();
const { manifest, chunks: bins } = buildModel(st, products, { sourceName: name, onProgress: (n, t) => { if (n % 3000 === 0) process.stdout.write(`\rtessellated ${n}/${t}   `); } });
console.log(`\nbuilt model in ${((Date.now() - t1) / 1000).toFixed(1)} s, ${mb()}`);
fs.mkdirSync(path.join(out, "data"), { recursive: true }); fs.mkdirSync(path.join(out, "geom"), { recursive: true });
for (const c of bins) fs.writeFileSync(path.join(out, c.file), c.data);
fs.writeFileSync(path.join(out, "data", "elements.json"), JSON.stringify(manifest));
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${manifest.elements.length} elements, ${bins.length} geometry files, ${manifest.positionFixes} placement repairs, unsupported ${JSON.stringify(manifest.unsupported)}`);

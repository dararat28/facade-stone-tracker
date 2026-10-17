"""Export tessellated IFC geometry to compact per-elevation binary chunks
plus an element manifest (data/elements.json).

Binary chunk format 'FBG1' (little-endian):
  u32 magic 'FBG1' | u32 version=1 | u32 nElem | u32 nVert | u32 nIdx
  nElem x { u32 eid, u32 vStart, u32 vCount, u32 iStart, u32 iCount,
            f32 min[3], f32 size[3] }          (44 bytes each)
  nVert x { u16 qx, u16 qy, u16 qz }            positions quantised in element bbox
  pad to 4 bytes
  nIdx  x u16                                   indices relative to element vStart
Positions are in metres relative to the model origin stored in elements.json.
"""
import sys, os, re, json, struct, pickle, time, collections
import gc
gc.disable()  # batch script: the cyclic GC makes loading large pickles 10-20x slower
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from geom_build import Geo

CACHE, OUTDIR = sys.argv[1], sys.argv[2]
os.makedirs(os.path.join(OUTDIR, "geom"), exist_ok=True)
os.makedirs(os.path.join(OUTDIR, "data"), exist_ok=True)

P = pickle.load(open(os.path.join(CACHE, "products.pkl"), "rb"))
g = Geo(os.path.join(CACHE, "m"))


def txt(p, ps, k):
    v = p["inst"].get(ps, {}).get(k)
    return v.strip() if isinstance(v, str) else v


def canon_phase(v):
    """'P8' and 'P8-New' / 'P8 New' are the same phase -> 'P8'. Only that exact pattern is merged."""
    if not isinstance(v, str):
        return v
    m = re.match(r"^\s*P\s*(\d+)(?:[\s_\-]*NEW)?\s*$", v, re.I)
    return f"P{int(m.group(1))}" if m else v.strip()


def raw(p, name):
    """Value of a property by exact name from any instance property set (None if absent)."""
    for ps, d in p["inst"].items():
        if name in d:
            return d[name]
    return None


def kind(p):
    t = p["inst"].get("Text", {})
    if p["cls"] == "IFCBUILDINGELEMENTPROXY":
        if "TICKET NUMBER" in t:
            return "stone"
        if "Ticket Number" in t:
            return "tag3d"
        return "other"
    return p["cls"]


stones, context, skipped = [], [], collections.Counter()
for p in P.values():
    k = kind(p)
    if k == "stone":
        stones.append(p)
    elif k in ("other", "IFCWINDOW", "IFCSLAB"):
        context.append(p)
    else:
        skipped[k] += 1

stones.sort(key=lambda p: (txt(p, "Text", "Architect") or "", txt(p, "Text", "TICKET NUMBER") or "", p["id"]))
context.sort(key=lambda p: p["id"])
ordered = stones + context

t0 = time.time()

# --- Display coordinate system -------------------------------------------------
# The IfcSite placement carries the shared-coordinate rotation (about -90.9 deg in
# this model). Revit shows models in project coordinates (Project North), so the
# whole model is displayed with the IfcSite placement removed: ONE rigid
# transform applied identically to every element, its bounding box, picking and
# highlighting. The matrix to get back to IFC (shared) coordinates is stored in
# elements.json.
sem = pickle.load(open(os.path.join(CACHE, "m_sem.pkl"), "rb"))
site = [a for t, a in sem.values() if t == "IFCSITE"]
SITE = g.placement(site[0][5]) if site and site[0][5] is not None else np.eye(4)
SITE_INV = np.linalg.inv(SITE)
site_rot = float(np.degrees(np.arctan2(SITE[1, 0], SITE[0, 0])))
del sem
print(f"IfcSite placement: rotation {site_rot:.3f} deg, translation {np.round(SITE[:3, 3], 1).tolist()} mm")


def to_display(m):
    if m is None:
        return None
    V, F = m
    return (SITE_INV[:3, :3] @ V.T).T + SITE_INV[:3, 3], F


# --- Root-cause repair: ObjectPlacement baked into the B-rep -------------------
# Rule (checked per element, from the file itself): the element has a
# non-identity ObjectPlacement whose origin lies inside the bounding box of its
# own untransformed geometry, while that geometry is more than 5 m from the
# local origin. Its vertices therefore already contain the placement and the
# exporter wrote the same placement again. Such geometry is placed with the
# parent placement only. Each repair is validated afterwards (no overlap with
# another stone, a neighbouring stone within 2 m) and recorded in elements.json.
pos_fix = {}


def mesh_for(p):
    pl = p["placement"]
    if pl is None or p["rep"] is None:
        return g.product_mesh(pl, p["rep"])
    _t, _a = g.G[pl]
    own = g.a2p3(_a[1])
    if not np.allclose(own, np.eye(4)):
        raw = g.product_mesh(None, p["rep"])
        if raw is not None:
            mn, mx = raw[0].min(0), raw[0].max(0)
            o = own[:3, 3]
            if np.all(o > mn - 50) and np.all(o < mx + 50) and np.linalg.norm((mn + mx) / 2) > 5000:
                fixed = g.product_mesh(_a[0], p["rep"])
                wrong = g.product_mesh(pl, p["rep"])
                c1 = (wrong[0].min(0) + wrong[0].max(0)) / 2
                c2 = (fixed[0].min(0) + fixed[0].max(0)) / 2
                pos_fix[p["id"]] = {
                    "rule": "ObjectPlacement already contained in the B-rep coordinates (applied twice by the IFC export)",
                    "ifcOffset_mm": [round(float(x), 1) for x in o],
                    "moved_m": round(float(np.linalg.norm(c1 - c2)) / 1000, 1)}
                return fixed
            # Rule 2 (mirror case): the B-rep is local in x/y but its z already has the
            # placement height SUBTRACTED (raw z range contains -ObjectPlacement z), so
            # applying the placement puts the stone near ground level. The height is
            # added back along the element's local z axis. Validated like rule 1.
            oz = o[2]
            c = (mn + mx) / 2
            if abs(oz) > 5000 and abs(c[0]) < 5000 and abs(c[1]) < 5000 and mn[2] - 500 < -oz < mx[2] + 500:
                wrong = g.product_mesh(pl, p["rep"])
                M = g.placement(pl)
                d = M[:3, :3] @ np.array([0.0, 0.0, oz])
                pos_fix[p["id"]] = {
                    "rule": "B-rep z already offset by minus the ObjectPlacement height (subtracted by the IFC export); height added back",
                    "ifcOffset_mm": [round(float(x), 1) for x in o],
                    "moved_m": round(float(np.linalg.norm(d)) / 1000, 1)}
                return wrong[0] + d, wrong[1]
    return g.product_mesh(pl, p["rep"])


meshes = {}
for n, p in enumerate(ordered):
    meshes[p["id"]] = to_display(mesh_for(p))
    if n % 3000 == 0:
        print("tessellated", n, round(time.time() - t0), flush=True)
print("placement repairs (baked ObjectPlacement):", len(pos_fix))

# validate every repair against the rest of the model
_st = [p for p in stones if meshes[p["id"]] is not None]
_B = np.array([np.concatenate([meshes[p["id"]][0].min(0), meshes[p["id"]][0].max(0)]) for p in _st])
_C = (_B[:, :3] + _B[:, 3:]) / 2
for k, p in enumerate(_st):
    if p["id"] not in pos_fix:
        continue
    b = _B[k]
    lo_ = np.maximum(b[:3], _B[:, :3]); hi_ = np.minimum(b[3:], _B[:, 3:])
    inter = np.prod(np.clip(hi_ - lo_, 0, None), axis=1)
    iou = inter / np.maximum(np.prod(b[3:] - b[:3]) + np.prod(_B[:, 3:] - _B[:, :3], axis=1) - inter, 1e-9)
    iou[k] = 0
    d = np.linalg.norm(_C - _C[k], axis=1); d[k] = np.inf
    pos_fix[p["id"]]["check"] = {"maxOverlapIoU": round(float(iou.max()), 3), "nearestStone_m": round(float(d.min()) / 1000, 2),
                                 "ok": bool(iou.max() < 0.5 and d.min() < 2000)}
bad = [p["id"] for p in _st if p["id"] in pos_fix and not pos_fix[p["id"]]["check"]["ok"]]
print("repairs failing validation:", len(bad))

# model origin = centre of the stones that have neighbours (isolated stones do not stretch the view)
_iso = []
for k in range(len(_C)):
    d = np.linalg.norm(_C - _C[k], axis=1); d[k] = np.inf
    _iso.append(d.min() > 3000)
_keep = [p for p, f in zip(_st, _iso) if not f]
allmin = np.min([meshes[p["id"]][0].min(0) for p in _keep], axis=0)
allmax = np.max([meshes[p["id"]][0].max(0) for p in _keep], axis=0)
origin = (allmin + allmax) / 2


def split_parts(V, F, limit=65535):
    """Split a mesh into parts with <= limit vertices (u16 indices)."""
    if len(V) <= limit:
        return [(V, F)]
    parts = []
    start = 0
    step = max(1, limit // 3)
    for s in range(0, len(F), step):
        f = F[s:s + step]
        u, inv = np.unique(f.ravel(), return_inverse=True)
        parts.append((V[u], inv.reshape(-1, 3)))
    return parts


elements = []
chunks = collections.defaultdict(list)
for i, p in enumerate(ordered):
    eid = i + 1
    m = meshes[p["id"]]
    is_stone = kind(p) == "stone"
    rec = {
        "eid": eid,
        "step": p["id"],
        "gid": p["gid"],
        "cls": p["cls"],
        "kind": "stone" if is_stone else "context",
        "revitId": p["tag"],
    }
    if is_stone:
        d = p["inst"].get("Dimensions", {})
        rec.update({
            "ticket": txt(p, "Text", "TICKET NUMBER"),
            "elev": txt(p, "Text", "Architect"),
            "workset": txt(p, "Identity Data", "Workset"),
            "phase": canon_phase(txt(p, "Identity Data", "Workset")),
            "assembly": txt(p, "Identity Data", "Assembly Name"),
            "finish": txt(p, "Text", "FINISH"),
            "detail": txt(p, "Text", "Detail"),
            "rev": txt(p, "Text", "Revision Number"),
            "release": txt(p, "Text", "Release date"),
            "status": txt(p, "Text", "STATUS"),
            "tolerance": txt(p, "Text", "TOLERANCE"),
            "count": txt(p, "Text", "Count"),
            "confirm": txt(p, "Text", "Wait to confirm model"),
            "L": d.get("LENGTH"), "W": d.get("WIDTH"), "H": d.get("HEIGHT"), "T": d.get("THICKNESS"),
            "area": d.get("Area"), "volume": d.get("Volume"),
            "asm": (P[p["parent"]]["name"] if p.get("parent") in P else None),
            "posFix": pos_fix.get(p["id"]),
            # manufacturing parameters, raw IFC values (strings as stored in the file)
            "issue": raw(p, "Issue Status"),
            "t31": raw(p, "T-31-Count"),
            "t31_30": raw(p, "T-31(30mm.)-Count"),
            # every instance property set, unchanged, for display and search
            "ps": {ps: {k: v for k, v in d.items()} for ps, d in p["inst"].items()},
        })
        rec = {k: v for k, v in rec.items() if v is not None and (v != "" or k in ("issue", "t31", "t31_30"))}
    else:
        o = p["inst"].get("Other", {})
        rec["name"] = o.get("Family and Type") or p["type_name"] or p["name"]
    if m is None:
        rec["noGeom"] = True
    else:
        V = (m[0] - origin) / 1000.0
        mn, mx = V.min(0), V.max(0)
        rec["bb"] = [round(float(x), 3) for x in list(mn) + list(mx)]
        for Vp, Fp in split_parts(V, m[1]):
            chunks[rec.get("elev", "CONTEXT") if is_stone else "CONTEXT"].append((eid, Vp, Fp))
    elements.append(rec)

# flag stones that are isolated (> 3 m from any other stone): not repaired, reported
st_idx = [i for i, r in enumerate(elements) if r["kind"] == "stone" and "bb" in r]
C = np.array([[(elements[i]["bb"][k] + elements[i]["bb"][k + 3]) / 2 for k in range(3)] for i in st_idx])
n_away = 0
for j, i in enumerate(st_idx):
    d = np.linalg.norm(C - C[j], axis=1); d[j] = np.inf
    if d.min() > 3.0:
        elements[i]["away"] = True; n_away += 1
print("isolated stones (not repaired):", n_away)

manifest_chunks = []
for name in sorted(chunks):
    items = chunks[name]
    nV = sum(len(V) for _, V, _ in items)
    nI = sum(F.size for _, _, F in items)
    header = struct.pack("<4sIIII", b"FBG1", 1, len(items), nV, nI)
    table = bytearray(); qv = []; ix = []
    vs = 0; is_ = 0
    for eid, V, F in items:
        mn = V.min(0); size = V.max(0) - mn
        size[size < 1e-9] = 1e-9
        q = np.round((V - mn) / size * 65535).astype(np.uint16)
        if len(V) > 65535:
            raise SystemExit(f"element {eid} has {len(V)} vertices > 65535")
        table += struct.pack("<IIIII6f", eid, vs, len(V), is_, F.size, *mn.astype(np.float32), *size.astype(np.float32))
        qv.append(q); ix.append(F.astype(np.uint16).ravel())
        vs += len(V); is_ += F.size
    vbytes = np.vstack(qv).tobytes()
    pad = b"\0" * ((4 - (len(header) + len(table) + len(vbytes)) % 4) % 4)
    blob = header + bytes(table) + vbytes + pad + np.concatenate(ix).tobytes()
    fn = f"geom/{name}.bin"
    with open(os.path.join(OUTDIR, fn), "wb") as f:
        f.write(blob)
    manifest_chunks.append({"name": name, "file": fn, "bytes": len(blob), "elements": len(items), "verts": nV, "tris": nI // 3})
    print(name, len(items), nV, nI // 3, len(blob))

json.dump({
    "source": os.environ.get("IFC_NAME", "model.ifc"),
    "schema": "IFC2X3",
    "lengthUnit": "mm (IFC) -> viewer uses metres",
    "origin_mm": [float(x) for x in origin],
    "chunks": manifest_chunks,
    "skipped": dict(skipped),
    "unsupported": g.unsupported,
    "positionFixes": len(pos_fix),
    "coords": {"display": "Revit project coordinates: IFC coordinates with the IfcSite placement removed, minus origin_mm, in metres",
               "siteRotationDeg": round(site_rot, 4), "siteMatrix": [[round(float(x), 9) for x in r] for r in SITE]},
    "elements": elements,
}, open(os.path.join(OUTDIR, "data", "elements.json"), "w"), ensure_ascii=False, separators=(",", ":"))
print("done", round(time.time() - t0), "s; skipped", dict(skipped), "unsupported", g.unsupported)

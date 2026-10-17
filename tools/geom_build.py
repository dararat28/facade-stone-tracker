"""Tessellate IFC product geometry (the subset of IFC2x3 used by this model).

Supports: IfcFacetedBrep, IfcFaceBasedSurfaceModel, IfcExtrudedAreaSolid
(rectangle / circle / arbitrary closed / arbitrary with voids profiles built
from IfcPolyline, IfcCompositeCurve, IfcTrimmedCurve on IfcCircle),
IfcMappedItem, IfcLocalPlacement chains.  Anything else is reported, never
silently replaced.
"""
import sys, os, math, pickle
import gc
gc.disable()  # batch script: the cyclic GC makes loading large pickles 10-20x slower
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stepparse import Typed, Ref, DERIVED

DEG = math.pi / 180.0
CIRCLE_SEG = 24


class Geo:
    def __init__(self, cache):
        z = np.load(cache + "_geom.npz")
        self.tcode = z["tcode"]; self.tidx = z["tidx"]; self.pts = z["pts"]
        self.loop_ids = z["loop_ids"]; self.loop_off = z["loop_off"]
        self.bnd_loop = z["bnd_loop"]; self.bnd_ori = z["bnd_ori"]; self.bnd_outer = z["bnd_outer"]
        self.face_ids = z["face_ids"]; self.face_off = z["face_off"]
        self.shell_ids = z["shell_ids"]; self.shell_off = z["shell_off"]
        self.G = pickle.load(open(cache + "_ggen.pkl", "rb"))
        self._pl = {}
        self.unsupported = {}

    # ---------- primitives ----------
    def pt(self, r):
        return self.pts[self.tidx[r]]

    def dirv(self, r, default):
        if r is None:
            return np.array(default, dtype=float)
        v = self.G[r][1][0]
        v = list(v) + [0.0] * (3 - len(v))
        return np.array(v, dtype=float)

    def a2p3(self, r):
        _, a = self.G[r]
        o = self.pt(a[0])
        zax = self.dirv(a[1], (0, 0, 1)); zax /= np.linalg.norm(zax)
        x = self.dirv(a[2] if len(a) > 2 else None, (1, 0, 0))
        x = x - x.dot(zax) * zax
        nx = np.linalg.norm(x)
        if nx < 1e-9:
            x = np.array([1.0, 0, 0]) if abs(zax[0]) < 0.9 else np.array([0, 1.0, 0])
            x = x - x.dot(zax) * zax; nx = np.linalg.norm(x)
        x /= nx
        y = np.cross(zax, x)
        M = np.eye(4); M[:3, 0] = x; M[:3, 1] = y; M[:3, 2] = zax; M[:3, 3] = o
        return M

    def a2p2(self, r):
        _, a = self.G[r]
        o = self.pt(a[0])[:2]
        x = self.dirv(a[1], (1, 0))[:2]; x /= np.linalg.norm(x)
        y = np.array([-x[1], x[0]])
        M = np.eye(3); M[:2, 0] = x; M[:2, 1] = y; M[:2, 2] = o
        return M

    def placement(self, r):
        if r is None:
            return np.eye(4)
        if r in self._pl:
            return self._pl[r]
        t, a = self.G[r]
        rel = self.placement(a[0]) if a[0] is not None else np.eye(4)
        M = rel @ self.a2p3(a[1])
        self._pl[r] = M
        return M

    def cto3(self, r):
        _, a = self.G[r]
        sc = a[3] if isinstance(a[3], (int, float)) else 1.0
        x = self.dirv(a[0], (1, 0, 0)); x /= np.linalg.norm(x)
        zz = self.dirv(a[4] if len(a) > 4 else None, (0, 0, 1))
        y = self.dirv(a[1], tuple(np.cross(zz, x)))
        y = y - y.dot(x) * x; y /= np.linalg.norm(y)
        zax = np.cross(x, y)
        M = np.eye(4); M[:3, 0] = x * sc; M[:3, 1] = y * sc; M[:3, 2] = zax * sc; M[:3, 3] = self.pt(a[2])
        return M

    # ---------- 2D curves ----------
    def curve2d(self, r):
        t, a = self.G[r]
        if t == "IFCPOLYLINE":
            return [tuple(self.pt(p)[:2]) for p in a[0]]
        if t == "IFCCOMPOSITECURVE":
            out = []
            for s in a[0]:
                _, sa = self.G[s]
                c = self.curve2d(sa[2])
                if sa[1] == "F":
                    c = c[::-1]
                if out and c and np.hypot(out[-1][0] - c[0][0], out[-1][1] - c[0][1]) < 1e-6:
                    c = c[1:]
                out.extend(c)
            return out
        if t == "IFCTRIMMEDCURVE":
            bt, ba = self.G[a[0]]
            if bt != "IFCCIRCLE":
                self.unsupported[bt] = self.unsupported.get(bt, 0) + 1
                return []
            M = self.a2p2(ba[0]); R = ba[1]
            def ang(trim):
                for v in trim:
                    if isinstance(v, Typed) and v.type == "IFCPARAMETERVALUE":
                        return v.value * DEG
                for v in trim:
                    if isinstance(v, Ref):
                        p = self.pt(v)[:2]
                        loc = np.linalg.inv(M) @ np.array([p[0], p[1], 1.0])
                        return math.atan2(loc[1], loc[0])
                return 0.0
            a1, a2 = ang(a[1]), ang(a[2])
            sense = a[3] != "F"
            if sense:
                while a2 <= a1: a2 += 2 * math.pi
            else:
                while a2 >= a1: a2 -= 2 * math.pi
            n = max(2, int(math.ceil(abs(a2 - a1) / (2 * math.pi) * CIRCLE_SEG)) + 1)
            out = []
            for k in range(n):
                th = a1 + (a2 - a1) * k / (n - 1)
                v = M @ np.array([R * math.cos(th), R * math.sin(th), 1.0])
                out.append((v[0], v[1]))
            return out
        if t == "IFCCIRCLE":
            M = self.a2p2(a[0]); R = a[1]
            return [tuple((M @ np.array([R * math.cos(2 * math.pi * k / CIRCLE_SEG), R * math.sin(2 * math.pi * k / CIRCLE_SEG), 1.0]))[:2]) for k in range(CIRCLE_SEG)]
        self.unsupported[t] = self.unsupported.get(t, 0) + 1
        return []

    def profile(self, r):
        """Return list of loops (outer first) as 2D point lists."""
        t, a = self.G[r]
        if t == "IFCRECTANGLEPROFILEDEF":
            M = self.a2p2(a[2]) if a[2] is not None else np.eye(3)
            hx, hy = a[3] / 2, a[4] / 2
            loop = [tuple((M @ np.array([x, y, 1]))[:2]) for x, y in ((-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy))]
            return [loop]
        if t == "IFCCIRCLEPROFILEDEF":
            M = self.a2p2(a[2]) if a[2] is not None else np.eye(3)
            R = a[3]
            return [[tuple((M @ np.array([R * math.cos(2 * math.pi * k / CIRCLE_SEG), R * math.sin(2 * math.pi * k / CIRCLE_SEG), 1]))[:2]) for k in range(CIRCLE_SEG)]]
        if t == "IFCARBITRARYCLOSEDPROFILEDEF":
            return [self.curve2d(a[2])]
        if t == "IFCARBITRARYPROFILEDEFWITHVOIDS":
            return [self.curve2d(a[2])] + [self.curve2d(c) for c in a[3]]
        self.unsupported[t] = self.unsupported.get(t, 0) + 1
        return []

    # ---------- item meshes (local coords) ----------
    def extrusion(self, a):
        loops = [clean_loop(l) for l in self.profile(a[0])]
        loops = [l for l in loops if len(l) >= 3]
        if not loops:
            return None
        P = self.a2p3(a[1]) if a[1] is not None else np.eye(4)
        d = self.dirv(a[2], (0, 0, 1)); d = d / np.linalg.norm(d) * a[3]
        # orient: outer CCW, holes CW
        loops = [l if (area2(l) > 0) == (i == 0) else l[::-1] for i, l in enumerate(loops)]
        tris2d, flat = triangulate_with_holes(loops)
        n = len(flat)
        bot = np.array([[x, y, 0.0] for x, y in flat])
        top = bot + d
        V = np.vstack([bot, top])
        F = []
        for (i, j, k) in tris2d:
            F.append((i, k, j)); F.append((i + n, j + n, k + n))
        base = 0
        for l in loops:
            m = len(l)
            for q in range(m):
                i0 = base + q; i1 = base + (q + 1) % m
                F.append((i0, i1, i1 + n)); F.append((i0, i1 + n, i0 + n))
            base += m
        if d[2] < 0:
            F = [(i, k, j) for i, j, k in F]
        V = (P[:3, :3] @ V.T).T + P[:3, 3]
        return V, np.array(F, dtype=np.int64)

    def shell_faces(self, shell_ref, Vmap, Vlist, F):
        s = self.tidx[shell_ref]
        for fid in self.shell_ids[self.shell_off[s]:self.shell_off[s + 1]]:
            fi = self.tidx[fid]
            bids = self.face_ids[self.face_off[fi]:self.face_off[fi + 1]]
            loops = []
            for b in bids:
                bi = self.tidx[b]
                li = self.tidx[self.bnd_loop[bi]]
                ids = self.loop_ids[self.loop_off[li]:self.loop_off[li + 1]].tolist()
                if not self.bnd_ori[bi]:
                    ids = ids[::-1]
                if self.bnd_outer[bi]:
                    loops.insert(0, ids)
                else:
                    loops.append(ids)
            local = []
            for ids in loops:
                ll = []
                for pid in ids:
                    k = Vmap.get(pid)
                    if k is None:
                        k = len(Vlist); Vmap[pid] = k; Vlist.append(self.tidx[pid])
                    if not ll or ll[-1] != k:
                        ll.append(k)
                if len(ll) > 1 and ll[0] == ll[-1]:
                    ll.pop()
                if len(ll) >= 3:
                    local.append(ll)
            if not local:
                continue
            if len(local) == 1 and len(local[0]) == 3:
                F.append(tuple(local[0])); continue
            P3 = [self.pts[np.array([Vlist[k] for k in ll])] for ll in local]
            for tri in triangulate_3d(P3, local):
                F.append(tri)

    def item(self, r):
        t, a = self.G[r]
        if t == "IFCEXTRUDEDAREASOLID":
            return [self.extrusion(a)]
        if t in ("IFCFACETEDBREP", "IFCFACEBASEDSURFACEMODEL"):
            shells = [a[0]] if t == "IFCFACETEDBREP" else a[0]
            Vmap, Vlist, F = {}, [], []
            for s in shells:
                self.shell_faces(s, Vmap, Vlist, F)
            if not F:
                return [None]
            return [(self.pts[np.array(Vlist)], np.array(F, dtype=np.int64))]
        if t == "IFCMAPPEDITEM":
            _, ma = self.G[a[0]]
            O = self.a2p3(ma[0]) if self.G[ma[0]][0] == "IFCAXIS2PLACEMENT3D" else np.eye(4)
            T = self.cto3(a[1])
            M = T @ O
            out = []
            for it in self.G[ma[1]][1][3]:
                for m in self.item(it):
                    if m is not None:
                        V, F = m
                        out.append(((M[:3, :3] @ V.T).T + M[:3, 3], F))
            return out
        self.unsupported[t] = self.unsupported.get(t, 0) + 1
        return [None]

    def product_mesh(self, placement, rep):
        if rep is None:
            return None
        M = self.placement(placement)
        Vs, Fs, off = [], [], 0
        for sr in self.G[rep][1][2]:
            st, sa = self.G[sr]
            if sa[1] != "Body":
                continue
            for it in sa[3]:
                for m in self.item(it):
                    if m is None:
                        continue
                    V, F = m
                    Vs.append(V); Fs.append(F + off); off += len(V)
        if not Vs:
            return None
        V = np.vstack(Vs); F = np.vstack(Fs)
        V = (M[:3, :3] @ V.T).T + M[:3, 3]
        return V, F


# ---------- polygon helpers ----------
def area2(l):
    s = 0.0
    for i in range(len(l)):
        x1, y1 = l[i]; x2, y2 = l[(i + 1) % len(l)]
        s += x1 * y2 - x2 * y1
    return s


def clean_loop(l):
    out = []
    for p in l:
        if not out or abs(out[-1][0] - p[0]) + abs(out[-1][1] - p[1]) > 1e-6:
            out.append(p)
    if len(out) > 1 and abs(out[0][0] - out[-1][0]) + abs(out[0][1] - out[-1][1]) < 1e-6:
        out.pop()
    return out


def ear_clip(poly):
    """poly: list of (x,y) CCW. returns triangles as index triples into poly."""
    n = len(poly)
    if n < 3:
        return []
    if n == 3:
        return [(0, 1, 2)]
    idx = list(range(n))
    tris = []
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    guard = 0
    while len(idx) > 3 and guard < 5 * n * n:
        m = len(idx)
        found = False
        for k in range(m):
            i0, i1, i2 = idx[(k - 1) % m], idx[k], idx[(k + 1) % m]
            a, b, c = poly[i0], poly[i1], poly[i2]
            if cross(a, b, c) <= 1e-12:
                continue
            ok = True
            for j in idx:
                if j in (i0, i1, i2):
                    continue
                p = poly[j]
                if p == a or p == b or p == c:
                    continue
                if cross(a, b, p) >= 0 and cross(b, c, p) >= 0 and cross(c, a, p) >= 0:
                    ok = False; break
            if ok:
                tris.append((i0, i1, i2)); idx.pop(k); found = True
                break
            guard += 1
        if not found:
            # degenerate / self-touching: fall back to fan for the rest
            for k in range(1, len(idx) - 1):
                tris.append((idx[0], idx[k], idx[k + 1]))
            return tris
    if len(idx) == 3:
        tris.append(tuple(idx))
    return tris


def bridge_holes(loops):
    """Merge holes into the outer loop via bridges. loops: outer CCW, holes CW.
    Returns (merged list of original-flat indices, flat point list)."""
    flat = []
    idxloops = []
    for l in loops:
        idxloops.append(list(range(len(flat), len(flat) + len(l))))
        flat.extend(l)
    outer = idxloops[0]
    holes = sorted(idxloops[1:], key=lambda h: -max(flat[i][0] for i in h))
    for h in holes:
        hi = max(h, key=lambda i: flat[i][0])
        hp = flat[hi]
        best, bd = None, None
        for oi in outer:
            op = flat[oi]
            if op[0] < hp[0] - 1e-9:
                continue
            d = (op[0] - hp[0]) ** 2 + (op[1] - hp[1]) ** 2
            if bd is None or d < bd:
                best, bd = oi, d
        if best is None:
            best = min(outer, key=lambda oi: (flat[oi][0] - hp[0]) ** 2 + (flat[oi][1] - hp[1]) ** 2)
        k = outer.index(best)
        j = h.index(hi)
        hseq = h[j:] + h[:j]
        outer = outer[:k + 1] + hseq + [hseq[0], best] + outer[k + 1:]
    return outer, flat


def triangulate_with_holes(loops):
    if len(loops) == 1:
        return ear_clip(loops[0]), loops[0]
    merged, flat = bridge_holes(loops)
    poly = [flat[i] for i in merged]
    tris = ear_clip(poly)
    return [(merged[a], merged[b], merged[c]) for a, b, c in tris], flat


def triangulate_3d(P3, local):
    """P3: list of (n,3) arrays per loop; local: matching vertex indices."""
    outer = P3[0]
    # Newell normal
    nrm = np.zeros(3)
    for i in range(len(outer)):
        a = outer[i]; b = outer[(i + 1) % len(outer)]
        nrm += np.array([(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])])
    ln = np.linalg.norm(nrm)
    if ln < 1e-12:
        return []
    nrm /= ln
    ax = int(np.argmax(np.abs(nrm)))
    u, v = [(1, 2), (2, 0), (0, 1)][ax]
    sign = 1.0 if nrm[ax] > 0 else -1.0
    loops2 = [[(p[u], p[v] * sign) for p in L] for L in P3]
    flatidx = [k for ll in local for k in ll]
    if len(loops2) == 1 and len(loops2[0]) == 4:
        # convex quad fast path
        q = loops2[0]
        def cr(o, a, b): return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
        if all(cr(q[i], q[(i + 1) % 4], q[(i + 2) % 4]) > 0 for i in range(4)):
            L = local[0]
            return [(L[0], L[1], L[2]), (L[0], L[2], L[3])]
    # ensure outer CCW, holes CW in this projection
    fixed = []
    for i, l in enumerate(loops2):
        ccw = area2(l) > 0
        fixed.append(l if ccw == (i == 0) else None)
    rev = [f is None for f in fixed]
    loops2 = [l[::-1] if r else l for l, r in zip(loops2, rev)]
    loc = [ll[::-1] if r else ll for ll, r in zip(local, rev)]
    flatidx = [k for ll in loc for k in ll]
    tris, _ = triangulate_with_holes(loops2)
    out = [(flatidx[a], flatidx[b], flatidx[c]) for a, b, c in tris]
    if rev[0]:
        out = [(a, c, b) for a, b, c in out]
    return out

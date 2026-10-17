"""Stream the IFC once and store geometry entities in compact arrays.

Heavy entity types (points, polyloops, faces, bounds, shells) go into flat
numpy-backed arrays; the few thousand other geometry entities are parsed
generically.  Output: one .npz + one .pkl in the cache folder.
"""
import sys, os, re, pickle, time
import gc
gc.disable()  # batch script: the cyclic GC makes loading large pickles 10-20x slower
from array import array
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stepparse import parse_line, open_ifc

SRC, OUT = sys.argv[1], sys.argv[2]
MAXID = 26_000_000

T_PT, T_LOOP, T_BOUND, T_FACE, T_SHELL = 1, 2, 3, 4, 5
tcode = np.zeros(MAXID, dtype=np.uint8)
tidx = np.full(MAXID, -1, dtype=np.int32)

pts = array("d")          # x,y,z triplets
loop_ids = array("i"); loop_off = array("q", [0])
bnd_loop = array("i"); bnd_ori = array("b"); bnd_outer = array("b")
face_ids = array("i"); face_off = array("q", [0])
shell_ids = array("i"); shell_off = array("q", [0])

GENERIC = {
    "IFCDIRECTION", "IFCAXIS2PLACEMENT3D", "IFCAXIS2PLACEMENT2D", "IFCLOCALPLACEMENT",
    "IFCPRODUCTDEFINITIONSHAPE", "IFCSHAPEREPRESENTATION", "IFCFACETEDBREP",
    "IFCFACEBASEDSURFACEMODEL", "IFCEXTRUDEDAREASOLID", "IFCRECTANGLEPROFILEDEF",
    "IFCARBITRARYCLOSEDPROFILEDEF", "IFCARBITRARYPROFILEDEFWITHVOIDS", "IFCCIRCLEPROFILEDEF",
    "IFCPOLYLINE", "IFCCOMPOSITECURVE", "IFCCOMPOSITECURVESEGMENT", "IFCTRIMMEDCURVE",
    "IFCCIRCLE", "IFCMAPPEDITEM", "IFCREPRESENTATIONMAP", "IFCCARTESIANTRANSFORMATIONOPERATOR3D",
    "IFCSTYLEDITEM", "IFCPRESENTATIONSTYLEASSIGNMENT", "IFCSURFACESTYLE", "IFCSURFACESTYLERENDERING",
    "IFCCOLOURRGB", "IFCGEOMETRICREPRESENTATIONCONTEXT", "IFCGEOMETRICREPRESENTATIONSUBCONTEXT",
}
generic = {}

num = re.compile(rb"-?[0-9.]+(?:E[-+]?[0-9]+)?")
ref = re.compile(rb"#([0-9]+)")

t0 = time.time()
n = 0
with open_ifc(SRC) as f:
    for raw in f:
        if raw[:1] != b"#":
            continue
        eq = raw.index(b"=")
        p = raw.index(b"(", eq)
        t = raw[eq + 1:p]
        eid = int(raw[1:eq])
        if t == b"IFCPOLYLOOP":
            tcode[eid] = T_LOOP; tidx[eid] = len(loop_off) - 1
            loop_ids.extend(int(x) for x in ref.findall(raw, p))
            loop_off.append(len(loop_ids))
        elif t == b"IFCFACE":
            tcode[eid] = T_FACE; tidx[eid] = len(face_off) - 1
            face_ids.extend(int(x) for x in ref.findall(raw, p))
            face_off.append(len(face_ids))
        elif t == b"IFCFACEOUTERBOUND" or t == b"IFCFACEBOUND":
            tcode[eid] = T_BOUND; tidx[eid] = len(bnd_loop)
            m = ref.search(raw, p)
            bnd_loop.append(int(m.group(1)))
            bnd_ori.append(0 if b".F." in raw[m.end():] else 1)
            bnd_outer.append(1 if t == b"IFCFACEOUTERBOUND" else 0)
        elif t == b"IFCCARTESIANPOINT":
            tcode[eid] = T_PT; tidx[eid] = len(pts) // 3
            v = [float(x) for x in num.findall(raw, p)]
            if len(v) == 2:
                v.append(0.0)
            pts.extend(v[:3])
        elif t == b"IFCCLOSEDSHELL" or t == b"IFCCONNECTEDFACESET" or t == b"IFCOPENSHELL":
            tcode[eid] = T_SHELL; tidx[eid] = len(shell_off) - 1
            shell_ids.extend(int(x) for x in ref.findall(raw, p))
            shell_off.append(len(shell_ids))
        else:
            ts = t.decode()
            if ts in GENERIC:
                _, tt, args = parse_line(raw.decode("utf-8", "replace").rstrip())
                generic[eid] = (tt, args)
        n += 1
        if n % 5_000_000 == 0:
            print(n, round(time.time() - t0), flush=True)

np.savez(OUT + "_geom.npz", tcode=tcode, tidx=tidx,
         pts=np.frombuffer(pts, dtype=np.float64).reshape(-1, 3),
         loop_ids=np.frombuffer(loop_ids, dtype=np.int32), loop_off=np.frombuffer(loop_off, dtype=np.int64),
         bnd_loop=np.frombuffer(bnd_loop, dtype=np.int32), bnd_ori=np.frombuffer(bnd_ori, dtype=np.int8),
         bnd_outer=np.frombuffer(bnd_outer, dtype=np.int8),
         face_ids=np.frombuffer(face_ids, dtype=np.int32), face_off=np.frombuffer(face_off, dtype=np.int64),
         shell_ids=np.frombuffer(shell_ids, dtype=np.int32), shell_off=np.frombuffer(shell_off, dtype=np.int64))
pickle.dump(generic, open(OUT + "_ggen.pkl", "wb"), protocol=5)
print("done", n, "lines", round(time.time() - t0), "s; generic", len(generic))

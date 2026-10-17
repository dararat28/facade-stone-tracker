"""Pass 1 over the IFC: build a byte-offset index for every entity and parse the
semantic (non-geometry) entities into a pickle for inspection and data export."""
import sys, os, pickle, time, numpy as np
import gc
gc.disable()  # batch script: the cyclic GC makes loading large pickles 10-20x slower
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stepparse import parse_line, open_ifc

SRC, OUT = sys.argv[1], sys.argv[2]

KEEP = {
    "IFCPROJECT", "IFCSITE", "IFCBUILDING", "IFCBUILDINGSTOREY",
    "IFCBUILDINGELEMENTPROXY", "IFCELEMENTASSEMBLY", "IFCWINDOW", "IFCSLAB",
    "IFCBUILDINGELEMENTPROXYTYPE", "IFCTYPEPRODUCT", "IFCWINDOWSTYLE", "IFCSLABTYPE",
    "IFCPROPERTYSET", "IFCPROPERTYSINGLEVALUE", "IFCRELDEFINESBYPROPERTIES",
    "IFCRELDEFINESBYTYPE", "IFCRELAGGREGATES", "IFCRELCONTAINEDINSPATIALSTRUCTURE",
    "IFCGROUP", "IFCRELASSIGNSTOGROUP", "IFCPRESENTATIONLAYERASSIGNMENT",
    "IFCSIUNIT", "IFCUNITASSIGNMENT", "IFCCONVERSIONBASEDUNIT",
    "IFCPRODUCTDEFINITIONSHAPE", "IFCSHAPEREPRESENTATION",
}

t0 = time.time()
maxid = 26_000_000
offs = np.full(maxid, -1, dtype=np.int64)
ents = {}
bad = 0
pos = 0
with open_ifc(SRC) as f:
    for raw in f:
        if raw[:1] == b"#":
            eq = raw.index(b"=")
            eid = int(raw[1:eq])
            offs[eid] = pos
            p = raw.index(b"(", eq)
            t = raw[eq + 1:p].strip().decode()
            if t in KEEP:
                line = raw.decode("utf-8", "replace").rstrip()
                if not line.endswith(";"):
                    bad += 1
                _, _, args = parse_line(line)
                ents[eid] = (t, args)
        pos += len(raw)
with open(OUT + "_sem.pkl", "wb") as f:
    pickle.dump(ents, f, protocol=5)
print("entities kept", len(ents), "multi-line suspects", bad, "time", round(time.time() - t0, 1))

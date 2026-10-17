"""Resolve instance- and type-level properties for every IFC product."""
import sys, os, pickle, collections
import gc
gc.disable()  # batch script: the cyclic GC makes loading large pickles 10-20x slower
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stepparse import Typed

ents = pickle.load(open(sys.argv[1], "rb"))
PRODUCTS = {"IFCBUILDINGELEMENTPROXY", "IFCELEMENTASSEMBLY", "IFCWINDOW", "IFCSLAB"}


def pval(v):
    if isinstance(v, Typed):
        return v.value
    return v


def pset_props(psid):
    t, a = ents[psid]
    name = a[2]
    props = {}
    for r in a[4]:
        pt, pa = ents.get(r, (None, None))
        if pt == "IFCPROPERTYSINGLEVALUE":
            props[pa[0]] = pval(pa[2])
    return name, props


inst = collections.defaultdict(dict)      # elem -> {pset:{k:v}}
typeof = {}
typeps = {}
parent = {}
container = {}
for eid, (t, a) in ents.items():
    if t == "IFCRELDEFINESBYPROPERTIES":
        if ents.get(a[5], ("",))[0] != "IFCPROPERTYSET":
            continue
        n, p = pset_props(a[5])
        for o in a[4]:
            inst[o][n] = p
    elif t == "IFCRELDEFINESBYTYPE":
        for o in a[4]:
            typeof[o] = a[5]
    elif t == "IFCRELAGGREGATES":
        for o in a[5]:
            parent[o] = a[4]
    elif t == "IFCRELCONTAINEDINSPATIALSTRUCTURE":
        for o in a[4]:
            container[o] = a[5]

for eid, (t, a) in ents.items():
    if (t.endswith("TYPE") and not t.startswith("IFCREL")) or t in ("IFCTYPEPRODUCT", "IFCWINDOWSTYLE"):
        ps = {}
        if a[5]:
            for r in a[5]:
                if ents.get(r, ("",))[0] == "IFCPROPERTYSET":
                    n, p = pset_props(r)
                    ps[n] = p
        typeps[eid] = (a[2], ps)

products = {}
for eid, (t, a) in ents.items():
    if t in PRODUCTS:
        tid = typeof.get(eid)
        products[eid] = dict(
            id=eid, cls=t, gid=a[0], name=a[2], objtype=a[4], placement=a[5], rep=a[6], tag=a[7],
            inst=inst.get(eid, {}), type=tid, type_name=typeps.get(tid, (None,))[0],
            type_ps=typeps.get(tid, (None, {}))[1], parent=parent.get(eid), container=container.get(eid),
        )
pickle.dump(products, open(sys.argv[2], "wb"), protocol=5)
print("products", len(products))

#!/usr/bin/env python3
"""Write CSV reports (reports/*.csv) from the dashboard data, i.e. from the IFC model
and the PDF / STL file indexes. Excel is not used.

    python tools/report.py [app folder]

  ifc_stones.csv          one row per IFC stone: ticket, elevation, phase, Issue Status,
                          T-31-Count, T-31(30mm.)-Count (raw value + state), files, flags
  tickets.csv             one row per ticket: element count, elevations, Issue Status values,
                          hole totals, PDF / STL found, STL expected (Issue Status mentions STL)
  file_matching.csv       missing PDF, STL expected but missing, STL without STL status,
                          files that match no IFC ticket
  data_checks.csv         invalid T-31 values, T-31 count without T-31 status, mixed Issue
                          Status per ticket, suspect dimensions, placement repairs, isolated stones
"""
import csv, json, os, re, sys, collections

APP = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(APP, "reports")
os.makedirs(OUT, exist_ok=True)
load = lambda p: json.load(open(os.path.join(APP, "data", p), encoding="utf-8"))
E = load("elements.json")
IDX = {}
for k in ("pdf", "stl"):
    try:
        IDX[k] = load(f"{k}_index.json")
    except FileNotFoundError:
        IDX[k] = {"files": {}, "unmatched": []}
norm = lambda t: re.sub(r"\s+", "", str(t or "")).upper()


def count_state(v):
    if v is None:
        return "absent", None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return ("ok", int(v)) if float(v).is_integer() and v >= 0 else ("invalid", None)
    t = str(v).strip()
    if not t:
        return "empty", None
    return ("ok", int(t)) if t.isdigit() else ("invalid", None)


def cats(v):
    if not isinstance(v, str) or not v.strip():
        return []
    c = []
    if re.search(r"\bSTL\b", v, re.I): c.append("STL file")
    if re.search(r"PIN\s*&\s*GLUED", v, re.I): c.append("Pin & glued")
    if re.search(r"T-31", v, re.I): c.append("T-31 (30 mm stone)" if re.search(r"30\s*mm", v, re.I) else "T-31")
    return c or ["Other"]


stones = [e for e in E["elements"] if e.get("kind") == "stone"]
by_t = collections.defaultdict(list)
for e in stones:
    by_t[norm(e["ticket"])].append(e)
needs_stl = {k: any(re.search(r"\bSTL\b", x.get("issue") or "", re.I) for x in v) for k, v in by_t.items()}
has = {k: {t for t in IDX[k]["files"]} for k in IDX}


def w(name, head, rows):
    with open(os.path.join(OUT, name), "w", newline="", encoding="utf-8-sig") as f:
        cw = csv.writer(f); cw.writerow(head); cw.writerows(rows)
    print(f"{name}: {len(rows)} rows")


rows, checks = [], []
for e in sorted(stones, key=lambda e: (norm(e["ticket"]), e.get("elev") or "")):
    k = norm(e["ticket"])
    s31, n31 = count_state(e.get("t31")); s30, n30 = count_state(e.get("t31_30"))
    sus = [d for d in ("L", "W", "H", "T") if isinstance(e.get(d), (int, float)) and 0 < e[d] < 1]
    rows.append([e["ticket"], e.get("elev", ""), e.get("phase") or e.get("workset", ""), e.get("workset", ""), e.get("issue", ""), "; ".join(cats(e.get("issue"))),
                 e.get("t31", ""), s31, e.get("t31_30", ""), s30, e.get("finish", ""),
                 *[e.get(d, "") for d in ("L", "W", "H", "T")], "yes" if k in has["pdf"] else "no", "yes" if k in has["stl"] else "no",
                 "yes" if needs_stl[k] else "no", "yes" if e.get("posFix") else "", "yes" if e.get("away") else "", " ".join(sus), e["gid"], e.get("revitId", "")])
    if s31 in ("invalid", "empty") or s30 in ("invalid", "empty"):
        checks.append(["Invalid or empty T-31 value", e["ticket"], e.get("elev", ""), f"T-31-Count={e.get('t31')!r} T-31(30mm.)-Count={e.get('t31_30')!r}", e["gid"]])
    if (s31 == "ok" or s30 == "ok") and not any(c.startswith("T-31") for c in cats(e.get("issue"))):
        checks.append(["T-31 count without T-31 Issue Status", e["ticket"], e.get("elev", ""), f"Issue Status={e.get('issue')!r} T-31-Count={e.get('t31')!r} T-31(30mm.)-Count={e.get('t31_30')!r}", e["gid"]])
    if sus:
        checks.append(["Suspect dimension (< 1 mm)", e["ticket"], e.get("elev", ""), ", ".join(f"{d}={e[d]}" for d in sus), e["gid"]])
    if e.get("posFix"):
        checks.append(["Placement repaired", e["ticket"], e.get("elev", ""), f"moved {e['posFix'].get('moved_m')} m", e["gid"]])
    if e.get("away"):
        checks.append(["Isolated stone (> 3 m from others)", e["ticket"], e.get("elev", ""), "", e["gid"]])
w("ifc_stones.csv", ["Ticket", "Elevation", "Phase", "Workset (original)", "Issue Status", "Issue group (derived)", "T-31-Count (IFC)", "T-31-Count state",
                     "T-31(30mm.)-Count (IFC)", "T-31(30mm.)-Count state", "Finish", "Length", "Width", "Height", "Thickness", "Fab Sheet PDF", "STL file",
                     "STL expected", "Placement repaired", "Isolated", "Suspect dimensions", "GlobalId", "Revit ID"], rows)

trows, frows = [], []
for k, v in sorted(by_t.items()):
    iss = sorted({x.get("issue") for x in v if x.get("issue")})
    if len({x.get("issue") or "" for x in v}) > 1:
        checks.append(["Ticket with different Issue Status values", v[0]["ticket"], "", " | ".join(iss) + f" | {sum(1 for x in v if not x.get('issue'))} without", ""])
    h31 = sum(n for s, n in (count_state(x.get("t31")) for x in v) if s == "ok")
    h30 = sum(n for s, n in (count_state(x.get("t31_30")) for x in v) if s == "ok")
    trows.append([v[0]["ticket"], len(v), " ".join(sorted({x.get("elev") or "" for x in v})), " | ".join(iss), h31, h30,
                  "yes" if k in has["pdf"] else "no", "yes" if k in has["stl"] else "no", "yes" if needs_stl[k] else "no"])
    if k not in has["pdf"]:
        frows.append(["Fab Sheet PDF missing", v[0]["ticket"], "", ""])
    if needs_stl[k] and k not in has["stl"]:
        frows.append(["STL expected but missing", v[0]["ticket"], "", " | ".join(iss)])
    if k in has["stl"] and not needs_stl[k]:
        frows.append(["STL file without STL Issue Status", v[0]["ticket"], IDX["stl"]["files"][k]["path"], " | ".join(iss) or "no Issue Status"])
for kind in ("pdf", "stl"):
    for u in IDX[kind].get("unmatched", []):
        frows.append([f"{kind.upper()} file matches no IFC ticket", "", u["file"], u["reason"]])
w("tickets.csv", ["Ticket", "IFC elements", "Elevations", "Issue Status values", "T-31-Count holes", "T-31(30mm.)-Count holes", "Fab Sheet PDF", "STL file", "STL expected"], trows)
w("file_matching.csv", ["Check", "Ticket", "File", "Details"], frows)
w("data_checks.csv", ["Check", "Ticket", "Elevation", "Details", "GlobalId"], checks)

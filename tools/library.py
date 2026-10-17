#!/usr/bin/env python3
"""File libraries linked to IFC ticket numbers: Fab Sheet PDFs and STL files.

    python tools/library.py index                  rebuild data/pdf_index.json and data/stl_index.json
    python tools/library.py import pdf <zip|file|folder> ...
    python tools/library.py import stl <zip|file|folder> ...

One file per ticket, named exactly like the IFC ticket number:
    fab-sheets/<TICKET>.pdf   (extra sheets: <TICKET>__2.pdf ...)
    stl/<TICKET>.stl
Accepted incoming names (case and spaces ignored): TICKET.ext, TICKET - TICKET.ext,
TICKET__2.ext / TICKET (2).ext (PDF only). A ticket written without leading zeros
(AC-5) is matched to AC-005 only if that match is unique. The list of valid tickets
comes from the IFC export (data/elements.json), never from Excel.
A replaced file is moved to <folder>/_archive/<date-time>/ and logged in
<folder>/_imports.json. Standard library only (used by server.py and the GitHub
Pages workflow).
"""
import datetime, hashlib, json, os, re, shutil, struct, sys, zipfile

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KINDS = {
    "pdf": {"folder": "fab-sheets", "ext": ".pdf", "index": "pdf_index.json", "sheets": True,
            "convention": "fab-sheets/<TICKET>.pdf (extra sheets <TICKET>__2.pdf ...)"},
    "stl": {"folder": "stl", "ext": ".stl", "index": "stl_index.json", "sheets": False,
            "convention": "stl/<TICKET>.stl"},
}


def norm(t):
    return re.sub(r"\s+", "", str(t or "")).upper()


def known_tickets():
    """Ticket numbers of the IFC stones (data/elements.json)."""
    try:
        with open(os.path.join(APP, "data", "elements.json"), encoding="utf-8") as f:
            return {norm(e["ticket"]) for e in json.load(f)["elements"] if e.get("kind") == "stone" and e.get("ticket")}
    except Exception:
        return set()


def _unpad(k):
    return re.sub(r"(?<=-)0+(?=\d)", "", k)


def parse_name(kind, name, tickets):
    """Return (ticket, sheet_no, note) or (None, None, reason)."""
    K = KINDS[kind]
    base = os.path.basename(name.replace("\\", "/"))
    if not base.lower().endswith(K["ext"]):
        return None, None, f"not a {K['ext']} file name"
    stem = base[:-len(K["ext"])]
    sheet = 1
    if K["sheets"]:
        m = re.match(r"^(.*?)(?:__(\d+)|\s*\((\d+)\))$", stem)
        if m and (m.group(2) or m.group(3)):
            stem, sheet = m.group(1), int(m.group(2) or m.group(3))
    parts = [p for p in re.split(r"\s+-\s+", stem.strip()) if p]
    if len(parts) == 2 and norm(parts[0]) == norm(parts[1]):
        key = norm(parts[0])
    elif len(parts) == 1:
        key = norm(parts[0])
    else:
        return None, None, f"name is not 'TICKET{K['ext']}' or 'TICKET - TICKET{K['ext']}'"
    if not tickets or key in tickets:
        return key, sheet, None
    cands = [t for t in tickets if _unpad(t) == _unpad(key)]
    if len(cands) == 1:
        return cands[0], sheet, f"'{key}' matched to {cands[0]} (leading zeros)"
    return None, None, f"ticket '{key}' is not in the IFC model"


def check_content(kind, data):
    """None if the bytes look like the file type, else a reason."""
    if kind == "pdf":
        return None if data.startswith(b"%PDF-") else "not a PDF file (no %PDF header)"
    if len(data) >= 84:
        n = struct.unpack("<I", data[80:84])[0]
        if 84 + 50 * n == len(data) and n > 0:
            return None                      # binary STL
    head = data[:1024].lstrip().lower()
    if head.startswith(b"solid") and b"facet" in data[:200000].lower() and b"vertex" in data[:200000].lower():
        return None                          # ASCII STL
    return "not an STL file (neither binary nor ASCII STL)"


def std_name(kind, key, sheet):
    ext = KINDS[kind]["ext"]
    return f"{key}{ext}" if sheet == 1 else f"{key}__{sheet}{ext}"


def _paths(kind):
    K = KINDS[kind]
    folder = os.path.join(APP, K["folder"])
    return folder, os.path.join(APP, "data", K["index"]), os.path.join(folder, "_imports.json")


def read_log(kind):
    try:
        with open(_paths(kind)[2], encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def build_index(kind, write=True):
    K = KINDS[kind]
    folder, index, _ = _paths(kind)
    tickets = known_tickets()
    files, unmatched, ignored = {}, [], []
    if os.path.isdir(folder):
        for fn in sorted(os.listdir(folder)):
            full = os.path.join(folder, fn)
            if not os.path.isfile(full) or fn.startswith((".", "_")) or fn.lower().endswith((".txt", ".md")):
                continue
            if not fn.lower().endswith(K["ext"]):
                ignored.append(fn); continue
            key, sheet, note = parse_name(kind, fn, tickets)
            if not key:
                unmatched.append({"file": fn, "reason": note}); continue
            st = os.stat(full)
            files.setdefault(key, []).append({"path": fn, "bytes": st.st_size, "sheet": sheet,
                                             "mtime": datetime.datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds")})
    last = {}
    for e in read_log(kind):
        last[e["ticket"]] = e
    out = {}
    for k, v in files.items():
        v.sort(key=lambda r: r["sheet"])
        rec = {"path": v[0]["path"], "bytes": v[0]["bytes"], "mtime": v[0]["mtime"]}
        if len(v) > 1:
            rec["sheets"] = [r["path"] for r in v]
        if k in last:
            rec["imported"] = last[k]["time"]; rec["replaced"] = bool(last[k].get("replaced"))
        out[k] = rec
    idx = {"base": K["folder"] + "/", "convention": K["convention"],
           "generated": datetime.datetime.now().isoformat(timespec="seconds"),
           "files": out, "unmatched": unmatched, "ignored": ignored,
           "ticketsWithoutFile": sorted(tickets - set(out))}
    if write:
        tmp = index + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(idx, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, index)
    return idx


def import_file(kind, name, data, tickets=None, stamp=None, source=None):
    """Store one file under its standard name. Returns a result dict
    (status added / replaced / unchanged / rejected)."""
    tickets = tickets if tickets is not None else known_tickets()
    key, sheet, note = parse_name(kind, name, tickets)
    if not key:
        return {"file": name, "status": "rejected", "reason": note}
    bad = check_content(kind, data)
    if bad:
        return {"file": name, "ticket": key, "status": "rejected", "reason": bad}
    folder, _, log_path = _paths(kind)
    os.makedirs(folder, exist_ok=True)
    dest_name = std_name(kind, key, sheet)
    dest = os.path.join(folder, dest_name)
    sha = hashlib.sha256(data).hexdigest()
    archived = None
    if os.path.exists(dest):
        with open(dest, "rb") as f:
            if hashlib.sha256(f.read()).hexdigest() == sha:
                return {"file": name, "ticket": key, "status": "unchanged", "path": dest_name}
        stamp = stamp or datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        archived = f"_archive/{stamp}/{dest_name}"
        os.makedirs(os.path.dirname(os.path.join(folder, archived)), exist_ok=True)
        shutil.move(dest, os.path.join(folder, archived))
    tmp = dest + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, dest)
    entry = {"time": datetime.datetime.now().isoformat(timespec="seconds"), "ticket": key, "file": name, "source": source,
             "path": dest_name, "bytes": len(data), "sha256": sha, "replaced": bool(archived), "archivedTo": archived}
    log = read_log(kind); log.append(entry)
    with open(log_path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(log, f, ensure_ascii=False, indent=1)
    os.replace(log_path + ".tmp", log_path)
    return {"status": "replaced" if archived else "added", **({"note": note} if note else {}), **entry}


def iter_inputs(paths):
    for p in paths:
        if os.path.isdir(p):
            for dp, dn, fn in os.walk(p):
                dn[:] = [d for d in dn if not d.startswith("_")]
                for f in fn:
                    with open(os.path.join(dp, f), "rb") as fh:
                        yield f, fh.read(), p
        elif p.lower().endswith(".zip"):
            z = zipfile.ZipFile(p)
            for info in z.infolist():
                n = info.filename
                if info.is_dir() or n.startswith("/") or ".." in n.split("/"):
                    continue
                yield n.split("/")[-1], z.read(info), os.path.basename(p)
        else:
            with open(p, "rb") as fh:
                yield os.path.basename(p), fh.read(), None


def import_many(kind, paths):
    tickets = known_tickets()
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    seen, counts, rows = {}, {}, []
    for name, data, src in iter_inputs(paths):
        if not name.lower().endswith(KINDS[kind]["ext"]):
            continue
        key, sheet, _ = parse_name(kind, name, tickets)
        if key and (key, sheet) in seen:
            r = {"file": name, "status": "rejected", "reason": f"same ticket as {seen[(key, sheet)]} in this import"}
        else:
            r = import_file(kind, name, data, tickets, stamp, src)
            if key:
                seen[(key, sheet)] = name
        counts[r["status"]] = counts.get(r["status"], 0) + 1
        rows.append(r)
    return counts, rows


def main():
    a = sys.argv[1:]
    if not a or a[0] not in ("index", "import") or (a[0] == "import" and (len(a) < 3 or a[1] not in KINDS)):
        print(__doc__); sys.exit(1)
    if a[0] == "import":
        counts, rows = import_many(a[1], a[2:])
        for r in rows:
            if r["status"] == "rejected" or r.get("note"):
                print(f"  {r['status']:9} {r['file']}: {r.get('reason') or r.get('note')}")
        print(f"import {a[1]}:", counts)
    for kind in KINDS:
        idx = build_index(kind)
        print(f"{kind} index: {len(idx['files'])} tickets with a file, {len(idx['ticketsWithoutFile'])} without, "
              f"{len(idx['unmatched'])} unmatched files, {len(idx['ignored'])} ignored")


if __name__ == "__main__":
    main()

"""Check that each Fab Sheet PDF's drawing text contains its own ticket number
(guards against mis-named files). Also captures the title-block line."""
import sys, os, re, json, glob
import pdfplumber

root, out = sys.argv[1], sys.argv[2]
res = {}
files = sorted(glob.glob(os.path.join(root, "**", "*.pdf"), recursive=True))
for i, f in enumerate(files):
    base = os.path.basename(f)
    m = re.match(r"^(.+?) - (.+?)\.pdf$", base, re.I)
    key = re.sub(r"\s+", "", m.group(1)).upper() if m else None
    try:
        with pdfplumber.open(f) as p:
            text = "\n".join((pg.extract_text() or "") for pg in p.pages)
            pages = len(p.pages)
        toks = set(re.findall(r"[A-Z0-9]+-[0-9]+[A-Z]*", text.upper()))
        title = None
        mm = re.search(r"TICKET NUMBER[^\n]*\n([^\n]+)", text)
        if mm:
            title = mm.group(1).strip()[:120]
        res[os.path.relpath(f, root)] = {"key": key, "pages": pages, "ticketInText": key in toks,
                                         "otherTickets": sorted(t for t in toks if t != key and re.match(r"^[0-9A-Z]{1,4}-[0-9]{3}[A-Z]{0,2}$", t))[:10],
                                         "titleRow": title}
    except Exception as e:
        res[os.path.relpath(f, root)] = {"key": key, "error": str(e)[:200]}
    if i % 200 == 0:
        print(i, len(files), flush=True)
json.dump(res, open(out, "w"), ensure_ascii=False, indent=0)
bad = [k for k, v in res.items() if not v.get("ticketInText")]
print("checked", len(res), "ticket not found in text:", len(bad), bad[:30])

#!/usr/bin/env python3
"""Rebuild the dashboard model from the IFC file (the only data source of the dashboard).

    python tools/build_all.py --ifc "model.ifc or model.zip" [--pdf fab-sheets.zip,...] [--stl stl.zip,...]

--pdf / --stl (optional) take ZIPs, files or folders (comma separated); they are copied
into fab-sheets/<TICKET>.pdf and stl/<TICKET>.stl. Without them the existing folders are
just re-indexed. No Excel file is read. Needs Python 3.9+ with numpy (pip install numpy).
Nothing is uploaded anywhere.

Same result without Python: the dashboard's Import > IFC model button, or
    node --max-old-space-size=6144 tools/ifc-convert.mjs model.zip .
Steps: IFC properties -> IFC geometry -> geom/*.bin + data/elements.json -> file indexes.
Temporary files go to tools/_cache (about 1 GB for a 1.4 GB IFC; delete afterwards).
"""
import argparse, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)


def run(script, *args, env=None):
    t = time.time()
    print(f"\n== {script} {' '.join(os.path.basename(a) for a in args)}", flush=True)
    subprocess.run([sys.executable, os.path.join(HERE, script), *args], check=True, env=env)
    print(f"   done in {time.time() - t:.0f} s", flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ifc", required=True)
    ap.add_argument("--pdf", default=None)
    ap.add_argument("--stl", default=None)
    a = ap.parse_args()
    cache = os.path.join(HERE, "_cache")
    os.makedirs(cache, exist_ok=True)
    env = dict(os.environ)
    ifc_name = os.path.basename(a.ifc)
    if ifc_name.lower().endswith(".zip"):
        import zipfile
        names = [n for n in zipfile.ZipFile(a.ifc).namelist() if n.lower().endswith(".ifc")]
        ifc_name = os.path.basename(names[0]) if names else ifc_name
    env["IFC_NAME"] = ifc_name
    m = os.path.join(cache, "m")
    run("ifc_pass1.py", a.ifc, m, env=env)
    run("ifc_props.py", m + "_sem.pkl", os.path.join(cache, "products.pkl"), env=env)
    run("geom_load.py", a.ifc, m, env=env)
    run("export_geom.py", cache, APP, env=env)
    for kind, src in (("pdf", a.pdf), ("stl", a.stl)):
        if src:
            run("library.py", "import", kind, *src.split(","), env=env)
    run("library.py", "index", env=env)
    run("report.py", APP, env=env)
    print("\nAll done. Start the dashboard with:  python server.py --open")


if __name__ == "__main__":
    main()

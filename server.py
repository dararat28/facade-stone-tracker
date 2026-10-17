#!/usr/bin/env python3
"""Local server for the Façade Stone Dashboard (Python 3.8+, standard library only).

    python server.py --open          start and open the browser (http://127.0.0.1:8080/)
    python server.py --port 9000
    python server.py --host 0.0.0.0  let colleagues on the LAN view it

The dashboard itself is a static site (it also runs on GitHub Pages). This server
adds saving of imports, so every user of this server sees them:
  * Fab Sheet PDFs  -> fab-sheets/<TICKET>.pdf  (old file -> fab-sheets/_archive/<date-time>/)
  * STL files       -> stl/<TICKET>.stl         (old file -> stl/_archive/<date-time>/)
  * a new IFC model, converted in the browser -> data/elements.json + geom/*.bin
    (the previous model is moved to _archive/model-<date-time>/ first)
The file indexes data/pdf_index.json and data/stl_index.json are rebuilt after each change.

Imports are accepted only from this computer unless --allow-remote-import is
given. There is no login: do not expose this server to the internet.
"""
import argparse, datetime, http.server, json, os, re, secrets, shutil, socketserver, sys, threading, urllib.parse

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import library  # noqa: E402

MAX_FILE = 300 * 1024 * 1024
INCOMING = os.path.join(ROOT, "_incoming")
MODEL_FILE = re.compile(r"^(data/elements\.json|geom/[A-Za-z0-9_\-]{1,40}\.bin)$")
LOCK = threading.Lock()


class Handler(http.server.SimpleHTTPRequestHandler):
    allow_remote = False

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def end_headers(self):
        p = urllib.parse.urlparse(self.path).path
        if p.startswith(("/api/", "/fab-sheets/", "/stl/", "/data/", "/geom/")):
            self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def guess_type(self, path):
        p = str(path)
        if p.endswith(".bin"):
            return "application/octet-stream"
        if p.endswith(".mjs"):
            return "text/javascript"
        return super().guess_type(path)

    def list_directory(self, path):
        self.send_error(403, "Directory listing disabled")
        return None

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _local(self):
        return self.client_address[0] in ("127.0.0.1", "::1", "::ffff:127.0.0.1")

    def do_GET(self):
        p = urllib.parse.urlparse(self.path).path
        if p == "/api/status":
            return self._json(200, {"server": True, "import": self.allow_remote or self._local()})
        if "/_" in p or p.endswith((".py", ".pkl")) or p.startswith(("/tools/", "/reports/")):
            return self.send_error(404)
        return super().do_GET()

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            n = 0
        if n <= 0 or n > MAX_FILE:
            return None
        return self.rfile.read(n)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        arg = lambda k: (q.get(k) or [""])[0]
        if not u.path.startswith("/api/"):
            return self.send_error(404)
        if not (self.allow_remote or self._local()):
            return self._json(403, {"status": "rejected", "ok": False, "reason": "Imports are only accepted on the computer running server.py."})
        if u.path == "/api/library":
            kind, name = arg("kind"), arg("name")
            if kind not in library.KINDS:
                return self._json(400, {"status": "rejected", "reason": "unknown kind"})
            data = self._body()
            if data is None:
                return self._json(413, {"file": name, "status": "rejected", "reason": "empty or larger than 300 MB"})
            with LOCK:
                r = library.import_file(kind, name, data, source="dashboard")
                if r["status"] in ("added", "replaced"):
                    library.build_index(kind)
            return self._json(200, r)
        if u.path == "/api/model/begin":
            tok = secrets.token_hex(8)
            os.makedirs(os.path.join(INCOMING, tok, "geom"), exist_ok=True)
            os.makedirs(os.path.join(INCOMING, tok, "data"), exist_ok=True)
            return self._json(200, {"token": tok})
        tok = arg("token")
        stage = os.path.join(INCOMING, tok)
        if not re.fullmatch(r"[0-9a-f]{16}", tok) or not os.path.isdir(stage):
            return self._json(400, {"ok": False, "reason": "unknown upload"})
        if u.path == "/api/model/file":
            rel = arg("path")
            if not MODEL_FILE.match(rel):
                return self._json(400, {"ok": False, "reason": "file name not allowed"})
            data = self._body()
            if data is None:
                return self._json(413, {"ok": False, "reason": "empty or too large"})
            with open(os.path.join(stage, rel), "wb") as f:
                f.write(data)
            return self._json(200, {"ok": True})
        if u.path == "/api/model/commit":
            with LOCK:
                try:
                    return self._json(200, commit_model(stage))
                except Exception as e:
                    return self._json(200, {"ok": False, "reason": str(e)})
                finally:
                    shutil.rmtree(stage, ignore_errors=True)
        return self.send_error(404)


def commit_model(stage):
    """Check the staged model, archive the current one, then move the new one in place."""
    with open(os.path.join(stage, "data", "elements.json"), encoding="utf-8") as f:
        m = json.load(f)
    stones = [e for e in m.get("elements", []) if e.get("kind") == "stone"]
    if not stones:
        raise ValueError("the new model has no stones with a TICKET NUMBER")
    for c in m.get("chunks", []):
        p = os.path.join(stage, c["file"])
        if not os.path.isfile(p) or os.path.getsize(p) != c["bytes"]:
            raise ValueError(f"geometry file {c['file']} is missing or incomplete")
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    arch = os.path.join(ROOT, "_archive", "model-" + stamp)
    os.makedirs(os.path.join(arch, "data"), exist_ok=True)
    cur_json, cur_geom = os.path.join(ROOT, "data", "elements.json"), os.path.join(ROOT, "geom")
    moved = []
    try:
        if os.path.isfile(cur_json):
            shutil.move(cur_json, os.path.join(arch, "data", "elements.json")); moved.append("json")
        if os.path.isdir(cur_geom):
            shutil.move(cur_geom, os.path.join(arch, "geom")); moved.append("geom")
        shutil.move(os.path.join(stage, "geom"), cur_geom)
        shutil.move(os.path.join(stage, "data", "elements.json"), cur_json)
    except Exception:
        # put the previous model back
        if "geom" in moved:
            shutil.rmtree(cur_geom, ignore_errors=True); shutil.move(os.path.join(arch, "geom"), cur_geom)
        if "json" in moved:
            shutil.move(os.path.join(arch, "data", "elements.json"), cur_json)
        raise
    for kind in library.KINDS:      # ticket list may have changed
        library.build_index(kind)
    return {"ok": True, "archivedTo": os.path.relpath(arch, ROOT).replace(os.sep, "/"), "stones": len(stones)}


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    # On Windows SO_REUSEADDR lets a second server share a busy port, which would hide the conflict.
    allow_reuse_address = os.name != "nt"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=None, help="default 8080, or the next free port up to 8099")
    ap.add_argument("--open", action="store_true", help="open the dashboard in the default browser once the server is running")
    ap.add_argument("--allow-remote-import", action="store_true", help="accept imports from other computers (no authentication!)")
    a = ap.parse_args()
    Handler.allow_remote = a.allow_remote_import
    missing = [f for f in ("index.html", os.path.join("data", "elements.json"), os.path.join("assets", "app.js")) if not os.path.isfile(os.path.join(ROOT, f))]
    if missing:
        print("ERROR: these files are missing next to server.py: " + ", ".join(missing))
        print("Extract the whole ZIP first (right-click the ZIP > Extract All), then run the start file from the extracted folder.")
        print("ไม่พบไฟล์ของแดชบอร์ด: ให้แตกไฟล์ ZIP ทั้งหมดก่อน (คลิกขวา > Extract All) แล้วเปิดจากโฟลเดอร์ที่แตกแล้ว")
        sys.exit(2)
    shutil.rmtree(INCOMING, ignore_errors=True)   # unfinished model uploads
    for kind, label in (("pdf", "Fab Sheets"), ("stl", "STL files")):   # pick up files copied in by hand
        idx = library.build_index(kind)
        print(f"{label}: {len(idx['files'])} tickets have a file, {len(idx['ticketsWithoutFile'])} do not, {len(idx['unmatched'])} files match no IFC ticket.")
    ports = [a.port] if a.port else list(range(8080, 8100))
    srv, last = None, None
    for port in ports:
        try:
            srv = Server((a.host, port), Handler)
            break
        except OSError as e:
            last = e
    if srv is None:
        print(f"ERROR: cannot start the server on port {ports[0]}{'-' + str(ports[-1]) if len(ports) > 1 else ''}: {last}")
        print("Another program may be using the port, or a firewall/antivirus blocked Python. Try: python server.py --port 9000")
        sys.exit(3)
    url = f"http://127.0.0.1:{srv.server_address[1]}/"
    print(f"Facade Stone Dashboard is running: {url}")
    print("Keep this window open while you use the dashboard. Press Ctrl+C or close the window to stop.")
    print("เปิดหน้าต่างนี้ค้างไว้ระหว่างใช้งาน ปิดหน้าต่างนี้ = ปิดแดชบอร์ด")
    if a.open:
        import webbrowser
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

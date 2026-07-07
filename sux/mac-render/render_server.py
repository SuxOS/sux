#!/usr/bin/env python3
# Residential render service — a patched (patchright) headless Chromium on a Mac
# that egresses from the home residential IP. Solves active JS bot challenges
# (Akamai sensor, etc.) that Cloudflare Browser Rendering can't. The sux Worker
# POSTs /render with an HMAC (ts+sig in the query, same scheme as the OpenWRT
# /fetch node) and gets back rendered html/text/screenshot/pdf.
import os, json, hmac, hashlib, base64
from urllib.parse import urlparse, parse_qs
from http.server import BaseHTTPRequestHandler, HTTPServer
from patchright.sync_api import sync_playwright

SECRET = os.environ.get("RENDER_SECRET", "").encode()
PORT = int(os.environ.get("PORT", "8790"))
BLOCK = {"image", "media", "font", "stylesheet"}

_pw = sync_playwright().start()
_ctx = _pw.chromium.launch_persistent_context(
    user_data_dir=os.path.expanduser("~/.sux-render-profile"),
    headless=True, viewport={"width": 1280, "height": 800},
)

def render(spec):
    url = spec["url"]
    as_ = spec.get("as", "html")
    page = _ctx.new_page()
    try:
        if spec.get("block_resources"):
            page.route("**/*", lambda r: r.abort() if r.request.resource_type in BLOCK else r.continue_())
        page.goto(url, wait_until=spec.get("wait_until", "domcontentloaded"), timeout=int(spec.get("timeout_ms", 45000)))
        if spec.get("wait_ms"):
            page.wait_for_timeout(int(spec["wait_ms"]))
        if as_ == "screenshot":
            return {"status": 200, "content_type": "image/png", "bodyEncoding": "base64",
                    "body": base64.b64encode(page.screenshot(full_page=bool(spec.get("full_page")))).decode()}
        if as_ == "pdf":
            return {"status": 200, "content_type": "application/pdf", "bodyEncoding": "base64",
                    "body": base64.b64encode(page.pdf()).decode()}
        if as_ == "text":
            return {"status": 200, "content_type": "text/plain",
                    "body": page.evaluate("document.body ? document.body.innerText : ''")}
        return {"status": 200, "content_type": "text/html", "body": page.content()}
    finally:
        page.close()

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if urlparse(self.path).path == "/health": return self._send(200, {"status": "ok"})
        self._send(404, {"error": "not_found"})
    def do_POST(self):
        q = parse_qs(urlparse(self.path).query)
        ts = (q.get("ts") or [""])[0]; sig = (q.get("sig") or [""])[0]
        raw = self.rfile.read(int(self.headers.get("content-length", 0) or 0))
        calc = hmac.new(SECRET, (ts + "\n").encode() + raw, hashlib.sha256).hexdigest()
        if not sig or not hmac.compare_digest(calc, sig): return self._send(401, {"error": "unauthorized"})
        try:
            spec = json.loads(raw)
        except Exception:
            return self._send(400, {"error": "bad_json"})
        if not spec.get("url"): return self._send(400, {"error": "missing_url"})
        try:
            self._send(200, render(spec))
        except Exception as e:
            self._send(502, {"error": str(e)[:300]})

if __name__ == "__main__":
    if len(SECRET) < 16:
        raise SystemExit("set RENDER_SECRET (>=16 chars)")
    print(f"sux render service on 127.0.0.1:{PORT}")
    HTTPServer(("127.0.0.1", PORT), H).serve_forever()

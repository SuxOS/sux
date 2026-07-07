#!/usr/bin/env python3
# Residential render service — patchright (patched Chromium) on a residential Mac
# that solves active JS bot challenges (Akamai sensor) CF Browser Rendering can't.
# ASYNC: one browser, many concurrent pages (semaphore-capped) for parallel serving.
# The sux Worker POSTs /render?ts=&sig= with HMAC(RENDER_SECRET, `${ts}\n${payload}`).
import os, json, hmac, hashlib, base64, asyncio
from aiohttp import web
from patchright.async_api import async_playwright

SECRET = os.environ.get("RENDER_SECRET", "").encode()
PORT = int(os.environ.get("PORT", "8790"))
CONC = int(os.environ.get("CONCURRENCY", "4"))
BLOCK = {"image", "media", "font", "stylesheet"}
ctx = None
sem = asyncio.Semaphore(CONC)

async def do_render(spec):
    as_ = spec.get("as", "html")
    async with sem:
        page = await ctx.new_page()
        try:
            if spec.get("block_resources"):
                async def _route(r):
                    if r.request.resource_type in BLOCK:
                        await r.abort()
                    else:
                        await r.continue_()
                await page.route("**/*", _route)
            await page.goto(spec["url"], wait_until=spec.get("wait_until", "domcontentloaded"), timeout=int(spec.get("timeout_ms", 45000)))
            if spec.get("wait_ms"):
                await page.wait_for_timeout(int(spec["wait_ms"]))
            if as_ == "screenshot":
                data = await page.screenshot(full_page=bool(spec.get("full_page")))
                return {"status": 200, "content_type": "image/png", "bodyEncoding": "base64", "body": base64.b64encode(data).decode()}
            if as_ == "pdf":
                data = await page.pdf()
                return {"status": 200, "content_type": "application/pdf", "bodyEncoding": "base64", "body": base64.b64encode(data).decode()}
            if as_ == "text":
                return {"status": 200, "content_type": "text/plain", "body": await page.evaluate("document.body ? document.body.innerText : ''")}
            return {"status": 200, "content_type": "text/html", "body": await page.content()}
        finally:
            await page.close()

async def h_render(req):
    ts = req.query.get("ts", ""); sig = req.query.get("sig", "")
    raw = await req.read()
    calc = hmac.new(SECRET, (ts + "\n").encode() + raw, hashlib.sha256).hexdigest()
    if not sig or not hmac.compare_digest(calc, sig):
        return web.json_response({"error": "unauthorized"}, status=401)
    try:
        spec = json.loads(raw)
    except Exception:
        return web.json_response({"error": "bad_json"}, status=400)
    if not spec.get("url"):
        return web.json_response({"error": "missing_url"}, status=400)
    try:
        return web.json_response(await do_render(spec))
    except Exception as e:
        return web.json_response({"error": str(e)[:300]}, status=502)

async def h_health(req):
    return web.json_response({"status": "ok", "concurrency": CONC})

async def main():
    global ctx
    pw = await async_playwright().start()
    ctx = await pw.chromium.launch_persistent_context(
        user_data_dir=os.path.expanduser("~/.sux-render-profile"),
        headless=True, viewport={"width": 1280, "height": 800})
    app = web.Application(client_max_size=2 * 1024 * 1024)
    app.router.add_post("/render", h_render)
    app.router.add_get("/health", h_health)
    runner = web.AppRunner(app); await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", PORT).start()
    print(f"async render service on 127.0.0.1:{PORT} conc={CONC}")
    await asyncio.Event().wait()

if __name__ == "__main__":
    if len(SECRET) < 16:
        raise SystemExit("set RENDER_SECRET (>=16 chars)")
    asyncio.run(main())

"""
Toss V4 Trader - optional backend
- Default: MOCK / preview only
- Token stays server-side in TOSS_ACCESS_TOKEN.
- Live order sending is deliberately gated by LIVE_TRADING_ENABLED=true.
"""
from __future__ import annotations
import os, json, math
from urllib.request import Request, urlopen
from urllib.parse import urlencode
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

BASE = "https://openapi.tossinvest.com"
ROOT = Path(__file__).resolve().parent
TOKEN = os.getenv("TOSS_ACCESS_TOKEN", "")
LIVE = os.getenv("LIVE_TRADING_ENABLED", "").lower() == "true"

def toss_get(path: str, params: dict):
    if not TOKEN:
        raise RuntimeError("TOSS_ACCESS_TOKEN is not set")
    qs = urlencode(params)
    req = Request(f"{BASE}{path}?{qs}", headers={"Authorization": f"Bearer {TOKEN}"})
    with urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())

class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        if path.startswith("/api/"):
            return super().translate_path(path)
        rel = path.split("?",1)[0].lstrip("/") or "index.html"
        return str(ROOT / rel)

    def _json(self, code, payload):
        body=json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code); self.send_header("Content-Type","application/json; charset=utf-8")
        self.send_header("Content-Length",str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/api/health"):
            return self._json(200, {"ok":True,"mode":"LIVE" if LIVE else "MOCK","tokenConfigured":bool(TOKEN)})
        if self.path.startswith("/api/price"):
            try:
                q=self.path.split("symbol=",1)[1].split("&",1)[0] if "symbol=" in self.path else "TQQQ"
                data=toss_get("/api/v1/prices", {"symbols":q})
                return self._json(200,data)
            except Exception as e:
                return self._json(502,{"error":str(e)})
        return super().do_GET()

    def do_POST(self):
        if self.path == "/api/order":
            if not LIVE:
                return self._json(403, {"error":"LIVE trading is disabled. Set LIVE_TRADING_ENABLED=true only after sandbox/manual verification."})
            # Intentionally not forwarding live orders until the current official
            # Toss order schema is bound and tested against the user's account.
            return self._json(501, {"error":"Live order adapter not bound yet. Preview/order-generation only."})
        return self._json(404, {"error":"not found"})

if __name__ == "__main__":
    os.chdir(ROOT)
    port=int(os.getenv("PORT","8000"))
    print(f"Toss V4 Trader: http://127.0.0.1:{port}  live={LIVE}")
    ThreadingHTTPServer(("127.0.0.1",port),Handler).serve_forever()

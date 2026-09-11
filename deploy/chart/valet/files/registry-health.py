"""Report physical registry filesystem bytes on each health request."""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/health":
            self.respond(404, {"error": "Use GET /health to read registry capacity."})
            return
        try:
            stats = os.statvfs("/var/lib/registry")
        except OSError:
            self.respond(503, {"error": "Cannot read registry capacity. Check the registry volume mount."})
            return
        self.respond(200, {
            "capacityBytes": stats.f_blocks * stats.f_frsize,
            "availableBytes": stats.f_bavail * stats.f_frsize,
            "usedBytes": (stats.f_blocks - stats.f_bfree) * stats.f_frsize,
        })

    def respond(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        # Kubernetes health checks must not create continuous access logs.
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 5001), Handler).serve_forever()
